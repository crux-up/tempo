import { useEffect, useState } from 'react';
import type { Problem } from '../api';
import { dateTime, day, evidenceFigure, evidenceLabel, figureText, share } from '../format';
import type { Evidence, Narrative } from '../types';
import { Num } from './Num';
import { ProblemNotice } from './ProblemNotice';

export type NarrativeState =
  | { status: 'idle' }
  | { status: 'loading'; startedAt: number; refresh: boolean; previous: Narrative | null }
  | { status: 'done'; narrative: Narrative }
  | { status: 'error'; problem: Problem; refresh: boolean };

type Citing = { canCite: (factId: string) => boolean; onCite: (factId: string) => void };

function Chip({ evidence, canCite, onCite }: { evidence: Evidence } & Citing) {
  const label = evidenceLabel(evidence.label);
  const figure = evidenceFigure(evidence);
  const content = (
    <>
      <span className="chip-label">{label}</span>
      <Num figure={figure} className="chip-value" />
    </>
  );
  if (!canCite(evidence.factId)) {
    return (
      <span className="chip chip-static" title="This number is not shown on the dashboard">
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip"
      onClick={() => onCite(evidence.factId)}
      aria-label={`${label}: ${figureText(figure)}. Show it on the dashboard`}
    >
      {content}
    </button>
  );
}

function Chips({ evidence, ...citing }: { evidence: Evidence[] } & Citing) {
  if (evidence.length === 0) return null;
  return (
    <ul className="chips" aria-label="Evidence">
      {evidence.map((item, index) => (
        <li key={`${item.factId}-${index}`}>
          <Chip evidence={item} {...citing} />
        </li>
      ))}
    </ul>
  );
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="num">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

function Verification({ narrative }: { narrative: Narrative }) {
  const { droppedFindings, droppedEvidenceIds, confidenceCapped } = narrative.verification;
  const notes: string[] = [];
  if (droppedFindings > 0) {
    notes.push(`${droppedFindings} ${droppedFindings === 1 ? 'finding was' : 'findings were'} removed: no cited number matched the metrics.`);
  }
  if (droppedEvidenceIds.length > 0) {
    notes.push(`${droppedEvidenceIds.length} ${droppedEvidenceIds.length === 1 ? 'citation was' : 'citations were'} removed as unknown or empty:`);
  }
  return (
    <section className="verification" aria-labelledby="verification-title">
      <h3 id="verification-title">Checked by the server</h3>
      {notes.length === 0 && !confidenceCapped ? (
        <p>Every finding and citation matched the metrics; nothing was removed.</p>
      ) : (
        <ul>
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {droppedEvidenceIds.length > 0 && (
            <li className="dropped-ids">
              {droppedEvidenceIds.map((id) => (
                <code key={id}>{id}</code>
              ))}
            </li>
          )}
          {confidenceCapped && (
            <li>
              Confidence lowered from {figureText(share(confidenceCapped.from, 0))} to {figureText(share(confidenceCapped.to, 0))}:{' '}
              {confidenceCapped.reason}.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

type ResultProps = { narrative: Narrative; reportDataAsOf: string | null; onRegenerate?: () => void } & Citing;

function Result({ narrative, reportDataAsOf, onRegenerate, ...citing }: ResultProps) {
  const { hypothesis } = narrative;
  const staleData = reportDataAsOf !== null && narrative.dataAsOf !== reportDataAsOf;
  return (
    <div className="narrative-body">
      <div className="narrative-meta-row">
        <p className="narrative-meta">
          {narrative.model === 'none' ? 'No model call was needed' : `Written by ${narrative.model}`} ·{' '}
          {narrative.cached ? 'from cache' : 'new'}
          <br />
          {dateTime(narrative.generatedAt)}
          <br />
          Covers {day(narrative.window.from)} to {day(narrative.window.to)}
        </p>
        {onRegenerate && (
          <button type="button" className="button button-secondary" onClick={onRegenerate}>
            Regenerate
          </button>
        )}
      </div>
      {staleData && (
        <p className="narrative-note">
          This explanation is based on data as of {dateTime(narrative.dataAsOf)}; the metrics on the page are as of{' '}
          {dateTime(reportDataAsOf)}. Regenerate to explain the current data.
        </p>
      )}
      <p className="summary">{narrative.summary}</p>

      {hypothesis && (
        <section className="hypothesis" aria-labelledby="hypothesis-title">
          <h3 id="hypothesis-title">Likely cause</h3>
          <p className="hypothesis-statement">{hypothesis.statement}</p>
          <div className="confidence">
            <span className="confidence-label">Confidence</span>
            <span className="meter" aria-hidden="true">
              <svg viewBox="0 0 100 6" preserveAspectRatio="none">
                <rect width="100" height="6" rx="3" className="meter-track" />
                <rect width={hypothesis.confidence * 100} height="6" rx="3" className="meter-fill" />
              </svg>
            </span>
            <Num figure={share(hypothesis.confidence, 0)} className="confidence-value" />
          </div>
          <p className="reasoning">{hypothesis.reasoning}</p>
          <Chips evidence={hypothesis.evidence} {...citing} />
          {hypothesis.alternatives.length > 0 && (
            <>
              <h4>Other explanations that fit</h4>
              <ul className="alternatives">
                {hypothesis.alternatives.map((alternative) => (
                  <li key={alternative}>{alternative}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {narrative.findings.length > 0 && (
        <section aria-labelledby="findings-title">
          <h3 id="findings-title">Findings</h3>
          <ol className="findings">
            {narrative.findings.map((finding) => (
              <li key={finding.claim}>
                <p>{finding.claim}</p>
                <Chips evidence={finding.evidence} {...citing} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {narrative.caveats.length > 0 && (
        <section aria-labelledby="caveats-title">
          <h3 id="caveats-title">Limits of the data</h3>
          <ul className="caveats">
            {narrative.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </section>
      )}

      <Verification narrative={narrative} />
    </div>
  );
}

type NarrativePanelProps = Citing & {
  state: NarrativeState;
  ready: boolean;
  /** When the page's metrics were synced; an explanation of older data says so. */
  reportDataAsOf: string | null;
  onExplain: (refresh: boolean) => void;
  onCancel: () => void;
};

/** The "why": a model-written explanation whose numbers come only from the server-checked evidence. */
export function NarrativePanel({ state, ready, reportDataAsOf, onExplain, onCancel, canCite, onCite }: NarrativePanelProps) {
  const citing = { canCite, onCite };
  return (
    <section className="narrative" aria-labelledby="narrative-title" aria-busy={state.status === 'loading'}>
      <header className="narrative-head">
        <div>
          <h2 id="narrative-title">Why it piles up</h2>
          <p className="section-note">
            A language model reads only these numbers and GitHub logins. Every figure it cites is checked against the
            metrics; select one to find it on the page.
          </p>
        </div>
      </header>

      {state.status === 'idle' && (
        <div className="narrative-start">
          <button type="button" className="button button-primary" onClick={() => onExplain(false)} disabled={!ready}>
            Explain
          </button>
          <p className="section-note">
            {ready
              ? 'A summary, findings and a likely cause with its confidence, each backed by cited numbers. A cached explanation returns at once; a new one can take up to about 2 minutes.'
              : 'Available once the metrics have loaded.'}
          </p>
        </div>
      )}

      {state.status === 'loading' && (
        <div className="narrative-wait" role="status">
          <p>
            {state.refresh ? 'Writing a new explanation' : 'Fetching the explanation'} · <Elapsed startedAt={state.startedAt} />
          </p>
          <p className="section-note">
            When nothing is cached the model can take up to about 2 minutes. You can keep reading the metrics meanwhile.
          </p>
          <button type="button" className="text-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {state.status === 'error' && (
        <ProblemNotice problem={state.problem} what="No explanation" onRetry={() => onExplain(state.refresh)} />
      )}

      {state.status === 'done' && (
        <Result narrative={state.narrative} reportDataAsOf={reportDataAsOf} onRegenerate={() => onExplain(true)} {...citing} />
      )}
      {state.status === 'loading' && state.previous && (
        <div className="narrative-stale">
          <Result narrative={state.previous} reportDataAsOf={reportDataAsOf} {...citing} />
        </div>
      )}
    </section>
  );
}
