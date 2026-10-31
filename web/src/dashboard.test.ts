import { afterEach, describe, expect, it, vi } from 'vitest';
import { asProblem, fetchReport } from './api';
import { hourTicks, labelEvery } from './chart';
import { factOnScreen, parseFact } from './facts';
import { evidenceFigure, evidenceLabel, figureText, hours, share } from './format';
import { apiParams, parseRepo, queryFromSearch, searchFromQuery, validateWindow } from './query';
import type { ReviewFlowReport } from './types';

describe('format', () => {
  it('reads durations as minutes, hours, then days', () => {
    expect(hours(0.25)).toEqual({ value: '15', unit: 'min' });
    expect(hours(14.54)).toEqual({ value: '14.5', unit: 'h' });
    expect(hours(55.2)).toEqual({ value: '2.3', unit: 'd' });
    expect(hours(null)).toBeNull();
  });

  it('rounds before choosing the unit', () => {
    expect(figureText(hours(0.999))).toBe('1.0 h');
    expect(figureText(hours(47.96))).toBe('2.0 d');
    expect(figureText(hours(0.99))).toBe('59 min');
  });

  it('shows shares as percentages and missing values as a dash', () => {
    expect(figureText(share(0.4123))).toBe('41.2%');
    expect(figureText(share(0.55, 0))).toBe('55%');
    expect(figureText(share(null))).toBe('—');
  });

  it('formats evidence by its unit, never by parsing text', () => {
    expect(figureText(evidenceFigure({ value: 98.4, unit: 'hours' }))).toBe('4.1 d');
    expect(figureText(evidenceFigure({ value: 0.322, unit: 'share' }))).toBe('32.2%');
    expect(figureText(evidenceFigure({ value: 1234, unit: 'count' }))).toBe('1,234');
    expect(figureText(evidenceFigure({ value: 'mcollina', unit: 'login' }))).toBe('mcollina');
    expect(figureText(evidenceFigure({ value: '2026-09-23T21:15:00.000Z', unit: 'datetime' }))).toMatch(
      /^23 Sept? 2026, 21:15 UTC$/,
    );
    expect(evidenceFigure({ value: null, unit: 'hours' })).toBeNull();
  });

  it('shows yes/no facts as words', () => {
    const label = 'Bot accounts are counted as people (1 = yes, 0 = no)';
    expect(figureText(evidenceFigure({ label, value: 1, unit: 'count' }))).toBe('yes');
    expect(figureText(evidenceFigure({ label, value: 0, unit: 'count' }))).toBe('no');
    expect(evidenceLabel(label)).toBe('Bot accounts are counted as people');
  });

  it('drops unit words from fact labels', () => {
    expect(evidenceLabel('Median hours to first review')).toBe('Median time to first review');
    expect(evidenceLabel("Top reviewer's share of PR reviews, counted once per reviewer per PR (fraction 0-1)")).toBe(
      "Top reviewer's share of PR reviews",
    );
    expect(evidenceLabel('Median age in hours of PRs awaiting a first review')).toBe(
      'Median age of PRs awaiting a first review',
    );
  });
});

describe('query', () => {
  it('accepts owner/name and github.com URLs', () => {
    expect(parseRepo('fastify/fastify')).toEqual({ owner: 'fastify', repo: 'fastify' });
    expect(parseRepo('https://github.com/nodejs/undici.git')).toEqual({ owner: 'nodejs', repo: 'undici' });
    expect(parseRepo('fastify')).toBeNull();
    expect(parseRepo('a/b/c')).toBeNull();
    expect(parseRepo('-bad/name')).toBeNull();
    expect(parseRepo('owner/..')).toBeNull();
  });

  it('round-trips through the URL', () => {
    const query = { owner: 'pinojs', repo: 'pino', from: '2026-08-01', to: '2026-10-29', includeBots: true };
    expect(queryFromSearch(searchFromQuery(query))).toEqual(query);
  });

  it('falls back to a 90-day window ending at the given end date', () => {
    const query = queryFromSearch('?repo=nodejs/undici&to=2026-10-31&from=nonsense');
    expect(query).toMatchObject({ owner: 'nodejs', repo: 'undici', from: '2026-08-03', to: '2026-10-31' });
  });

  it('sends the inclusive end date as the next day', () => {
    const params = apiParams({ owner: 'a', repo: 'b', from: '2026-10-01', to: '2026-10-31', includeBots: false });
    expect(params.get('to')).toBe('2026-11-01');
    expect(params.get('includeBots')).toBe('false');
  });

  it('rejects reversed and over-long windows', () => {
    expect(validateWindow('2026-10-02', '2026-10-01')).toMatch(/after/);
    expect(validateWindow('2025-01-01', '2026-10-01')).toMatch(/366/);
    expect(validateWindow('2026-01-01', '2026-10-01')).toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(validateWindow('2026-02-30', '2026-03-10')).toMatch(/both dates/);
    expect(queryFromSearch('?to=2026-13-01').to).not.toBe('2026-13-01');
  });
});

describe('facts', () => {
  it('parses person and week ids', () => {
    expect(parseFact('person.dependabot[bot].prsMerged')).toMatchObject({ kind: 'person', login: 'dependabot[bot]' });
    expect(parseFact('week.2026-W42.medianFirstReviewHours')).toMatchObject({ kind: 'week', week: '2026-W42' });
    expect(parseFact('team.timeToMerge.median')).toMatchObject({ kind: 'team' });
    expect(parseFact('signal.reviewConcentration')).toBeNull();
  });

  const report = (overrides: { unlinkedCommits?: number; topReviewer?: string | null } = {}) =>
    ({
      people: [
        { login: 'mcollina', unlinked: false, commits: 3 },
        { login: 'Matteo Collina', unlinked: true, commits: overrides.unlinkedCommits ?? 2 },
      ],
      weekly: [{ week: '2026-W42' }],
      coverage: { partial: false },
      team: { reviewConcentration: { topReviewer: overrides.topReviewer === undefined ? 'mcollina' : overrides.topReviewer } },
    }) as unknown as ReviewFlowReport;

  it('shows the unlinked commit count and top reviewer only when they are rendered', () => {
    expect(factOnScreen('team.unlinkedCommits', report())).toBe(true);
    expect(factOnScreen('team.unlinkedCommits', report({ unlinkedCommits: 0 }))).toBe(false);
    expect(factOnScreen('team.reviewConcentration.topReviewer', report({ topReviewer: null }))).toBe(false);
  });

  it('knows which facts the dashboard shows', () => {
    expect(factOnScreen('person.mcollina.reviewShare', report())).toBe(true);
    expect(factOnScreen('person.ghost.reviewShare', report())).toBe(false);
    expect(factOnScreen('week.2026-W42.prsOpened', report())).toBe(true);
    expect(factOnScreen('week.2026-W01.prsOpened', report())).toBe(false);
    expect(factOnScreen('team.timeToFirstReview.median', report())).toBe(true);
    expect(factOnScreen('meta.coverageFrom', report())).toBe(false);
  });
});

describe('chart', () => {
  it('puts round hour ticks above the largest value', () => {
    expect(hourTicks(41.8)).toEqual([0, 12, 24, 36, 48]);
    expect(hourTicks(12)).toEqual([0, 6, 12, 18]);
    expect(hourTicks(1)).toEqual([0, 1, 2]);
  });

  it('thins labels to fit the width', () => {
    expect(labelEvery(13, 860, 60)).toBe(1);
    expect(labelEvery(13, 300, 60)).toBe(3);
  });
});

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports an aborted request as an abort, not as a problem', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => {
      controller.abort();
      return new Response(JSON.stringify({ title: 'Too many requests', detail: 'retry' }), { status: 429 });
    });
    const query = { owner: 'a', repo: 'b', from: '2026-10-01', to: '2026-10-31', includeBots: false };
    const error = await fetchReport(query, controller.signal).catch((e: unknown) => e);
    expect(asProblem(error)).toBeNull();
  });
});
