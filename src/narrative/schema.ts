import { z } from 'zod';

const CLAIM = 'Plain-language claim; do not state numbers that are not in the cited facts';
const evidence = () => z.array(z.string()).describe('Fact ids copied exactly from the fact sheet');

/**
 * The LLM output contract. Kept to plain object, array, string, number and nullable types (plus descriptions) so
 * it converts to a structured-output JSON schema as is. Evidence entries are fact ids; `verifyNarrative` checks
 * them and clamps `confidence`.
 */
export const NarrativeDraftSchema = z.object({
  summary: z.string().describe('Two or three sentences on the review flow in the window, without numbers'),
  findings: z.array(z.object({ claim: z.string().describe(CLAIM), evidence: evidence() })),
  hypothesis: z
    .object({
      statement: z.string().describe(CLAIM),
      confidence: z.number().describe('Number from 0 to 1'),
      reasoning: z.string().describe('Why the cited facts support the statement'),
      evidence: evidence(),
      alternatives: z.array(z.string()).describe('Other explanations that fit the same facts'),
    })
    .nullable(),
  caveats: z.array(z.string()).describe('Limits of the data, such as small samples or partial coverage'),
});

export type NarrativeDraft = z.infer<typeof NarrativeDraftSchema>;
