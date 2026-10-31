import { z } from 'zod';
import { CoverageSchema, nonNegativeInt, ratio, WindowSchema } from '../domain/schemas.js';

const EvidenceSchema = z.object({
  factId: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string()]).nullable().describe('The fact value from the metrics, not from the model'),
  unit: z
    .enum(['count', 'hours', 'share', 'login', 'week', 'datetime'])
    .describe('A share is a fraction from 0 to 1; a datetime is an ISO-8601 UTC instant'),
});

/** The narrative as the API returns it; also validates cached bodies before they are served again. */
export const NarrativeResponseSchema = z
  .object({
    repo: z.string(),
    window: WindowSchema,
    dataAsOf: z.iso.datetime(),
    coverage: CoverageSchema,
    summary: z.string(),
    findings: z.array(z.object({ claim: z.string(), evidence: z.array(EvidenceSchema) })),
    hypothesis: z
      .object({
        statement: z.string(),
        confidence: ratio.describe('0 to 1, after the cap for small samples'),
        reasoning: z.string(),
        evidence: z.array(EvidenceSchema),
        alternatives: z.array(z.string()),
      })
      .nullable(),
    caveats: z.array(z.string()),
    verification: z
      .object({
        droppedFindings: nonNegativeInt,
        droppedEvidenceIds: z.array(z.string()).describe('Cited ids that are unknown or have no value (at most 20)'),
        confidenceCapped: z.object({ from: ratio, to: ratio, reason: z.string() }).nullable(),
      })
      .describe('What the server removed or changed in the model output before returning it'),
    model: z.string().describe('Model that wrote the narrative, or "none" when no model was called'),
    promptVersion: z.string(),
    cached: z.boolean(),
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Narrative' });
