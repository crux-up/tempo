import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Narrative, Person } from '../types';
import { CoverageNotice } from './CoverageNotice';
import { NarrativePanel } from './NarrativePanel';
import { Num } from './Num';
import { PeopleTable } from './PeopleTable';
import { ProblemNotice } from './ProblemNotice';

const person = (login: string, prsReviewed: number, unlinked = false): Person => ({
  login,
  unlinked,
  commits: 1,
  prsOpened: 1,
  prsMerged: 1,
  linesChanged: 10,
  reviewsSubmitted: prsReviewed,
  prsReviewed,
  approvals: 0,
  changesRequested: 0,
  reviewComments: 0,
  reviewShare: prsReviewed / 100,
  codeShare: 0.05,
});

const people = Array.from({ length: 12 }, (_, i) => person(`dev${i}`, 20 - i));
const rowCount = (markup: string) => (markup.match(/data-fact-row="person\./g) ?? []).length;

describe('PeopleTable', () => {
  it('shows the top 10 with a toggle for the rest', () => {
    const markup = renderToStaticMarkup(<PeopleTable people={people} revealLogin={null} />);
    expect(rowCount(markup)).toBe(10);
    expect(markup).toContain('Show all 12 people');
  });

  it('shows every row while a person past the cap is cited', () => {
    expect(rowCount(renderToStaticMarkup(<PeopleTable people={people} revealLogin="dev11" />))).toBe(12);
    expect(rowCount(renderToStaticMarkup(<PeopleTable people={people} revealLogin="dev2" />))).toBe(10);
  });

  it('keeps a linked login and a git name of the same spelling as two rows', () => {
    const markup = renderToStaticMarkup(
      <PeopleTable people={[person('mcollina', 5), person('mcollina', 0, true)]} revealLogin={null} />,
    );
    expect(markup.match(/>mcollina</g)).toHaveLength(2);
    expect(markup).toContain('git name');
  });
});

describe('Num', () => {
  it('reads a missing value as words, not as a dash', () => {
    const markup = renderToStaticMarkup(<Num figure={null} />);
    expect(markup).toContain('<span aria-hidden="true">—</span>');
    expect(markup).toContain('<span class="sr-only">no data</span>');
    expect(markup).not.toContain('aria-label');
  });
});

describe('NarrativePanel', () => {
  const narrative = {
    repo: 'fastify/fastify',
    window: { from: '2026-08-03T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' },
    dataAsOf: '2026-10-31T08:00:00.000Z',
    coverage: { partial: false, from: '2026-08-03T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' },
    summary: 'Reviews wait for two maintainers.',
    findings: [],
    hypothesis: null,
    caveats: [],
    verification: { droppedFindings: 0, droppedEvidenceIds: [], confidenceCapped: null },
    model: 'test-model',
    promptVersion: 'v1',
    cached: true,
    generatedAt: '2026-10-31T08:05:00.000Z',
  } satisfies Narrative;

  const render = (reportDataAsOf: string) =>
    renderToStaticMarkup(
      <NarrativePanel
        state={{ status: 'done', narrative }}
        ready
        blockedReason={null}
        reportDataAsOf={reportDataAsOf}
        onExplain={() => undefined}
        onCancel={() => undefined}
        canCite={() => false}
        onCite={() => undefined}
      />,
    );

  it('says when the explanation describes older data than the page', () => {
    expect(render('2026-10-31T09:00:00.000Z')).toContain('This explanation is based on data as of 31 Oct 2026, 08:00 UTC');
    expect(render(narrative.dataAsOf)).not.toContain('This explanation is based on data as of');
  });

  it('shows the last included day of the covered window', () => {
    expect(render(narrative.dataAsOf)).toContain('Covers 3 Aug 2026 to 30 Oct 2026');
  });
});

describe('PeopleTable order', () => {
  const names = (markup: string) => [...markup.matchAll(/data-fact-row="person\.([^"]+)"/g)].map((m) => m[1]);

  it('breaks ties as the API does: reviewed, then merged, then login in code-unit order', () => {
    const rows = [
      { ...person('alice', 5), prsMerged: 1 },
      { ...person('Zed', 5), prsMerged: 1 },
      { ...person('mid', 5), prsMerged: 3 },
      person('top', 9),
    ];
    const markup = renderToStaticMarkup(<PeopleTable people={rows} revealLogin={null} />);
    expect(names(markup)).toEqual(['top', 'mid', 'Zed', 'alice']);
  });
});

describe('CoverageNotice', () => {
  const window = { from: '2026-08-03T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' };

  it('says nothing for complete coverage', () => {
    const coverage = { partial: false, ...window };
    expect(renderToStaticMarkup(<CoverageNotice coverage={coverage} window={window} />)).toBe('');
  });

  it('explains a backfill that stopped early', () => {
    const coverage = { partial: true, from: '2026-09-23T21:15:00.000Z', to: window.to };
    const markup = renderToStaticMarkup(<CoverageNotice coverage={coverage} window={window} />);
    expect(markup).toContain('synced history starts on');
    expect(markup).toMatch(/23 Sept? 2026, 21:15 UTC/);
    expect(markup).not.toContain('meta.coverageTo');
  });

  it('explains a refresh that was cut short at the end of the window', () => {
    const coverage = { partial: true, from: window.from, to: '2026-10-20T06:30:00.000Z' };
    const markup = renderToStaticMarkup(<CoverageNotice coverage={coverage} window={window} />);
    expect(markup).toContain('data-fact="meta.coverageTo"');
    expect(markup).toContain('20 Oct 2026, 06:30 UTC');
    expect(markup).toContain('30 Oct 2026');
    expect(markup).not.toContain('meta.coverageFrom');
  });
});

describe('ProblemNotice', () => {
  const urn = (slug: string) => `urn:tempo:problem:${slug}`;
  const render = (type: string, retryAfterSeconds?: number, status = 429) =>
    renderToStaticMarkup(
      <ProblemNotice
        problem={{ type, title: 'Title', status, detail: 'Detail', retryAfterSeconds }}
        what="No explanation"
        onRetry={() => undefined}
      />,
    );

  it('explains an exhausted explanation budget and holds Retry back for the wait', () => {
    const markup = render(urn('narrative-budget-exhausted'), 90);
    expect(markup).toContain('hourly');
    expect(markup).toContain('Retry in');
    expect(markup).toContain('disabled');
  });

  it('explains a refused request and offers no retry', () => {
    const markup = render(urn('forbidden'), undefined, 403);
    expect(markup).toContain('address');
    expect(markup).not.toContain('>Retry<');
  });

  it('does not name a dev command', () => {
    for (const slug of ['github-token-rejected', 'not-configured']) expect(render(urn(slug))).not.toContain('npm');
    expect(render('unreachable', undefined, 0)).not.toContain('npm');
  });
});

describe('NarrativePanel start', () => {
  const idle = (blockedReason: string | null) =>
    renderToStaticMarkup(
      <NarrativePanel
        state={{ status: 'idle' }}
        ready
        blockedReason={blockedReason}
        reportDataAsOf={null}
        onExplain={() => undefined}
        onCancel={() => undefined}
        canCite={() => false}
        onCite={() => undefined}
      />,
    );

  it('disables Explain with the reason when the range holds no whole day', () => {
    const markup = idle('Pick a start before today.');
    expect(markup).toContain('Pick a start before today.');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Explain</);
  });

  it('keeps Explain enabled otherwise', () => {
    expect(idle(null)).not.toMatch(/<button[^>]*disabled=""[^>]*>Explain</);
  });
});
