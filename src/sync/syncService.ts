import type { RepoRecord, Store } from '../db/store.js';
import type { Coverage, RepoRef, TimeWindow } from '../domain/types.js';
import type { GitHubSource } from '../github/client.js';
import type { Logger } from '../logger.js';

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

/** `covered`: everything from this instant up to the top of the pass's range is stored. */
type PassResult = { covered: number; stopped: boolean };

const SECOND_MS = 1000;

/** Shared page/time budget for one run; checked after each page, so each pass fetches at least one page. */
class Budget {
  private pages = 0;
  readonly startedAt: number;

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

/** Store key of a repository: `owner/name`, lowercased. */
export const repoKey = (repo: RepoRef) => `${repo.owner}/${repo.name}`.toLowerCase();

/** The part of `window` backed by stored data, for a repo that has been synced at least once. */
export function coverageOf(repo: RepoRecord, window: TimeWindow): Coverage {
  const syncedFrom = toMs(repo.syncedFrom as string);
  const windowFrom = window.from.getTime();
  const windowTo = window.to.getTime();
  return {
    partial: syncedFrom > windowFrom,
    from: toIso(Math.min(Math.max(windowFrom, syncedFrom), windowTo)),
    to: toIso(windowTo),
  };
}

/**
 * Keeps the store in sync with GitHub on demand.
 *
 * Stored invariant: every PR with `updatedAt >= syncedFrom` and every commit with `committedAt` in
 * `[syncedFrom, syncedAt)` is stored. PRs are paged newest-updated first. A refresh walks from the newest page back
 * to `syncedAt`. A backfill walks back to `window.from`, starting after `backfillCursor` when an earlier backfill was
 * cut short, otherwise from the newest page (which then also covers any refresh).
 */
export class SyncService {
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly now: () => Date;

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Concurrent callers share the running sync, then each one checks its own window and syncs again if needed. */
  async ensureSynced(repo: RepoRef, window: TimeWindow): Promise<SyncResult> {
    const key = repoKey(repo);
    for (;;) {
      const pending = this.inFlight.get(key);
      if (pending) {
        const budgetHit = await pending;
        const record = this.deps.store.getRepo(key) as RepoRecord;
        if (budgetHit || !this.needsWork(record, window)) return this.result(record, window);
        continue;
      }
      const run = this.run(key, repo, window).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, run);
      await run;
      return this.result(this.deps.store.getRepo(key) as RepoRecord, window);
    }
  }

  private plan(repo: RepoRecord, window: TimeWindow, at: number) {
    const needBackfill = repo.syncedFrom === null || window.from.getTime() < toMs(repo.syncedFrom);
    const needRefresh = repo.syncedAt !== null && at - toMs(repo.syncedAt) > this.deps.ttlMinutes * 60_000;
    return { needBackfill, needRefresh };
  }

  private needsWork(repo: RepoRecord, window: TimeWindow): boolean {
    const { needBackfill, needRefresh } = this.plan(repo, window, this.now().getTime());
    return needBackfill || needRefresh;
  }

  /** Syncs what `window` needs and reports whether the budget cut any pass short. */
  private async run(key: string, ref: RepoRef, window: TimeWindow): Promise<boolean> {
    const { store, logger } = this.deps;
    const budget = new Budget(this.deps.maxPages, this.deps.maxSeconds * 1000, this.now);
    const startedAt = budget.startedAt;
    const repo = store.getRepo(key) ?? (await this.register(key, ref));
    const { needBackfill, needRefresh } = this.plan(repo, window, startedAt);
    if (!needBackfill && !needRefresh) return false;

    const windowFrom = window.from.getTime();
    const oldFrom = repo.syncedFrom === null ? null : toMs(repo.syncedFrom);
    const oldAt = repo.syncedAt === null ? null : toMs(repo.syncedAt);
    // The top range runs from the old syncedAt (or window.from on the first sync) up to now.
    const topNeeded = needRefresh || oldAt === null;
    const topTarget = oldAt ?? windowFrom;

    let topPr: PassResult = { covered: startedAt, stopped: false };
    let backfill: (PassResult & { lastCursor: string | null }) | null = null;
    if (needBackfill && repo.backfillCursor === null) {
      backfill = await this.prPass(repo, windowFrom, budget);
      topPr = backfill;
    } else {
      // A refresh cut short above the old syncedAt leaves the markers as they were, so the next call refreshes
      // again. It stays stuck only if more than maxPages pages of PRs were updated within one TTL gap.
      if (needRefresh) topPr = await this.prPass(repo, topTarget, budget);
      if (needBackfill) backfill = await this.prPass(repo, windowFrom, budget, repo.backfillCursor ?? undefined);
    }

    const passes: PassResult[] = [topPr];
    let topCovered = topPr.covered;
    if (topNeeded) {
      const commits = await this.commitPass(repo, Math.max(topTarget, topPr.covered), startedAt, budget);
      passes.push(commits);
      topCovered = commits.covered;
    }
    let bottomCovered = oldFrom;
    if (backfill && oldFrom !== null) {
      passes.push(backfill);
      const commits = await this.commitPass(repo, Math.max(windowFrom, backfill.covered), oldFrom, budget);
      passes.push(commits);
      bottomCovered = Math.min(oldFrom, commits.covered);
    }

    // A top range that ends above the old syncedAt leaves a gap below it, so syncedAt may not move. Otherwise
    // syncedAt becomes this run's start, so PRs updated during the run are fetched again next time.
    const topContiguous = oldAt === null || topCovered <= oldAt;
    const syncedAt = topNeeded && topContiguous ? startedAt : (oldAt as number);
    const syncedFrom = oldFrom === null ? topCovered : (bottomCovered as number);
    // A finished backfill clears the cursor, unless the commit pass fell short and the backfill must run again.
    let backfillCursor = repo.backfillCursor;
    if (backfill) backfillCursor = backfill.stopped || syncedFrom > windowFrom ? backfill.lastCursor : null;
    store.markSynced(repo.id, { syncedFrom: toIso(syncedFrom), syncedAt: toIso(syncedAt), backfillCursor });

    const budgetHit = passes.some((p) => p.stopped);
    const log = { repo: key, pages: budget.pagesUsed, syncedFrom: toIso(syncedFrom), syncedAt: toIso(syncedAt) };
    if (budgetHit) logger.warn(log, 'Sync budget reached; coverage is partial');
    else logger.debug(log, 'Sync completed');
    return budgetHit;
  }

  /** Walks PR pages back to `target`, upserting each page as it arrives. */
  private async prPass(repo: RepoRecord, target: number, budget: Budget, after?: string) {
    const { github, store } = this.deps;
    const source = { owner: repo.owner, name: repo.name };
    let oldest = budget.startedAt;
    let lastCursor: string | null = null;
    for await (const page of github.pullRequestPages(source, after === undefined ? undefined : { after })) {
      store.upsertPullRequests(repo.id, page.pullRequests, page.reviews);
      lastCursor = page.endCursor;
      if (page.oldestUpdatedAt !== null) oldest = Math.min(oldest, toMs(page.oldestUpdatedAt));
      const spent = budget.spend();
      if (oldest < target || page.endCursor === null) break;
      // The next page may hold PRs updated in the same second as the oldest one reached, so that second is not claimed.
      if (spent) return { covered: oldest + SECOND_MS, stopped: true, lastCursor };
    }
    return { covered: target, stopped: false, lastCursor };
  }

  /** Fetches commits in `[since, until)`, upserting each page as it arrives. */
  private async commitPass(repo: RepoRecord, since: number, until: number, budget: Budget): Promise<PassResult> {
    if (since >= until) return { covered: since, stopped: false };
    const { github, store } = this.deps;
    const source = { owner: repo.owner, name: repo.name };
    let oldest = until;
    for await (const commits of github.commitPages(source, repo.defaultBranch, toIso(since), toIso(until))) {
      store.upsertCommits(repo.id, commits);
      for (const c of commits) oldest = Math.min(oldest, toMs(c.committedAt));
      const spent = budget.spend();
      if (commits.length === 0) break;
      // Assumes history pages are newest-first by commit date; the oldest second reached may continue on the next page.
      if (spent) return { covered: Math.max(since, oldest + SECOND_MS), stopped: true };
    }
    return { covered: since, stopped: false };
  }

  private async register(key: string, ref: RepoRef): Promise<RepoRecord> {
    const canonical = await this.deps.github.getRepository(ref);
    return this.deps.store.upsertRepo({ key, ...canonical });
  }

  private result(repo: RepoRecord, window: TimeWindow): SyncResult {
    return { repo, dataAsOf: repo.syncedAt as string, coverage: coverageOf(repo, window) };
  }
}
