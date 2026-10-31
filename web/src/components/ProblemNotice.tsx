import { useEffect, useState } from 'react';
import { problemKind, type Problem } from '../api';

/** What the person can do about each kind of problem; the server's own detail is always shown above it. */
const NEXT_STEP: Record<string, string> = {
  'github-token-rejected': 'Set a valid GITHUB_TOKEN in .env, then restart the service.',
  'not-configured': 'The metrics still work; only the explanation needs the key. Set ANTHROPIC_API_KEY in .env, then restart the service.',
  'repo-not-found': 'Check the owner and name. Private repositories are not supported.',
  'invalid-request': 'Change the repository or the dates and try again.',
  'upstream-rate-limited': 'Data already synced stays available; new syncs wait for the limit to reset.',
  'rate-limited': 'Too many requests from this browser. Wait a moment, then retry.',
  'narrative-budget-exhausted':
    'The hourly budget of new explanations is used up. The metrics still work, and an explanation already written is returned from cache.',
  forbidden:
    'The request was refused. Open the dashboard at the address the service is running on, not from another site or host name.',
  'llm-error': 'Try again; a new attempt makes a new request to the model.',
  unreachable: 'Start the service, then retry.',
};

const NOT_RETRYABLE = new Set(['not-configured', 'repo-not-found', 'invalid-request', 'forbidden']);

/** Short waits in seconds, long ones (an hourly budget) in minutes. */
const wait = (seconds: number) => (seconds < 120 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`);

function useCountdown(seconds: number | undefined) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    if (!seconds) return;
    const deadline = Date.now() + seconds * 1000;
    setLeft(seconds);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return left;
}

type ProblemNoticeProps = { problem: Problem; onRetry?: () => void; what: string };

/** A failed block keeps its frame: the problem title and detail, the next step, and Retry when retrying can help. */
export function ProblemNotice({ problem, onRetry, what }: ProblemNoticeProps) {
  const left = useCountdown(problem.retryAfterSeconds);
  const kind = problemKind(problem);
  const retryable = !NOT_RETRYABLE.has(kind);
  return (
    <div className="problem" role="alert">
      <p className="problem-title">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="problem-icon">
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.8v3.8M7 9.6v.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {what}: {problem.title}
      </p>
      <p className="problem-detail">{problem.detail}</p>
      {NEXT_STEP[kind] && <p className="problem-next">{NEXT_STEP[kind]}</p>}
      <div className="problem-actions">
        {onRetry && retryable && (
          <button type="button" className="text-button" onClick={onRetry} disabled={left > 0}>
            {left > 0 ? `Retry in ${wait(left)}` : 'Retry'}
          </button>
        )}
        {problem.requestId && (
          <span className="problem-id">
            Request <code>{problem.requestId}</code>
          </span>
        )}
      </div>
    </div>
  );
}
