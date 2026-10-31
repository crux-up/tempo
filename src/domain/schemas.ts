import { z } from 'zod';
import type { Coverage } from './types.js';

/** Zod building blocks shared by the HTTP contract and the narrative cache. */
export const nonNegativeInt = z.number().int().nonnegative();
export const ratio = z.number().min(0).max(1);
export const WindowSchema = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });

export const CoverageSchema = z
  .object({ partial: z.boolean(), from: z.iso.datetime(), to: z.iso.datetime() })
  .describe(
    'Part of the window backed by synced data. Partial when a sync budget cut the backfill short (from is later ' +
      'than window.from) or cut a refresh short (to is dataAsOf, earlier than window.to).',
  ) satisfies z.ZodType<Coverage>;
