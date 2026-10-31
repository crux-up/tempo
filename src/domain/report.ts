import type { PersonStats, TeamStats } from './types.js';

/** Whether the window holds any PR activity: a PR opened or merged, or a review submitted. */
export const hasActivity = (team: Pick<TeamStats, 'prsOpened' | 'prsMerged' | 'reviewsSubmitted'>): boolean =>
  team.prsOpened + team.prsMerged + team.reviewsSubmitted > 0;

/** Commits by authors with no linked GitHub account, summed over the people list. */
export const unlinkedCommitCount = (people: Pick<PersonStats, 'unlinked' | 'commits'>[]): number =>
  people.reduce((sum, p) => sum + (p.unlinked ? p.commits : 0), 0);
