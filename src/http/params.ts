import { z } from 'zod';
import { CoverageSchema, nonNegativeInt, ratio, WindowSchema } from '../domain/schemas.js';
import type { NarrativeQuery, ReviewFlowQuery, ReviewFlowReport } from '../domain/types.js';

/* Request and response schemas of the HTTP API; each one is checked against the domain type it carries. */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoParams = z.object({
  owner: z.string().regex(OWNER, 'must be a valid GitHub owner login').describe('Repository owner, e.g. fastify'),
  repo: z
    .string()
    .regex(NAME, 'must be a valid GitHub repository name')
    .refine((name) => name !== '.' && name !== '..', 'must not be . or ..')
    .describe('Repository name, e.g. fastify'),
});

export const ReviewFlowQuerySchema = z.object({
  from: z
    .string()
    .optional()
    .describe(
      'Window start (inclusive): YYYY-MM-DD (UTC midnight) or ISO-8601 datetime with offset. ' +
        'Default: to minus 30 days. At most 2 years before now.',
    ),
  to: z
    .string()
    .optional()
    .describe('Window end (exclusive), same formats as from. Default and maximum: now.'),
  includeBots: z
    .enum(['true', 'false'])
    .optional()
    .describe('Count bot accounts as people. Default: false.'),
}) satisfies z.ZodType<ReviewFlowQuery>;

const hours = z.number().nonnegative().nullable();

const DurationStatSchema = z.object({ medianHours: hours, p90Hours: hours, sampleSize: nonNegativeInt });

const TotalsSchema = z.object({
  commits: nonNegativeInt,
  prsOpened: nonNegativeInt,
  prsMerged: nonNegativeInt,
  linesChanged: nonNegativeInt,
  reviewsSubmitted: nonNegativeInt,
  prsReviewed: nonNegativeInt,
  approvals: nonNegativeInt,
  changesRequested: nonNegativeInt,
  reviewComments: nonNegativeInt,
});

const PersonStatsSchema = TotalsSchema.extend({
  login: z.string().describe('GitHub login, or the git author name when the commit is not linked to an account'),
  unlinked: z.boolean().describe('True when `login` is a git author name with no linked GitHub account'),
  reviewShare: ratio,
  codeShare: ratio,
});

const WeekStatsSchema = z.object({
  week: z.string().describe('ISO week, e.g. 2026-W10'),
  weekStart: z.string().describe('Monday of the ISO week, YYYY-MM-DD'),
  prsOpened: nonNegativeInt,
  prsMerged: nonNegativeInt,
  reviewsSubmitted: nonNegativeInt,
  medianFirstReviewHours: hours,
  firstReviewSample: nonNegativeInt,
});

const TeamStatsSchema = z.object({
  prsOpened: nonNegativeInt,
  prsMerged: nonNegativeInt,
  reviewsSubmitted: nonNegativeInt,
  timeToFirstReview: DurationStatSchema,
  awaitingFirstReview: z.object({ count: nonNegativeInt, medianAgeHours: hours }),
  timeToMerge: DurationStatSchema,
  mergedWithoutReview: z.object({ count: nonNegativeInt, share: ratio.nullable() }),
  reviewConcentration: z.object({
    topReviewer: z.string().nullable(),
    topReviewerShare: ratio.nullable(),
    reviewersFor50Pct: nonNegativeInt,
  }),
});

export const ReviewFlowReportSchema = z
  .object({
    repo: z.string().describe('Canonical owner/name as GitHub reports it'),
    window: WindowSchema.describe('Resolved half-open UTC window'),
    dataAsOf: z.iso.datetime().describe('When the stored data was last synced from GitHub'),
    coverage: CoverageSchema,
    includeBots: z.boolean(),
    team: TeamStatsSchema,
    people: z.array(PersonStatsSchema),
    totals: TotalsSchema,
    weekly: z.array(WeekStatsSchema),
  })
  .meta({ id: 'ReviewFlowReport' }) satisfies z.ZodType<ReviewFlowReport>;

export const HealthSchema = z.object({ status: z.literal('ok') });
export const ReadySchema = z.object({ status: z.literal('ready') });

export const NarrativeQuerySchema = ReviewFlowQuerySchema.extend({
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .describe('Generate a new narrative even when a cached one exists. Default: false.'),
}) satisfies z.ZodType<NarrativeQuery>;
