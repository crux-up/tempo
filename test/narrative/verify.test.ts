import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FactSheet } from '../../src/narrative/factSheet.js';
import { NarrativeDraftSchema, type NarrativeDraft } from '../../src/narrative/schema.js';
import { confidenceCap, verifyNarrative } from '../../src/narrative/verify.js';

const sheetWith = (prsOpened: number, prsMerged: number): FactSheet => ({
  repo: 'acme/widgets',
  window: { from: '2026-03-02T00:00:00.000Z', to: '2026-03-16T00:00:00.000Z' },
  facts: [
    { id: 'team.prsOpened', label: 'PRs opened', value: prsOpened, unit: 'count' },
    { id: 'team.prsMerged', label: 'PRs merged', value: prsMerged, unit: 'count' },
    { id: 'team.timeToFirstReview.median', label: 'Median hours to first review', value: 74, unit: 'hours', sampleSize: 2 },
    { id: 'person.bob.prsReviewed', label: 'bob: PRs reviewed', value: 2, unit: 'count' },
  ],
  signals: [],
});

const sheet = sheetWith(15, 12);

type Hypothesis = NonNullable<NarrativeDraft['hypothesis']>;

const hypothesis = (overrides: Partial<Hypothesis> = {}): Hypothesis => ({
  statement: 'Review load sits on one person.',
  confidence: 0.4,
  reasoning: 'bob reviews most PRs.',
  evidence: ['person.bob.prsReviewed'],
  alternatives: ['Large PRs take longer to review.'],
  ...overrides,
});

const draft = (overrides: Partial<NarrativeDraft> = {}): NarrativeDraft => ({
  summary: 'Reviews are slow.',
  findings: [{ claim: 'First review takes about three days.', evidence: ['team.timeToFirstReview.median'] }],
  hypothesis: hypothesis(),
  caveats: ['Small sample.'],
  ...overrides,
});

describe('verifyNarrative', () => {
  it('attaches the sheet label, value and unit to known evidence and keeps the draft text', () => {
    const result = verifyNarrative(
      draft({ findings: [{ claim: 'First review takes 999 hours.', evidence: ['team.timeToFirstReview.median'] }] }),
      sheet,
    );
    expect(result.summary).toBe('Reviews are slow.');
    expect(result.findings).toEqual([
      {
        claim: 'First review takes 999 hours.',
        evidence: [
          { factId: 'team.timeToFirstReview.median', label: 'Median hours to first review', value: 74, unit: 'hours' },
        ],
      },
    ]);
    expect(result.hypothesis).toEqual({
      ...hypothesis(),
      evidence: [{ factId: 'person.bob.prsReviewed', label: 'bob: PRs reviewed', value: 2, unit: 'count' }],
    });
    expect(result.caveats).toEqual(['Small sample.']);
    expect(result.verification).toEqual({ droppedFindings: 0, droppedEvidenceIds: [], confidenceCapped: null });
  });

  it('drops an unknown evidence id, records it, and dedupes repeated ids', () => {
    const result = verifyNarrative(
      draft({ findings: [{ claim: 'c', evidence: ['team.prsMerged', 'team.madeUp', 'team.prsMerged', 'team.madeUp'] }] }),
      sheet,
    );
    expect(result.findings[0]?.evidence.map((e) => e.factId)).toEqual(['team.prsMerged']);
    expect(result.verification.droppedEvidenceIds).toEqual(['team.madeUp']);
  });

  it('drops findings left with no valid evidence', () => {
    const result = verifyNarrative(
      draft({
        findings: [
          { claim: 'keep', evidence: ['team.prsOpened'] },
          { claim: 'drop', evidence: ['person.mallory.prsMerged', 'team.madeUp'] },
          { claim: 'drop too', evidence: [] },
        ],
      }),
      sheet,
    );
    expect(result.findings.map((f) => f.claim)).toEqual(['keep']);
    expect(result.verification.droppedFindings).toBe(2);
    expect(result.verification.droppedEvidenceIds).toEqual(['person.mallory.prsMerged', 'team.madeUp']);
  });

  it('lists each unknown id once across findings and hypothesis', () => {
    const result = verifyNarrative(
      draft({
        findings: [{ claim: 'a', evidence: ['team.x', 'team.prsOpened'] }],
        hypothesis: hypothesis({ evidence: ['team.x', 'person.bob.prsReviewed'] }),
      }),
      sheet,
    );
    expect(result.verification.droppedEvidenceIds).toEqual(['team.x']);
  });

  it('nulls the hypothesis when its evidence is all unknown', () => {
    const result = verifyNarrative(draft({ hypothesis: hypothesis({ evidence: ['team.madeUp'], confidence: 0.9 }) }), sheet);
    expect(result.hypothesis).toBeNull();
    expect(result.verification.droppedEvidenceIds).toEqual(['team.madeUp']);
    expect(result.verification.confidenceCapped).toBeNull();
  });

  it('keeps a null hypothesis null', () => {
    expect(verifyNarrative(draft({ hypothesis: null }), sheet).hypothesis).toBeNull();
  });

  it('caps confidence 0.9 to 0.5 when the sample is 15 and reports it', () => {
    const result = verifyNarrative(draft({ hypothesis: hypothesis({ confidence: 0.9 }) }), sheet);
    expect(result.hypothesis?.confidence).toBe(0.5);
    expect(result.verification.confidenceCapped).toEqual({
      from: 0.9,
      to: 0.5,
      reason: 'Only 15 PRs were opened or merged in the window (fewer than 20).',
    });
  });

  it('leaves confidence under the cap alone', () => {
    const result = verifyNarrative(draft(), sheet);
    expect(result.hypothesis?.confidence).toBe(0.4);
    expect(result.verification.confidenceCapped).toBeNull();
  });

  it('clamps confidence into [0, 1] before capping', () => {
    const big = sheetWith(30, 40);
    const high = verifyNarrative(draft({ hypothesis: hypothesis({ confidence: 3 }) }), big);
    expect(high.hypothesis?.confidence).toBe(1);
    expect(high.verification.confidenceCapped).toBeNull();
    expect(verifyNarrative(draft({ hypothesis: hypothesis({ confidence: -2 }) }), big).hypothesis?.confidence).toBe(0);
    expect(verifyNarrative(draft({ hypothesis: hypothesis({ confidence: Number.NaN }) }), big).hypothesis?.confidence).toBe(0);
    const capped = verifyNarrative(draft({ hypothesis: hypothesis({ confidence: 7 }) }), sheetWith(3, 2));
    expect(capped.hypothesis?.confidence).toBe(0.3);
    expect(capped.verification.confidenceCapped).toMatchObject({ from: 1, to: 0.3 });
  });
});

describe('confidenceCap', () => {
  it('uses the larger of PRs opened and merged as the sample', () => {
    expect(confidenceCap(sheetWith(9, 4))).toEqual({
      max: 0.3,
      reason: 'Only 9 PRs were opened or merged in the window (fewer than 10).',
    });
    expect(confidenceCap(sheetWith(4, 10))?.max).toBe(0.5);
    expect(confidenceCap(sheetWith(19, 3))?.max).toBe(0.5);
    expect(confidenceCap(sheetWith(20, 3))).toBeNull();
    expect(confidenceCap(sheetWith(3, 25))).toBeNull();
  });

  it('applies the strictest cap when the sheet lacks PR counts', () => {
    expect(confidenceCap({ ...sheet, facts: [] })?.max).toBe(0.3);
  });
});

describe('NarrativeDraftSchema', () => {
  it('accepts a well-formed draft and a null hypothesis', () => {
    expect(NarrativeDraftSchema.parse(draft())).toEqual(draft());
    expect(NarrativeDraftSchema.safeParse(draft({ hypothesis: null })).success).toBe(true);
  });

  it('rejects evidence that is not a list of strings and a missing hypothesis key', () => {
    expect(NarrativeDraftSchema.safeParse({ ...draft(), findings: [{ claim: 'c', evidence: [1] }] }).success).toBe(false);
    const noHypothesis: Record<string, unknown> = { ...draft() };
    delete noHypothesis.hypothesis;
    expect(NarrativeDraftSchema.safeParse(noHypothesis).success).toBe(false);
  });

  it('converts to a plain JSON schema with no numeric or string constraints', () => {
    const json = JSON.stringify(z.toJSONSchema(NarrativeDraftSchema));
    expect(json).not.toMatch(/minimum|maximum|minLength|maxLength|pattern|minItems|maxItems/);
  });
});
