import { z } from 'zod';

/**
 * The LLM output contract. Kept to plain object, array, string, number and nullable types so it converts to a
 * structured-output JSON schema as is. Evidence entries are fact ids; `verifyNarrative` checks them and clamps
 * `confidence`.
 */
export const NarrativeDraftSchema = z.object({
  summary: z.string(),
  findings: z.array(z.object({ claim: z.string(), evidence: z.array(z.string()) })),
  hypothesis: z
    .object({
      statement: z.string(),
      confidence: z.number(),
      reasoning: z.string(),
      evidence: z.array(z.string()),
      alternatives: z.array(z.string()),
    })
    .nullable(),
  caveats: z.array(z.string()),
});

export type NarrativeDraft = z.infer<typeof NarrativeDraftSchema>;
