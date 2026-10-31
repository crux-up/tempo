import { createHash } from 'node:crypto';
import type { Store } from '../db/store.js';
import type { Coverage, NarrativeQuery, RepoRef, ReviewFlowQuery, ReviewFlowReport } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { ReviewFlowService } from '../services/reviewFlowService.js';
import { repoKey } from '../sync/syncService.js';
import { buildFactSheet, type FactSheet } from './factSheet.js';
import type { NarrativeModel, TokenUsage } from './llmClient.js';
import { PROMPT_VERSION } from './prompt.js';
import { NarrativeResponseSchema } from './response.js';
import { VERIFIER_VERSION, verifyNarrative, type Narrative } from './verify.js';

export type NarrativeResponse = Narrative & {
  repo: string;
  window: { from: string; to: string };
  dataAsOf: string;
  coverage: Coverage;
  model: string;
  promptVersion: string;
  cached: boolean;
  generatedAt: string;
};

type NarrativeDeps = {
  model: NarrativeModel;
  modelName: string;
  store: Store;
  reviewFlow: Pick<ReviewFlowService, 'getReport' | 'getStoredReport'>;
  logger: Logger;
};

type StoredBody = Omit<NarrativeResponse, 'cached'>;

const StoredBodySchema = NarrativeResponseSchema.omit({ cached: true });

/** Reported as the model of a narrative that no model wrote. */
const NO_MODEL = 'none';

/** The default window length, as in `parseWindow`. */
const DEFAULT_WINDOW_MS = 30 * 86_400_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** JSON with object keys sorted at every level, so equal sheets hash equally whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hasActivity = (report: ReviewFlowReport) =>
  report.team.prsOpened + report.team.prsMerged + report.team.reviewsSubmitted > 0;

const reportContext = (report: ReviewFlowReport) => ({
  repo: report.repo,
  window: report.window,
  dataAsOf: report.dataAsOf,
  coverage: report.coverage,
});

/**
 * Turns a review-flow report into a verified narrative. Narratives are cached by everything that shapes the output:
 * repo, window, bot setting, the fact sheet's content, prompt version, verifier version and model name.
 * Concurrent requests for the same key share one model call.
 */
export class NarrativeService {
  private readonly inFlight = new Map<string, Promise<StoredBody>>();

  constructor(private readonly deps: NarrativeDeps) {}

  async getNarrative(repo: RepoRef, query: NarrativeQuery): Promise<NarrativeResponse> {
    const startedAt = performance.now();
    const { refresh, ...reportQuery } = query;
    const report = await this.snappedReport(repo, reportQuery);
    if (!hasActivity(report)) return this.emptyNarrative(report);

    const sheet = buildFactSheet(report);
    const key = this.cacheKey(report, sheet);
    if (refresh !== 'true') {
      const body = this.readCache(key, report);
      if (body) {
        this.logServed(report, 'hit', startedAt, body, null);
        // The sheet is part of the key, so the facts are unchanged; report the current sync time and coverage.
        return { ...body, ...reportContext(report), cached: true };
      }
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.generate(key, report, sheet, startedAt).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return { ...(await pending), cached: false };
  }

  /**
   * The report for the request, with an open-ended `to` (absent, or later than the data snapshot) snapped to the
   * snapshot time `dataAsOf`, and a defaulted `from` kept 30 days before it. Requests between syncs then resolve to
   * the same window and share a cache entry. The second report is built from the data the first one just synced,
   * without another sync, so a request spends at most one sync budget.
   *
   * Moving a defaulted window back by (now - dataAsOf) can start it just before the synced data, which would flag a
   * fully synced request as partial. When the first report was fully covered, the snapped `from` is therefore
   * clamped to the start of the synced data; that start only moves when a backfill extends it, so the window stays
   * stable between syncs.
   */
  private async snappedReport(repo: RepoRef, query: ReviewFlowQuery): Promise<ReviewFlowReport> {
    const report = await this.deps.reviewFlow.getReport(repo, query);
    const snapshot = Date.parse(report.dataAsOf);
    const openEnded = query.to === undefined || Date.parse(report.window.to) > snapshot;
    if (!openEnded || Number.isNaN(snapshot) || report.window.to === report.dataAsOf) return report;

    let from = query.from;
    if (from === undefined) {
      const syncedFrom = this.deps.store.getRepo(repoKey(repo))?.syncedFrom;
      const defaultFrom = snapshot - DEFAULT_WINDOW_MS;
      const clampTo = !report.coverage.partial && syncedFrom ? Date.parse(syncedFrom) : defaultFrom;
      const start = Math.max(defaultFrom, clampTo);
      from = new Date(start).toISOString();
    }
    if (Date.parse(from) >= snapshot) return report;
    return this.deps.reviewFlow.getStoredReport(repo, { ...query, from, to: report.dataAsOf });
  }

  /** The cached body for `key`, or null when absent or no longer valid for the response schema. */
  private readCache(key: string, report: ReviewFlowReport): StoredBody | null {
    const stored = this.deps.store.getNarrative(key);
    if (!stored) return null;
    const parsed = StoredBodySchema.safeParse(stored.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.length;
      this.deps.logger.warn({ repo: report.repo, issues }, 'Cached narrative failed validation');
      return null;
    }
    return parsed.data;
  }

  private cacheKey(report: ReviewFlowReport, sheet: FactSheet): string {
    return sha256(
      [
        report.repo.toLowerCase(),
        report.window.from,
        report.window.to,
        String(report.includeBots),
        sha256(stableJson(sheet)),
        PROMPT_VERSION,
        VERIFIER_VERSION,
        this.deps.modelName,
      ].join('|'),
    );
  }

  private async generate(key: string, report: ReviewFlowReport, sheet: FactSheet, startedAt: number) {
    const result = await this.deps.model.draft(sheet);
    const narrative = verifyNarrative(result.draft, sheet);
    const body: StoredBody = {
      ...narrative,
      ...reportContext(report),
      model: result.model,
      promptVersion: PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
    };
    this.deps.store.saveNarrative(key, body, { model: result.model, promptVersion: PROMPT_VERSION });
    this.logServed(report, 'miss', startedAt, body, result.usage);
    return body;
  }

  private emptyNarrative(report: ReviewFlowReport): NarrativeResponse {
    return {
      summary: 'No pull request activity in this window.',
      findings: [],
      hypothesis: null,
      caveats: [],
      verification: { droppedFindings: 0, droppedEvidenceIds: [], confidenceCapped: null },
      ...reportContext(report),
      model: NO_MODEL,
      promptVersion: PROMPT_VERSION,
      cached: false,
      generatedAt: new Date().toISOString(),
    };
  }

  private logServed(
    report: ReviewFlowReport,
    cache: 'hit' | 'miss',
    startedAt: number,
    body: StoredBody,
    usage: TokenUsage | null,
  ): void {
    this.deps.logger.info(
      {
        repo: report.repo,
        cache,
        model: body.model,
        promptVersion: body.promptVersion,
        latencyMs: Math.round(performance.now() - startedAt),
        ...(usage ?? {}),
        findings: body.findings.length,
        droppedFindings: body.verification.droppedFindings,
        droppedEvidenceIds: body.verification.droppedEvidenceIds.length,
        confidenceCapped: body.verification.confidenceCapped !== null,
      },
      'Narrative served',
    );
  }
}
