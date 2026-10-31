import { afterEach, describe, expect, it } from 'vitest';
import { LlmError, NotConfiguredError, UpstreamRateLimitedError } from '../../src/errors.js';
import { NarrativeResponseSchema } from '../../src/narrative/response.js';
import { FakeNarrativeModel } from '../narrative/fakes.js';
import { createHarness, type Harness } from './harness.js';

const PATH = '/api/v1/repos/fastify/fastify/review-flow/narrative';
const WINDOW_QS = 'from=2026-03-02&to=2026-03-16';

let h: Harness;
let model: FakeNarrativeModel;

const start = async (configured = true, narrativeMaxPerHour?: number) => {
  model = new FakeNarrativeModel();
  h = await createHarness(configured ? { narrativeModel: model, narrativeMaxPerHour } : {});
};

afterEach(async () => {
  await h.close();
});

const get = (url: string) => h.app.inject({ method: 'GET', url });
type Res = Awaited<ReturnType<typeof get>>;

function expectProblem(res: Res, status: number, type: string): Record<string, unknown> {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.json<Record<string, unknown>>();
  expect(body).toMatchObject({ status, type: `urn:tempo:problem:${type}` });
  expect(body.requestId).toBe(res.headers['x-request-id']);
  return body;
}

describe('GET /api/v1/repos/:owner/:repo/review-flow/narrative', () => {
  it('returns a verified narrative that matches the response schema', async () => {
    await start();
    const res = await get(`${PATH}?${WINDOW_QS}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    const body = NarrativeResponseSchema.parse(res.json());
    expect(body.cached).toBe(false);
    expect(body.findings[0]?.evidence[0]).toMatchObject({ factId: 'team.timeToFirstReview.median', value: 74 });
    expect(body.verification.droppedEvidenceIds).toContain('made.up.id');
  });

  it('evidence values match the review-flow report for the same window', async () => {
    await start();
    const narrative = NarrativeResponseSchema.parse((await get(`${PATH}?${WINDOW_QS}`)).json());
    const report = (await get(`/api/v1/repos/fastify/fastify/review-flow?${WINDOW_QS}`)).json<{
      team: { timeToFirstReview: { medianHours: number }; reviewConcentration: { topReviewerShare: number } };
    }>();

    const value = (id: string) => narrative.hypothesis?.evidence.find((e) => e.factId === id)?.value;
    expect(value('team.timeToFirstReview.median')).toBe(report.team.timeToFirstReview.medianHours);
    expect(value('team.reviewConcentration.topReviewerShare')).toBe(report.team.reviewConcentration.topReviewerShare);
  });

  it('serves a repeated request from the cache and calls the model once', async () => {
    await start();
    await get(`${PATH}?${WINDOW_QS}`);
    const second = await get(`${PATH}?${WINDOW_QS}`);

    expect(second.json()).toMatchObject({ cached: true });
    expect(model.calls).toBe(1);
  });

  it('serves a repeated open-ended request (no to) from the cache', async () => {
    await start();
    const first = await get(PATH);
    h.clock.now = new Date(h.clock.now.getTime() + 60_000);
    const second = await get(PATH);

    expect(first.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ cached: true });
    expect(model.calls).toBe(1);
  });

  it('calls the model again when refresh=true', async () => {
    await start();
    await get(`${PATH}?${WINDOW_QS}`);
    const refreshed = await get(`${PATH}?${WINDOW_QS}&refresh=true`);

    expect(refreshed.json()).toMatchObject({ cached: false });
    expect(model.calls).toBe(2);
  });

  it('answers a window without PR activity without calling the model', async () => {
    await start();
    const res = await get(`${PATH}?from=2025-01-01&to=2025-02-01`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ summary: 'No pull request activity in this window.', hypothesis: null });
    expect(model.calls).toBe(0);
  });

  it('maps a model failure to a 502 problem', async () => {
    await start();
    model.failWith = new LlmError('The model declined to analyse this data');

    const body = expectProblem(await get(`${PATH}?${WINDOW_QS}`), 502, 'llm-error');
    expect(body.detail).toBe('The model declined to analyse this data');
  });

  it('maps a rejected API key to 503 not-configured', async () => {
    await start();
    model.failWith = new NotConfiguredError('ANTHROPIC_API_KEY was rejected');

    expectProblem(await get(`${PATH}?${WINDOW_QS}`), 503, 'not-configured');
  });

  it('maps an upstream rate limit to 503 with Retry-After', async () => {
    await start();
    model.failWith = new UpstreamRateLimitedError(30, 'Anthropic');

    const res = await get(`${PATH}?${WINDOW_QS}`);
    expectProblem(res, 503, 'upstream-rate-limited');
    expect(res.headers['retry-after']).toBe('30');
  });

  it('returns 503 naming ANTHROPIC_API_KEY when no narrative service is configured', async () => {
    await start(false);
    const body = expectProblem(await get(`${PATH}?${WINDOW_QS}`), 503, 'not-configured');

    expect(body.detail).toContain('ANTHROPIC_API_KEY');
  });

  it('validates params and query like the review-flow route', async () => {
    await start();
    expectProblem(await get(`/api/v1/repos/-bad/fastify/review-flow/narrative`), 400, 'invalid-request');
    expectProblem(await get(`${PATH}?refresh=yes`), 400, 'invalid-request');
    expectProblem(await get(`${PATH}?from=2026-03-16&to=2026-03-02`), 400, 'invalid-request');
    expect(model.calls).toBe(0);
  });

  it('rate limits each client to 10 narrative requests per minute', async () => {
    await start();
    let last: Res | undefined;
    for (let i = 0; i < 11; i++) last = await get(`${PATH}?${WINDOW_QS}`);

    expectProblem(last!, 429, 'rate-limited');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    expect((await get(`/api/v1/repos/fastify/fastify/review-flow?${WINDOW_QS}`)).statusCode).toBe(200);
  });

  it('answers 429 with Retry-After once the server-wide hourly budget of new narratives is used up', async () => {
    await start(true, 1);
    expect((await get(`${PATH}?${WINDOW_QS}`)).statusCode).toBe(200);

    const res = await get(`${PATH}?${WINDOW_QS}&refresh=true`);

    expectProblem(res, 429, 'narrative-budget-exhausted');
    expect(res.headers['retry-after']).toBe('3600');
  });

  it('charges new narratives to the client address, so one client cannot spend the shared budget alone', async () => {
    model = new FakeNarrativeModel();
    h = await createHarness({ narrativeModel: model, narrativeMaxPerClientPerHour: 1 });
    const from = (ip: string, url: string) => h.app.inject({ method: 'GET', url, remoteAddress: ip });
    expect((await from('203.0.113.7', `${PATH}?${WINDOW_QS}`)).statusCode).toBe(200);

    const refused = await from('203.0.113.7', `${PATH}?${WINDOW_QS}&refresh=true`);

    expectProblem(refused, 429, 'narrative-budget-exhausted');
    expect(refused.headers['retry-after']).toBe('3600');
    expect((await from('203.0.113.8', `${PATH}?${WINDOW_QS}&refresh=true`)).statusCode).toBe(200);
  });

  it('rejects a window that holds no whole UTC day', async () => {
    await start();
    expectProblem(await get(`${PATH}?from=2026-03-10T01:00:00Z&to=2026-03-10T20:00:00Z`), 400, 'invalid-request');
  });

  it('rejects a window that starts more than two years ago', async () => {
    await start();
    expectProblem(await get(`${PATH}?from=2024-03-01&to=2024-04-01`), 400, 'invalid-request');
  });

  it('is documented in the OpenAPI document with a response schema', async () => {
    await start();
    const doc = (await get('/api/v1/openapi.json')).json<{
      paths: Record<
        string,
        { get?: { description?: string; responses: Record<string, { content?: Record<string, { schema: unknown }> }> } }
      >;
    }>();

    const op = doc.paths['/api/v1/repos/{owner}/{repo}/review-flow/narrative']?.get;
    expect(op?.responses['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/Narrative',
    });
    expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['400', '429', '502', '503']));
    expect(JSON.stringify(op)).toContain('150 seconds');
  });
});
