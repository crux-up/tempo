import { describe, expect, it, vi } from 'vitest';
import {
  GitHubTokenRejectedError,
  RepoNotFoundError,
  UpstreamError,
  UpstreamRateLimitedError,
} from '../../src/errors.js';
import { createGitHubClient } from '../../src/github/client.js';
import type { Logger } from '../../src/logger.js';

const TOKEN = 'test-github-token-supersecret123';
const repo = { owner: 'acme', name: 'widgets' };

type Call = { url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } };

function harness(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const next = queue.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const logs: Array<{ obj: object; msg?: string }> = [];
  const logger: Logger = {
    debug: (obj, msg) => logs.push({ obj, msg }),
    info: (obj, msg) => logs.push({ obj, msg }),
    warn: (obj, msg) => logs.push({ obj, msg }),
  };
  const delays: number[] = [];
  const client = createGitHubClient({
    token: TOKEN,
    fetchFn,
    logger,
    sleep: async (ms) => {
      delays.push(ms);
    },
    now: () => Date.parse('2026-03-10T12:00:00.000Z'),
  });
  return { client, calls, logs, delays, fetchFn };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const rateLimit = { remaining: 4990, resetAt: '2026-03-10T13:00:00Z' };

const repoOk = () =>
  json({
    data: {
      repository: { nameWithOwner: 'acme/widgets', isPrivate: false, defaultBranchRef: { name: 'main' } },
      rateLimit,
    },
  });

const rawReview = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  state: 'APPROVED',
  submittedAt: '2026-03-10T10:00:00Z',
  author: { __typename: 'User', login: 'bob' },
  comments: { totalCount: 2 },
  ...over,
});

const rawPr = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  number: Number(id.replace(/\D/g, '')),
  createdAt: '2026-03-09T09:00:00Z',
  updatedAt: '2026-03-10T09:00:00Z',
  mergedAt: null,
  closedAt: null,
  additions: 10,
  deletions: 3,
  author: { __typename: 'User', login: 'alice' },
  reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
  ...over,
});

const prPage = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) =>
  json({
    data: {
      repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } },
      rateLimit,
    },
  });

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('getRepository', () => {
  it('returns canonical owner, name and default branch', async () => {
    const h = harness([
      json({
        data: {
          repository: { nameWithOwner: 'Acme/Widgets', isPrivate: false, defaultBranchRef: { name: 'trunk' } },
          rateLimit,
        },
      }),
    ]);
    await expect(h.client.getRepository(repo)).resolves.toEqual({
      owner: 'Acme',
      name: 'Widgets',
      defaultBranch: 'trunk',
    });
  });

  it('sends every request to the GitHub endpoint with a bearer token and variables', async () => {
    const h = harness([repoOk()]);
    await h.client.getRepository(repo);
    expect(h.calls[0]?.url).toBe('https://api.github.com/graphql');
    expect(h.calls[0]?.init.method).toBe('POST');
    const headers = new Headers(h.calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(h.calls[0]?.body.variables).toEqual({ owner: 'acme', name: 'widgets' });
    expect(h.calls[0]?.body.query).not.toContain('acme');
    expect(h.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('logs the remaining rate limit at debug level without the token', async () => {
    const h = harness([repoOk()]);
    await h.client.getRepository(repo);
    expect(JSON.stringify(h.logs)).toContain('4990');
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('reports the last rate limit GitHub returned, and null before any response', async () => {
    const h = harness([repoOk()]);
    expect(h.client.quota()).toBeNull();
    await h.client.getRepository(repo);
    expect(h.client.quota()).toEqual({ remaining: 4990, resetAt: '2026-03-10T13:00:00Z' });
  });

  it('maps repository null to RepoNotFoundError', async () => {
    const h = harness([json({ data: { repository: null, rateLimit } })]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('maps a NOT_FOUND GraphQL error to RepoNotFoundError', async () => {
    const h = harness([
      json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }),
    ]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('asks GitHub whether the repository is private', async () => {
    const h = harness([repoOk()]);
    await h.client.getRepository(repo);
    expect(h.calls[0]?.body.query).toContain('isPrivate');
  });

  it('refuses a private repository as not found, so its existence is not disclosed', async () => {
    const h = harness([
      json({
        data: {
          repository: { nameWithOwner: 'acme/secret', isPrivate: true, defaultBranchRef: { name: 'main' } },
          rateLimit,
        },
      }),
    ]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('fails closed when GitHub omits the visibility flag', async () => {
    const h = harness([
      json({ data: { repository: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }, rateLimit } }),
    ]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('maps a repository without a default branch to UpstreamError', async () => {
    const h = harness([
      json({
        data: { repository: { nameWithOwner: 'acme/widgets', isPrivate: false, defaultBranchRef: null }, rateLimit },
      }),
    ]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('pullRequestPages', () => {
  it('yields each page in order and stops when there is no next page', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', { updatedAt: '2026-03-10T09:00:00Z' }),
          rawPr('PR_2', { updatedAt: '2026-03-08T09:00:00Z' }),
        ],
        true,
        'c1',
      ),
      prPage([rawPr('PR_3', { updatedAt: '2026-03-05T09:00:00Z' })], false, null),
    ]);
    const pages = await collect(h.client.pullRequestPages(repo));
    expect(pages.map((p) => p.pullRequests.map((r) => r.id))).toEqual([['PR_1', 'PR_2'], ['PR_3']]);
    expect(pages.map((p) => p.oldestUpdatedAt)).toEqual(['2026-03-08T09:00:00Z', '2026-03-05T09:00:00Z']);
    expect(pages.map((p) => p.endCursor)).toEqual(['c1', null]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.body.variables.cursor).toBeNull();
    expect(h.calls[1]?.body.variables.cursor).toBe('c1');
  });

  it('does not fetch the next page when the caller stops iterating', async () => {
    const h = harness([prPage([rawPr('PR_1')], true, 'c1'), prPage([rawPr('PR_2')], false, null)]);
    for await (const page of h.client.pullRequestPages(repo)) {
      expect(page.pullRequests).toHaveLength(1);
      break;
    }
    expect(h.calls).toHaveLength(1);
  });

  it('yields oldestUpdatedAt null for an empty page', async () => {
    const h = harness([prPage([], false, null)]);
    const pages = await collect(h.client.pullRequestPages(repo));
    expect(pages).toEqual([{ pullRequests: [], reviews: [], oldestUpdatedAt: null, endCursor: null, requests: 1 }]);
  });

  it('starts after the given cursor when resuming', async () => {
    const h = harness([prPage([rawPr('PR_9')], true, 'c10'), prPage([rawPr('PR_8')], false, null)]);
    const pages = await collect(h.client.pullRequestPages(repo, { after: 'c9' }));
    expect(pages.map((p) => p.endCursor)).toEqual(['c10', null]);
    expect(h.calls[0]?.body.variables.cursor).toBe('c9');
    expect(h.calls[1]?.body.variables.cursor).toBe('c10');
  });

  it('maps repository null to RepoNotFoundError', async () => {
    const h = harness([json({ data: { repository: null, rateLimit } })]);
    await expect(collect(h.client.pullRequestPages(repo))).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('fetches remaining review pages for a PR before yielding', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', {
            reviews: {
              pageInfo: { hasNextPage: true, endCursor: 'r1' },
              nodes: [rawReview('R_1'), rawReview('R_2')],
            },
          }),
        ],
        false,
        null,
      ),
      json({
        data: {
          node: { reviews: { pageInfo: { hasNextPage: true, endCursor: 'r2' }, nodes: [rawReview('R_3')] } },
          rateLimit,
        },
      }),
      json({
        data: {
          node: { reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [rawReview('R_4')] } },
          rateLimit,
        },
      }),
    ]);
    const pages = await collect(h.client.pullRequestPages(repo));
    expect(pages[0]?.reviews.map((r) => r.id)).toEqual(['R_1', 'R_2', 'R_3', 'R_4']);
    expect(pages[0]?.reviews.every((r) => r.pullRequestId === 'PR_1')).toBe(true);
    expect(h.calls[1]?.body.variables).toEqual({ prId: 'PR_1', cursor: 'r1' });
    expect(h.calls[2]?.body.variables).toEqual({ prId: 'PR_1', cursor: 'r2' });
    expect(pages[0]?.requests).toBe(3);
  });

  it('counts retries in the requests a page took', async () => {
    const h = harness([new Response('bad gateway', { status: 502 }), prPage([rawPr('PR_1')], false, null)]);
    const pages = await collect(h.client.pullRequestPages(repo));
    expect(pages[0]?.requests).toBe(2);
  });

  it('maps a null author to ghost', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', {
            author: null,
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [rawReview('R_1', { author: null })],
            },
          }),
        ],
        false,
        null,
      ),
    ]);
    const [page] = await collect(h.client.pullRequestPages(repo));
    expect(page?.pullRequests[0]).toMatchObject({ author: 'ghost', authorIsBot: false });
    expect(page?.reviews[0]).toMatchObject({ reviewer: 'ghost', reviewerIsBot: false });
  });

  it('flags bots by __typename or [bot] suffix', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', { author: { __typename: 'Bot', login: 'dependabot' } }),
          rawPr('PR_2', { author: { __typename: 'User', login: 'renovate[bot]' } }),
          rawPr('PR_3'),
        ],
        false,
        null,
      ),
    ]);
    const [page] = await collect(h.client.pullRequestPages(repo));
    expect(page?.pullRequests.map((p) => p.authorIsBot)).toEqual([true, true, false]);
  });

  it('adds the [bot] suffix to GraphQL Bot logins so a bot has the same login as on its commits', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', {
            author: { __typename: 'Bot', login: 'dependabot' },
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [rawReview('R_1', { author: { __typename: 'Bot', login: 'copilot' } })],
            },
          }),
          rawPr('PR_2', { author: { __typename: 'Bot', login: 'renovate[bot]' } }),
        ],
        false,
        null,
      ),
    ]);
    const [page] = await collect(h.client.pullRequestPages(repo));
    expect(page?.pullRequests.map((p) => p.author)).toEqual(['dependabot[bot]', 'renovate[bot]']);
    expect(page?.reviews.map((r) => r.reviewer)).toEqual(['copilot[bot]']);
  });

  it('maps review fields and drops pending reviews', async () => {
    const h = harness([
      prPage(
        [
          rawPr('PR_1', {
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                rawReview('R_1', { state: 'CHANGES_REQUESTED', author: { __typename: 'Bot', login: 'copilot' } }),
                rawReview('R_2', { state: 'PENDING', submittedAt: null }),
                rawReview('R_3', { state: 'PENDING' }),
                rawReview('R_4', { submittedAt: null }),
              ],
            },
          }),
        ],
        false,
        null,
      ),
    ]);
    const [page] = await collect(h.client.pullRequestPages(repo));
    expect(page?.reviews).toEqual([
      {
        id: 'R_1',
        pullRequestId: 'PR_1',
        reviewer: 'copilot[bot]',
        reviewerIsBot: true,
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-03-10T10:00:00Z',
        commentCount: 2,
      },
    ]);
  });
});

describe('commitPages', () => {
  const rawCommit = (oid: string, over: Record<string, unknown> = {}) => ({
    oid,
    committedDate: '2026-03-10T08:00:00Z',
    author: { name: 'Alice A', user: { login: 'alice' } },
    ...over,
  });
  const commitPage = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) =>
    json({
      data: {
        repository: { ref: { target: { history: { pageInfo: { hasNextPage, endCursor }, nodes } } } },
        rateLimit,
      },
    });

  it('pages through history and maps linked, unlinked and bot authors', async () => {
    const h = harness([
      commitPage(
        [
          rawCommit('a1'),
          rawCommit('a2', { author: { name: 'Stranger', user: null } }),
          rawCommit('a3', { author: { name: 'dependabot[bot]', user: null } }),
          rawCommit('a4', { author: { name: 'Renovate', user: { login: 'renovate[bot]' } } }),
          rawCommit('a5', { author: null }),
        ],
        true,
        'k1',
      ),
      commitPage([rawCommit('b1')], false, null),
    ]);
    const pages = await collect(
      h.client.commitPages(repo, 'main', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
    );
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.requests)).toEqual([1, 1]);
    expect(pages[0]?.commits.map((c) => [c.sha, c.authorLogin, c.authorName, c.authorIsBot])).toEqual([
      ['a1', 'alice', 'Alice A', false],
      ['a2', null, 'Stranger', false],
      ['a3', null, 'dependabot[bot]', true],
      ['a4', 'renovate[bot]', 'Renovate', true],
      ['a5', null, '', false],
    ]);
    expect(pages[0]?.commits[0]).toEqual({
      sha: 'a1',
      authorLogin: 'alice',
      authorName: 'Alice A',
      authorIsBot: false,
      committedAt: '2026-03-10T08:00:00Z',
    });
    expect(h.calls[0]?.body.variables).toEqual({
      owner: 'acme',
      name: 'widgets',
      branch: 'refs/heads/main',
      cursor: null,
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
    });
    expect(h.calls[1]?.body.variables.cursor).toBe('k1');
    // Commit line counts make GitHub compute a diff per commit and no metric uses them.
    expect(h.calls[0]?.body.query).not.toMatch(/additions|deletions/);
  });

  it('strips control and bidi characters from git author names and caps them at 100 characters', async () => {
    const h = harness([
      commitPage(
        [
          rawCommit('a1', { author: { name: 'admin‮nimda\u0007⁦x⁩‏', user: null } }),
          rawCommit('a2', { author: { name: 'n'.repeat(150), user: null } }),
          rawCommit('a3', { author: { name: `${'é'.repeat(99)}\u{1F600}tail`, user: null } }),
        ],
        false,
        null,
      ),
    ]);
    const [page] = await collect(h.client.commitPages(repo, 'main', 'a', 'b'));
    expect(page?.commits.map((c) => c.authorName)).toEqual(['adminnimdax', 'n'.repeat(100), `${'é'.repeat(99)}\u{1F600}`]);
  });

  it('yields nothing when the branch does not exist', async () => {
    const h = harness([json({ data: { repository: { ref: null }, rateLimit } })]);
    expect(await collect(h.client.commitPages(repo, 'gone', 'a', 'b'))).toEqual([]);
  });
});

describe('error mapping', () => {
  it('maps HTTP 401 to GitHubTokenRejectedError without leaking the token', async () => {
    const h = harness([new Response(`bad credentials ${TOKEN}`, { status: 401 })]);
    const error = await h.client.getRepository(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubTokenRejectedError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('maps x-ratelimit-remaining 0 to UpstreamRateLimitedError with seconds until reset', async () => {
    const reset = Math.floor(Date.parse('2026-03-10T12:05:00.000Z') / 1000);
    const h = harness([
      new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }),
    ]);
    const error = await h.client.getRepository(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRateLimitedError);
    expect((error as UpstreamRateLimitedError).retryAfterSeconds).toBe(300);
  });

  it('prefers retry-after and enforces a minimum of one second', async () => {
    const h = harness([
      new Response('{}', { status: 429, headers: { 'retry-after': '42' } }),
      new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } }),
    ]);
    const first = await h.client.getRepository(repo).catch((e: unknown) => e);
    expect((first as UpstreamRateLimitedError).retryAfterSeconds).toBe(42);
    const second = await h.client.getRepository(repo).catch((e: unknown) => e);
    expect((second as UpstreamRateLimitedError).retryAfterSeconds).toBe(1);
  });

  it('maps a RATE_LIMITED GraphQL error to UpstreamRateLimitedError', async () => {
    const h = harness([json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] })]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(UpstreamRateLimitedError);
  });

  it('treats a 403 without rate-limit signals as an upstream error without retrying', async () => {
    const h = harness([new Response('forbidden', { status: 403 })]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(UpstreamError);
    expect(h.calls).toHaveLength(1);
  });

  it('retries 502 twice with 500 ms and 1500 ms backoff, then succeeds', async () => {
    const h = harness([new Response('bad gateway', { status: 502 }), new Response('bad gateway', { status: 502 }), repoOk()]);
    await expect(h.client.getRepository(repo)).resolves.toMatchObject({ defaultBranch: 'main' });
    expect(h.delays).toEqual([500, 1500]);
    expect(h.calls).toHaveLength(3);
  });

  it('throws UpstreamError after three 502 responses', async () => {
    const h = harness([
      new Response('bad gateway', { status: 502 }),
      new Response('bad gateway', { status: 502 }),
      new Response('bad gateway', { status: 502 }),
    ]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(UpstreamError);
    expect(h.calls).toHaveLength(3);
  });

  it('retries network failures and never leaks the token', async () => {
    const h = harness([
      new TypeError(`fetch failed ${TOKEN}`),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    const error = await h.client.getRepository(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
    expect(h.calls).toHaveLength(3);
  });

  it('maps an unparseable 200 body to UpstreamError', async () => {
    const h = harness([new Response('<html>', { status: 200 })]);
    await expect(h.client.getRepository(repo)).rejects.toBeInstanceOf(UpstreamError);
  });
});
