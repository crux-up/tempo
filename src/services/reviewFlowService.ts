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

export class ReviewFlowService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReviewFlowDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Syncs what the window needs, then computes metrics from the store. Metrics are observed at request time
   * (`asOf` = now), so every stored row is visible and ages are never negative; `dataAsOf` says how fresh the
   * stored data is.
   */
  async getReport(repo: RepoRef, query: ReviewFlowQuery): Promise<ReviewFlowReport> {
    const now = this.now();
    const window = parseWindow(query, now);
    const includeBots = query.includeBots === 'true';
    const synced = await this.deps.sync.ensureSynced(repo, window);
    const data = this.deps.store.loadWindowData(synced.repo.id, window, now);
    const metrics = computeReviewFlow({ ...data, window, asOf: now, includeBots });
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
