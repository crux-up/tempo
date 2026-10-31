import type { PersonStats, TeamStats, WeekStats } from '../domain/types.js';
import type { ReviewFlowReport } from '../services/reviewFlowService.js';

export type Fact = {
  id: string;
  label: string;
  value: number | string | null;
  /** `datetime` values are ISO-8601 UTC instants. Yes/no context facts use `count` with the value 0 or 1. */
  unit: 'count' | 'hours' | 'share' | 'login' | 'week' | 'datetime';
  sampleSize?: number;
};
export type Signal = { id: string; description: string; factIds: string[] };
export type FactSheet = { repo: string; window: { from: string; to: string }; facts: Fact[]; signals: Signal[] };

/** GitHub login shape. Anything else is withheld from the sheet so free text cannot reach the prompt. */
const LOGIN = /^[A-Za-z0-9-]+(\[bot\])?$/;
const TOP_N = 10;
const MIN_WEEK_SAMPLE = 3;

const isLogin = (login: string | null): login is string => login !== null && LOGIN.test(login);

type PersonField = Exclude<keyof PersonStats, 'login' | 'unlinked'>;

const PERSON_FIELDS: { field: PersonField; label: string; unit: Fact['unit'] }[] = [
  { field: 'prsOpened', label: 'PRs opened', unit: 'count' },
  { field: 'prsMerged', label: 'PRs merged', unit: 'count' },
  { field: 'linesChanged', label: 'lines added plus deleted in merged PRs', unit: 'count' },
  { field: 'reviewsSubmitted', label: 'reviews submitted', unit: 'count' },
  { field: 'prsReviewed', label: 'PRs reviewed', unit: 'count' },
  { field: 'approvals', label: 'approvals', unit: 'count' },
  { field: 'changesRequested', label: 'changes requested', unit: 'count' },
  { field: 'reviewComments', label: 'review comments', unit: 'count' },
  { field: 'reviewShare', label: 'share of PR reviews, counted once per reviewer per PR (fraction 0-1)', unit: 'share' },
  { field: 'codeShare', label: "share of the team's merged PRs (fraction 0-1)", unit: 'share' },
  { field: 'commits', label: 'commits', unit: 'count' },
];

const ids = {
  topReviewer: 'team.reviewConcentration.topReviewer',
  topReviewerShare: 'team.reviewConcentration.topReviewerShare',
  person: (login: string, field: PersonField) => `person.${login}.${field}`,
  weekMedian: (week: string) => `week.${week}.medianFirstReviewHours`,
};

const formatHours = (hours: number) => String(Number(hours.toFixed(1)));
const formatShare = (share: number) => `${Math.round(share * 100)}%`;

function teamFacts(team: TeamStats, people: PersonStats[]): Fact[] {
  const ttfr = team.timeToFirstReview;
  const ttm = team.timeToMerge;
  const awaiting = team.awaitingFirstReview;
  const concentration = team.reviewConcentration;
  const unlinkedCommits = people.filter((p) => p.unlinked).reduce((sum, p) => sum + p.commits, 0);
  return [
    { id: 'team.prsOpened', label: 'PRs opened', value: team.prsOpened, unit: 'count' },
    { id: 'team.prsMerged', label: 'PRs merged', value: team.prsMerged, unit: 'count' },
    { id: 'team.reviewsSubmitted', label: 'Reviews submitted', value: team.reviewsSubmitted, unit: 'count' },
    {
      id: 'team.timeToFirstReview.median',
      label: 'Median hours to first review',
      value: ttfr.medianHours,
      unit: 'hours',
      sampleSize: ttfr.sampleSize,
    },
    {
      id: 'team.timeToFirstReview.p90',
      label: '90th percentile hours to first review',
      value: ttfr.p90Hours,
      unit: 'hours',
      sampleSize: ttfr.sampleSize,
    },
    {
      id: 'team.timeToFirstReview.sampleSize',
      label: 'PRs with a measured time to first review',
      value: ttfr.sampleSize,
      unit: 'count',
    },
    {
      id: 'team.awaitingFirstReview.count',
      label: 'Open PRs awaiting a first review',
      value: awaiting.count,
      unit: 'count',
    },
    {
      id: 'team.awaitingFirstReview.medianAgeHours',
      label: 'Median age in hours of PRs awaiting a first review',
      value: awaiting.medianAgeHours,
      unit: 'hours',
      sampleSize: awaiting.count,
    },
    {
      id: 'team.timeToMerge.median',
      label: 'Median hours to merge',
      value: ttm.medianHours,
      unit: 'hours',
      sampleSize: ttm.sampleSize,
    },
    {
      id: 'team.timeToMerge.p90',
      label: '90th percentile hours to merge',
      value: ttm.p90Hours,
      unit: 'hours',
      sampleSize: ttm.sampleSize,
    },
    { id: 'team.timeToMerge.sampleSize', label: 'PRs with a measured time to merge', value: ttm.sampleSize, unit: 'count' },
    {
      id: 'team.mergedWithoutReview.count',
      label: 'PRs merged without a review',
      value: team.mergedWithoutReview.count,
      unit: 'count',
    },
    {
      id: 'team.mergedWithoutReview.share',
      label: 'Share of merged PRs merged without a review (fraction 0-1)',
      value: team.mergedWithoutReview.share,
      unit: 'share',
    },
    {
      id: ids.topReviewer,
      label: 'Top reviewer by PRs reviewed',
      value: isLogin(concentration.topReviewer) ? concentration.topReviewer : null,
      unit: 'login',
    },
    {
      id: ids.topReviewerShare,
      label: "Top reviewer's share of PR reviews, counted once per reviewer per PR (fraction 0-1)",
      value: concentration.topReviewerShare,
      unit: 'share',
    },
    {
      id: 'team.reviewConcentration.reviewersFor50Pct',
      label: 'Fewest reviewers covering half of PR reviews (counted per reviewer per PR)',
      value: concentration.reviewersFor50Pct,
      unit: 'count',
    },
    {
      id: 'team.unlinkedCommits',
      label: 'Commits by authors without a linked GitHub account',
      value: unlinkedCommits,
      unit: 'count',
    },
    {
      id: 'team.peopleCount',
      label: 'People with a linked GitHub account active in the window',
      value: people.filter((p) => !p.unlinked).length,
      unit: 'count',
    },
  ];
}

/** How the report was built: bot setting and sync coverage, so the model need not assume either. */
function metaFacts(report: ReviewFlowReport): Fact[] {
  const facts: Fact[] = [
    {
      id: 'meta.includeBots',
      label: 'Bot accounts are counted as people (1 = yes, 0 = no)',
      value: report.includeBots ? 1 : 0,
      unit: 'count',
    },
    {
      id: 'meta.coveragePartial',
      label: 'Synced data covers only part of the window (1 = yes, 0 = no)',
      value: report.coverage.partial ? 1 : 0,
      unit: 'count',
    },
  ];
  if (report.coverage.partial) {
    facts.push({
      id: 'meta.coverageFrom',
      label: 'Start of the synced data; the window before this instant is missing',
      value: report.coverage.from,
      unit: 'datetime',
    });
  }
  return facts;
}

const topBy = (people: PersonStats[], field: PersonField) =>
  [...people]
    .sort((a, b) => b[field] - a[field] || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0))
    .slice(0, TOP_N);

/** Linked people with GitHub-shaped logins: top N by PRs reviewed plus top N by PRs merged, in report order. */
function selectPeople(people: PersonStats[]): PersonStats[] {
  const eligible = people.filter((p) => !p.unlinked && isLogin(p.login));
  const chosen = new Set([...topBy(eligible, 'prsReviewed'), ...topBy(eligible, 'prsMerged')]);
  return eligible.filter((p) => chosen.has(p));
}

const personFacts = (person: PersonStats): Fact[] =>
  PERSON_FIELDS.map(({ field, label, unit }) => ({
    id: ids.person(person.login, field),
    label: `${person.login}: ${label}`,
    value: person[field],
    unit,
  }));

const weekFacts = (week: WeekStats): Fact[] => [
  { id: `week.${week.week}.prsOpened`, label: `${week.week}: PRs opened`, value: week.prsOpened, unit: 'count' },
  { id: `week.${week.week}.prsMerged`, label: `${week.week}: PRs merged`, value: week.prsMerged, unit: 'count' },
  {
    id: `week.${week.week}.reviewsSubmitted`,
    label: `${week.week}: reviews submitted`,
    value: week.reviewsSubmitted,
    unit: 'count',
  },
  {
    id: ids.weekMedian(week.week),
    label: `${week.week}: median hours to first review`,
    value: week.medianFirstReviewHours,
    unit: 'hours',
    sampleSize: week.firstReviewSample,
  },
];

function firstReviewWeekChange(weekly: WeekStats[]): Signal | null {
  let best: { prev: WeekStats; next: WeekStats; prevHours: number; nextHours: number } | null = null;
  for (let i = 1; i < weekly.length; i++) {
    const prev = weekly[i - 1];
    const next = weekly[i];
    if (!prev || !next || prev.firstReviewSample < MIN_WEEK_SAMPLE || next.firstReviewSample < MIN_WEEK_SAMPLE) continue;
    const prevHours = prev.medianFirstReviewHours;
    const nextHours = next.medianFirstReviewHours;
    if (prevHours === null || nextHours === null || prevHours === nextHours) continue;
    if (!best || Math.abs(nextHours - prevHours) > Math.abs(best.nextHours - best.prevHours)) {
      best = { prev, next, prevHours, nextHours };
    }
  }
  if (!best) return null;
  return {
    id: 'signal.firstReviewWeekChange',
    description:
      `Median hours to first review went from ${formatHours(best.prevHours)} h in ${best.prev.week} ` +
      `to ${formatHours(best.nextHours)} h in ${best.next.week}.`,
    factIds: [ids.weekMedian(best.prev.week), ids.weekMedian(best.next.week)],
  };
}

/** The single person with the most PRs merged, or null when nobody merged or the lead is tied. */
function topMerger(people: PersonStats[]): PersonStats | null {
  const [first, second] = topBy(people, 'prsMerged');
  if (!first || first.prsMerged === 0 || (second && second.prsMerged === first.prsMerged)) return null;
  return first;
}

function buildSignals(report: ReviewFlowReport, people: PersonStats[]): Signal[] {
  const { team } = report;
  const signals: Signal[] = [];
  const weekChange = firstReviewWeekChange(report.weekly);
  if (weekChange) signals.push(weekChange);

  const { topReviewer, topReviewerShare } = team.reviewConcentration;
  if (isLogin(topReviewer) && topReviewerShare !== null && topReviewerShare >= 0.4) {
    signals.push({
      id: 'signal.reviewConcentration',
      description: `${topReviewer} accounts for ${formatShare(topReviewerShare)} of PRs reviewed, counted per reviewer.`,
      factIds: [ids.topReviewer, ids.topReviewerShare],
    });
  }

  const merger = topMerger(people);
  if (isLogin(topReviewer) && merger?.login === topReviewer) {
    signals.push({
      id: 'signal.topReviewerIsTopMerger',
      description:
        `${merger.login} is both the top reviewer (${merger.prsReviewed} PRs reviewed) ` +
        `and the top merger (${merger.prsMerged} PRs merged).`,
      factIds: [ids.topReviewer, ids.person(merger.login, 'prsReviewed'), ids.person(merger.login, 'prsMerged')],
    });
  }

  const unreviewed = team.mergedWithoutReview;
  if (unreviewed.share !== null && unreviewed.share >= 0.25) {
    signals.push({
      id: 'signal.mergedWithoutReview',
      description:
        `${unreviewed.count} of ${team.prsMerged} merged PRs (${formatShare(unreviewed.share)}) ` +
        'were merged without a review.',
      factIds: ['team.mergedWithoutReview.count', 'team.mergedWithoutReview.share', 'team.prsMerged'],
    });
  }

  const awaiting = team.awaitingFirstReview;
  if (awaiting.count >= 5) {
    const age = awaiting.medianAgeHours === null ? '' : ` (median age ${formatHours(awaiting.medianAgeHours)} h)`;
    signals.push({
      id: 'signal.awaitingBacklog',
      description: `${awaiting.count} open PRs await a first review${age}.`,
      factIds: ['team.awaitingFirstReview.count', 'team.awaitingFirstReview.medianAgeHours'],
    });
  }
  return signals;
}

/**
 * Flattens a report into numbered-by-id facts plus deterministic signals. Only numbers, fixed labels, ISO week
 * names, ISO instants and GitHub-shaped logins appear; unlinked commit authors are counted, never named.
 */
export function buildFactSheet(report: ReviewFlowReport): FactSheet {
  const people = selectPeople(report.people);
  return {
    repo: report.repo,
    window: report.window,
    facts: [
      ...metaFacts(report),
      ...teamFacts(report.team, report.people),
      ...people.flatMap(personFacts),
      ...report.weekly.flatMap(weekFacts),
    ],
    signals: buildSignals(report, people),
  };
}
