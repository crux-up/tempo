import type { Store } from '../db/store.js';
import type { RepoRef, ReviewFlowQuery, ReviewFlowReport, TimeWindow } from '../domain/types.js';
import { parseWindow } from '../domain/window.js';
import { computeReviewFlow } from '../metrics/reviewFlow.js';
import { coverageOf, repoKey, type SyncResult, type SyncService } from '../sync/syncService.js';

type ReviewFlowDeps = {
  store: Store;
  sync: Pick<SyncService, 'ensureSynced'>;
  now?: () => Date;
};

type WindowData = ReturnType<Store['loadWindowData']>;

const after = (iso: string | null, asOf: Date) => iso !== null && Date.parse(iso) > asOf.getTime();

/** Shows the data as it stood at `asOf`: later PRs and commits are dropped, later merges and closes undone. */
function snapshotAt(data: WindowData, asOf: Date): WindowData {
  return {
    pullRequests: data.pullRequests
      .filter((pr) => !after(pr.createdAt, asOf))
      .map((pr) => ({
        ...pr,
        mergedAt: after(pr.mergedAt, asOf) ? null : pr.mergedAt,
        closedAt: after(pr.closedAt, asOf) ? null : pr.closedAt,
      })),
    reviews: data.reviews,
    commits: data.commits.filter((c) => !after(c.committedAt, asOf)),
  };
}

export class ReviewFlowService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReviewFlowDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Syncs what the window needs, then computes metrics as of the data snapshot (`dataAsOf`, never after now).
   * Rows a sync stored after that instant are left out, so a report depends only on its `dataAsOf`.
   */
  async getReport(repo: RepoRef, query: ReviewFlowQuery): Promise<ReviewFlowReport> {
    const now = this.now();
    const window = parseWindow(query, now);
    const synced = await this.deps.sync.ensureSynced(repo, window);
    return this.build(synced, window, query, now);
  }

  /**
   * The same report from data already stored, with no sync: for a follow-up window right after `getReport` synced
   * the repo, so one request never pays for two sync budgets. Coverage is recomputed for this window.
   */
  getStoredReport(repo: RepoRef, query: ReviewFlowQuery): ReviewFlowReport {
    const now = this.now();
    const window = parseWindow(query, now);
    const record = this.deps.store.getRepo(repoKey(repo));
    if (!record?.syncedAt || !record.syncedFrom) throw new Error(`${repoKey(repo)} has not been synced`);
    const synced = { repo: record, dataAsOf: record.syncedAt, coverage: coverageOf(record, window) };
    return this.build(synced, window, query, now);
  }

  private build(synced: SyncResult, window: TimeWindow, query: ReviewFlowQuery, now: Date): ReviewFlowReport {
    const includeBots = query.includeBots === 'true';
    const snapshotMs = Date.parse(synced.dataAsOf);
    const asOf = Number.isNaN(snapshotMs) ? now : new Date(Math.min(now.getTime(), snapshotMs));
    const data = snapshotAt(this.deps.store.loadWindowData(synced.repo.id, window, asOf), asOf);
    const metrics = computeReviewFlow({ ...data, window, asOf, includeBots });
    return {
      repo: `${synced.repo.owner}/${synced.repo.name}`,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      dataAsOf: synced.dataAsOf,
      coverage: synced.coverage,
      includeBots,
      ...metrics,
    };
  }
}
