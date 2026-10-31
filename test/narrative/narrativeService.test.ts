import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import { LlmError } from '../../src/errors.js';
import type { Logger } from '../../src/logger.js';
import { NarrativeService } from '../../src/narrative/narrativeService.js';
import { PROMPT_VERSION } from '../../src/narrative/prompt.js';
import { ReviewFlowService } from '../../src/services/reviewFlowService.js';
import { AS_OF, commits, pullRequests, reviews } from '../fixtures/smallRepo.js';
import { FakeSync } from '../routes/harness.js';
import { FakeNarrativeModel } from './fakes.js';

const REPO = { owner: 'fastify', name: 'fastify' };
const ACTIVE = { from: '2026-03-02', to: '2026-03-16' };
const QUIET = { from: '2025-01-01', to: '2025-02-01' };

type LogLine = { level: 'debug' | 'info' | 'warn'; obj: Record<string, unknown>; msg?: string };

let db: Database;
let store: Store;
let sync: FakeSync;
let model: FakeNarrativeModel;
let logs: LogLine[];
let service: NarrativeService;

const logger: Logger = {
  debug: (obj, msg) => logs.push({ level: 'debug', obj: obj as Record<string, unknown>, msg }),
  info: (obj, msg) => logs.push({ level: 'info', obj: obj as Record<string, unknown>, msg }),
  warn: (obj, msg) => logs.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
};

const build = (modelName = 'claude-opus-5-5') =>
  new NarrativeService({
    model,
    modelName,
    store,
    reviewFlow: new ReviewFlowService({ store, sync, now: () => AS_OF }),
    logger,
  });

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new Store(db);
  const repo = store.upsertRepo({ key: 'fastify/fastify', owner: 'fastify', name: 'fastify', defaultBranch: 'main' });
  store.upsertPullRequests(repo.id, pullRequests, reviews);
  store.upsertCommits(repo.id, commits);
  sync = new FakeSync(store);
  model = new FakeNarrativeModel();
  logs = [];
  service = build();
});

afterEach(() => {
  db.close();
});

describe('NarrativeService', () => {
  it('returns the verified narrative with evidence values taken from the fact sheet', async () => {
    const res = await service.getNarrative(REPO, ACTIVE);

    expect(model.calls).toBe(1);
    expect(res).toMatchObject({
      repo: 'fastify/fastify',
      window: { from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' },
      model: 'claude-opus-5-5',
      promptVersion: PROMPT_VERSION,
      cached: false,
      coverage: { partial: false },
    });
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0]?.evidence).toEqual([
      { factId: 'team.timeToFirstReview.median', label: 'Median hours to first review', value: 74, unit: 'hours' },
    ]);
    expect(res.verification.droppedFindings).toBe(1);
    expect(res.verification.droppedEvidenceIds).toEqual(['made.up.id', 'not.a.fact']);
    // Four PRs in the window: the verifier caps confidence at 0.3.
    expect(res.hypothesis?.confidence).toBe(0.3);
    expect(res.verification.confidenceCapped).toMatchObject({ from: 0.9, to: 0.3 });
    expect(Number.isNaN(Date.parse(res.generatedAt))).toBe(false);
  });

  it('sends the model only numbers, fixed labels and logins', async () => {
    await service.getNarrative(REPO, ACTIVE);

    const sheet = model.sheets[0];
    expect(sheet?.facts.length).toBeGreaterThan(0);
    expect(JSON.stringify(sheet)).not.toContain('Erin Example');
  });

  it('serves the second identical request from the cache without calling the model', async () => {
    const first = await service.getNarrative(REPO, ACTIVE);
    const second = await service.getNarrative(REPO, ACTIVE);

    expect(model.calls).toBe(1);
    expect(second.cached).toBe(true);
    expect({ ...second, cached: false }).toEqual(first);
  });

  it('shares one model call between concurrent identical requests', async () => {
    const [a, b] = await Promise.all([service.getNarrative(REPO, ACTIVE), service.getNarrative(REPO, ACTIVE)]);

    expect(model.calls).toBe(1);
    expect(a.summary).toBe(b.summary);
  });

  it('calls the model again on refresh=true and replaces the cached entry', async () => {
    await service.getNarrative(REPO, ACTIVE);
    model.nextDraft = { ...model.nextDraft, summary: 'Refreshed summary.' };

    const refreshed = await service.getNarrative(REPO, { ...ACTIVE, refresh: 'true' });
    const after = await service.getNarrative(REPO, ACTIVE);

    expect(model.calls).toBe(2);
    expect(refreshed).toMatchObject({ summary: 'Refreshed summary.', cached: false });
    expect(after).toMatchObject({ summary: 'Refreshed summary.', cached: true });
  });

  it('keys the cache on window, includeBots, prompt version inputs and model name', async () => {
    await service.getNarrative(REPO, ACTIVE);
    await service.getNarrative(REPO, { ...ACTIVE, includeBots: 'true' });
    await service.getNarrative(REPO, { from: '2026-03-02', to: '2026-03-15' });
    await build('claude-other-model').getNarrative(REPO, ACTIVE);

    expect(model.calls).toBe(4);
  });

  it('reports the current sync time and coverage on a cache hit', async () => {
    await service.getNarrative(REPO, ACTIVE);
    // One minute earlier leaves every fact unchanged (ages are rounded to 0.1 h), so the sheet and key match.
    sync.dataAsOf = '2026-03-19T23:49:00.000Z';

    const hit = await service.getNarrative(REPO, ACTIVE);

    expect(hit.cached).toBe(true);
    expect(hit.dataAsOf).toBe('2026-03-19T23:49:00.000Z');
  });

  it('misses the cache when a later sync changes a fact', async () => {
    await service.getNarrative(REPO, ACTIVE);
    // An hour earlier snapshot makes the open PR an hour younger, so its awaiting-review age fact changes.
    sync.dataAsOf = '2026-03-19T22:50:00.000Z';

    const res = await service.getNarrative(REPO, ACTIVE);

    expect(res.cached).toBe(false);
    expect(model.calls).toBe(2);
  });

  it('answers a window without PR activity with a fixed narrative and no model call', async () => {
    const res = await service.getNarrative(REPO, QUIET);

    expect(model.calls).toBe(0);
    expect(res).toMatchObject({
      summary: 'No pull request activity in this window.',
      findings: [],
      hypothesis: null,
      caveats: [],
      verification: { droppedFindings: 0, droppedEvidenceIds: [], confidenceCapped: null },
      cached: false,
    });
  });

  it('propagates model errors and caches nothing', async () => {
    model.failWith = new LlmError('The model declined to analyse this data');

    await expect(service.getNarrative(REPO, ACTIVE)).rejects.toBeInstanceOf(LlmError);

    model.failWith = null;
    const res = await service.getNarrative(REPO, ACTIVE);
    expect(res.cached).toBe(false);
    expect(model.calls).toBe(2);
  });

  it('logs cache misses and hits with verification counts and token usage', async () => {
    await service.getNarrative(REPO, ACTIVE);
    await service.getNarrative(REPO, ACTIVE);

    const entries = logs.filter((l) => l.msg === 'Narrative served').map((l) => l.obj);
    expect(entries[0]).toMatchObject({
      repo: 'fastify/fastify',
      cache: 'miss',
      model: 'claude-opus-5-5',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 900,
      droppedFindings: 1,
      droppedEvidenceIds: 2,
      confidenceCapped: true,
    });
    expect(typeof entries[0]?.latencyMs).toBe('number');
    expect(entries[1]).toMatchObject({ cache: 'hit' });
  });
});
