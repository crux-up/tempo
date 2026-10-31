import { describe, expect, it } from 'vitest';
import { buildFactSheet } from '../../src/narrative/factSheet.js';
import { smallReport } from '../../test/narrative/reportFixture.js';
import { FACT, factOnScreen, parseFact } from './facts';
import type { ReviewFlowReport } from './types';

/** A report whose sheet carries every kind of fact: partial at both ends, with unlinked commits and a top reviewer. */
function partialReport(): ReviewFlowReport {
  const base = smallReport();
  const from = Date.parse(base.window.from) + 86_400_000;
  const to = Date.parse(base.window.to) - 86_400_000;
  return { ...base, coverage: { partial: true, from: new Date(from).toISOString(), to: new Date(to).toISOString() } };
}

/** Person fields the people table shows; `linesChanged` is deliberately kept off the screen. */
const PERSON_FIELDS_ON_SCREEN = [
  'prsReviewed',
  'reviewsSubmitted',
  'reviewShare',
  'codeShare',
  'prsMerged',
  'prsOpened',
  'approvals',
  'changesRequested',
  'reviewComments',
  'commits',
];

describe('fact ids shared with the server', () => {
  const report = partialReport();
  const ids = buildFactSheet(report).facts.map((f) => f.id);
  const teamIds: string[] = Object.values(FACT);

  it('recognises every id in the server fact sheet', () => {
    const unknown = ids.filter((id) => {
      const target = parseFact(id);
      return !target || (target.kind === 'team' && !teamIds.includes(id));
    });
    expect(unknown).toEqual([]);
  });

  it('finds every team and meta id the dashboard marks in the fact sheet', () => {
    expect(teamIds.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it('shows every fact except the deliberately off-screen ones', () => {
    const offScreen = ids.filter((id) => !factOnScreen(id, report));
    expect(offScreen.filter((id) => !id.endsWith('.linesChanged'))).toEqual([]);
  });

  it('names the person fields the people table shows', () => {
    const fields = new Set(ids.filter((id) => id.startsWith('person.')).map((id) => id.split('.').pop()));
    for (const field of PERSON_FIELDS_ON_SCREEN) expect(fields.has(field)).toBe(true);
  });
});
