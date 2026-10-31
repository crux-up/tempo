import type {
  CommitRow,
  DurationStat,
  MetricsInput,
  PersonStats,
  PullRequestRow,
  ReviewFlowMetrics,
  ReviewRow,
  TeamStats,
  Totals,
  WeekStats,
} from '../domain/types.js';
import { inWindow } from '../domain/window.js';
import { hoursBetween, isoWeek, median, percentile, roundTo } from './stats.js';

const WEEK_MS = 7 * 86_400_000;

/** Rows after bot filtering, with qualifying reviews indexed by PR. */
type Prepared = {
  input: MetricsInput;
  prs: PullRequestRow[];
  reviewsByPr: Map<string, ReviewRow[]>;
  windowReviews: ReviewRow[];
  commits: CommitRow[];
};

type FirstReviewSample = { createdAt: string; hours: number };

type PersonAcc = { login: string; unlinked: boolean; counts: Totals; reviewedPrs: Set<string> };

const TOTAL_KEYS = [
  'commits',
  'prsOpened',
  'prsMerged',
  'linesChanged',
  'reviewsSubmitted',
  'prsReviewed',
  'approvals',
  'changesRequested',
  'reviewComments',
] as const satisfies readonly (keyof Totals)[];

const zeroTotals = (): Totals => ({
  commits: 0,
  prsOpened: 0,
  prsMerged: 0,
  linesChanged: 0,
  reviewsSubmitted: 0,
  prsReviewed: 0,
  approvals: 0,
  changesRequested: 0,
  reviewComments: 0,
});

const ms = (iso: string): number => Date.parse(iso);
const share = (part: number, whole: number): number => (whole === 0 ? 0 : roundTo(part / whole, 3)!);
const toHours = (value: number | null): number | null => roundTo(value, 1);

/**
 * A qualifying review is not by the PR author and, unless bots are included, not by a bot.
 * Reviews on bot-authored PRs still count when the reviewer qualifies.
 */
function prepare(input: MetricsInput): Prepared {
  const keep = (isBot: boolean) => input.includeBots || !isBot;
  const authorByPr = new Map(input.pullRequests.map((pr) => [pr.id, pr.author]));
  const qualifying = input.reviews
    .filter((r) => keep(r.reviewerIsBot))
    .filter((r) => authorByPr.has(r.pullRequestId) && authorByPr.get(r.pullRequestId) !== r.reviewer)
    .sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt));

  const reviewsByPr = new Map<string, ReviewRow[]>();
  for (const review of qualifying) {
    const list = reviewsByPr.get(review.pullRequestId) ?? [];
    list.push(review);
    reviewsByPr.set(review.pullRequestId, list);
  }

  return {
    input,
    prs: input.pullRequests.filter((pr) => keep(pr.authorIsBot)),
    reviewsByPr,
    windowReviews: qualifying.filter((r) => inWindow(r.submittedAt, input.window)),
    commits: input.commits.filter((c) => keep(c.authorIsBot) && inWindow(c.committedAt, input.window)),
  };
}

function durationStat(hours: number[]): DurationStat {
  return { medianHours: toHours(median(hours)), p90Hours: toHours(percentile(hours, 90)), sampleSize: hours.length };
}

function isOpenAt(pr: PullRequestRow, asOf: Date): boolean {
  const endedBy = (iso: string | null) => iso !== null && ms(iso) <= asOf.getTime();
  return !endedBy(pr.closedAt) && !endedBy(pr.mergedAt);
}

/** First qualifying review up to `asOf` for each PR opened in the window; the rest that are still open wait. */
function firstReviews(ctx: Prepared, opened: PullRequestRow[]) {
  const { asOf } = ctx.input;
  const samples: FirstReviewSample[] = [];
  const awaitingAges: number[] = [];
  for (const pr of opened) {
    const first = ctx.reviewsByPr.get(pr.id)?.[0];
    if (first && ms(first.submittedAt) <= asOf.getTime()) {
      samples.push({ createdAt: pr.createdAt, hours: hoursBetween(pr.createdAt, first.submittedAt) });
    } else if (isOpenAt(pr, asOf)) {
      awaitingAges.push(hoursBetween(pr.createdAt, asOf.toISOString()));
    }
  }
  return { samples, awaitingAges };
}

function reviewedBeforeMerge(ctx: Prepared, pr: PullRequestRow): boolean {
  const first = ctx.reviewsByPr.get(pr.id)?.[0];
  return first !== undefined && pr.mergedAt !== null && ms(first.submittedAt) < ms(pr.mergedAt);
}

// Unlinked commit authors are keyed apart from logins so a git name never merges into a GitHub account.
function personAcc(map: Map<string, PersonAcc>, login: string, unlinked = false): PersonAcc {
  const key = `${unlinked ? 'name' : 'login'}:${login}`;
  let acc = map.get(key);
  if (!acc) {
    acc = { login, unlinked, counts: zeroTotals(), reviewedPrs: new Set() };
    map.set(key, acc);
  }
  return acc;
}

function accumulatePeople(ctx: Prepared, opened: PullRequestRow[], merged: PullRequestRow[]): PersonAcc[] {
  const map = new Map<string, PersonAcc>();
  for (const commit of ctx.commits) {
    const unlinked = commit.authorLogin === null;
    personAcc(map, commit.authorLogin ?? commit.authorName, unlinked).counts.commits += 1;
  }
  for (const pr of opened) personAcc(map, pr.author).counts.prsOpened += 1;
  for (const pr of merged) {
    const { counts } = personAcc(map, pr.author);
    counts.prsMerged += 1;
    counts.linesChanged += pr.additions + pr.deletions;
  }
  for (const review of ctx.windowReviews) {
    const { counts, reviewedPrs } = personAcc(map, review.reviewer);
    reviewedPrs.add(review.pullRequestId);
    counts.reviewsSubmitted += 1;
    counts.approvals += review.state === 'APPROVED' ? 1 : 0;
    counts.changesRequested += review.state === 'CHANGES_REQUESTED' ? 1 : 0;
    counts.reviewComments += review.commentCount;
  }
  return [...map.values()];
}

// Ordinal (code unit) comparison keeps the order independent of the server locale.
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byReviewThenMergeThenLogin = (a: PersonStats, b: PersonStats): number =>
  b.prsReviewed - a.prsReviewed || b.prsMerged - a.prsMerged || ordinal(a.login, b.login);

function finalizePeople(accs: PersonAcc[], teamMerged: number): PersonStats[] {
  const withReviewed = accs.map((acc) => ({ ...acc, counts: { ...acc.counts, prsReviewed: acc.reviewedPrs.size } }));
  const reviewedTotal = withReviewed.reduce((sum, acc) => sum + acc.counts.prsReviewed, 0);
  return withReviewed
    .filter((acc) => TOTAL_KEYS.some((key) => acc.counts[key] !== 0))
    .map((acc) => ({
      login: acc.login,
      unlinked: acc.unlinked,
      ...acc.counts,
      reviewShare: share(acc.counts.prsReviewed, reviewedTotal),
      codeShare: share(acc.counts.prsMerged, teamMerged),
    }))
    .sort(byReviewThenMergeThenLogin);
}

function sumTotals(people: PersonStats[]): Totals {
  const totals = zeroTotals();
  for (const p of people) for (const key of TOTAL_KEYS) totals[key] += p[key];
  return totals;
}

/** Expects `people` sorted by prsReviewed descending. */
function reviewConcentration(people: PersonStats[]): TeamStats['reviewConcentration'] {
  const total = people.reduce((sum, p) => sum + p.prsReviewed, 0);
  const top = people[0];
  if (total === 0 || !top) return { topReviewer: null, topReviewerShare: null, reviewersFor50Pct: 0 };
  let covered = 0;
  let k = 0;
  while (covered * 2 < total) covered += people[k++]!.prsReviewed;
  return { topReviewer: top.login, topReviewerShare: share(top.prsReviewed, total), reviewersFor50Pct: k };
}

function weekly(ctx: Prepared, opened: PullRequestRow[], merged: PullRequestRow[], samples: FirstReviewSample[]) {
  const { window } = ctx.input;
  const buckets = new Map<string, { stats: WeekStats; hours: number[] }>();
  for (let t = ms(isoWeek(window.from).weekStart); t < window.to.getTime(); t += WEEK_MS) {
    const { week, weekStart } = isoWeek(new Date(t));
    const stats: WeekStats = {
      week,
      weekStart,
      prsOpened: 0,
      prsMerged: 0,
      reviewsSubmitted: 0,
      medianFirstReviewHours: null,
      firstReviewSample: 0,
    };
    buckets.set(week, { stats, hours: [] });
  }
  const bucket = (iso: string) => {
    const found = buckets.get(isoWeek(new Date(iso)).week);
    if (!found) throw new Error(`Timestamp ${iso} falls outside the metrics window`);
    return found;
  };

  for (const pr of opened) bucket(pr.createdAt).stats.prsOpened += 1;
  for (const pr of merged) bucket(pr.mergedAt!).stats.prsMerged += 1;
  for (const review of ctx.windowReviews) bucket(review.submittedAt).stats.reviewsSubmitted += 1;
  for (const sample of samples) bucket(sample.createdAt).hours.push(sample.hours);

  return [...buckets.values()].map(({ stats, hours }) => ({
    ...stats,
    medianFirstReviewHours: toHours(median(hours)),
    firstReviewSample: hours.length,
  }));
}

export function computeReviewFlow(input: MetricsInput): ReviewFlowMetrics {
  const ctx = prepare(input);
  const opened = ctx.prs.filter((pr) => inWindow(pr.createdAt, input.window));
  const merged = ctx.prs.filter((pr) => inWindow(pr.mergedAt, input.window));
  const { samples, awaitingAges } = firstReviews(ctx, opened);
  const unreviewedMerges = merged.filter((pr) => !reviewedBeforeMerge(ctx, pr)).length;
  const people = finalizePeople(accumulatePeople(ctx, opened, merged), merged.length);

  const team: TeamStats = {
    prsOpened: opened.length,
    prsMerged: merged.length,
    reviewsSubmitted: ctx.windowReviews.length,
    timeToFirstReview: durationStat(samples.map((s) => s.hours)),
    awaitingFirstReview: { count: awaitingAges.length, medianAgeHours: toHours(median(awaitingAges)) },
    timeToMerge: durationStat(merged.map((pr) => hoursBetween(pr.createdAt, pr.mergedAt!))),
    mergedWithoutReview: {
      count: unreviewedMerges,
      share: merged.length === 0 ? null : share(unreviewedMerges, merged.length),
    },
    reviewConcentration: reviewConcentration(people),
  };

  return { team, people, totals: sumTotals(people), weekly: weekly(ctx, opened, merged, samples) };
}
