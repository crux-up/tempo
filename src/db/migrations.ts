import type { Database } from 'better-sqlite3';

/** Ordered schema steps. `PRAGMA user_version` records how many have run; never edit a shipped step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repos (
    id             INTEGER PRIMARY KEY,
    key            TEXT NOT NULL UNIQUE,
    owner          TEXT NOT NULL,
    name           TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    synced_from    TEXT,
    synced_at      TEXT
  );

  CREATE TABLE pull_requests (
    id            TEXT PRIMARY KEY,
    repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number        INTEGER NOT NULL,
    author        TEXT NOT NULL,
    author_is_bot INTEGER NOT NULL CHECK (author_is_bot IN (0, 1)),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    merged_at     TEXT,
    closed_at     TEXT,
    additions     INTEGER NOT NULL,
    deletions     INTEGER NOT NULL
  );
  CREATE INDEX idx_pull_requests_repo_created ON pull_requests(repo_id, created_at);
  CREATE INDEX idx_pull_requests_repo_merged ON pull_requests(repo_id, merged_at);

  CREATE TABLE reviews (
    id              TEXT PRIMARY KEY,
    repo_id         INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    reviewer        TEXT NOT NULL,
    reviewer_is_bot INTEGER NOT NULL CHECK (reviewer_is_bot IN (0, 1)),
    state           TEXT NOT NULL,
    submitted_at    TEXT NOT NULL,
    comment_count   INTEGER NOT NULL
  );
  CREATE INDEX idx_reviews_pull_request ON reviews(pull_request_id);
  CREATE INDEX idx_reviews_repo_submitted ON reviews(repo_id, submitted_at);

  CREATE TABLE commits (
    repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    sha           TEXT NOT NULL,
    author_login  TEXT,
    author_name   TEXT NOT NULL,
    author_is_bot INTEGER NOT NULL CHECK (author_is_bot IN (0, 1)),
    committed_at  TEXT NOT NULL,
    additions     INTEGER NOT NULL,
    deletions     INTEGER NOT NULL,
    PRIMARY KEY (repo_id, sha)
  );
  CREATE INDEX idx_commits_repo_committed ON commits(repo_id, committed_at);

  CREATE TABLE narratives (
    cache_key      TEXT PRIMARY KEY,
    body           TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE repos ADD COLUMN backfill_cursor TEXT;
  `,
];

export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
