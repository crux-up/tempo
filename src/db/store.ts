import type { Database } from 'better-sqlite3';
import type { CommitRow, PullRequestRow, ReviewRow, ReviewState, TimeWindow } from '../domain/types.js';

export type RepoRecord = {
  id: number;
  key: string;
  owner: string;
  name: string;
  defaultBranch: string;
  syncedFrom: string | null;
  syncedAt: string | null;
  /** GitHub cursor after the last PR page an unfinished backfill stored; the next backfill resumes there. */
  backfillCursor: string | null;
};

export type StoredNarrative = { body: unknown; model: string; promptVersion: string; createdAt: string };

type RepoDbRow = {
  id: number;
  key: string;
  owner: string;
  name: string;
  default_branch: string;
  synced_from: string | null;
  synced_at: string | null;
  backfill_cursor: string | null;
};

type PullRequestDbRow = {
  id: string;
  number: number;
  author: string;
  author_is_bot: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  additions: number;
  deletions: number;
};

type ReviewDbRow = {
  id: string;
  pull_request_id: string;
  reviewer: string;
  reviewer_is_bot: number;
  state: string;
  submitted_at: string;
  comment_count: number;
};

type CommitDbRow = {
  sha: string;
  author_login: string | null;
  author_name: string;
  author_is_bot: number;
  committed_at: string;
  additions: number;
  deletions: number;
};

type NarrativeDbRow = { body: string; model: string; prompt_version: string; created_at: string };

/** Timestamps are kept as `toISOString()` text so that lexical order equals time order. */
function iso(value: string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: string | null): string | null {
  return value === null ? null : iso(value);
}

const toRepo = (r: RepoDbRow): RepoRecord => ({
  id: r.id,
  key: r.key,
  owner: r.owner,
  name: r.name,
  defaultBranch: r.default_branch,
  syncedFrom: r.synced_from,
  syncedAt: r.synced_at,
  backfillCursor: r.backfill_cursor,
});

const toPullRequest = (r: PullRequestDbRow): PullRequestRow => ({
  id: r.id,
  number: r.number,
  author: r.author,
  authorIsBot: r.author_is_bot === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  mergedAt: r.merged_at,
  closedAt: r.closed_at,
  additions: r.additions,
  deletions: r.deletions,
});

const toReview = (r: ReviewDbRow): ReviewRow => ({
  id: r.id,
  pullRequestId: r.pull_request_id,
  reviewer: r.reviewer,
  reviewerIsBot: r.reviewer_is_bot === 1,
  state: r.state as ReviewState,
  submittedAt: r.submitted_at,
  commentCount: r.comment_count,
});

const toCommit = (r: CommitDbRow): CommitRow => ({
  sha: r.sha,
  authorLogin: r.author_login,
  authorName: r.author_name,
  authorIsBot: r.author_is_bot === 1,
  committedAt: r.committed_at,
  additions: r.additions,
  deletions: r.deletions,
});

export class Store {
  private readonly selectRepo;
  private readonly insertRepo;
  private readonly updateSync;
  private readonly insertPullRequest;
  private readonly insertReview;
  private readonly insertCommit;
  private readonly selectWindowPullRequests;
  private readonly selectReviewsOfPullRequests;
  private readonly selectWindowCommits;
  private readonly selectNarrative;
  private readonly insertNarrative;
  private readonly writePullRequests;
  private readonly writeCommits;

  constructor(private readonly db: Database) {
    this.selectRepo = db.prepare<[string], RepoDbRow>('SELECT * FROM repos WHERE key = ?');

    this.insertRepo = db.prepare<[string, string, string, string], RepoDbRow>(
      `INSERT INTO repos (key, owner, name, default_branch) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         owner = excluded.owner, name = excluded.name, default_branch = excluded.default_branch
       RETURNING *`,
    );

    this.updateSync = db.prepare<[string, string, string | null, number]>(
      'UPDATE repos SET synced_from = ?, synced_at = ?, backfill_cursor = ? WHERE id = ?',
    );

    this.insertPullRequest = db.prepare(
      `INSERT INTO pull_requests
         (id, repo_id, number, author, author_is_bot, created_at, updated_at, merged_at, closed_at, additions, deletions)
       VALUES
         (@id, @repoId, @number, @author, @authorIsBot, @createdAt, @updatedAt, @mergedAt, @closedAt, @additions, @deletions)
       ON CONFLICT(id) DO UPDATE SET
         number = excluded.number, author = excluded.author, author_is_bot = excluded.author_is_bot,
         created_at = excluded.created_at, updated_at = excluded.updated_at, merged_at = excluded.merged_at,
         closed_at = excluded.closed_at, additions = excluded.additions, deletions = excluded.deletions`,
    );

    this.insertReview = db.prepare(
      `INSERT INTO reviews
         (id, repo_id, pull_request_id, reviewer, reviewer_is_bot, state, submitted_at, comment_count)
       VALUES
         (@id, @repoId, @pullRequestId, @reviewer, @reviewerIsBot, @state, @submittedAt, @commentCount)
       ON CONFLICT(id) DO UPDATE SET
         pull_request_id = excluded.pull_request_id, reviewer = excluded.reviewer,
         reviewer_is_bot = excluded.reviewer_is_bot, state = excluded.state,
         submitted_at = excluded.submitted_at, comment_count = excluded.comment_count`,
    );

    this.insertCommit = db.prepare(
      `INSERT INTO commits
         (repo_id, sha, author_login, author_name, author_is_bot, committed_at, additions, deletions)
       VALUES
         (@repoId, @sha, @authorLogin, @authorName, @authorIsBot, @committedAt, @additions, @deletions)
       ON CONFLICT(repo_id, sha) DO UPDATE SET
         author_login = excluded.author_login, author_name = excluded.author_name,
         author_is_bot = excluded.author_is_bot, committed_at = excluded.committed_at,
         additions = excluded.additions, deletions = excluded.deletions`,
    );

    // :from/:to bound the window, :asOf caps review visibility. A PR qualifies when it was created or merged in
    // the window, or when it owns a review submitted in the window (and not after asOf).
    this.selectWindowPullRequests = db.prepare<
      { repoId: number; from: string; to: string; asOf: string },
      PullRequestDbRow
    >(
      `SELECT id, number, author, author_is_bot, created_at, updated_at, merged_at, closed_at, additions, deletions
         FROM pull_requests p
        WHERE p.repo_id = @repoId
          AND ( (p.created_at >= @from AND p.created_at < @to)
             OR (p.merged_at  >= @from AND p.merged_at  < @to)
             OR EXISTS (
                  SELECT 1 FROM reviews r
                   WHERE r.pull_request_id = p.id
                     AND r.submitted_at >= @from AND r.submitted_at < @to AND r.submitted_at <= @asOf) )
        ORDER BY p.created_at, p.id`,
    );

    this.selectReviewsOfPullRequests = db.prepare<
      { repoId: number; from: string; to: string; asOf: string },
      ReviewDbRow
    >(
      `SELECT r.id, r.pull_request_id, r.reviewer, r.reviewer_is_bot, r.state, r.submitted_at, r.comment_count
         FROM reviews r
         JOIN pull_requests p ON p.id = r.pull_request_id
        WHERE p.repo_id = @repoId
          AND r.submitted_at <= @asOf
          AND ( (p.created_at >= @from AND p.created_at < @to)
             OR (p.merged_at  >= @from AND p.merged_at  < @to)
             OR EXISTS (
                  SELECT 1 FROM reviews w
                   WHERE w.pull_request_id = p.id
                     AND w.submitted_at >= @from AND w.submitted_at < @to AND w.submitted_at <= @asOf) )
        ORDER BY r.submitted_at, r.id`,
    );

    this.selectWindowCommits = db.prepare<{ repoId: number; from: string; to: string }, CommitDbRow>(
      `SELECT sha, author_login, author_name, author_is_bot, committed_at, additions, deletions
         FROM commits
        WHERE repo_id = @repoId AND committed_at >= @from AND committed_at < @to
        ORDER BY committed_at, sha`,
    );

    this.selectNarrative = db.prepare<[string], NarrativeDbRow>(
      'SELECT body, model, prompt_version, created_at FROM narratives WHERE cache_key = ?',
    );

    this.insertNarrative = db.prepare<[string, string, string, string, string]>(
      `INSERT INTO narratives (cache_key, body, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         body = excluded.body, model = excluded.model,
         prompt_version = excluded.prompt_version, created_at = excluded.created_at`,
    );

    this.writePullRequests = db.transaction(
      (repoId: number, prs: PullRequestRow[], reviews: ReviewRow[]) => {
        for (const p of prs) {
          this.insertPullRequest.run({
            ...p,
            repoId,
            authorIsBot: p.authorIsBot ? 1 : 0,
            createdAt: iso(p.createdAt),
            updatedAt: iso(p.updatedAt),
            mergedAt: isoOrNull(p.mergedAt),
            closedAt: isoOrNull(p.closedAt),
          });
        }
        for (const r of reviews) {
          this.insertReview.run({
            ...r,
            repoId,
            reviewerIsBot: r.reviewerIsBot ? 1 : 0,
            submittedAt: iso(r.submittedAt),
          });
        }
      },
    );

    this.writeCommits = db.transaction((repoId: number, commits: CommitRow[]) => {
      for (const c of commits) {
        this.insertCommit.run({
          ...c,
          repoId,
          authorIsBot: c.authorIsBot ? 1 : 0,
          committedAt: iso(c.committedAt),
        });
      }
    });
  }

  getRepo(key: string): RepoRecord | null {
    const row = this.selectRepo.get(key);
    return row ? toRepo(row) : null;
  }

  upsertRepo(r: { key: string; owner: string; name: string; defaultBranch: string }): RepoRecord {
    const row = this.insertRepo.get(r.key, r.owner, r.name, r.defaultBranch);
    if (!row) throw new Error('repo upsert returned no row');
    return toRepo(row);
  }

  markSynced(repoId: number, p: { syncedFrom: string; syncedAt: string; backfillCursor: string | null }): void {
    this.updateSync.run(iso(p.syncedFrom), iso(p.syncedAt), p.backfillCursor, repoId);
  }

  upsertPullRequests(repoId: number, prs: PullRequestRow[], reviews: ReviewRow[]): void {
    this.writePullRequests(repoId, prs, reviews);
  }

  upsertCommits(repoId: number, commits: CommitRow[]): void {
    this.writeCommits(repoId, commits);
  }

  loadWindowData(
    repoId: number,
    w: TimeWindow,
    asOf: Date,
  ): { pullRequests: PullRequestRow[]; reviews: ReviewRow[]; commits: CommitRow[] } {
    const range = { repoId, from: w.from.toISOString(), to: w.to.toISOString() };
    const withAsOf = { ...range, asOf: asOf.toISOString() };
    return this.db.transaction(() => ({
      pullRequests: this.selectWindowPullRequests.all(withAsOf).map(toPullRequest),
      reviews: this.selectReviewsOfPullRequests.all(withAsOf).map(toReview),
      commits: this.selectWindowCommits.all(range).map(toCommit),
    }))();
  }

  getNarrative(cacheKey: string): StoredNarrative | null {
    const row = this.selectNarrative.get(cacheKey);
    if (!row) return null;
    return {
      body: JSON.parse(row.body) as unknown,
      model: row.model,
      promptVersion: row.prompt_version,
      createdAt: row.created_at,
    };
  }

  saveNarrative(cacheKey: string, body: unknown, meta: { model: string; promptVersion: string }): void {
    this.insertNarrative.run(cacheKey, JSON.stringify(body), meta.model, meta.promptVersion, new Date().toISOString());
  }
}
