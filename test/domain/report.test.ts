import { describe, expect, it } from 'vitest';
import { hasActivity, unlinkedCommitCount } from '../../src/domain/report.js';
import { personRow } from '../narrative/reportFixture.js';

describe('report helpers', () => {
  it('counts a window as active when a PR was opened or merged or a review was submitted', () => {
    expect(hasActivity({ prsOpened: 0, prsMerged: 0, reviewsSubmitted: 0 })).toBe(false);
    expect(hasActivity({ prsOpened: 0, prsMerged: 0, reviewsSubmitted: 1 })).toBe(true);
    expect(hasActivity({ prsOpened: 0, prsMerged: 2, reviewsSubmitted: 0 })).toBe(true);
  });

  it('sums commits of unlinked authors only', () => {
    const people = [
      personRow('alice', { commits: 5 }),
      personRow('Stranger', { unlinked: true, commits: 2 }),
      personRow('Someone Else', { unlinked: true, commits: 3 }),
    ];
    expect(unlinkedCommitCount(people)).toBe(5);
  });
});
