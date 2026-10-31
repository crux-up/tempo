import type { z } from 'zod';
import type { NarrativeResponseSchema, ReviewFlowReportSchema } from '@api/http/params.js';

export type ReviewFlowReport = z.infer<typeof ReviewFlowReportSchema>;
export type Narrative = z.infer<typeof NarrativeResponseSchema>;
export type Evidence = Narrative['findings'][number]['evidence'][number];
export type Person = ReviewFlowReport['people'][number];
export type Week = ReviewFlowReport['weekly'][number];
