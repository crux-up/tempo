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
const MAX_NAME_LENGTH = 100;
/** Control characters and invisible format characters (bidi marks and overrides, zero-width characters, BOM) that can disguise a name. */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}]/gu;
const BOT_SUFFIX = '[bot]';
const REVIEW_STATES: ReadonlySet<string> = new Set<ReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);

/**
 * GraphQL `Bot` actors have logins without the `[bot]` suffix that their commits carry (`dependabot` against
 * `dependabot[bot]`). The suffix is added here, so the metrics can match a bot's
 * unlinked commits (author name `dependabot[bot]`) to the verified bot actor.
 */
function mapActor(actor: RawActor): { login: string; isBot: boolean } {
  if (!actor) return { login: GHOST, isBot: false };
  if (actor.__typename === 'Bot') {
    const login = actor.login.endsWith(BOT_SUFFIX) ? actor.login : `${actor.login}${BOT_SUFFIX}`;
    return { login, isBot: true };
  }
  return { login: actor.login, isBot: actor.login.endsWith(BOT_SUFFIX) };
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

/** Git author names are free text from anyone who can push: strip unsafe characters, cap at 100 code points. */
function sanitizeName(name: string): string {
  return Array.from(name.replace(UNSAFE_NAME_CHARS, ''))
    .slice(0, MAX_NAME_LENGTH)
    .join('');
}

/**
 * The login comes only from the linked GitHub user, never from the free-text git author name. A bot commit has no
 * linked user (`GitActor.user` is a `User`); the metrics decide whether its name matches a verified bot.
 */
export function mapCommit(commit: RawCommit): CommitRow {
  const login = commit.author?.user?.login ?? null;
  const name = sanitizeName(commit.author?.name ?? '');
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
