import type { CommitRow, PullRequestRow, RepoRef, ReviewRow } from '../domain/types.js';
import {
  GitHubTokenRejectedError,
  RepoNotFoundError,
  UpstreamError,
  UpstreamRateLimitedError,
} from '../errors.js';
import type { Logger } from '../logger.js';
import {
  mapCommit,
  mapPullRequest,
  mapReviews,
  oldestUpdatedAt,
  type RawCommit,
  type RawPageInfo,
  type RawPullRequest,
  type RawReviewConnection,
} from './mapping.js';
import { COMMITS_QUERY, PULL_REQUESTS_QUERY, REPOSITORY_QUERY, REVIEWS_QUERY } from './queries.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [500, 1500];
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface GitHubSource {
  getRepository(repo: RepoRef): Promise<{ owner: string; name: string; defaultBranch: string }>;
  /**
   * Pages PRs ordered by UPDATED_AT DESC; yields each page and the caller stops iterating. `after` resumes after a
   * cursor from an earlier page. `endCursor` resumes after the page it comes with and is null on the last page.
   */
  pullRequestPages(
    repo: RepoRef,
    opts?: { after?: string },
  ): AsyncIterable<{
    pullRequests: PullRequestRow[];
    reviews: ReviewRow[];
    oldestUpdatedAt: string | null;
    endCursor: string | null;
  }>;
  commitPages(repo: RepoRef, branch: string, since: string, until: string): AsyncIterable<CommitRow[]>;
}

type GitHubClientOptions = {
  token: string;
  fetchFn?: typeof fetch;
  logger: Logger;
  /** Delay used between retries; injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type GraphQlResponse = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ type?: string; message?: string }>;
};

type Connection<T> = { pageInfo: RawPageInfo; nodes: T[] };

export function createGitHubClient(opts: GitHubClientOptions): GitHubSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const { logger } = opts;

  function rateLimitedFromHeaders(headers: Headers): UpstreamRateLimitedError | null {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
      return new UpstreamRateLimitedError(Math.max(1, Math.ceil(Number(retryAfter))));
    }
    if (headers.get('x-ratelimit-remaining') === '0') {
      const reset = headers.get('x-ratelimit-reset');
      const seconds =
        reset !== null && Number.isFinite(Number(reset))
          ? Math.max(1, Math.ceil((Number(reset) * 1000 - now()) / 1000))
          : DEFAULT_RETRY_AFTER_SECONDS;
      return new UpstreamRateLimitedError(seconds);
    }
    return null;
  }

  async function attempt(query: string, variables: Record<string, unknown>): Promise<GraphQlResponse | 'retry'> {
    let response: Response;
    try {
      response = await fetchFn(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
          'user-agent': 'tempo',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn({ errorName: error instanceof Error ? error.name : 'unknown' }, 'GitHub request failed');
      return 'retry';
    }

    if (response.status === 401) throw new GitHubTokenRejectedError();
    if (response.status === 403 || response.status === 429) {
      throw rateLimitedFromHeaders(response.headers) ?? new UpstreamError(`GitHub responded with HTTP ${response.status}`);
    }
    if (response.status >= 500) {
      logger.warn({ status: response.status }, 'GitHub server error');
      return 'retry';
    }
    if (!response.ok) throw new UpstreamError(`GitHub responded with HTTP ${response.status}`);

    try {
      return (await response.json()) as GraphQlResponse;
    } catch {
      throw new UpstreamError('GitHub returned an unreadable response');
    }
  }

  async function request(
    query: string,
    variables: Record<string, unknown>,
    repoLabel: string,
  ): Promise<Record<string, unknown>> {
    let result = await attempt(query, variables);
    for (const delay of RETRY_DELAYS_MS) {
      if (result !== 'retry') break;
      await sleep(delay);
      result = await attempt(query, variables);
    }
    if (result === 'retry') throw new UpstreamError('GitHub is unavailable');

    for (const error of result.errors ?? []) {
      if (error.type === 'RATE_LIMITED') throw new UpstreamRateLimitedError(DEFAULT_RETRY_AFTER_SECONDS);
      if (error.type === 'NOT_FOUND') throw new RepoNotFoundError(repoLabel);
    }
    if (result.errors?.length) throw new UpstreamError('GitHub returned a GraphQL error');
    if (!result.data) throw new UpstreamError('GitHub returned an empty response');

    const rateLimit = result.data.rateLimit as { remaining?: number; resetAt?: string } | undefined;
    if (rateLimit) logger.debug({ remaining: rateLimit.remaining, resetAt: rateLimit.resetAt }, 'GitHub rate limit');
    return result.data;
  }

  const label = (repo: RepoRef) => `${repo.owner}/${repo.name}`;

  async function allReviews(prId: string, first: RawReviewConnection, repoLabel: string) {
    const nodes = [...first.nodes];
    let page = first.pageInfo;
    while (page.hasNextPage) {
      const data = await request(REVIEWS_QUERY, { prId, cursor: page.endCursor }, repoLabel);
      const connection = (data.node as { reviews?: RawReviewConnection } | null)?.reviews;
      if (!connection) throw new UpstreamError('GitHub returned an unexpected review page');
      nodes.push(...connection.nodes);
      page = connection.pageInfo;
    }
    return nodes;
  }

  return {
    async getRepository(repo) {
      const data = await request(REPOSITORY_QUERY, { owner: repo.owner, name: repo.name }, label(repo));
      const repository = data.repository as {
        nameWithOwner: string;
        isPrivate?: boolean;
        defaultBranchRef: { name: string } | null;
      } | null;
      // Private repositories are reported exactly like missing ones, so the response never confirms they exist.
      if (!repository || repository.isPrivate !== false) throw new RepoNotFoundError(label(repo));
      if (!repository.defaultBranchRef) throw new UpstreamError('The repository has no default branch');
      const [owner = '', name = ''] = repository.nameWithOwner.split('/');
      return { owner, name, defaultBranch: repository.defaultBranchRef.name };
    },

    async *pullRequestPages(repo, opts) {
      let cursor: string | null = opts?.after ?? null;
      for (;;) {
        const data = await request(PULL_REQUESTS_QUERY, { owner: repo.owner, name: repo.name, cursor }, label(repo));
        const repository = data.repository as { pullRequests: Connection<RawPullRequest> } | null;
        if (!repository) throw new RepoNotFoundError(label(repo));
        const { pageInfo, nodes } = repository.pullRequests;

        const pullRequests: PullRequestRow[] = [];
        const reviews: ReviewRow[] = [];
        for (const node of nodes) {
          pullRequests.push(mapPullRequest(node));
          reviews.push(...mapReviews(node.id, await allReviews(node.id, node.reviews, label(repo))));
        }
        const endCursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
        yield { pullRequests, reviews, oldestUpdatedAt: oldestUpdatedAt(pullRequests), endCursor };

        if (endCursor === null) return;
        cursor = endCursor;
      }
    },

    async *commitPages(repo, branch, since, until) {
      let cursor: string | null = null;
      for (;;) {
        const data = await request(
          COMMITS_QUERY,
          { owner: repo.owner, name: repo.name, branch: `refs/heads/${branch}`, cursor, since, until },
          label(repo),
        );
        const repository = data.repository as { ref: { target: { history?: Connection<RawCommit> } } | null } | null;
        if (!repository) throw new RepoNotFoundError(label(repo));
        const history = repository.ref?.target.history;
        if (!history) return;

        yield history.nodes.map(mapCommit);

        if (!history.pageInfo.hasNextPage) return;
        cursor = history.pageInfo.endCursor;
      }
    },
  };
}
