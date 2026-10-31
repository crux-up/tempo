import type { Fact, FactSheet } from './factSheet.js';
import type { NarrativeDraft } from './schema.js';

export type Evidence = { factId: string; label: string; value: number | string | null; unit: Fact['unit'] };

export type Narrative = {
  summary: string;
  findings: { claim: string; evidence: Evidence[] }[];
  hypothesis: {
    statement: string;
    confidence: number;
    reasoning: string;
    evidence: Evidence[];
    alternatives: string[];
  } | null;
  caveats: string[];
  verification: {
    droppedFindings: number;
    droppedEvidenceIds: string[];
    confidenceCapped: { from: number; to: number; reason: string } | null;
  };
};

const CAPS = [
  { below: 10, max: 0.3 },
  { below: 20, max: 0.5 },
];

const numberFact = (sheet: FactSheet, id: string): number => {
  const value = sheet.facts.find((f) => f.id === id)?.value;
  return typeof value === 'number' ? value : 0;
};

/** Limits hypothesis confidence when the window holds few PRs: sample = max(PRs opened, PRs merged). */
export function confidenceCap(sheet: FactSheet): { max: number; reason: string } | null {
  const sample = Math.max(numberFact(sheet, 'team.prsOpened'), numberFact(sheet, 'team.prsMerged'));
  const cap = CAPS.find((c) => sample < c.below);
  if (!cap) return null;
  return { max: cap.max, reason: `Only ${sample} PRs were opened or merged in the window (fewer than ${cap.below}).` };
}

const clamp01 = (n: number) => (Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));

/**
 * Keeps the draft text verbatim but trusts none of its numbers: each evidence id is looked up in the sheet and
 * replaced by the sheet's label, value and unit. Unknown ids are dropped and listed; a finding or hypothesis left
 * without evidence is dropped. Confidence is clamped to [0, 1] and then to `confidenceCap`.
 */
export function verifyNarrative(draft: NarrativeDraft, sheet: FactSheet): Narrative {
  const facts = new Map(sheet.facts.map((f) => [f.id, f]));
  const dropped = new Set<string>();

  const resolve = (evidenceIds: string[]): Evidence[] => {
    const evidence: Evidence[] = [];
    for (const id of new Set(evidenceIds)) {
      const fact = facts.get(id);
      if (fact) evidence.push({ factId: fact.id, label: fact.label, value: fact.value, unit: fact.unit });
      else dropped.add(id);
    }
    return evidence;
  };

  const findings = draft.findings
    .map((f) => ({ claim: f.claim, evidence: resolve(f.evidence) }))
    .filter((f) => f.evidence.length > 0);

  let hypothesis: Narrative['hypothesis'] = null;
  let confidenceCapped: Narrative['verification']['confidenceCapped'] = null;
  if (draft.hypothesis) {
    const evidence = resolve(draft.hypothesis.evidence);
    if (evidence.length > 0) {
      let confidence = clamp01(draft.hypothesis.confidence);
      const cap = confidenceCap(sheet);
      if (cap && confidence > cap.max) {
        confidenceCapped = { from: confidence, to: cap.max, reason: cap.reason };
        confidence = cap.max;
      }
      const { statement, reasoning, alternatives } = draft.hypothesis;
      hypothesis = { statement, confidence, reasoning, evidence, alternatives };
    }
  }

  return {
    summary: draft.summary,
    findings,
    hypothesis,
    caveats: draft.caveats,
    verification: {
      droppedFindings: draft.findings.length - findings.length,
      droppedEvidenceIds: [...dropped],
      confidenceCapped,
    },
  };
}
