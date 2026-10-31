import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubTokenRejectedError, RepoNotFoundError, UpstreamRateLimitedError } from '../../src/errors.js';
import { ReviewFlowReportSchema } from '../../src/http/params.js';
import type { PullRequestRow, ReviewRow } from '../../src/domain/types.js';
import { createHarness, DATA_AS_OF, TOKEN, type Harness } from './harness.js';

const PATH = '/api/v1/repos/fastify/fastify/review-flow';
const WINDOW_QS = 'from=2026-03-02&to=2026-03-16';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let h: Harness;

/** Sends the path verbatim (no dot-segment removal), as `curl --path-as-is` would. */
function rawGet(base: URL, path: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'] ?? '', body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });

type Res = Awaited<ReturnType<typeof get>>;

function expectProblem(res: Res, status: number, type: string): Record<string, unknown> {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.json<Record<string, unknown>>();
  expect(body).toMatchObject({ status, type: `https://tempo.dev/problems/${type}` });
  expect(typeof body.title).toBe('string');
  expect(typeof body.detail).toBe('string');
  expect(typeof body.instance).toBe('string');
  expect(res.headers['x-request-id']).toMatch(UUID);
  expect(body.requestId).toBe(res.headers['x-request-id']);
  return body;
}

describe('GET /api/v1/repos/:owner/:repo/review-flow', () => {
  it('returns a report that matches the response schema with reconciling totals', async () => {
    const res = await get(`${PATH}?${WINDOW_QS}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('private, max-age=60');
    expect(res.headers['x-request-id']).toMatch(UUID);
    const body = ReviewFlowReportSchema.parse(res.json());
    expect(body.repo).toBe('fastify/fastify');
    expect(body.window).toEqual({ from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' });
    expect(body.dataAsOf).toBe(DATA_AS_OF);
    expect(body.coverage.partial).toBe(false);
    expect(body.includeBots).toBe(false);
    expect(body.team).toMatchObject({ prsOpened: 4, prsMerged: 3, reviewsSubmitted: 6 });
    expect(body.totals.prsMerged).toBe(body.team.prsMerged);
    expect(body.totals.reviewsSubmitted).toBe(body.team.reviewsSubmitted);
    for (const key of ['commits', 'prsOpened', 'prsMerged', 'linesChanged', 'reviewsSubmitted'] as const) {
      expect(body.people.reduce((sum, p) => sum + p[key], 0)).toBe(body.totals[key]);
    }
  });

  it('reports the canonical repo name and passes the parsed window to sync', async () => {
    const res = await get(`/api/v1/repos/Fastify/FASTIFY/review-flow?${WINDOW_QS}&includeBots=true`);

    expect(res.statusCode).toBe(200);
    const body = res.json<{ repo: string; includeBots: boolean; team: { prsOpened: number } }>();
    expect(body.repo).toBe('fastify/fastify');
    expect(body.includeBots).toBe(true);
    expect(body.team.prsOpened).toBe(5);
    expect(h.sync.calls).toHaveLength(1);
    expect(h.sync.calls[0]!.repo).toEqual({ owner: 'Fastify', name: 'FASTIFY' });
    expect(h.sync.calls[0]!.window.from.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(h.sync.calls[0]!.window.to.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it.each([
    ['owner a..b', '/api/v1/repos/a..b/fastify/review-flow'],
    ['owner starting with a dash', '/api/v1/repos/-fastify/fastify/review-flow'],
    ['owner longer than 39 characters', `/api/v1/repos/${'a'.repeat(40)}/fastify/review-flow`],
    ['name with a space', '/api/v1/repos/fastify/fast%20ify/review-flow'],
  ])('rejects an invalid repo path (%s) with a 400 problem', async (_label, url) => {
    const res = await get(url);
    expectProblem(res, 400, 'invalid-request');
    expect(h.sync.calls).toHaveLength(0);
  });

  it.each([
    ['..', '/api/v1/repos/fastify/../review-flow'],
    ['%2E%2E', '/api/v1/repos/fastify/%2E%2E/review-flow'],
    ['.', '/api/v1/repos/fastify/./review-flow'],
    ['%2E', '/api/v1/repos/fastify/%2E/review-flow'],
  ])('rejects the dot-segment name %s sent over a socket without client normalisation', async (_label, path) => {
    const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const res = await rawGet(new URL(address), path);
    expect(res.status).toBe(400);
    expect(res.contentType).toMatch(/^application\/problem\+json/);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'https://tempo.dev/problems/invalid-request' });
    expect(h.sync.calls).toHaveLength(0);
  });

  it('lists the offending field paths for a schema violation', async () => {
    const res = await get('/api/v1/repos/a..b/fastify/review-flow');
    const body = expectProblem(res, 400, 'invalid-request');
    expect(body.errors).toEqual([expect.objectContaining({ path: 'params.owner' })]);
    expect(body.instance).toBe('/api/v1/repos/a..b/fastify/review-flow');
  });

  it.each([
    ['an impossible month', 'from=2026-13-01&to=2026-03-16'],
    ['from after to', 'from=2026-03-16&to=2026-03-02'],
    ['a span over 366 days', 'from=2024-01-01&to=2026-03-16'],
  ])('rejects %s with a 400 problem', async (_label, qs) => {
    const res = await get(`${PATH}?${qs}`);
    expectProblem(res, 400, 'invalid-request');
    expect(h.sync.calls).toHaveLength(0);
  });

  it('rejects includeBots values other than true or false', async () => {
    const res = await get(`${PATH}?${WINDOW_QS}&includeBots=yes`);
    const body = expectProblem(res, 400, 'invalid-request');
    expect(body.errors).toEqual([expect.objectContaining({ path: 'querystring.includeBots' })]);
  });

  it('keeps the query string out of the problem instance', async () => {
    const res = await get(`${PATH}?from=2026-13-01&token=s3cret`);
    const body = expectProblem(res, 400, 'invalid-request');
    expect(body.instance).toBe(PATH);
    expect(res.body).not.toContain('s3cret');
  });

  it('maps a missing repository to 404', async () => {
    h.sync.failWith = new RepoNotFoundError('fastify/fastify');
    const res = await get(`${PATH}?${WINDOW_QS}`);
    expectProblem(res, 404, 'repo-not-found');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('maps an upstream rate limit to 503 with Retry-After', async () => {
    h.sync.failWith = new UpstreamRateLimitedError(42);
    const res = await get(`${PATH}?${WINDOW_QS}`);
    expectProblem(res, 503, 'upstream-rate-limited');
    expect(res.headers['retry-after']).toBe('42');
  });

  it('maps a rejected GitHub token to 503 without leaking the token to the body or logs', async () => {
    h.sync.failWith = new GitHubTokenRejectedError();
    const res = await get(`${PATH}?${WINDOW_QS}`, { authorization: `Bearer ${TOKEN}` });
    expectProblem(res, 503, 'github-token-rejected');
    expect(res.body).not.toContain(TOKEN);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain(TOKEN);
  });

  it('hides unexpected failures behind a generic 500 problem and logs the stack', async () => {
    h.sync.failWith = new Error('database exploded');
    const res = await get(`${PATH}?${WINDOW_QS}`);
    const body = expectProblem(res, 500, 'internal-error');
    expect(res.body).not.toContain('exploded');
    expect(body.detail).toBe('An unexpected error occurred');
    const logged = h.logs.join('\n');
    expect(logged).toContain('database exploded');
    expect(logged).toContain('"stack"');
  });

  it('does not echo the message of a non-framework error that carries a 4xx status', async () => {
    h.sync.failWith = Object.assign(new Error('upstream said: {"message":"Bad credentials","token":"zzz"}'), {
      statusCode: 404,
    });
    const res = await get(`${PATH}?${WINDOW_QS}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ status: 404, detail: 'Not Found' });
    expect(res.body).not.toContain('Bad credentials');
  });

  it('measures metrics at the data snapshot, so rows stored after dataAsOf do not change the report', async () => {
    // Window runs to now (AS_OF, 2026-03-20T00:00Z); dataAsOf is ten minutes earlier.
    const url = `${PATH}?from=2026-03-02`;
    const first = await get(url);
    expect(first.statusCode).toBe(200);

    const repoId = h.store.getRepo('fastify/fastify')!.id;
    const late: PullRequestRow = {
      id: 'PR_LATE',
      number: 99,
      author: 'erin',
      authorIsBot: false,
      createdAt: '2026-03-19T23:55:00Z',
      updatedAt: '2026-03-19T23:55:00Z',
      mergedAt: null,
      closedAt: null,
      additions: 1,
      deletions: 1,
    };
    const lateReview: ReviewRow = {
      id: 'R_LATE',
      pullRequestId: 'PR5',
      reviewer: 'bob',
      reviewerIsBot: false,
      state: 'APPROVED',
      submittedAt: '2026-03-19T23:56:00Z',
      commentCount: 0,
    };
    h.store.upsertPullRequests(repoId, [late], [lateReview]);
    h.store.upsertCommits(repoId, [
      {
        sha: 'late',
        authorLogin: 'erin',
        authorName: 'Erin',
        authorIsBot: false,
        committedAt: '2026-03-19T23:57:00Z',
        additions: 1,
        deletions: 1,
      },
    ]);

    const second = await get(url);
    expect(second.json()).toEqual(first.json());
    const team = second.json<{ team: { awaitingFirstReview: { medianAgeHours: number | null } } }>().team;
    expect(team.awaitingFirstReview.medianAgeHours ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the request time when dataAsOf is not a valid timestamp', async () => {
    h.sync.dataAsOf = 'not-a-date';
    const report = await h.reviewFlow.getReport({ owner: 'fastify', name: 'fastify' }, { from: '2026-03-02' });
    expect(report.dataAsOf).toBe('not-a-date');
    expect(report.team.prsOpened).toBe(4);
  });

  it('redacts secret-named fields at the top level of a log entry', async () => {
    h.app.log.info({ token: TOKEN, githubToken: TOKEN, apiKey: TOKEN, anthropicApiKey: TOKEN }, 'secrets');
    const line = h.logs.find((l) => l.includes('"secrets"'));
    expect(line).toBeDefined();
    expect(line).not.toContain(TOKEN);
  });

  it('assigns a fresh request id and ignores any inbound one', async () => {
    const res = await get(`${PATH}?${WINDOW_QS}`, { 'x-request-id': 'forged-id' });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(h.logs.join('\n')).not.toContain('forged-id');
  });

  it('returns a 404 problem for unknown API routes', async () => {
    const res = await get('/api/v1/nope');
    const body = expectProblem(res, 404, 'not-found');
    expect(body.instance).toBe('/api/v1/nope');
  });

  it('returns a 400 problem for a malformed URL', async () => {
    const res = await get('/api/v1/repos/%E0%A4%A/fastify/review-flow');
    expectProblem(res, 400, 'invalid-request');
  });

  it('returns a 404 problem for unsupported methods', async () => {
    const res = await h.app.inject({ method: 'DELETE', url: PATH });
    expectProblem(res, 404, 'not-found');
  });

  it('sets security headers', async () => {
    const res = await get(`${PATH}?${WINDOW_QS}`);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rate limits each client to 120 requests per minute', async () => {
    let last: Res | undefined;
    for (let i = 0; i < 121; i++) last = await get(`${PATH}?${WINDOW_QS}`);
    const body = expectProblem(last!, 429, 'rate-limited');
    expect(body.title).toBe('Too many requests');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts percent-encoded API paths against the API budget', async () => {
    const encoded = `/%61pi/v1/repos/fastify/fastify/review-flow?${WINDOW_QS}`;
    const first = await get(encoded);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('119');
    let last: Res | undefined;
    for (let i = 1; i < 121; i++) last = await get(encoded);
    expectProblem(last!, 429, 'rate-limited');
  });

  it('counts percent-encoded unknown API paths against the API budget', async () => {
    let last: Res | undefined;
    for (let i = 0; i < 121; i++) last = await get('/%61pi/v1/nope');
    expectProblem(last!, 429, 'rate-limited');
  });
});
