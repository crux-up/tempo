import type { CommitRow, PullRequestRow, ReviewRow, ReviewState } from '../domain/types.js';

type RawActor = { __typename: string; login: string } | null;

type RawReview = {
  id: string;
  state: string;
  submittedAt: string | null;
  author: RawActor;
  comments: { totalCount: number };
};

export type RawPageInfo = { hasNextPage: boolean; endCursor: string | null };

export type RawReviewConnection = { pageInfo: RawPageInfo; nodes: RawReview[] };

export type RawPullRequest = {
  id: string;
  number: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  author: RawActor;
  reviews: RawReviewConnection;
};

export type RawCommit = {
  oid: string;
  committedDate: string;
  author: { name: string | null; user: { login: string } | null } | null;
};

const GHOST = 'ghost';
const BOT_SUFFIX = '[bot]';
const REVIEW_STATES: ReadonlySet<string> = new Set<ReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);

function mapActor(actor: RawActor): { login: string; isBot: boolean } {
  if (!actor) return { login: GHOST, isBot: false };
  return { login: actor.login, isBot: actor.__typename === 'Bot' || actor.login.endsWith(BOT_SUFFIX) };
}

export function mapPullRequest(pr: RawPullRequest): PullRequestRow {
  const author = mapActor(pr.author);
  return {
    id: pr.id,
    number: pr.number,
    author: author.login,
    authorIsBot: author.isBot,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

/** Drops pending reviews: they carry no submission time and are invisible to other users. */
export function mapReviews(pullRequestId: string, reviews: RawReview[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const review of reviews) {
    if (review.submittedAt === null || !REVIEW_STATES.has(review.state)) continue;
    const reviewer = mapActor(review.author);
    rows.push({
      id: review.id,
      pullRequestId,
      reviewer: reviewer.login,
      reviewerIsBot: reviewer.isBot,
      state: review.state as ReviewState,
      submittedAt: review.submittedAt,
      commentCount: review.comments.totalCount,
    });
  }
  return rows;
}

export function mapCommit(commit: RawCommit): CommitRow {
  const login = commit.author?.user?.login ?? null;
  const name = commit.author?.name ?? '';
  return {
    sha: commit.oid,
    authorLogin: login,
    authorName: name,
    authorIsBot: (login?.endsWith(BOT_SUFFIX) ?? false) || name.endsWith(BOT_SUFFIX),
    committedAt: commit.committedDate,
  };
}

export function oldestUpdatedAt(pullRequests: PullRequestRow[]): string | null {
  let oldest: string | null = null;
  for (const pr of pullRequests) {
    if (oldest === null || Date.parse(pr.updatedAt) < Date.parse(oldest)) oldest = pr.updatedAt;
  }
  return oldest;
}
