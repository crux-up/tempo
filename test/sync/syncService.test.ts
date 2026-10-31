import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import type { CommitRow, PullRequestRow, RepoRef, ReviewRow } from '../../src/domain/types.js';
import { UpstreamError } from '../../src/errors.js';
import type { GitHubSource } from '../../src/github/client.js';
import type { Logger } from '../../src/logger.js';
import { SyncService } from '../../src/sync/syncService.js';

const pr = (n: number, updatedAt: string): PullRequestRow => ({
  id: `PR_${n}`,
  number: n,
  author: 'alice',
  authorIsBot: false,
  createdAt: updatedAt,
  updatedAt,
  mergedAt: null,
  closedAt: null,
  additions: 1,
  deletions: 1,
});

const commit = (sha: string, committedAt: string): CommitRow => ({
  sha,
  authorLogin: 'alice',
  authorName: 'Alice',
  authorIsBot: false,
  committedAt,
  additions: 1,
  deletions: 1,
});

type PrPage = { pullRequests: PullRequestRow[]; reviews: ReviewRow[]; oldestUpdatedAt: string | null };

const page = (...prs: PullRequestRow[]): PrPage => ({
  pullRequests: prs,
  reviews: [],
  oldestUpdatedAt: prs.length ? prs.map((p) => p.updatedAt).sort()[0]! : null,
});

/** Lazy fake: counts the pages actually pulled, so tests can assert how far the service paged. */
class FakeGitHub implements GitHubSource {
  prPages: PrPage[] = [];
  commitPagesData: CommitRow[][] = [];
  failPrPageAt: number | null = null;
  onPage: () => void = () => {};
  repoCalls: RepoRef[] = [];
  prCalls = 0;
  prPagesPulled = 0;
  commitCalls: Array<{ branch: string; since: string; until: string }> = [];
  commitPagesPulled = 0;

  async getRepository(repo: RepoRef) {
    this.repoCalls.push(repo);
    await Promise.resolve();
    return { owner: 'fastify', name: 'fastify', defaultBranch: 'main' };
  }

  async *pullRequestPages(): AsyncIterable<PrPage> {
    this.prCalls++;
    for (let i = 0; i < this.prPages.length; i++) {
      if (this.failPrPageAt === i) throw new UpstreamError('boom');
      this.prPagesPulled++;
      this.onPage();
      yield this.prPages[i]!;
    }
  }

  async *commitPages(_repo: RepoRef, branch: string, since: string, until: string): AsyncIterable<CommitRow[]> {
    this.commitCalls.push({ branch, since, until });
    for (const p of this.commitPagesData) {
      this.commitPagesPulled++;
      this.onPage();
      yield p;
    }
  }

  get totalCalls() {
    return this.repoCalls.length + this.prCalls + this.commitCalls.length;
  }
}

const silent: Logger = { debug: () => {}, warn: () => {} };
const T0 = new Date('2026-03-31T12:00:00.000Z');
const MARCH = { from: new Date('2026-03-01T00:00:00.000Z'), to: T0 };
const REPO = { owner: 'fastify', name: 'fastify' };

describe('SyncService', () => {
  let db: Database;
  let store: Store;
  let github: FakeGitHub;
  let clock: Date;

  const service = (over: { maxPages?: number; maxSeconds?: number } = {}) =>
    new SyncService({
      github,
      store,
      ttlMinutes: 15,
      maxPages: over.maxPages ?? 40,
      maxSeconds: over.maxSeconds ?? 25,
      now: () => clock,
      logger: silent,
    });

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new Store(db);
    github = new FakeGitHub();
    clock = T0;
    github.prPages = [
      page(pr(1, '2026-03-30T00:00:00.000Z'), pr(2, '2026-03-20T00:00:00.000Z')),
      page(pr(3, '2026-03-10T00:00:00.000Z'), pr(4, '2026-02-25T00:00:00.000Z')),
      page(pr(5, '2026-02-20T00:00:00.000Z'), pr(6, '2026-02-10T00:00:00.000Z')),
    ];
    github.commitPagesData = [[commit('c1', '2026-03-15T00:00:00.000Z')]];
  });

  afterEach(() => db.close());

  it('backfills on the first call and sets the sync markers', async () => {
    const result = await service().ensureSynced(REPO, MARCH);

    expect(github.repoCalls).toHaveLength(1);
    expect(github.prPagesPulled).toBe(2);
    expect(github.commitCalls).toEqual([
      { branch: 'main', since: '2026-03-01T00:00:00.000Z', until: '2026-03-31T12:00:00.000Z' },
    ]);
    expect(result.repo).toMatchObject({
      key: 'fastify/fastify',
      syncedFrom: '2026-03-01T00:00:00.000Z',
      syncedAt: '2026-03-31T12:00:00.000Z',
    });
    expect(result.dataAsOf).toBe('2026-03-31T12:00:00.000Z');
    expect(result.coverage).toEqual({
      partial: false,
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-31T12:00:00.000Z',
    });
    const stored = store.loadWindowData(result.repo.id, MARCH, T0);
    expect(stored.pullRequests.map((p) => p.number)).toEqual([3, 2, 1]);
    expect(stored.commits.map((c) => c.sha)).toEqual(['c1']);
  });

  it('makes no GitHub calls on a second call within the TTL', async () => {
    const first = await service().ensureSynced(REPO, MARCH);
    const callsAfterFirst = github.totalCalls;
    clock = new Date(T0.getTime() + 10 * 60_000);

    const second = await service().ensureSynced(REPO, MARCH);

    expect(github.totalCalls).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it('after the TTL refreshes only back to syncedAt', async () => {
    await service().ensureSynced(REPO, MARCH);
    clock = new Date(T0.getTime() + 20 * 60_000);
    github.prPages = [
      page(pr(7, '2026-03-31T12:10:00.000Z'), pr(1, '2026-03-31T11:00:00.000Z')),
      page(pr(2, '2026-03-20T00:00:00.000Z')),
    ];
    github.prPagesPulled = 0;

    const result = await service().ensureSynced(REPO, MARCH);

    expect(github.prPagesPulled).toBe(1);
    expect(github.commitCalls[1]).toEqual({
      branch: 'main',
      since: '2026-03-31T12:00:00.000Z',
      until: '2026-03-31T12:20:00.000Z',
    });
    expect(result.repo.syncedAt).toBe('2026-03-31T12:20:00.000Z');
    expect(result.repo.syncedFrom).toBe('2026-03-01T00:00:00.000Z');
    expect(result.dataAsOf).toBe('2026-03-31T12:20:00.000Z');
    expect(result.coverage.partial).toBe(false);
  });

  it('backfills when a wider window starts before syncedFrom', async () => {
    await service().ensureSynced(REPO, MARCH);
    clock = new Date(T0.getTime() + 60_000);
    github.prPagesPulled = 0;
    const wider = { from: new Date('2026-02-15T00:00:00.000Z'), to: T0 };

    const result = await service().ensureSynced(REPO, wider);

    expect(github.prPagesPulled).toBe(3);
    expect(github.commitCalls[1]).toEqual({
      branch: 'main',
      since: '2026-02-15T00:00:00.000Z',
      until: '2026-03-01T00:00:00.000Z',
    });
    expect(result.repo.syncedFrom).toBe('2026-02-15T00:00:00.000Z');
    expect(result.repo.syncedAt).toBe('2026-03-31T12:00:00.000Z');
    expect(result.coverage).toEqual({
      partial: false,
      from: '2026-02-15T00:00:00.000Z',
      to: '2026-03-31T12:00:00.000Z',
    });
  });

  it('stops at maxPages and reports partial coverage from the oldest PR reached', async () => {
    const result = await service({ maxPages: 1 }).ensureSynced(REPO, MARCH);

    expect(github.prPagesPulled).toBe(1);
    expect(github.commitCalls[0]?.since).toBe('2026-03-20T00:00:00.000Z');
    expect(result.repo.syncedFrom).toBe('2026-03-20T00:00:00.000Z');
    expect(result.repo.syncedAt).toBe('2026-03-31T12:00:00.000Z');
    expect(result.coverage).toEqual({
      partial: true,
      from: '2026-03-20T00:00:00.000Z',
      to: '2026-03-31T12:00:00.000Z',
    });
  });

  it('stops when maxSeconds has elapsed, measured with the injected clock', async () => {
    github.onPage = () => {
      clock = new Date(clock.getTime() + 30_000);
    };

    const result = await service({ maxSeconds: 25 }).ensureSynced(REPO, MARCH);

    expect(github.prPagesPulled).toBe(1);
    expect(result.coverage.partial).toBe(true);
    expect(result.repo.syncedAt).toBe('2026-03-31T12:00:00.000Z');
  });

  it('limits syncedFrom to the oldest commit reached when the budget stops the commit pass', async () => {
    github.commitPagesData = [
      [commit('c3', '2026-03-28T00:00:00.000Z')],
      [commit('c2', '2026-03-25T00:00:00.000Z')],
      [commit('c1', '2026-03-05T00:00:00.000Z')],
    ];

    const result = await service({ maxPages: 3 }).ensureSynced(REPO, MARCH);

    expect(github.prPagesPulled).toBe(2);
    expect(github.commitPagesPulled).toBe(1);
    expect(result.repo.syncedFrom).toBe('2026-03-28T00:00:00.000Z');
    expect(result.coverage).toMatchObject({ partial: true, from: '2026-03-28T00:00:00.000Z' });
  });

  it('keeps syncedAt when a refresh hits the budget before reaching it', async () => {
    await service().ensureSynced(REPO, MARCH);
    clock = new Date(T0.getTime() + 20 * 60_000);
    github.prPages = [
      page(pr(8, '2026-03-31T12:15:00.000Z')),
      page(pr(7, '2026-03-31T12:10:00.000Z')),
      page(pr(1, '2026-03-30T00:00:00.000Z')),
    ];

    const result = await service({ maxPages: 1 }).ensureSynced(REPO, MARCH);

    expect(result.repo.syncedAt).toBe('2026-03-31T12:00:00.000Z');
    expect(result.repo.syncedFrom).toBe('2026-03-01T00:00:00.000Z');
    expect(store.loadWindowData(result.repo.id, { from: MARCH.from, to: clock }, clock).pullRequests.map((p) => p.number)).toContain(8);
  });

  it('shares one in-flight sync between concurrent calls for the same repo', async () => {
    const sync = service();
    const [a, b] = await Promise.all([
      sync.ensureSynced(REPO, MARCH),
      sync.ensureSynced({ owner: 'FASTIFY', name: 'Fastify' }, MARCH),
    ]);

    expect(github.repoCalls).toHaveLength(1);
    expect(github.prCalls).toBe(1);
    expect(a).toEqual(b);
  });

  it('resolves differently cased names to the same repo using canonical names', async () => {
    const sync = service();
    const a = await sync.ensureSynced({ owner: 'Fastify', name: 'FASTIFY' }, MARCH);
    const b = await sync.ensureSynced({ owner: 'fastify', name: 'fastify' }, MARCH);

    expect(a.repo.id).toBe(b.repo.id);
    expect(a.repo).toMatchObject({ key: 'fastify/fastify', owner: 'fastify', name: 'fastify' });
    expect(github.repoCalls).toEqual([{ owner: 'Fastify', name: 'FASTIFY' }]);
  });

  it('propagates GitHub errors, keeps upserted pages and leaves the markers unchanged', async () => {
    github.failPrPageAt = 1;
    const sync = service();

    await expect(sync.ensureSynced(REPO, MARCH)).rejects.toBeInstanceOf(UpstreamError);

    const repo = store.getRepo('fastify/fastify')!;
    expect(repo).toMatchObject({ syncedFrom: null, syncedAt: null });
    expect(store.loadWindowData(repo.id, MARCH, T0).pullRequests.map((p) => p.number)).toEqual([2, 1]);

    github.failPrPageAt = null;
    const retry = await sync.ensureSynced(REPO, MARCH);
    expect(github.prCalls).toBe(2);
    expect(retry.repo.syncedAt).toBe('2026-03-31T12:00:00.000Z');
  });
});
