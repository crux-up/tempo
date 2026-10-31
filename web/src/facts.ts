import type { ReviewFlowReport } from './types';

/**
 * Fact ids as the server's fact sheet names them. Numbers on screen carry `data-fact` with these ids, so an evidence
 * chip in the narrative can point at the number it cites.
 */
export const FACT = {
  prsOpened: 'team.prsOpened',
  prsMerged: 'team.prsMerged',
  reviewsSubmitted: 'team.reviewsSubmitted',
  firstReviewMedian: 'team.timeToFirstReview.median',
  firstReviewP90: 'team.timeToFirstReview.p90',
  firstReviewSample: 'team.timeToFirstReview.sampleSize',
  awaitingCount: 'team.awaitingFirstReview.count',
  awaitingAge: 'team.awaitingFirstReview.medianAgeHours',
  mergeMedian: 'team.timeToMerge.median',
  mergeP90: 'team.timeToMerge.p90',
  mergeSample: 'team.timeToMerge.sampleSize',
  unreviewedCount: 'team.mergedWithoutReview.count',
  unreviewedShare: 'team.mergedWithoutReview.share',
  topReviewer: 'team.reviewConcentration.topReviewer',
  topReviewerShare: 'team.reviewConcentration.topReviewerShare',
  reviewersForHalf: 'team.reviewConcentration.reviewersFor50Pct',
  unlinkedCommits: 'team.unlinkedCommits',
  peopleCount: 'team.peopleCount',
  includeBots: 'meta.includeBots',
  coveragePartial: 'meta.coveragePartial',
  coverageFrom: 'meta.coverageFrom',
  coverageTo: 'meta.coverageTo',
} as const;

export const personFact = (login: string, field: string) => `person.${login}.${field}`;
export const personRow = (login: string) => `person.${login}`;
export const weekFact = (week: string, field: string) => `week.${week}.${field}`;
export const weekRow = (week: string) => `week.${week}`;

export type FactTarget =
  | { kind: 'team'; id: string }
  | { kind: 'person'; login: string; id: string }
  | { kind: 'week'; week: string; id: string };

/** Splits `person.<login>.<field>` and `week.<YYYY-Www>.<field>`; logins never contain dots. */
export function parseFact(id: string): FactTarget | null {
  const person = /^person\.([^.]+)\.[A-Za-z]+$/.exec(id);
  if (person?.[1]) return { kind: 'person', login: person[1], id };
  const week = /^week\.(\d{4}-W\d{2})\.[A-Za-z]+$/.exec(id);
  if (week?.[1]) return { kind: 'week', week: week[1], id };
  if (id.startsWith('team.') || id.startsWith('meta.')) return { kind: 'team', id };
  return null;
}

const TEAM_IDS = new Set<string>(Object.values(FACT));

/** Commits by git names with no linked account; the dashboard mentions them only when there are any. */
export const unlinkedCommits = (report: Pick<ReviewFlowReport, 'people'>) =>
  report.people.filter((p) => p.unlinked).reduce((sum, p) => sum + p.commits, 0);

/** Whether the dashboard shows the number behind a fact id for this report. */
export function factOnScreen(id: string, report: ReviewFlowReport): boolean {
  const target = parseFact(id);
  if (!target) return false;
  if (target.kind === 'person') return report.people.some((p) => !p.unlinked && p.login === target.login);
  if (target.kind === 'week') return report.weekly.some((w) => w.week === target.week);
  if (id === FACT.coveragePartial) return report.coverage.partial;
  if (id === FACT.coverageFrom) return report.coverage.partial && report.coverage.from > report.window.from;
  if (id === FACT.coverageTo) return report.coverage.partial && report.coverage.to < report.window.to;
  if (id === FACT.unlinkedCommits) return unlinkedCommits(report) > 0;
  if (id === FACT.topReviewer) return report.team.reviewConcentration.topReviewer !== null;
  return TEAM_IDS.has(id);
}

/** The element showing a fact: the exact number when it is on screen, else its person row or week column. */
export function findFactElement(target: FactTarget): Element | null {
  const exact = document.querySelector(`[data-fact="${CSS.escape(target.id)}"]`);
  if (exact) return exact;
  if (target.kind === 'person') return document.querySelector(`[data-fact-row="${CSS.escape(personRow(target.login))}"]`);
  if (target.kind === 'week') return document.querySelector(`[data-fact-row="${CSS.escape(weekRow(target.week))}"]`);
  return null;
}
