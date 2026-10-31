import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Narrative, Person } from '../types';
import { NarrativePanel } from './NarrativePanel';
import { Num } from './Num';
import { PeopleTable } from './PeopleTable';

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
});
