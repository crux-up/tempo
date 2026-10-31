import type { Evidence } from './types';

/** A figure split into its value and a unit suffix, so the unit can be set smaller and grey. */
export type Figure = { value: string; unit: string } | null;

const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const count = (n: number) => integer.format(n);

/** Durations read as people say them: minutes under an hour, hours under two days, then days. */
export function hours(h: number | null): Figure {
  if (h === null) return null;
  // Rounded first, so a value never shows as "60 min" or "48.0 h" at a unit's upper edge.
  const minutes = Math.round(h * 60);
  if (minutes < 60) return { value: integer.format(minutes), unit: 'min' };
  if (Math.round(h * 10) / 10 < 48) return { value: oneDecimal.format(h), unit: 'h' };
  return { value: oneDecimal.format(h / 24), unit: 'd' };
}

/** Shares arrive as fractions from 0 to 1. */
export function share(fraction: number | null, decimals: 0 | 1 = 1): Figure {
  if (fraction === null) return null;
  return { value: (decimals === 0 ? integer : oneDecimal).format(fraction * 100), unit: '%' };
}

export function figureText(figure: Figure): string {
  if (!figure) return '—';
  if (!figure.unit) return figure.value;
  return figure.unit === '%' ? `${figure.value}%` : `${figure.value} ${figure.unit}`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

export const day = (iso: string) => dateFormat.format(new Date(iso));
export const dayShort = (iso: string) => shortDate.format(new Date(iso));
export const dateTime = (iso: string) => `${dateFormat.format(new Date(iso))}, ${timeFormat.format(new Date(iso))} UTC`;

const DAY_MS = 86_400_000;
const atMidnight = (iso: string) => Date.parse(iso) % DAY_MS === 0;

/** The API's window is [from, to). A start on a UTC midnight reads as that day; any other instant is shown exactly. */
export const windowStart = (iso: string) => (atMidnight(iso) ? day(iso) : dateTime(iso));

/** The exclusive end shown as the last included day, like the top bar; an end that is not a midnight is shown exactly. */
export const windowEnd = (iso: string) => (atMidnight(iso) ? day(new Date(Date.parse(iso) - DAY_MS).toISOString()) : dateTime(iso));

/** Yes/no context facts are counts of 0 or 1 whose label ends with this marker. */
const YES_NO = /\s*\(1 = yes, 0 = no\)/;

/**
 * Fact-sheet labels are written for the model ("Median hours to first review", "(fraction 0-1)"). On screen the value
 * carries its own unit, so the label drops the unit words.
 */
export function evidenceLabel(label: string): string {
  return label
    .replace(YES_NO, '')
    .replace(/\s*\(fraction 0-1\)/g, '')
    .replace(/, counted once per reviewer per PR/g, '')
    .replace(/\s*\(counted per reviewer per PR\)/g, '')
    .replace(/\bhours to\b/g, 'time to')
    .replace(/ in hours\b/g, '');
}

/** Evidence values come from the server's metrics; they are formatted by unit, never read from model prose. */
export function evidenceFigure(evidence: Pick<Evidence, 'value' | 'unit'> & { label?: string }): Figure {
  const { value, unit, label } = evidence;
  if (value === null) return null;
  if (typeof value === 'number' && label !== undefined && YES_NO.test(label)) {
    return { value: value === 1 ? 'yes' : 'no', unit: '' };
  }
  if (typeof value === 'string') return { value: unit === 'datetime' ? dateTime(value) : value, unit: '' };
  if (unit === 'hours') return hours(value);
  if (unit === 'share') return share(value);
  return { value: count(value), unit: '' };
}
