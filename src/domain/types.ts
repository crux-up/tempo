export type RepoRef = { owner: string; name: string };

/** Half-open UTC interval `[from, to)`. */
export type TimeWindow = { from: Date; to: Date };

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export type PullRequestRow = {
  id: string;
  number: number;
  author: string;
  authorIsBot: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
};

export type ReviewRow = {
  id: string;
  pullRequestId: string;
  reviewer: string;
  reviewerIsBot: boolean;
  state: ReviewState;
  submittedAt: string;
  commentCount: number;
};

export type CommitRow = {
  sha: string;
  authorLogin: string | null;
  authorName: string;
  authorIsBot: boolean;
  committedAt: string;
};

export type DurationStat = { medianHours: number | null; p90Hours: number | null; sampleSize: number };

export type PersonStats = {
  login: string;
  unlinked: boolean;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  linesChanged: number;
  reviewsSubmitted: number;
  prsReviewed: number;
  approvals: number;
  changesRequested: number;
  reviewComments: number;
  reviewShare: number;
  codeShare: number;
};

export type WeekStats = {
  week: string;
  weekStart: string;
  prsOpened: number;
  prsMerged: number;
  reviewsSubmitted: number;
  medianFirstReviewHours: number | null;
  firstReviewSample: number;
};

export type TeamStats = {
  prsOpened: number;
  prsMerged: number;
  reviewsSubmitted: number;
  timeToFirstReview: DurationStat;
  awaitingFirstReview: { count: number; medianAgeHours: number | null };
  timeToMerge: DurationStat;
  mergedWithoutReview: { count: number; share: number | null };
  reviewConcentration: {
    topReviewer: string | null;
    topReviewerShare: number | null;
    reviewersFor50Pct: number;
  };
};

export type Totals = Omit<PersonStats, 'login' | 'unlinked' | 'reviewShare' | 'codeShare'>;

export type ReviewFlowMetrics = { team: TeamStats; people: PersonStats[]; totals: Totals; weekly: WeekStats[] };

/**
 * Contract: `pullRequests` must include every PR that owns a review submitted in the window (plus PRs created or
 * merged in it), and `reviews` must hold all reviews (submitted at or before `asOf`) of every PR listed. Reviews
 * whose PR is missing from `pullRequests` are dropped by `computeReviewFlow`.
 */
export type MetricsInput = {
  pullRequests: PullRequestRow[];
  reviews: ReviewRow[];
  commits: CommitRow[];
  window: TimeWindow;
  asOf: Date;
  includeBots: boolean;
};

/** Query of a review-flow report, as the HTTP layer passes it on: the window bounds and the bot setting. */
export type ReviewFlowQuery = { from?: string; to?: string; includeBots?: 'true' | 'false' };

/** A review-flow query plus the narrative's cache bypass. */
export type NarrativeQuery = ReviewFlowQuery & { refresh?: 'true' | 'false' };

/** The part of a report's window that stored data backs. */
export type Coverage = { partial: boolean; from: string; to: string };

export type ReviewFlowReport = ReviewFlowMetrics & {
  repo: string;
  window: { from: string; to: string };
  dataAsOf: string;
  coverage: Coverage;
  includeBots: boolean;
};
