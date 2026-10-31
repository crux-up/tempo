const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const ascending = (values: number[]): number[] => [...values].sort((a, b) => a - b);

/** Middle value; the mean of the two middle values for an even count. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = ascending(values);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile: `sorted[ceil(p/100 * n) - 1]`. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = ascending(values);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function roundTo(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Exact hours from `a` to `b`. Round only the reported value, after aggregating. */
export function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / HOUR_MS;
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** ISO-8601 week of the UTC calendar day of `date`. */
export function isoWeek(date: Date): { week: string; weekStart: string } {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = new Date(day).getUTCDay() || 7;
  const monday = day - (weekday - 1) * DAY_MS;
  const thursday = monday + 3 * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const weekNumber = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1;
  return { week: `${isoYear}-W${String(weekNumber).padStart(2, '0')}`, weekStart: isoDate(monday) };
}
