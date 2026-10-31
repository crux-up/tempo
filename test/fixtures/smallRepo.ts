import type { CommitRow, MetricsInput, PullRequestRow, ReviewRow } from '../../src/domain/types.js';

/*
 * Hand-computed expectations. Window [2026-03-02, 2026-03-16) UTC, asOf 2026-03-20T00:00Z.
 * ISO weeks overlapping the window: 2026-W10 (Mon 03-02) and 2026-W11 (Mon 03-09).
 *
 * Pull requests
 * | PR | author          | created     | merged      | +/-     | notes
 * | #1 | alice           | 03-02 10:00 | 03-04 10:00 | 100/20  | self-reviewed (R1); bob approves after 4h
 * | #2 | dependabot[bot] | 03-03 08:00 | 03-03 20:00 | 10/10   | bot PR; carol approves after 1h
 * | #3 | bob             | 03-05 09:00 | 03-06 09:00 | 30/5    | merged with no review
 * | #4 | carol           | 03-12 12:00 | open        | 40/0    | first review 03-18 12:00 (after `to`) = 144h
 * | #5 | dave            | 03-13 09:00 | open        | 15/5    | unreviewed; age at asOf = 159h
 * | #6 | alice           | 02-25 10:00 | 03-11 12:00 | 200/50  | opened before window, reviewed in window
 *
 * Reviews
 * | R  | PR | reviewer | state             | submitted   | comments | counted in window?
 * | R1 | #1 | alice    | COMMENTED         | 03-02 12:00 | 1        | no (self-review)
 * | R2 | #1 | bob      | APPROVED          | 03-02 14:00 | 0        | yes
 * | R3 | #2 | carol    | APPROVED          | 03-03 09:00 | 0        | yes (human review on a bot PR)
 * | R4 | #4 | dave     | APPROVED          | 03-18 12:00 | 0        | no (after `to`)
 * | R5 | #6 | bob      | CHANGES_REQUESTED | 03-09 10:00 | 3        | yes
 * | R6 | #6 | carol    | COMMENTED         | 03-10 10:00 | 2        | yes
 * | R7 | #6 | carol    | COMMENTED         | 03-10 15:00 | 1        | yes
 * | R8 | #6 | bob      | DISMISSED         | 03-11 09:00 | 0        | yes (review, not approval)
 *
 * Commits
 * | C1 | alice                     | 03-02 11:00 | in window
 * | C2 | bob                       | 03-16 00:00 | no (`to` is exclusive)
 * | C3 | "Erin Example" (no login) | 03-10 08:00 | in window, unlinked
 * | C4 | dependabot[bot]           | 03-03 07:00 | bot
 *
 * Expected, includeBots = false
 * team: prsOpened 4 (#1 #3 #4 #5), prsMerged 3 (#1 #3 #6), reviewsSubmitted 6 (R2 R3 R5 R6 R7 R8)
 *   timeToFirstReview samples [4, 144]   -> median 74, p90 144, n 2  (#3 merged unreviewed: neither)
 *   awaitingFirstReview: #5 -> count 1, medianAge 159
 *   timeToMerge samples [48, 24, 338]    -> median 48, p90 338, n 3
 *   mergedWithoutReview: #3 -> count 1, share 1/3 = 0.333
 *   reviewConcentration: prsReviewed bob 2, carol 2 (sum 4) -> top bob, share 0.5, reviewersFor50Pct 1
 *
 * | person       | commits | opened | merged | lines | reviews | prsRev | appr | chReq | comments | revShare | codeShare
 * | bob          | 0       | 1      | 1      | 35    | 3       | 2      | 1    | 1     | 3        | 0.5      | 0.333
 * | carol        | 0       | 1      | 0      | 0     | 3       | 2      | 1    | 0     | 3        | 0.5      | 0
 * | alice        | 1       | 1      | 2      | 370   | 0       | 0      | 0    | 0     | 0        | 0        | 0.667
 * | Erin Example | 1       | 0      | 0      | 0     | 0       | 0      | 0    | 0     | 0        | 0        | 0
 * | dave         | 0       | 1      | 0      | 0     | 0       | 0      | 0    | 0     | 0        | 0        | 0
 * | totals       | 2       | 4      | 3      | 405   | 6       | 4      | 2    | 1     | 6        |
 * Order: prsReviewed desc, prsMerged desc, login asc (ordinal, so "Erin Example" < "dave").
 *
 * | week     | weekStart  | opened | merged | reviews | medianFirstReview | sample
 * | 2026-W10 | 2026-03-02 | 2      | 2      | 2       | 4                 | 1
 * | 2026-W11 | 2026-03-09 | 2      | 1      | 4       | 144               | 1
 *
 * Expected, includeBots = true (adds #2 and C4)
 * team: prsOpened 5, prsMerged 4, reviewsSubmitted 6
 *   timeToFirstReview [4, 1, 144] -> median 4, p90 144, n 3
 *   timeToMerge [48, 12, 24, 338] -> median 36, p90 338, n 4
 *   mergedWithoutReview count 1, share 0.25
 * dependabot[bot]: commits 1, opened 1, merged 1, lines 20, codeShare 0.25
 * alice codeShare 0.5, bob 0.25. totals: commits 3, opened 5, merged 4, lines 425
 * Order: bob, carol, alice, dependabot[bot], Erin Example, dave
 * W10: opened 3, merged 3, reviews 2, medianFirstReview 2.5 (samples 4, 1), sample 2
 */

export const WINDOW = { from: new Date('2026-03-02T00:00:00Z'), to: new Date('2026-03-16T00:00:00Z') };
export const AS_OF = new Date('2026-03-20T00:00:00Z');

const pr = (
  n: number,
  author: string,
  createdAt: string,
  mergedAt: string | null,
  additions: number,
  deletions: number,
): PullRequestRow => ({
  id: `PR${n}`,
  number: n,
  author,
  authorIsBot: author.endsWith('[bot]'),
  createdAt,
  updatedAt: mergedAt ?? createdAt,
  mergedAt,
  closedAt: mergedAt,
  additions,
  deletions,
});

const review = (
  n: number,
  prNumber: number,
  reviewer: string,
  state: ReviewRow['state'],
  submittedAt: string,
  commentCount: number,
): ReviewRow => ({
  id: `R${n}`,
  pullRequestId: `PR${prNumber}`,
  reviewer,
  reviewerIsBot: reviewer.endsWith('[bot]'),
  state,
  submittedAt,
  commentCount,
});

const commit = (sha: string, authorLogin: string | null, authorName: string, committedAt: string): CommitRow => ({
  sha,
  authorLogin,
  authorName,
  authorIsBot: authorName.endsWith('[bot]'),
  committedAt,
  additions: 10,
  deletions: 2,
});

export const pullRequests: PullRequestRow[] = [
  pr(1, 'alice', '2026-03-02T10:00:00Z', '2026-03-04T10:00:00Z', 100, 20),
  pr(2, 'dependabot[bot]', '2026-03-03T08:00:00Z', '2026-03-03T20:00:00Z', 10, 10),
  pr(3, 'bob', '2026-03-05T09:00:00Z', '2026-03-06T09:00:00Z', 30, 5),
  pr(4, 'carol', '2026-03-12T12:00:00Z', null, 40, 0),
  pr(5, 'dave', '2026-03-13T09:00:00Z', null, 15, 5),
  pr(6, 'alice', '2026-02-25T10:00:00Z', '2026-03-11T12:00:00Z', 200, 50),
];

export const reviews: ReviewRow[] = [
  review(1, 1, 'alice', 'COMMENTED', '2026-03-02T12:00:00Z', 1),
  review(2, 1, 'bob', 'APPROVED', '2026-03-02T14:00:00Z', 0),
  review(3, 2, 'carol', 'APPROVED', '2026-03-03T09:00:00Z', 0),
  review(4, 4, 'dave', 'APPROVED', '2026-03-18T12:00:00Z', 0),
  review(5, 6, 'bob', 'CHANGES_REQUESTED', '2026-03-09T10:00:00Z', 3),
  review(6, 6, 'carol', 'COMMENTED', '2026-03-10T10:00:00Z', 2),
  review(7, 6, 'carol', 'COMMENTED', '2026-03-10T15:00:00Z', 1),
  review(8, 6, 'bob', 'DISMISSED', '2026-03-11T09:00:00Z', 0),
];

export const commits: CommitRow[] = [
  commit('c1', 'alice', 'Alice A', '2026-03-02T11:00:00Z'),
  commit('c2', 'bob', 'Bob B', '2026-03-16T00:00:00Z'),
  commit('c3', null, 'Erin Example', '2026-03-10T08:00:00Z'),
  commit('c4', 'dependabot[bot]', 'dependabot[bot]', '2026-03-03T07:00:00Z'),
];

export const smallRepo = (overrides: Partial<MetricsInput> = {}): MetricsInput => ({
  pullRequests,
  reviews,
  commits,
  window: WINDOW,
  asOf: AS_OF,
  includeBots: false,
  ...overrides,
});
