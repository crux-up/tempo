import { BadRequestError } from '../errors.js';
import type { TimeWindow } from './types.js';

export const DAY_MS = 86_400_000;
/** Length of the window when the request gives no `from`. */
export const DEFAULT_WINDOW_DAYS = 30;
const MAX_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Date.parse rolls impossible days over (2026-02-30 becomes 03-02), so check the calendar date round-trips.
const isCalendarDate = (date: string): boolean => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
};

function parseInstant(field: string, value: string): Date {
  const dateOnly = DATE_ONLY.test(value);
  const datePart = dateOnly ? value : DATE_TIME.exec(value)?.[1];
  const ms = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  if (datePart === undefined || !isCalendarDate(datePart) || Number.isNaN(ms)) {
    throw new BadRequestError(`${field} must be YYYY-MM-DD or an ISO-8601 datetime with offset`);
  }
  return new Date(ms);
}

/** Resolves the `[from, to)` query window; see Global Constraints for the rules. */
export function parseWindow(query: { from?: string; to?: string }, now: Date): TimeWindow {
  const requestedTo = query.to === undefined ? now : parseInstant('to', query.to);
  const to = requestedTo > now ? now : requestedTo;
  const from =
    query.from === undefined ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS) : parseInstant('from', query.from);
  if (from >= to) throw new BadRequestError('from must be earlier than to');
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) {
    throw new BadRequestError(`The window must not exceed ${MAX_DAYS} days`);
  }
  return { from, to };
}

export function inWindow(iso: string | null, window: TimeWindow): boolean {
  if (iso === null) return false;
  const ms = Date.parse(iso);
  return ms >= window.from.getTime() && ms < window.to.getTime();
}
