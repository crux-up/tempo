import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Week } from '../types';
import { WeeklyPlot } from './WeeklyChart';

const week = (n: number, median: number | null): Week => ({
  week: `2026-W${String(40 + n).padStart(2, '0')}`,
  weekStart: `2026-10-0${n + 1}`,
  prsOpened: 4,
  prsMerged: 3,
  reviewsSubmitted: 9,
  medianFirstReviewHours: median,
  firstReviewSample: median === null ? 0 : 5,
});

describe('WeeklyPlot', () => {
  const markup = renderToStaticMarkup(
    <WeeklyPlot
      width={600}
      weekly={[week(0, 9.5), week(1, null)]}
      windowMedian={9.5}
      activeWeek={null}
      syncedFrom={null}
      onHover={() => undefined}
    />,
  );

  it('exposes the chart as a group so its focusable weeks stay reachable', () => {
    expect(markup).toMatch(/<svg[^>]*role="group"[^>]*aria-label="Median hours to first review for 2 weeks"/);
    expect(markup).not.toMatch(/<svg[^>]*role="img"/);
  });

  it('gives every week its own labelled image role', () => {
    const weeks = markup.match(/<g[^>]*class="week[^"]*"[^>]*>/g) ?? [];
    expect(weeks).toHaveLength(2);
    for (const tag of weeks) {
      expect(tag).toContain('role="img"');
      expect(tag).toContain('tabindex="0"');
      expect(tag).toMatch(/aria-label="Week of /);
    }
    expect(weeks[1]).toContain('no first review');
  });
});
