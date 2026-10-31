import { useCallback, useEffect, useRef, useState } from 'react';
import { asProblem, fetchNarrative, fetchReport, type Problem } from './api';
import { NarrativePanel, type NarrativeState } from './components/NarrativePanel';
import { CoverageNotice } from './components/CoverageNotice';
import { Num } from './components/Num';
import { PeopleTable } from './components/PeopleTable';
import { ProblemNotice } from './components/ProblemNotice';
import { QueryForm } from './components/QueryForm';
import { TeamFigures } from './components/TeamFigures';
import { TopBar } from './components/TopBar';
import { WeeklyChart } from './components/WeeklyChart';
import { FACT, factOnScreen, findFactElement, parseFact, unlinkedCommits, type FactTarget } from './facts';
import { count, dateTime, day, figureText, hours, share, windowEnd, windowStart } from './format';
import { narrativeBlock, queryFromSearch, searchFromQuery, type Query } from './query';
import type { ReviewFlowReport } from './types';

type ReportState =
  | { status: 'loading'; previous: ReviewFlowReport | null }
  | { status: 'done'; report: ReviewFlowReport; key: string }
  | { status: 'error'; problem: Problem };

const CITE_HIGHLIGHT_MS = 2400;

/** The one line under the title: where the review work sits and how long a PR waits for it. */
function finding(report: ReviewFlowReport): string {
  const { team } = report;
  if (team.prsOpened + team.prsMerged + team.reviewsSubmitted === 0) return 'No pull request activity in this window.';
  const { topReviewer, topReviewerShare, reviewersFor50Pct } = team.reviewConcentration;
  const wait = team.timeToFirstReview;
  const parts: string[] = [];
  if (topReviewer && topReviewerShare !== null) {
    const who = reviewersFor50Pct === 1 ? '1 person' : `${count(reviewersFor50Pct)} people`;
    parts.push(`Half of all PR reviews came from ${who}; ${topReviewer} alone did ${figureText(share(topReviewerShare))}.`);
  } else {
    parts.push('No PR was reviewed in this window.');
  }
  if (wait.medianHours !== null) {
    parts.push(`The median PR waited ${figureText(hours(wait.medianHours))} for a first review (n ${count(wait.sampleSize)}).`);
  }
  return parts.join(' ');
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App() {
  const [query, setQuery] = useState<Query>(() => queryFromSearch(window.location.search));
  const [reportState, setReportState] = useState<ReportState>({ status: 'loading', previous: null });
  const [narrative, setNarrative] = useState<NarrativeState>({ status: 'idle' });
  const [cited, setCited] = useState<{ target: FactTarget; nonce: number } | null>(null);
  const [citedWeek, setCitedWeek] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const narrativeAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    window.history.replaceState(null, '', searchFromQuery(query));
    const onPop = () => setQuery(queryFromSearch(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // The first render's query is written to the URL once; later changes push their own entries.
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const key = searchFromQuery(query);
    // Old values stay on screen only while the same query reloads; Back, Forward and new queries start blank.
    setReportState((current) => ({
      status: 'loading',
      previous: current.status === 'done' && current.key === key ? current.report : null,
    }));
    fetchReport(query, controller.signal).then(
      (report) => {
        if (!controller.signal.aborted) setReportState({ status: 'done', report, key });
      },
      (error: unknown) => {
        const problem = asProblem(error);
        if (problem && !controller.signal.aborted) setReportState({ status: 'error', problem });
      },
    );
    return () => controller.abort();
    // `reloads` re-runs the fetch for the same query.
  }, [query, reloads]);

  useEffect(() => {
    narrativeAbort.current?.abort();
    setNarrative({ status: 'idle' });
    setCited(null);
    setCitedWeek(null);
  }, [query]);

  useEffect(() => {
    if (!cited) return;
    let timer = 0;
    const frame = window.requestAnimationFrame(() => {
      const element = findFactElement(cited.target);
      if (!element) return;
      element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      element.classList.remove('is-cited');
      element.getBoundingClientRect();
      element.classList.add('is-cited');
      // Ending the reveal lets the people table collapse again; it stays expanded until the person collapses it.
      timer = window.setTimeout(() => {
        element.classList.remove('is-cited');
        setCited(null);
      }, CITE_HIGHLIGHT_MS);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [cited]);

  const submit = useCallback((next: Query) => {
    if (searchFromQuery(next) === window.location.search) {
      setReloads((n) => n + 1);
      return;
    }
    window.history.pushState(null, '', searchFromQuery(next));
    setReloads(0);
    setQuery(next);
  }, []);

  const explain = useCallback(
    (refresh: boolean) => {
      narrativeAbort.current?.abort();
      const controller = new AbortController();
      narrativeAbort.current = controller;
      setNarrative((current) => ({
        status: 'loading',
        startedAt: Date.now(),
        refresh,
        previous: current.status === 'done' ? current.narrative : null,
      }));
      fetchNarrative(query, refresh, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) setNarrative({ status: 'done', narrative: result });
        },
        (error: unknown) => {
          const problem = asProblem(error);
          if (problem && !controller.signal.aborted) setNarrative({ status: 'error', problem, refresh });
        },
      );
    },
    [query],
  );

  const cancelNarrative = useCallback(() => {
    narrativeAbort.current?.abort();
    setNarrative((current) =>
      current.status === 'loading' && current.previous ? { status: 'done', narrative: current.previous } : { status: 'idle' },
    );
  }, []);

  const report = reportState.status === 'done' ? reportState.report : reportState.status === 'loading' ? reportState.previous : null;
  const canCite = useCallback((id: string) => (report ? factOnScreen(id, report) : false), [report]);
  const cite = useCallback((id: string) => {
    const target = parseFact(id);
    if (!target) return;
    setCited((current) => ({ target, nonce: (current?.nonce ?? 0) + 1 }));
    if (target.kind === 'week') setCitedWeek(target.week);
  }, []);

  const repoName = report?.repo ?? `${query.owner}/${query.repo}`;
  const scope = `${repoName} · ${day(query.from)} – ${day(query.to)}`;
  const loading = reportState.status === 'loading';
  const unlinked = report ? unlinkedCommits(report) : 0;

  return (
    <>
      <TopBar scope={scope} />
      <main className="canvas">
        <div className="title-row">
          <div className="title-text">
            <h1>{repoName}</h1>
            <p className="title-sub">
              {report ? finding(report) : reportState.status === 'error' ? 'No metrics for this view.' : 'Loading review-flow metrics…'}
            </p>
          </div>
          {report && (
            <div className="freshness">
              <span>Data as of {dateTime(report.dataAsOf)}</span>
              <button type="button" className="text-button" onClick={() => setReloads((n) => n + 1)} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          )}
        </div>

        <QueryForm key={searchFromQuery(query)} query={query} busy={loading} onSubmit={submit} />

        {report && <CoverageNotice coverage={report.coverage} window={report.window} />}

        {reportState.status === 'error' ? (
          <div className="body body-error">
            <ProblemNotice problem={reportState.problem} what="No metrics" onRetry={() => setReloads((n) => n + 1)} />
          </div>
        ) : (
          <div className="body">
            <div className="main-column">
              <section className="block block-team" aria-labelledby="team-title">
                <div className="block-head">
                  <h2 id="team-title">Review flow</h2>
                  <p className="section-note">
                    {report ? (
                      <>
                        <Num figure={{ value: count(report.team.prsOpened), unit: '' }} fact={FACT.prsOpened} /> PRs opened,{' '}
                        <Num figure={{ value: count(report.team.prsMerged), unit: '' }} fact={FACT.prsMerged} /> merged and{' '}
                        <Num figure={{ value: count(report.team.reviewsSubmitted), unit: '' }} fact={FACT.reviewsSubmitted} />{' '}
                        reviews submitted from {windowStart(report.window.from)} to {windowEnd(report.window.to)}
                        {report.includeBots ? ', bots included.' : ', bots left out.'}
                      </>
                    ) : (
                      'PRs opened, merged and reviewed in the window.'
                    )}
                  </p>
                </div>
                <TeamFigures report={report} />
              </section>

              <section className="block block-weekly" aria-labelledby="weekly-title">
                <div className="block-head">
                  <h2 id="weekly-title">Wait for a first review, by week</h2>
                  <p className="section-note">Median hours from opening a PR to its first review, by the week it opened.</p>
                </div>
                {report ? (
                  <WeeklyChart
                    weekly={report.weekly}
                    windowMedian={report.team.timeToFirstReview.medianHours}
                    citedWeek={citedWeek}
                    syncedFrom={report.coverage.partial ? report.coverage.from : null}
                  />
                ) : (
                  <div className="chart-loading" aria-hidden="true" />
                )}
              </section>

              <section className="block block-people" aria-labelledby="people-title">
                <div className="block-head">
                  <h2 id="people-title">Who reviews, who ships</h2>
                  <p className="section-note">
                    Review share counts each reviewer once per PR; code share is the share of merged PRs.
                    {report && unlinked > 0 && (
                      <>
                        {' '}
                        <Num figure={{ value: count(unlinked), unit: '' }} fact={FACT.unlinkedCommits} />{' '}
                        {unlinked === 1 ? 'commit is' : 'commits are'} from unlinked git names.
                      </>
                    )}
                  </p>
                </div>
                <PeopleTable
                  people={report?.people ?? null}
                  revealLogin={cited?.target.kind === 'person' ? cited.target.login : null}
                />
              </section>
            </div>

            <aside className="rail">
              <NarrativePanel
                state={narrative}
                ready={reportState.status === 'done'}
                blockedReason={narrativeBlock(query)}
                report={report}
                onExplain={explain}
                onCancel={cancelNarrative}
                canCite={canCite}
                onCite={cite}
              />
            </aside>
          </div>
        )}
      </main>
    </>
  );
}
