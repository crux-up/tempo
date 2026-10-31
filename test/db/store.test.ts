import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { openDatabase } from '../../src/db/database.js';
import { MIGRATIONS } from '../../src/db/migrations.js';
import { Store } from '../../src/db/store.js';
import type { CommitRow, PullRequestRow, ReviewRow } from '../../src/domain/types.js';

const pr = (id: string, over: Partial<PullRequestRow> = {}): PullRequestRow => ({
  id,
  number: Number(id.replace(/\D/g, '')) || 1,
  author: 'alice',
  authorIsBot: false,
  createdAt: '2026-03-10T09:00:00.000Z',
  updatedAt: '2026-03-10T09:00:00.000Z',
  mergedAt: null,
  closedAt: null,
  additions: 10,
  deletions: 2,
  ...over,
});

const review = (id: string, pullRequestId: string, submittedAt: string, over: Partial<ReviewRow> = {}): ReviewRow => ({
  id,
  pullRequestId,
  reviewer: 'bob',
  reviewerIsBot: false,
  state: 'APPROVED',
  submittedAt,
  commentCount: 1,
  ...over,
});

const commit = (sha: string, committedAt: string, over: Partial<CommitRow> = {}): CommitRow => ({
  sha,
  authorLogin: 'alice',
  authorName: 'Alice',
  authorIsBot: false,
  committedAt,
  ...over,
});

const window = { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') };
const asOf = new Date('2026-04-01T00:00:00Z');

describe('Store', () => {
  let db: Database;
  let store: Store;
  let repoId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new Store(db);
    repoId = store.upsertRepo({ key: 'acme/api', owner: 'acme', name: 'api', defaultBranch: 'main' }).id;
  });

  afterEach(() => db.close());

  it('upserts and reads repos, and records sync state', () => {
    expect(store.getRepo('nope/none')).toBeNull();
    const again = store.upsertRepo({ key: 'acme/api', owner: 'acme', name: 'api', defaultBranch: 'trunk' });
    expect(again.id).toBe(repoId);
    expect(again.defaultBranch).toBe('trunk');
    expect(again.syncedAt).toBeNull();
    expect(again.backfillCursor).toBeNull();
    expect(again.refreshIncomplete).toBe(false);
    store.markSynced(repoId, {
      syncedFrom: '2026-01-01T00:00:00.000Z',
      syncedAt: '2026-04-01T00:00:00.000Z',
      backfillCursor: 'Y3Vyc29yOjE=',
      refreshIncomplete: true,
    });
    expect(store.getRepo('acme/api')).toMatchObject({
      syncedFrom: '2026-01-01T00:00:00.000Z',
      syncedAt: '2026-04-01T00:00:00.000Z',
      backfillCursor: 'Y3Vyc29yOjE=',
      refreshIncomplete: true,
    });
    store.markSynced(repoId, {
      syncedFrom: '2026-01-01T00:00:00.000Z',
      syncedAt: '2026-04-01T00:00:00.000Z',
      backfillCursor: null,
      refreshIncomplete: false,
    });
    expect(store.getRepo('acme/api')).toMatchObject({ backfillCursor: null, refreshIncomplete: false });
  });

  it('keeps one row per pull request and stores the newer values', () => {
    store.upsertPullRequests(repoId, [pr('PR_1')], [review('R_1', 'PR_1', '2026-03-11T00:00:00.000Z')]);
    store.upsertPullRequests(
      repoId,
      [pr('PR_1', { mergedAt: '2026-03-12T00:00:00.000Z', additions: 99 })],
      [review('R_1', 'PR_1', '2026-03-11T00:00:00.000Z', { state: 'CHANGES_REQUESTED' })],
    );
    const data = store.loadWindowData(repoId, window, asOf);
    expect(data.pullRequests).toHaveLength(1);
    expect(data.pullRequests[0]).toMatchObject({ additions: 99, mergedAt: '2026-03-12T00:00:00.000Z' });
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0]?.state).toBe('CHANGES_REQUESTED');
  });

  it('round-trips booleans and nullable fields', () => {
    store.upsertPullRequests(
      repoId,
      [pr('PR_1', { authorIsBot: true })],
      [review('R_1', 'PR_1', '2026-03-11T00:00:00.000Z', { reviewerIsBot: true })],
    );
    const bot = commit('a1', '2026-03-05T00:00:00.000Z', { authorLogin: null, authorIsBot: true });
    store.upsertCommits(repoId, [bot]);
    const data = store.loadWindowData(repoId, window, asOf);
    expect(data.pullRequests[0]).toEqual(pr('PR_1', { authorIsBot: true }));
    expect(data.reviews[0]?.reviewerIsBot).toBe(true);
    expect(data.commits[0]).toEqual(bot);
  });

  it('selects PRs created or merged in the window and treats the window as [from, to)', () => {
    store.upsertPullRequests(
      repoId,
      [
        pr('PR_created', { createdAt: '2026-03-01T00:00:00.000Z' }),
        pr('PR_merged', { createdAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-03-20T00:00:00.000Z' }),
        pr('PR_old', { createdAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-02-01T00:00:00.000Z' }),
        pr('PR_at_to', { createdAt: '2026-04-01T00:00:00.000Z' }),
      ],
      [],
    );
    const ids = store
      .loadWindowData(repoId, window, asOf)
      .pullRequests.map((p) => p.id)
      .sort();
    expect(ids).toEqual(['PR_created', 'PR_merged']);
  });

  it('returns an out-of-window PR when it owns an in-window review, with all its reviews up to asOf', () => {
    store.upsertPullRequests(
      repoId,
      [pr('PR_old', { createdAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-02-01T00:00:00.000Z' })],
      [
        review('R_early', 'PR_old', '2026-01-05T00:00:00.000Z'),
        review('R_in', 'PR_old', '2026-03-05T00:00:00.000Z'),
        review('R_late', 'PR_old', '2026-04-20T00:00:00.000Z'),
      ],
    );
    const data = store.loadWindowData(repoId, window, new Date('2026-04-10T00:00:00Z'));
    expect(data.pullRequests.map((p) => p.id)).toEqual(['PR_old']);
    expect(data.reviews.map((r) => r.id).sort()).toEqual(['R_early', 'R_in']);
  });

  it('excludes reviews after asOf and the PRs that only they would pull in', () => {
    store.upsertPullRequests(
      repoId,
      [pr('PR_old', { createdAt: '2026-01-01T00:00:00.000Z' })],
      [review('R_future', 'PR_old', '2026-03-30T00:00:00.000Z')],
    );
    const data = store.loadWindowData(repoId, window, new Date('2026-03-15T00:00:00Z'));
    expect(data.pullRequests).toEqual([]);
    expect(data.reviews).toEqual([]);
  });

  it('matches timestamps across ISO spellings by normalising on write', () => {
    store.upsertPullRequests(repoId, [pr('PR_1', { createdAt: '2026-03-01T00:00:00Z' })], []);
    expect(store.loadWindowData(repoId, window, asOf).pullRequests).toHaveLength(1);
  });

  it('keeps data of different repos apart', () => {
    const other = store.upsertRepo({ key: 'acme/web', owner: 'acme', name: 'web', defaultBranch: 'main' }).id;
    store.upsertPullRequests(other, [pr('PR_other')], []);
    store.upsertCommits(other, [commit('zz', '2026-03-05T00:00:00.000Z')]);
    const data = store.loadWindowData(repoId, window, asOf);
    expect(data.pullRequests).toEqual([]);
    expect(data.commits).toEqual([]);
  });

  it('upserts commits by (repo, sha) and filters them by window', () => {
    store.upsertCommits(repoId, [
      commit('a1', '2026-03-05T00:00:00.000Z'),
      commit('b2', '2026-02-28T23:59:59.000Z'),
      commit('c3', '2026-04-01T00:00:00.000Z'),
    ]);
    store.upsertCommits(repoId, [commit('a1', '2026-03-05T00:00:00.000Z', { authorName: 'Alice A' })]);
    const commits = store.loadWindowData(repoId, window, asOf).commits;
    expect(commits.map((c) => c.sha)).toEqual(['a1']);
    expect(commits[0]?.authorName).toBe('Alice A');
  });

  it('rolls back the whole batch when a review references an unknown pull request', () => {
    expect(() =>
      store.upsertPullRequests(repoId, [pr('PR_1')], [review('R_1', 'PR_missing', '2026-03-11T00:00:00.000Z')]),
    ).toThrow();
    expect(store.loadWindowData(repoId, window, asOf).pullRequests).toEqual([]);
  });

  it('round-trips narratives and replaces them on the same key', () => {
    expect(store.getNarrative('k')).toBeNull();
    store.saveNarrative('k', { headline: 'a', items: [1, 2] }, { model: 'm1', promptVersion: 'v1' });
    const first = store.getNarrative('k');
    expect(first).toMatchObject({ body: { headline: 'a', items: [1, 2] }, model: 'm1', promptVersion: 'v1' });
    expect(Number.isNaN(Date.parse(first?.createdAt ?? ''))).toBe(false);
    store.saveNarrative('k', { headline: 'b' }, { model: 'm2', promptVersion: 'v2' });
    expect(store.getNarrative('k')).toMatchObject({ body: { headline: 'b' }, model: 'm2', promptVersion: 'v2' });
  });
});

describe('openDatabase', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tempo-db-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates parent directories, enables WAL and foreign keys, and migrates idempotently on reopen', () => {
    const path = join(dir, 'nested', 'deeper', 'tempo.db');
    const first = openDatabase(path);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
    const version = first.pragma('user_version', { simple: true });
    expect(version).toBeGreaterThan(0);
    new Store(first).upsertRepo({ key: 'acme/api', owner: 'acme', name: 'api', defaultBranch: 'main' });
    first.close();

    const second = openDatabase(path);
    expect(second.pragma('user_version', { simple: true })).toBe(version);
    expect(new Store(second).getRepo('acme/api')).not.toBeNull();
    second.close();
  });

  it('applies migration 2 to an existing version 1 database and keeps its rows', () => {
    const path = join(dir, 'v1.db');
    const v1 = new BetterSqlite3(path);
    v1.exec(MIGRATIONS[0] as string);
    v1.pragma('user_version = 1');
    v1.prepare(
      `INSERT INTO repos (key, owner, name, default_branch, synced_from, synced_at)
       VALUES ('acme/api', 'acme', 'api', 'main', '2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z')`,
    ).run();
    v1.close();

    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(new Store(db).getRepo('acme/api')).toMatchObject({
      syncedFrom: '2026-01-01T00:00:00.000Z',
      syncedAt: '2026-04-01T00:00:00.000Z',
      backfillCursor: null,
    });
    db.close();
  });

  it('applies migration 3 to a version 2 database: drops commit line counts and keeps the commits', () => {
    const path = join(dir, 'v2.db');
    const v2 = new BetterSqlite3(path);
    v2.exec(MIGRATIONS[0] as string);
    v2.exec(MIGRATIONS[1] as string);
    v2.pragma('user_version = 2');
    v2.prepare("INSERT INTO repos (key, owner, name, default_branch) VALUES ('acme/api', 'acme', 'api', 'main')").run();
    v2.prepare(
      `INSERT INTO commits (repo_id, sha, author_login, author_name, author_is_bot, committed_at, additions, deletions)
       VALUES (1, 'a1', 'alice', 'Alice', 0, '2026-03-05T00:00:00.000Z', 5, 1)`,
    ).run();
    v2.close();

    const db = openDatabase(path);
    const columns = (db.pragma('table_info(commits)') as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('additions');
    expect(columns).not.toContain('deletions');
    expect(new Store(db).loadWindowData(1, window, asOf).commits).toEqual([
      commit('a1', '2026-03-05T00:00:00.000Z'),
    ]);
    db.close();
  });

  it('supports in-memory databases', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    db.close();
  });
});
