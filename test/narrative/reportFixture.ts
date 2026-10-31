import type { PersonStats } from '../../src/domain/types.js';
import { computeReviewFlow } from '../../src/metrics/reviewFlow.js';
import type { ReviewFlowReport } from '../../src/domain/types.js';
import { smallRepo, WINDOW } from '../fixtures/smallRepo.js';

export const smallReport = (): ReviewFlowReport => ({
  repo: 'acme/widgets',
  window: { from: WINDOW.from.toISOString(), to: WINDOW.to.toISOString() },
  dataAsOf: '2026-03-20T00:00:00.000Z',
  coverage: { partial: false, from: WINDOW.from.toISOString(), to: WINDOW.to.toISOString() },
  includeBots: false,
  ...computeReviewFlow(smallRepo()),
});

export const personRow = (login: string, overrides: Partial<PersonStats> = {}): PersonStats => ({
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
  ...overrides,
});
