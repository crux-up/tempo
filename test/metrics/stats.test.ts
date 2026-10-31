import { describe, expect, it } from 'vitest';
import { hoursBetween, isoWeek, median, percentile, roundTo } from '../../src/metrics/stats.js';

describe('median', () => {
  it('is null for no values', () => {
    expect(median([])).toBeNull();
  });

  it('averages the two middle values for an even count', () => {
    expect(median([1, 3])).toBe(2);
  });

  it('takes the middle value of an unsorted odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([10, 1], 90)).toBe(10);
  });

  it('is null for no values', () => {
    expect(percentile([], 90)).toBeNull();
  });
});

describe('isoWeek', () => {
  it('puts 2026-01-01 (Thursday) in week 1 of 2026', () => {
    expect(isoWeek(new Date('2026-01-01'))).toEqual({ week: '2026-W01', weekStart: '2025-12-29' });
  });

  it('puts 2027-01-01 (Friday) in week 53 of 2026', () => {
    expect(isoWeek(new Date('2027-01-01'))).toEqual({ week: '2026-W53', weekStart: '2026-12-28' });
  });

  it('uses the UTC day, with Sunday closing the week', () => {
    expect(isoWeek(new Date('2026-03-08T23:59:59Z')).week).toBe('2026-W10');
    expect(isoWeek(new Date('2026-03-09T00:00:00Z'))).toEqual({ week: '2026-W11', weekStart: '2026-03-09' });
  });
});

describe('hoursBetween', () => {
  it('returns exact hours so medians are not computed on rounded values', () => {
    expect(hoursBetween('2026-03-02T10:00:00Z', '2026-03-02T10:20:00Z')).toBeCloseTo(1 / 3, 10);
  });

  it('respects timezone offsets', () => {
    expect(hoursBetween('2026-03-02T10:00:00+02:00', '2026-03-02T10:00:00Z')).toBe(2);
  });
});

describe('roundTo', () => {
  it('rounds to the given decimals and keeps null', () => {
    expect(roundTo(1 / 3, 1)).toBe(0.3);
    expect(roundTo(2 / 3, 3)).toBe(0.667);
    expect(roundTo(null, 1)).toBeNull();
  });
});
