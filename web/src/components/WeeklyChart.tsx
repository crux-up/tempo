import { useLayoutEffect, useRef, useState } from 'react';
import { hourTicks, labelEvery } from '../chart';
import { weekFact, weekRow } from '../facts';
import { count, dayShort, figureText, hours } from '../format';
import type { Week } from '../types';

/** Weekly medians from fewer PRs than this are drawn grey: one slow PR decides them. */
const MIN_SAMPLE = 3;
const PLOT_HEIGHT = 128;
const PAD = { top: 8, right: 4, bottom: 26, left: 40 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const tickLabel = (value: number, step: number) => (step >= 24 ? `${value / 24} d` : `${value} h`);

function slowestWeek(weekly: Week[]): Week | null {
  let slowest: Week | null = null;
  for (const week of weekly) {
    if (week.medianFirstReviewHours === null || week.firstReviewSample < MIN_SAMPLE) continue;
    if (!slowest || week.medianFirstReviewHours > (slowest.medianFirstReviewHours ?? 0)) slowest = week;
  }
  return slowest;
}

function describe(week: Week): string {
  const wait = week.medianFirstReviewHours === null ? 'no first review' : `${figureText(hours(week.medianFirstReviewHours))} median wait`;
  return (
    `Week of ${dayShort(week.weekStart)} (${week.week}): ${wait}, n ${count(week.firstReviewSample)} · ` +
    `${count(week.reviewsSubmitted)} reviews · ${count(week.prsOpened)} opened · ${count(week.prsMerged)} merged`
  );
}

const WEEK_MS = 7 * 86_400_000;
const unsynced = (week: Week, syncedFrom: string | null) =>
  syncedFrom !== null && Date.parse(`${week.weekStart}T00:00:00Z`) + WEEK_MS <= Date.parse(syncedFrom);

const scaleTicks = (weekly: Week[], windowMedian: number | null) =>
  hourTicks(Math.max(windowMedian ?? 0, ...weekly.flatMap((w) => (w.medianFirstReviewHours === null ? [] : [w.medianFirstReviewHours])), 1));

type WeeklyPlotProps = {
  width: number;
  weekly: Week[];
  windowMedian: number | null;
  activeWeek: string | null;
  /** Start of the synced data when coverage is partial; weeks that end before it have no data at all. */
  syncedFrom: string | null;
  onHover: (week: string | null) => void;
};

/**
 * The plot at a measured width. The svg is a group, not an image, so each week stays a focusable, labelled image of
 * its own; axis ticks and the reference line are decoration that the week labels already state in words.
 */
export function WeeklyPlot({ width, weekly, windowMedian, activeWeek, syncedFrom, onHover }: WeeklyPlotProps) {
  const ticks = scaleTicks(weekly, windowMedian);
  const top = ticks[ticks.length - 1]!;
  const step = ticks[1]! - ticks[0]!;
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const band = weekly.length ? plotWidth / weekly.length : 0;
  const barWidth = Math.min(36, band * 0.62);
  const y = (v: number) => PAD.top + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT;
  const every = labelEvery(weekly.length, plotWidth, 60);
  const height = PAD.top + PLOT_HEIGHT + PAD.bottom;
  const missing = weekly.filter((w) => unsynced(w, syncedFrom)).length;

  return (
    <svg
      width={width}
      height={height}
      role="group"
      aria-label={`Median hours to first review for ${weekly.length} weeks`}
      onMouseLeave={() => onHover(null)}
    >
      {missing > 0 && (
        <rect x={PAD.left} y={PAD.top} width={band * missing} height={PLOT_HEIGHT} className="unsynced" aria-hidden="true" />
      )}
      {ticks.map((tick) => (
        <g key={tick} aria-hidden="true">
          <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'baseline' : 'grid'} />
          <text x={PAD.left - 8} y={y(tick)} className="tick" textAnchor="end" dominantBaseline="middle">
            {tickLabel(tick, step)}
          </text>
        </g>
      ))}
      {weekly.map((week, i) => {
        const cx = PAD.left + band * i + band / 2;
        const value = week.medianFirstReviewHours;
        return (
          <g
            key={week.week}
            className={`week${activeWeek === week.week ? ' is-active' : ''}`}
            data-fact-row={weekRow(week.week)}
            role="img"
            tabIndex={0}
            aria-label={describe(week)}
            onMouseEnter={() => onHover(week.week)}
            onFocus={() => onHover(week.week)}
            onBlur={() => onHover(null)}
          >
            <rect x={cx - band / 2} y={PAD.top} width={band} height={PLOT_HEIGHT} className="week-hit" />
            {value === null ? (
              <line x1={cx - 4} x2={cx + 4} y1={y(0) - 1} y2={y(0) - 1} className="empty-week" />
            ) : (
              <rect
                x={cx - barWidth / 2}
                y={y(value)}
                width={barWidth}
                height={Math.max(1, y(0) - y(value))}
                className={`bar${week.firstReviewSample < MIN_SAMPLE ? ' bar-low' : ''}`}
                data-fact={weekFact(week.week, 'medianFirstReviewHours')}
              />
            )}
            {i % every === 0 && (
              <text x={cx} y={height - 8} className="tick" textAnchor="middle">
                {dayShort(week.weekStart)}
              </text>
            )}
          </g>
        );
      })}
      {windowMedian !== null && (
        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={y(windowMedian)}
          y2={y(windowMedian)}
          className="reference"
          aria-hidden="true"
        />
      )}
    </svg>
  );
}

type WeeklyChartProps = Omit<WeeklyPlotProps, 'width' | 'activeWeek' | 'onHover'> & { citedWeek: string | null };

/** Weekly median time to first review as columns, on an hour scale from zero, with the window median as a reference. */
export function WeeklyChart({ weekly, windowMedian, citedWeek, syncedFrom }: WeeklyChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<string | null>(null);

  const lowSample = weekly.some((w) => w.medianFirstReviewHours !== null && w.firstReviewSample < MIN_SAMPLE);
  const active = weekly.find((w) => w.week === (hovered ?? citedWeek)) ?? null;
  const slowest = slowestWeek(weekly);
  const readout = active ? describe(active) : slowest ? `Slowest. ${describe(slowest)}` : null;
  const missing = weekly.some((w) => unsynced(w, syncedFrom));

  return (
    <div className="chart">
      <div className="chart-top">
        <p className="chart-readout" aria-live="polite">
          {readout ?? 'No pull request got a first review in this window.'}
        </p>
        <ul className="legend" aria-label="Legend">
          <li>
            <svg width="10" height="10" aria-hidden="true">
              <rect width="10" height="10" className="bar" />
            </svg>
            Median of 3 or more PRs
          </li>
          {lowSample && (
            <li>
              <svg width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" className="bar bar-low" />
              </svg>
              Fewer than 3 PRs
            </li>
          )}
          {missing && (
            <li>
              <svg width="10" height="10" aria-hidden="true">
                <rect width="10" height="10" className="unsynced" />
              </svg>
              Not synced
            </li>
          )}
          {windowMedian !== null && (
            <li>
              <svg width="16" height="10" aria-hidden="true">
                <line x1="0" x2="16" y1="5" y2="5" className="reference" />
              </svg>
              Window median {figureText(hours(windowMedian))}
            </li>
          )}
        </ul>
      </div>
      <div ref={ref} className="chart-plot">
        {width > 0 && (
          <WeeklyPlot
            width={width}
            weekly={weekly}
            windowMedian={windowMedian}
            activeWeek={active?.week ?? null}
            syncedFrom={syncedFrom}
            onHover={setHovered}
          />
        )}
      </div>
    </div>
  );
}
