import type { Store } from '../db/store.js';
import type { RepoRef, ReviewFlowMetrics } from '../domain/types.js';
import { parseWindow } from '../domain/window.js';
import type { ReviewFlowQuery } from '../http/params.js';
import { computeReviewFlow } from '../metrics/reviewFlow.js';
import type { Coverage, SyncService } from '../sync/syncService.js';

export type ReviewFlowReport = ReviewFlowMetrics & {
  repo: string;
  window: { from: string; to: string };
  dataAsOf: string;
  coverage: Coverage;
  includeBots: boolean;
};

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
    const includeBots = query.includeBots === 'true';
    const synced = await this.deps.sync.ensureSynced(repo, window);
    const asOf = new Date(Math.min(now.getTime(), Date.parse(synced.dataAsOf)));
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
