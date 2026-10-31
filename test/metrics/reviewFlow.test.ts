import { describe, expect, it } from 'vitest';
import type { PersonStats, PullRequestRow, ReviewRow } from '../../src/domain/types.js';
import { computeReviewFlow } from '../../src/metrics/reviewFlow.js';
import { smallRepo } from '../fixtures/smallRepo.js';

const metrics = computeReviewFlow(smallRepo());
const withBots = computeReviewFlow(smallRepo({ includeBots: true }));

const person = (login: string, m = metrics): PersonStats => {
  const found = m.people.find((p) => p.login === login);
  if (!found) throw new Error(`no person ${login}`);
  return found;
};

describe('computeReviewFlow on the small repo fixture', () => {
  it('counts PRs opened by createdAt in window, excluding bot PRs', () => {
    expect(metrics.team.prsOpened).toBe(4);
    expect(person('alice').prsOpened).toBe(1);
  });

  it('counts PRs merged and lines changed by mergedAt in window', () => {
    expect(metrics.team.prsMerged).toBe(3);
    expect(person('alice')).toMatchObject({ prsMerged: 2, linesChanged: 370 });
    expect(person('bob')).toMatchObject({ prsMerged: 1, linesChanged: 35 });
  });

  it('counts reviews submitted in window, excluding self-reviews and reviews after to', () => {
    expect(metrics.team.reviewsSubmitted).toBe(6);
    expect(person('alice').reviewsSubmitted).toBe(0);
    expect(metrics.people.find((p) => p.login === 'dave')?.reviewsSubmitted).toBe(0);
  });

  it('counts DISMISSED as a review but not an approval', () => {
    expect(person('bob')).toMatchObject({ reviewsSubmitted: 3, approvals: 1, changesRequested: 1 });
  });

  it('counts two COMMENTED reviews on one PR as two reviews but one PR reviewed', () => {
    const carol = person('carol');
    expect(carol.reviewsSubmitted).toBe(3);
    expect(carol.prsReviewed).toBe(2);
  });

  it('sums comment counts into reviewComments', () => {
    expect(person('bob').reviewComments).toBe(3);
    expect(person('carol').reviewComments).toBe(3);
  });

  it('counts human reviews on bot PRs', () => {
    expect(person('carol').approvals).toBe(1);
  });

  it('counts commits by committedAt in window, with to exclusive', () => {
    expect(person('alice').commits).toBe(1);
    expect(person('bob').commits).toBe(0);
  });

  it('keys commits without a login by author name and marks them unlinked', () => {
    expect(person('Erin Example')).toMatchObject({ unlinked: true, commits: 1 });
    expect(person('alice').unlinked).toBe(false);
  });

  it('computes review and code shares rounded to 3 decimals', () => {
    expect(person('bob')).toMatchObject({ reviewShare: 0.5, codeShare: 0.333 });
    expect(person('alice')).toMatchObject({ reviewShare: 0, codeShare: 0.667 });
  });

  it('measures time to first review, including reviews after to', () => {
    expect(metrics.team.timeToFirstReview).toEqual({ medianHours: 74, p90Hours: 144, sampleSize: 2 });
  });

  it('lists unreviewed PRs still open at asOf as awaiting first review', () => {
    expect(metrics.team.awaitingFirstReview).toEqual({ count: 1, medianAgeHours: 159 });
  });

  it('measures time to merge for PRs merged in window', () => {
    expect(metrics.team.timeToMerge).toEqual({ medianHours: 48, p90Hours: 338, sampleSize: 3 });
  });

  it('counts PRs merged without any qualifying review', () => {
    expect(metrics.team.mergedWithoutReview).toEqual({ count: 1, share: 0.333 });
  });

  it('reports review concentration from prsReviewed', () => {
    expect(metrics.team.reviewConcentration).toEqual({
      topReviewer: 'bob',
      topReviewerShare: 0.5,
      reviewersFor50Pct: 1,
    });
  });

  it('sorts people by prsReviewed, prsMerged, then login, and omits all-zero people', () => {
    expect(metrics.people.map((p) => p.login)).toEqual(['bob', 'carol', 'alice', 'Erin Example', 'dave']);
  });

  it('breaks full ties by ordinal login order, not locale order, so API and UI agree', () => {
    const tied = (sha: string, login: string) => ({
      sha,
      authorLogin: login,
      authorName: login,
      authorIsBot: false,
      committedAt: '2026-03-05T00:00:00Z',
    });
    const m = computeReviewFlow(
      smallRepo({ pullRequests: [], reviews: [], commits: [tied('a', 'zoe'), tied('b', 'Zed'), tied('c', 'adam')] }),
    );
    // Ordinal: uppercase sorts before lowercase; localeCompare would give adam, Zed, zoe.
    expect(m.people.map((p) => p.login)).toEqual(['Zed', 'adam', 'zoe']);
  });

  it('builds one weekly entry per ISO week overlapping the window', () => {
    expect(metrics.weekly).toEqual([
      {
        week: '2026-W10',
        weekStart: '2026-03-02',
        prsOpened: 2,
        prsMerged: 2,
        reviewsSubmitted: 2,
        medianFirstReviewHours: 4,
        firstReviewSample: 1,
      },
      {
        week: '2026-W11',
        weekStart: '2026-03-09',
        prsOpened: 2,
        prsMerged: 1,
        reviewsSubmitted: 4,
        medianFirstReviewHours: 144,
        firstReviewSample: 1,
      },
    ]);
  });

  it('sums people into totals that reconcile with team counts', () => {
    expect(metrics.totals).toEqual({
      commits: 2,
      prsOpened: 4,
      prsMerged: 3,
      linesChanged: 405,
      reviewsSubmitted: 6,
      prsReviewed: 4,
      approvals: 2,
      changesRequested: 1,
      reviewComments: 6,
    });
    expect(metrics.totals.prsMerged).toBe(metrics.team.prsMerged);
    expect(metrics.totals.reviewsSubmitted).toBe(metrics.team.reviewsSubmitted);
    expect(withBots.totals.prsMerged).toBe(withBots.team.prsMerged);
    expect(withBots.totals.prsOpened).toBe(withBots.team.prsOpened);
  });
});

describe('computeReviewFlow with includeBots', () => {
  it('excludes bot authors by default', () => {
    expect(metrics.people.some((p) => p.login === 'dependabot[bot]')).toBe(false);
  });

  it('includes bot PRs and commits when asked', () => {
    expect(withBots.team).toMatchObject({ prsOpened: 5, prsMerged: 4, reviewsSubmitted: 6 });
    expect(person('dependabot[bot]', withBots)).toMatchObject({
      commits: 1,
      prsOpened: 1,
      prsMerged: 1,
      linesChanged: 20,
      codeShare: 0.25,
    });
    expect(withBots.people.map((p) => p.login)).toEqual([
      'bob',
      'carol',
      'alice',
      'dependabot[bot]',
      'Erin Example',
      'dave',
    ]);
  });

  it('adds bot PRs to the duration samples when asked', () => {
    expect(withBots.team.timeToFirstReview).toEqual({ medianHours: 4, p90Hours: 144, sampleSize: 3 });
    expect(withBots.team.timeToMerge).toEqual({ medianHours: 36, p90Hours: 338, sampleSize: 4 });
    expect(withBots.team.mergedWithoutReview).toEqual({ count: 1, share: 0.25 });
    expect(withBots.weekly[0]).toMatchObject({ prsOpened: 3, medianFirstReviewHours: 2.5, firstReviewSample: 2 });
  });

  it('drops reviews from bot reviewers unless included', () => {
    const botReview: ReviewRow = {
      id: 'RB',
      pullRequestId: 'PR5',
      reviewer: 'linter[bot]',
      reviewerIsBot: true,
      state: 'COMMENTED',
      submittedAt: '2026-03-14T09:00:00Z',
      commentCount: 4,
    };
    const input = smallRepo({ reviews: [botReview] });
    const without = computeReviewFlow(input);
    expect(without.team.reviewsSubmitted).toBe(0);
    // #4 and #5 are open with no qualifying review.
    expect(without.team.awaitingFirstReview.count).toBe(2);

    const included = computeReviewFlow({ ...input, includeBots: true });
    expect(included.team.reviewsSubmitted).toBe(1);
    expect(included.team.awaitingFirstReview.count).toBe(1);
    expect(person('linter[bot]', included)).toMatchObject({ reviewsSubmitted: 1, reviewComments: 4 });
  });
});

describe('computeReviewFlow edge cases', () => {
  const base: PullRequestRow = {
    id: 'X1',
    number: 1,
    author: 'alice',
    authorIsBot: false,
    createdAt: '2026-03-02T10:00:00Z',
    updatedAt: '2026-03-02T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    additions: 1,
    deletions: 1,
  };
  const reviewAt = (submittedAt: string): ReviewRow => ({
    id: `R-${submittedAt}`,
    pullRequestId: 'X1',
    reviewer: 'bob',
    reviewerIsBot: false,
    state: 'APPROVED',
    submittedAt,
    commentCount: 0,
  });

  it('returns zeros, null durations and empty weeks for empty input', () => {
    const empty = computeReviewFlow(smallRepo({ pullRequests: [], reviews: [], commits: [] }));
    expect(empty.team).toEqual({
      prsOpened: 0,
      prsMerged: 0,
      reviewsSubmitted: 0,
      timeToFirstReview: { medianHours: null, p90Hours: null, sampleSize: 0 },
      awaitingFirstReview: { count: 0, medianAgeHours: null },
      timeToMerge: { medianHours: null, p90Hours: null, sampleSize: 0 },
      mergedWithoutReview: { count: 0, share: null },
      reviewConcentration: { topReviewer: null, topReviewerShare: null, reviewersFor50Pct: 0 },
    });
    expect(empty.people).toEqual([]);
    expect(Object.values(empty.totals).every((v) => v === 0)).toBe(true);
    expect(empty.weekly).toHaveLength(2);
    expect(empty.weekly.every((w) => w.prsOpened === 0 && w.medianFirstReviewHours === null)).toBe(true);
  });

  it('covers partial ISO weeks at both ends of the window', () => {
    const window = { from: new Date('2026-03-04T00:00:00Z'), to: new Date('2026-03-17T00:00:00Z') };
    const result = computeReviewFlow(smallRepo({ pullRequests: [], reviews: [], commits: [], window }));
    expect(result.weekly.map((w) => w.week)).toEqual(['2026-W10', '2026-W11', '2026-W12']);
  });

  it('rounds reported hours to 0.1 after taking the median', () => {
    const prs = [base, { ...base, id: 'X2', number: 2 }];
    const result = computeReviewFlow(
      smallRepo({
        pullRequests: prs,
        reviews: [reviewAt('2026-03-02T10:03:36Z'), { ...reviewAt('2026-03-02T10:09:36Z'), pullRequestId: 'X2' }],
        commits: [],
      }),
    );
    // Samples 0.06h and 0.16h: median 0.11h -> 0.1. Rounding the samples first would give 0.15 -> 0.2.
    expect(result.team.timeToFirstReview.medianHours).toBe(0.1);
  });

  it('ignores reviews submitted after asOf for first review', () => {
    const result = computeReviewFlow(
      smallRepo({ pullRequests: [base], reviews: [reviewAt('2026-03-21T00:00:00Z')], commits: [] }),
    );
    expect(result.team.timeToFirstReview.sampleSize).toBe(0);
    expect(result.team.awaitingFirstReview.count).toBe(1);
  });

  it('does not treat a closed unmerged PR as awaiting review', () => {
    const closed = { ...base, closedAt: '2026-03-05T00:00:00Z' };
    const result = computeReviewFlow(smallRepo({ pullRequests: [closed], reviews: [], commits: [] }));
    expect(result.team.awaitingFirstReview.count).toBe(0);
  });

  it('counts a merged PR as unreviewed when its only review came after the merge', () => {
    const merged = { ...base, mergedAt: '2026-03-03T10:00:00Z', closedAt: '2026-03-03T10:00:00Z' };
    const result = computeReviewFlow(
      smallRepo({ pullRequests: [merged], reviews: [reviewAt('2026-03-04T10:00:00Z')], commits: [] }),
    );
    expect(result.team.mergedWithoutReview).toEqual({ count: 1, share: 1 });
  });

  it('needs more than one reviewer to reach half of the reviews when spread evenly', () => {
    const prs = ['a', 'b', 'c'].map((s, i) => ({ ...base, id: `P${s}`, number: i + 1 }));
    const reviewsSpread = ['bob', 'carol', 'dave'].map((reviewer, i) => ({
      ...reviewAt('2026-03-03T10:00:00Z'),
      id: `RS${i}`,
      pullRequestId: prs[i]!.id,
      reviewer,
    }));
    const result = computeReviewFlow(smallRepo({ pullRequests: prs, reviews: reviewsSpread, commits: [] }));
    expect(result.team.reviewConcentration).toEqual({
      topReviewer: 'bob',
      topReviewerShare: 0.333,
      reviewersFor50Pct: 2,
    });
  });
});
