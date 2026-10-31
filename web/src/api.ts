import { PROBLEM_BASE } from '@api/errors.js';
import { apiParams, type Query } from './query';
import type { Narrative, ReviewFlowReport } from './types';

/** An RFC 9457 problem as the API returns it, or one built here when the API could not be reached. */
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId?: string;
  retryAfterSeconds?: number;
};

export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail);
    this.name = 'ProblemError';
  }
}

/** The last segment of a Tempo problem type, such as `repo-not-found`; other types are returned as they are. */
export const problemKind = (problem: Problem) =>
  problem.type.startsWith(PROBLEM_BASE) ? problem.type.slice(PROBLEM_BASE.length) : problem.type;

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

async function toProblem(response: Response): Promise<Problem> {
  const retryHeader = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: fall through to a problem built from the status line.
  }
  const title = text(body.title);
  const detail = text(body.detail);
  return {
    type: text(body.type) ?? 'about:blank',
    title: title ?? (response.statusText || `HTTP ${response.status}`),
    status: response.status,
    detail: detail ?? 'The server answered with an error that is not a problem document.',
    requestId: text(body.requestId) ?? response.headers.get('x-request-id') ?? undefined,
    retryAfterSeconds,
  };
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' }, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProblemError({
      type: 'unreachable',
      title: 'Server unreachable',
      status: 0,
      detail: 'The Tempo API did not answer. Check that the server is running.',
    });
  }
  // A response that lands after the caller gave up is not news: report it as the abort it is.
  signal.throwIfAborted();
  if (!response.ok) {
    const problem = await toProblem(response);
    signal.throwIfAborted();
    throw new ProblemError(problem);
  }
  return (await response.json()) as T;
}

const repoPath = (query: Query) =>
  `/api/v1/repos/${encodeURIComponent(query.owner)}/${encodeURIComponent(query.repo)}/review-flow`;

export const fetchReport = (query: Query, signal: AbortSignal) =>
  getJson<ReviewFlowReport>(`${repoPath(query)}?${apiParams(query).toString()}`, signal);

export function fetchNarrative(query: Query, refresh: boolean, signal: AbortSignal) {
  const params = apiParams(query);
  if (refresh) params.set('refresh', 'true');
  return getJson<Narrative>(`${repoPath(query)}/narrative?${params.toString()}`, signal);
}

/** Turns anything a fetch threw into a problem to show; aborts return null. */
export function asProblem(error: unknown): Problem | null {
  if (error instanceof ProblemError) return error.problem;
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return {
    type: 'client-error',
    title: 'Unexpected response',
    status: 0,
    detail: 'The dashboard could not read the server response.',
  };
}
