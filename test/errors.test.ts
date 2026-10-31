import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  GitHubTokenRejectedError,
  LlmError,
  NotConfiguredError,
  RepoNotFoundError,
  UpstreamError,
  UpstreamRateLimitedError,
} from '../src/errors.js';

describe('error types', () => {
  it('UpstreamRateLimitedError carries status and retry hint', () => {
    const err = new UpstreamRateLimitedError(30);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.type).toBe('https://tempo.dev/problems/upstream-rate-limited');
  });

  it.each([
    [new BadRequestError('bad'), 400, 'invalid-request', 'bad'],
    [new RepoNotFoundError('a/b'), 404, 'repo-not-found', 'a/b'],
    [new GitHubTokenRejectedError(), 503, 'github-token-rejected', undefined],
    [new UpstreamError('boom'), 502, 'upstream-error', 'boom'],
    [new NotConfiguredError('no key'), 503, 'not-configured', 'no key'],
    [new LlmError('llm down'), 502, 'llm-error', 'llm down'],
  ])('%o maps to status, type and detail', (err, status, slug, detail) => {
    expect(err.status).toBe(status);
    expect(err.type).toBe(`https://tempo.dev/problems/${slug}`);
    expect(err.title.length).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeUndefined();
    if (detail) expect(err.message).toContain(detail);
  });
});
