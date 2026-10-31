import type { FactSheet } from '../../src/narrative/factSheet.js';
import type { NarrativeModel, NarrativeModelResult } from '../../src/narrative/llmClient.js';
import type { NarrativeDraft } from '../../src/narrative/schema.js';

/** A draft that cites real ids from the small-repo sheet plus one id the verifier must drop. */
export const DRAFT: NarrativeDraft = {
  summary: 'Reviews arrive slowly and one reviewer carries much of the load.',
  findings: [
    { claim: 'Time to first review is long.', evidence: ['team.timeToFirstReview.median'] },
    { claim: 'Review load is concentrated.', evidence: ['team.reviewConcentration.topReviewerShare', 'made.up.id'] },
    { claim: 'Unsupported claim.', evidence: ['not.a.fact'] },
  ],
  hypothesis: {
    statement: 'A small reviewer pool slows first reviews.',
    confidence: 0.9,
    reasoning: 'Concentrated reviews coincide with long waits.',
    evidence: ['team.reviewConcentration.topReviewerShare', 'team.timeToFirstReview.median'],
    alternatives: ['Contributors opened PRs before a holiday.'],
  },
  caveats: ['Small sample.'],
};

/** Records every sheet it receives; returns `nextDraft`, or throws `failWith`. */
export class FakeNarrativeModel implements NarrativeModel {
  sheets: FactSheet[] = [];
  failWith: Error | null = null;
  nextDraft: NarrativeDraft = DRAFT;
  servedModel = 'claude-opus-5-5';

  async draft(sheet: FactSheet): Promise<NarrativeModelResult> {
    this.sheets.push(sheet);
    await Promise.resolve();
    if (this.failWith) throw this.failWith;
    return {
      draft: this.nextDraft,
      model: this.servedModel,
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 },
    };
  }

  get calls(): number {
    return this.sheets.length;
  }
}
