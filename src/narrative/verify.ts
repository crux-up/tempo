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

const CAPS: [{ below: number; max: number }, ...{ below: number; max: number }[]] = [
  { below: 10, max: 0.3 },
  { below: 20, max: 0.5 },
];

const MAX_DROPPED_IDS = 20;
const MAX_ID_LENGTH = 120;

const numberFact = (sheet: FactSheet, id: string): number | null => {
  const value = sheet.facts.find((f) => f.id === id)?.value;
  return typeof value === 'number' ? value : null;
};

/**
 * Limits hypothesis confidence when the window holds few PRs: sample = max(PRs opened, PRs merged). A sheet without
 * both counts gets the strictest cap.
 */
export function confidenceCap(sheet: FactSheet): { max: number; reason: string } | null {
  const opened = numberFact(sheet, 'team.prsOpened');
  const merged = numberFact(sheet, 'team.prsMerged');
  if (opened === null || merged === null) {
    return { max: CAPS[0].max, reason: 'PR counts are missing from the fact sheet' };
  }
  const sample = Math.max(opened, merged);
  const cap = CAPS.find((c) => sample < c.below);
  if (!cap) return null;
  return { max: cap.max, reason: `Only ${sample} PRs were opened or merged in the window (fewer than ${cap.below}).` };
}

const clamp01 = (n: number) => (Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));

/**
 * Keeps the draft text verbatim but trusts none of its numbers: each evidence id is looked up in the sheet and
 * replaced by the sheet's label, value and unit. Unknown ids and ids of facts with a null value are dropped and
 * listed (at most 20, each cut to 120 characters); a finding or hypothesis left without evidence is dropped. Confidence is clamped to [0, 1] and then to `confidenceCap`.
 */
export function verifyNarrative(draft: NarrativeDraft, sheet: FactSheet): Narrative {
  const facts = new Map(sheet.facts.map((f) => [f.id, f]));
  const dropped = new Set<string>();

  const resolve = (evidenceIds: string[]): Evidence[] => {
    const evidence: Evidence[] = [];
    for (const id of new Set(evidenceIds)) {
      const fact = facts.get(id);
      if (fact && fact.value !== null) {
        evidence.push({ factId: fact.id, label: fact.label, value: fact.value, unit: fact.unit });
      } else if (dropped.size < MAX_DROPPED_IDS) {
        dropped.add(id.slice(0, MAX_ID_LENGTH));
      }
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
