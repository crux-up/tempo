import { useState, type FormEvent } from 'react';
import { FACT } from '../facts';
import { parseRepo, validateWindow, type Query } from '../query';

type QueryFormProps = { query: Query; busy: boolean; onSubmit: (query: Query) => void };

/** Repository, window and bot setting. Edits stay local until "Show" sends them. */
export function QueryForm({ query, busy, onSubmit }: QueryFormProps) {
  const [repo, setRepo] = useState(`${query.owner}/${query.repo}`);
  const [from, setFrom] = useState(query.from);
  const [to, setTo] = useState(query.to);
  const [includeBots, setIncludeBots] = useState(query.includeBots);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseRepo(repo);
    if (!parsed) {
      setError('Enter the repository as owner/name, for example fastify/fastify.');
      return;
    }
    const windowError = validateWindow(from, to);
    if (windowError) {
      setError(windowError);
      return;
    }
    setError(null);
    onSubmit({ ...parsed, from, to, includeBots });
  }

  return (
    <form className="query" onSubmit={submit} noValidate aria-describedby="query-error">
      <div className="field field-repo">
        <label htmlFor="q-repo">Repository</label>
        <input
          id="q-repo"
          className="input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error?.startsWith('Enter the repository') ?? false}
        />
      </div>
      <div className="field">
        <label htmlFor="q-from">From</label>
        <input id="q-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="q-to">To</label>
        <input id="q-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <label className="check" data-fact={FACT.includeBots}>
        <input type="checkbox" checked={includeBots} onChange={(e) => setIncludeBots(e.target.checked)} />
        Count bots as people
      </label>
      <button className="button button-secondary" type="submit" disabled={busy}>
        {busy ? 'Loading…' : 'Show'}
      </button>
      <p id="query-error" className="query-error" role="alert">
        {error}
      </p>
    </form>
  );
}
