/** Problem `type` URIs are identifiers, not links: a URN needs no domain the project would have to own. */
export const PROBLEM_BASE = 'urn:tempo:problem:';

/** Raised at startup when environment configuration is missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Base class for errors that map to an RFC 9457 problem response. */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  abstract readonly title: string;
  retryAfterSeconds?: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  readonly status = 400;
  readonly type = `${PROBLEM_BASE}invalid-request`;
  readonly title = 'Invalid request';
  constructor(detail: string) {
    super(detail);
  }
}

export class RepoNotFoundError extends AppError {
  readonly status = 404;
  readonly type = `${PROBLEM_BASE}repo-not-found`;
  readonly title = 'Repository not found';
  constructor(repo: string) {
    super(`Repository ${repo} was not found or is not accessible`);
  }
}

export class UpstreamRateLimitedError extends AppError {
  readonly status = 503;
  readonly type = `${PROBLEM_BASE}upstream-rate-limited`;
  readonly title = 'Upstream rate limit reached';
  constructor(retryAfterSeconds: number, upstream: 'GitHub' | 'Anthropic' = 'GitHub') {
    super(`The ${upstream} rate limit was reached; retry in ${retryAfterSeconds} seconds`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GitHubTokenRejectedError extends AppError {
  readonly status = 503;
  readonly type = `${PROBLEM_BASE}github-token-rejected`;
  readonly title = 'GitHub token rejected';
  constructor() {
    super('GitHub rejected the configured token');
  }
}

export class UpstreamError extends AppError {
  readonly status = 502;
  readonly type = `${PROBLEM_BASE}upstream-error`;
  readonly title = 'Upstream error';
  constructor(detail: string) {
    super(detail);
  }
}

export class NotConfiguredError extends AppError {
  readonly status = 503;
  readonly type = `${PROBLEM_BASE}not-configured`;
  readonly title = 'Feature not configured';
  constructor(detail: string) {
    super(detail);
  }
}

export class LlmError extends AppError {
  readonly status = 502;
  readonly type = `${PROBLEM_BASE}llm-error`;
  readonly title = 'Language model error';
  constructor(detail: string) {
    super(detail);
  }
}

export class RouteNotFoundError extends AppError {
  readonly status = 404;
  readonly type = `${PROBLEM_BASE}not-found`;
  readonly title = 'Not found';
  constructor(method: string) {
    super(`No ${method} route matches this path`);
  }
}

export class TooManyRequestsError extends AppError {
  readonly status = 429;
  readonly type = `${PROBLEM_BASE}rate-limited`;
  readonly title = 'Too many requests';
  constructor(retryAfterSeconds: number) {
    super(`Request rate limit exceeded; retry in ${retryAfterSeconds} seconds`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NarrativeBudgetError extends AppError {
  readonly status = 429;
  readonly type = `${PROBLEM_BASE}narrative-budget-exhausted`;
  readonly title = 'Narrative budget exhausted';
  constructor(retryAfterSeconds: number) {
    super(`The server's hourly budget of new narratives is used up; retry in ${retryAfterSeconds} seconds`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ForbiddenRequestError extends AppError {
  readonly status = 403;
  readonly type = `${PROBLEM_BASE}forbidden`;
  readonly title = 'Request refused';
  constructor(detail: string) {
    super(detail);
  }
}

export class NotReadyError extends AppError {
  readonly status = 503;
  readonly type = `${PROBLEM_BASE}not-ready`;
  readonly title = 'Service not ready';
  constructor() {
    super('The database is not available');
  }
}
