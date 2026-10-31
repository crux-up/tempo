import type { Store } from '../db/store.js';
import type { RepoRef, ReviewFlowQuery, ReviewFlowReport, TimeWindow } from '../domain/types.js';
import { DAY_MS, DEFAULT_WINDOW_DAYS, parseWindow } from '../domain/window.js';
import { BadRequestError } from '../errors.js';
import { computeReviewFlow } from '../metrics/reviewFlow.js';
import { coverageOf, type SyncResult, type SyncService } from '../sync/syncService.js';

type ReviewFlowDeps = {
  store: Store;
  sync: Pick<SyncService, 'ensureSynced'>;
  now?: () => Date;
};

type WindowData = ReturnType<Store['loadWindowData']>;

const DEFAULT_WINDOW_MS = DEFAULT_WINDOW_DAYS * DAY_MS;
const startOfUtcDay = (ms: number) => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);

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
   * A report over whole UTC days whose facts stay the same for a whole day, for results cached per fact sheet:
   * shifting a bound by seconds cannot make a new cache entry.
   *
   * An explicit `from` and an explicit `to` that the data reaches are floored to UTC midnight. An open-ended window
   * (no `to`, or `to` later than `dataAsOf`) ends at the latest UTC midnight at or before `dataAsOf` and is measured
   * at that instant, so ages of waiting PRs do not grow between syncs; an explicit window is measured at `dataAsOf`. A
   * defaulted `from` is the end minus 30 days; for an open-ended window, when that start falls before the synced data
   * while the synced range did cover the request, it is raised to the start of the synced data instead of flagging
   * the report partial (that start only moves when a backfill extends it). Exactly one sync runs per call. Throws
   * BadRequestError when the window holds no whole day.
   */
  async getDailyReport(repo: RepoRef, query: ReviewFlowQuery): Promise<ReviewFlowReport> {
    const now = this.now();
    const requested = parseWindow(query, now);
    const openRequest = requested.to.getTime() === now.getTime();
    const dayTo = startOfUtcDay(requested.to.getTime());
    // Sync from a midnight, so the start of the synced data does not creep back with every request of the day.
    let syncFrom = startOfUtcDay(requested.from.getTime());
    if (query.from === undefined) syncFrom = (openRequest ? startOfUtcDay(now.getTime()) : dayTo) - DEFAULT_WINDOW_MS;
    const synced = await this.deps.sync.ensureSynced(repo, { from: new Date(syncFrom), to: requested.to });

    const snapshot = Date.parse(synced.dataAsOf);
    if (Number.isNaN(snapshot)) return this.build(synced, requested, query, now);
    const openEnded = query.to === undefined || requested.to.getTime() > snapshot;
    const to = openEnded ? startOfUtcDay(snapshot) : dayTo;
    let from = syncFrom;
    if (query.from === undefined) {
      const defaultFrom = to - DEFAULT_WINDOW_MS;
      const syncedFrom = synced.repo.syncedFrom === null ? Number.NaN : Date.parse(synced.repo.syncedFrom);
      // Only the bottom edge matters here: a refresh cut short at the top does not make the start partial.
      const clamp = openEnded && !Number.isNaN(syncedFrom) && syncedFrom <= syncFrom;
      from = clamp ? Math.max(defaultFrom, syncedFrom) : defaultFrom;
    }
    if (from >= to) {
      throw new BadRequestError('A narrative covers whole UTC days: the window must contain at least one synced day');
    }
    const day = { from: new Date(from), to: new Date(to) };
    // An explicit window is measured at dataAsOf like any report, so its facts match the metrics endpoint.
    return this.build(synced, day, query, openEnded ? day.to : now);
  }

  /** Metrics for `window` measured at `dataAsOf`, or at `cap` when that is earlier. Coverage is for this window. */
  private build(synced: SyncResult, window: TimeWindow, query: ReviewFlowQuery, cap: Date): ReviewFlowReport {
    const includeBots = query.includeBots === 'true';
    const snapshotMs = Date.parse(synced.dataAsOf);
    const asOf = Number.isNaN(snapshotMs) ? cap : new Date(Math.min(cap.getTime(), snapshotMs));
    const data = snapshotAt(this.deps.store.loadWindowData(synced.repo.id, window, asOf), asOf);
    const metrics = computeReviewFlow({ ...data, window, asOf, includeBots });
    return {
      repo: `${synced.repo.owner}/${synced.repo.name}`,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      dataAsOf: synced.dataAsOf,
      coverage: coverageOf(synced.repo, window),
      includeBots,
      ...metrics,
    };
  }
}
