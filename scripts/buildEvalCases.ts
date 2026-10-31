import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonStats, WeekStats } from '../src/domain/types.js';
import { buildFactSheet } from '../src/narrative/factSheet.js';
import type { ReviewFlowReport } from '../src/domain/types.js';

/** Regenerates scripts/evalCases/*.json from the hand-written reports below, through the real buildFactSheet. */

const OUT_DIR = join(import.meta.dirname, 'evalCases');

const person = (login: string, p: Partial<PersonStats>): PersonStats => ({
  login,
  unlinked: false,
  commits: 0,
  prsOpened: 0,
  prsMerged: 0,
  linesChanged: 0,
  reviewsSubmitted: 0,
  prsReviewed: 0,
  approvals: 0,
  changesRequested: 0,
  reviewComments: 0,
  reviewShare: 0,
  codeShare: 0,
  ...p,
});

const WEEKS = [
  ['2026-W36', '2026-08-31'],
  ['2026-W37', '2026-09-07'],
  ['2026-W38', '2026-09-14'],
  ['2026-W39', '2026-09-21'],
  ['2026-W40', '2026-09-28'],
] as const;

const weekly = (
  opened: number[],
  merged: number[],
  reviews: number[],
  median: (number | null)[],
  sample: number[],
): WeekStats[] =>
  WEEKS.map(([week, weekStart], i) => ({
    week,
    weekStart,
    prsOpened: opened[i] ?? 0,
    prsMerged: merged[i] ?? 0,
    reviewsSubmitted: reviews[i] ?? 0,
    medianFirstReviewHours: median[i] ?? null,
    firstReviewSample: sample[i] ?? 0,
  }));

type Spec = {
  repo: string;
  opened: number;
  merged: number;
  reviews: number;
  ttfr: [median: number, p90: number, sample: number];
  awaiting: [count: number, medianAge: number | null];
  ttm: [median: number, p90: number, sample: number];
  unreviewed: [count: number, share: number | null];
  concentration: [login: string, share: number, reviewersFor50: number];
  people: PersonStats[];
  weekly: WeekStats[];
};

function report(o: Spec): ReviewFlowReport {
  const sum = (field: (p: PersonStats) => number) => o.people.reduce((total, p) => total + field(p), 0);
  return {
    repo: o.repo,
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    dataAsOf: '2026-10-01T00:00:00.000Z',
    coverage: { partial: false, from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    includeBots: false,
    team: {
      prsOpened: o.opened,
      prsMerged: o.merged,
      reviewsSubmitted: o.reviews,
      timeToFirstReview: { medianHours: o.ttfr[0], p90Hours: o.ttfr[1], sampleSize: o.ttfr[2] },
      awaitingFirstReview: { count: o.awaiting[0], medianAgeHours: o.awaiting[1] },
      timeToMerge: { medianHours: o.ttm[0], p90Hours: o.ttm[1], sampleSize: o.ttm[2] },
      mergedWithoutReview: { count: o.unreviewed[0], share: o.unreviewed[1] },
      reviewConcentration: {
        topReviewer: o.concentration[0],
        topReviewerShare: o.concentration[1],
        reviewersFor50Pct: o.concentration[2],
      },
    },
    people: o.people,
    totals: {
      commits: sum((p) => p.commits),
      prsOpened: sum((p) => p.prsOpened),
      prsMerged: sum((p) => p.prsMerged),
      linesChanged: sum((p) => p.linesChanged),
      reviewsSubmitted: sum((p) => p.reviewsSubmitted),
      prsReviewed: sum((p) => p.prsReviewed),
      approvals: sum((p) => p.approvals),
      changesRequested: sum((p) => p.changesRequested),
      reviewComments: sum((p) => p.reviewComments),
    },
    weekly: o.weekly,
  };
}

type CaseMeta = { name: string; expectHypothesis: boolean; minConfidence?: number };

const save = (file: string, meta: CaseMeta, spec: Spec) =>
  writeFileSync(join(OUT_DIR, `${file}.json`), JSON.stringify({ ...meta, sheet: buildFactSheet(report(spec)) }, null, 2) + '\n');

save('bottleneck', { name: 'bottleneck', expectHypothesis: true, minConfidence: 0.6 }, {
  repo: 'acme/payments',
  opened: 58,
  merged: 52,
  reviews: 96,
  ttfr: [14.5, 52, 50],
  awaiting: [4, 61],
  ttm: [30, 120, 52],
  unreviewed: [2, 0.04],
  concentration: ['maya-k', 0.6, 1],
  people: [
    person('maya-k', { commits: 40, prsOpened: 9, prsMerged: 21, linesChanged: 5200, reviewsSubmitted: 58, prsReviewed: 31, approvals: 25, changesRequested: 9, reviewComments: 88, reviewShare: 0.6, codeShare: 0.4 }),
    person('tomas-r', { commits: 33, prsOpened: 18, prsMerged: 14, linesChanged: 3100, reviewsSubmitted: 14, prsReviewed: 9, approvals: 8, changesRequested: 2, reviewComments: 21, reviewShare: 0.17, codeShare: 0.27 }),
    person('li-wei', { commits: 29, prsOpened: 16, prsMerged: 11, linesChanged: 2400, reviewsSubmitted: 12, prsReviewed: 7, approvals: 6, changesRequested: 1, reviewComments: 14, reviewShare: 0.13, codeShare: 0.21 }),
    person('sam-oduya', { commits: 20, prsOpened: 15, prsMerged: 6, linesChanged: 1300, reviewsSubmitted: 12, prsReviewed: 5, approvals: 4, changesRequested: 1, reviewComments: 9, reviewShare: 0.1, codeShare: 0.12 }),
  ],
  weekly: weekly([11, 12, 12, 12, 11], [9, 11, 11, 11, 10], [22, 20, 19, 18, 17], [8, 7.5, 12, 24, 49], [10, 11, 11, 10, 8]),
});

save('healthy', { name: 'healthy', expectHypothesis: false }, {
  repo: 'acme/web',
  opened: 46,
  merged: 44,
  reviews: 120,
  ttfr: [3.2, 9.5, 44],
  awaiting: [1, 5],
  ttm: [11, 30, 44],
  unreviewed: [1, 0.02],
  concentration: ['nora-b', 0.24, 3],
  people: [
    person('nora-b', { commits: 22, prsOpened: 9, prsMerged: 9, linesChanged: 1800, reviewsSubmitted: 30, prsReviewed: 20, approvals: 16, changesRequested: 3, reviewComments: 40, reviewShare: 0.24, codeShare: 0.2 }),
    person('omar-h', { commits: 24, prsOpened: 10, prsMerged: 10, linesChanged: 2100, reviewsSubmitted: 28, prsReviewed: 19, approvals: 15, changesRequested: 3, reviewComments: 36, reviewShare: 0.23, codeShare: 0.23 }),
    person('priya-s', { commits: 20, prsOpened: 9, prsMerged: 9, linesChanged: 1700, reviewsSubmitted: 27, prsReviewed: 18, approvals: 14, changesRequested: 4, reviewComments: 33, reviewShare: 0.22, codeShare: 0.2 }),
    person('quinn-d', { commits: 19, prsOpened: 9, prsMerged: 8, linesChanged: 1500, reviewsSubmitted: 18, prsReviewed: 13, approvals: 11, changesRequested: 2, reviewComments: 24, reviewShare: 0.16, codeShare: 0.18 }),
    person('rui-m', { commits: 18, prsOpened: 9, prsMerged: 8, linesChanged: 1400, reviewsSubmitted: 17, prsReviewed: 12, approvals: 10, changesRequested: 2, reviewComments: 20, reviewShare: 0.15, codeShare: 0.19 }),
  ],
  weekly: weekly([9, 10, 9, 9, 9], [9, 9, 9, 9, 8], [24, 25, 24, 24, 23], [3.1, 3.4, 3.0, 3.3, 3.2], [9, 9, 9, 9, 8]),
});

save('tinySample', { name: 'tiny sample', expectHypothesis: false }, {
  repo: 'acme/internal-tools',
  opened: 6,
  merged: 5,
  reviews: 7,
  ttfr: [20, 60, 5],
  awaiting: [1, 30],
  ttm: [40, 90, 5],
  unreviewed: [1, 0.2],
  concentration: ['dana-v', 0.5, 1],
  people: [
    person('dana-v', { commits: 8, prsOpened: 3, prsMerged: 3, linesChanged: 600, reviewsSubmitted: 4, prsReviewed: 3, approvals: 3, changesRequested: 0, reviewComments: 4, reviewShare: 0.5, codeShare: 0.6 }),
    person('eli-t', { commits: 5, prsOpened: 3, prsMerged: 2, linesChanged: 300, reviewsSubmitted: 3, prsReviewed: 3, approvals: 2, changesRequested: 1, reviewComments: 3, reviewShare: 0.5, codeShare: 0.4 }),
  ],
  weekly: weekly([1, 2, 1, 1, 1], [1, 1, 1, 1, 1], [1, 2, 1, 2, 1], [18, 22, 15, 26, null], [1, 2, 1, 1, 0]),
});

save('benignSignals', { name: 'benign-signals', expectHypothesis: false }, {
  repo: 'acme/docs',
  opened: 42,
  merged: 41,
  reviews: 70,
  ttfr: [6.1, 17, 40],
  awaiting: [2, 8],
  ttm: [18, 48, 41],
  unreviewed: [2, 0.05],
  concentration: ['alex-p', 0.28, 3],
  people: [
    person('alex-p', { commits: 18, prsOpened: 11, prsMerged: 11, linesChanged: 1200, reviewsSubmitted: 20, prsReviewed: 15, approvals: 12, changesRequested: 2, reviewComments: 19, reviewShare: 0.28, codeShare: 0.27 }),
    person('bea-n', { commits: 17, prsOpened: 10, prsMerged: 10, linesChanged: 1100, reviewsSubmitted: 18, prsReviewed: 14, approvals: 11, changesRequested: 2, reviewComments: 17, reviewShare: 0.26, codeShare: 0.24 }),
    person('cal-j', { commits: 16, prsOpened: 11, prsMerged: 10, linesChanged: 1000, reviewsSubmitted: 17, prsReviewed: 13, approvals: 10, changesRequested: 3, reviewComments: 15, reviewShare: 0.24, codeShare: 0.24 }),
    person('dee-f', { commits: 14, prsOpened: 10, prsMerged: 10, linesChanged: 900, reviewsSubmitted: 15, prsReviewed: 12, approvals: 9, changesRequested: 2, reviewComments: 14, reviewShare: 0.22, codeShare: 0.25 }),
  ],
  weekly: weekly([8, 9, 8, 9, 8], [8, 8, 8, 9, 8], [14, 14, 14, 14, 14], [6.0, 6.3, 5.9, 6.2, 6.1], [8, 9, 8, 9, 8]),
});
