import { Writable } from 'node:stream';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp, createLogger } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { openDatabase } from '../../src/db/database.js';
import { Store } from '../../src/db/store.js';
import type { RepoRef, TimeWindow } from '../../src/domain/types.js';
import type { NarrativeModel } from '../../src/narrative/llmClient.js';
import { NarrativeService } from '../../src/narrative/narrativeService.js';
import { ReviewFlowService } from '../../src/services/reviewFlowService.js';
import type { SyncResult } from '../../src/sync/syncService.js';
import { AS_OF, commits, pullRequests, reviews } from '../fixtures/smallRepo.js';

export const TOKEN = 'ghp_TESTTOKEN0123456789abcdefghijklmnop';

export const testConfig: Config = {
  githubToken: TOKEN,
  anthropicApiKey: null,
  anthropicModel: 'claude-opus-5-5',
  host: '127.0.0.1',
  port: 0,
  databasePath: ':memory:',
  syncTtlMinutes: 15,
  syncMaxPages: 40,
  syncMaxSeconds: 25,
  logLevel: 'info',
};

export const DATA_AS_OF = '2026-03-19T23:50:00.000Z';

/** Stands in for SyncService: records calls, reports the seeded repo as synced, or throws `failWith`. */
export class FakeSync {
  calls: Array<{ repo: RepoRef; window: TimeWindow }> = [];
  failWith: Error | null = null;
  dataAsOf = DATA_AS_OF;

  constructor(private readonly store: Store) {}

  async ensureSynced(repo: RepoRef, window: TimeWindow): Promise<SyncResult> {
    this.calls.push({ repo, window });
    await Promise.resolve();
    if (this.failWith) throw this.failWith;
    const record = this.store.getRepo(`${repo.owner}/${repo.name}`.toLowerCase());
    if (!record) throw new Error('test repo not seeded');
    return {
      repo: record,
      dataAsOf: this.dataAsOf,
      coverage: { partial: false, from: window.from.toISOString(), to: window.to.toISOString() },
    };
  }
}

export type Harness = {
  app: FastifyInstance;
  db: Database;
  store: Store;
  sync: FakeSync;
  reviewFlow: ReviewFlowService;
  /** The service clock; tests may move `clock.now` forward. */
  clock: { now: Date };
  logs: string[];
  close: () => Promise<void>;
};

/**
 * Builds the app over a `:memory:` store seeded with the small-repo fixture, capturing log lines. The narrative
 * route is backed by `narrativeModel` when given, otherwise it is not configured.
 */
export async function createHarness(opts: { webRoot?: string; narrativeModel?: NarrativeModel } = {}): Promise<Harness> {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const repo = store.upsertRepo({ key: 'fastify/fastify', owner: 'fastify', name: 'fastify', defaultBranch: 'main' });
  store.upsertPullRequests(repo.id, pullRequests, reviews);
  store.upsertCommits(repo.id, commits);

  const sync = new FakeSync(store);
  const clock = { now: AS_OF };
  const reviewFlow = new ReviewFlowService({ store, sync, now: () => clock.now });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger(testConfig, { level: 'debug' }, stream);
  const narrative = opts.narrativeModel
    ? new NarrativeService({ model: opts.narrativeModel, modelName: testConfig.anthropicModel, store, reviewFlow, logger })
    : null;
  const app = await buildApp({
    config: testConfig,
    store,
    reviewFlow,
    narrative,
    logger,
    webRoot: opts.webRoot,
  });
  return {
    app,
    db,
    store,
    sync,
    reviewFlow,
    clock,
    logs,
    close: async () => {
      await app.close();
      if (db.open) db.close();
    },
  };
}
