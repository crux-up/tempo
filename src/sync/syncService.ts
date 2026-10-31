import type { RepoRecord, Store } from '../db/store.js';
import type { RepoRef, TimeWindow } from '../domain/types.js';
import type { GitHubSource } from '../github/client.js';
import type { Logger } from '../logger.js';

export type Coverage = { partial: boolean; from: string; to: string };
export type SyncResult = { repo: RepoRecord; dataAsOf: string; coverage: Coverage };

type SyncDeps = {
  github: GitHubSource;
  store: Store;
  ttlMinutes: number;
  maxPages: number;
  maxSeconds: number;
  now?: () => Date;
  logger: Logger;
};

/** Shared page/time budget for one run; checked after each page, so each pass fetches at least one page. */
class Budget {
  private pages = 0;
  private readonly startedAt: number;

  constructor(
    private readonly maxPages: number,
    private readonly maxMs: number,
    private readonly now: () => Date,
  ) {
    this.startedAt = now().getTime();
  }

  /** Counts one fetched page and reports whether the budget is now spent. */
  spend(): boolean {
    this.pages++;
    return this.pages >= this.maxPages || this.now().getTime() - this.startedAt >= this.maxMs;
  }

  get pagesUsed(): number {
    return this.pages;
  }
}

const toIso = (ms: number) => new Date(ms).toISOString();
const toMs = (iso: string) => new Date(iso).getTime();

/**
 * Keeps the store in sync with GitHub on demand.
 *
 * Stored invariant: every PR with `updatedAt >= syncedFrom` and every commit with `committedAt` in
 * `[syncedFrom, syncedAt)` is stored. PRs are paged newest-updated first, so a pass always starts at "now" and
 * walks back to a boundary: `window.from` for a backfill (which also covers any refresh), else `syncedAt`.
 */
export class SyncService {
  private readonly inFlight = new Map<string, Promise<SyncResult>>();
  private readonly now: () => Date;

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  ensureSynced(repo: RepoRef, window: TimeWindow): Promise<SyncResult> {
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = this.sync(key, repo, window).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async sync(key: string, ref: RepoRef, window: TimeWindow): Promise<SyncResult> {
    const { github, store, logger } = this.deps;
    const startedAt = this.now().getTime();
    let repo = store.getRepo(key) ?? (await this.register(key, ref));

    const windowFrom = window.from.getTime();
    const oldFrom = repo.syncedFrom === null ? null : toMs(repo.syncedFrom);
    const oldAt = repo.syncedAt === null ? null : toMs(repo.syncedAt);
    const needBackfill = oldFrom === null || windowFrom < oldFrom;
    const needRefresh = oldAt !== null && startedAt - oldAt > this.deps.ttlMinutes * 60_000;

    if (needBackfill || needRefresh) {
      const budget = new Budget(this.deps.maxPages, this.deps.maxSeconds * 1000, this.now);
      const source = { owner: repo.owner, name: repo.name };

      // PR pass: one walk back from now to the older of the needed boundaries.
      const prTarget = needBackfill ? windowFrom : (oldAt as number);
      let prCovered = prTarget;
      let oldestPr = startedAt;
      for await (const page of github.pullRequestPages(source)) {
        store.upsertPullRequests(repo.id, page.pullRequests, page.reviews);
        if (page.oldestUpdatedAt !== null) oldestPr = Math.min(oldestPr, toMs(page.oldestUpdatedAt));
        const spent = budget.spend();
        if (oldestPr < prTarget) break;
        if (spent) {
          prCovered = oldestPr;
          break;
        }
      }

      // Commit pass: the union of the backfill and refresh ranges, cut at the point the PR pass reached.
      const reachesNow = needRefresh || oldFrom === null;
      const commitUntil = reachesNow ? startedAt : (oldFrom as number);
      const commitSince = Math.max(needBackfill ? windowFrom : (oldAt as number), prCovered);
      let commitCovered = commitSince;
      if (commitSince < commitUntil) {
        let oldestCommit = commitUntil;
        const pages = github.commitPages(source, repo.defaultBranch, toIso(commitSince), toIso(commitUntil));
        for await (const commits of pages) {
          store.upsertCommits(repo.id, commits);
          for (const c of commits) oldestCommit = Math.min(oldestCommit, toMs(c.committedAt));
          if (budget.spend()) {
            commitCovered = Math.max(commitSince, oldestCommit);
            break;
          }
        }
      }

      // Everything from `covered` up to the top of this run's range is now stored.
      const covered = Math.max(prCovered, commitCovered);
      // A run that ends above the old syncedAt leaves a gap below it, so neither marker may move: the next call
      // refreshes again. Otherwise syncedAt becomes this run's start, so PRs updated during the run are re-fetched.
      const contiguous = oldAt === null || covered <= oldAt;
      const syncedAt = reachesNow && contiguous ? startedAt : (oldAt as number);
      const syncedFrom = contiguous ? Math.min(oldFrom ?? covered, covered) : (oldFrom as number);
      store.markSynced(repo.id, { syncedFrom: toIso(syncedFrom), syncedAt: toIso(syncedAt) });
      repo = store.getRepo(key) as RepoRecord;

      const partialRun = covered > prTarget;
      const log = { repo: key, pages: budget.pagesUsed, syncedFrom: repo.syncedFrom, syncedAt: repo.syncedAt };
      if (partialRun) logger.warn(log, 'Sync budget reached; coverage is partial');
      else logger.debug(log, 'Sync completed');
    }

    return this.result(repo, window);
  }

  private async register(key: string, ref: RepoRef): Promise<RepoRecord> {
    const canonical = await this.deps.github.getRepository(ref);
    return this.deps.store.upsertRepo({ key, ...canonical });
  }

  private result(repo: RepoRecord, window: TimeWindow): SyncResult {
    const syncedFrom = toMs(repo.syncedFrom as string);
    const windowFrom = window.from.getTime();
    return {
      repo,
      dataAsOf: repo.syncedAt as string,
      coverage: {
        partial: syncedFrom > windowFrom,
        from: toIso(Math.max(windowFrom, syncedFrom)),
        to: window.to.toISOString(),
      },
    };
  }
}
