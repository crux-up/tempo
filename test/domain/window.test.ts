import { describe, expect, it } from 'vitest';
import { inWindow, parseWindow } from '../../src/domain/window.js';
import { BadRequestError } from '../../src/errors.js';

const NOW = new Date('2026-10-31T12:00:00Z');
const DAY = 86_400_000;

describe('parseWindow', () => {
  it('defaults to the 30 days ending now', () => {
    const w = parseWindow({}, NOW);
    expect(w.to).toEqual(NOW);
    expect(w.from).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });

  it('reads dates as UTC midnight', () => {
    const w = parseWindow({ from: '2026-03-02', to: '2026-03-16' }, NOW);
    expect(w.from.toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('accepts ISO datetimes with an offset', () => {
    const w = parseWindow({ from: '2026-03-02T09:00:00+02:00', to: '2026-03-16T00:00:00Z' }, NOW);
    expect(w.from.toISOString()).toBe('2026-03-02T07:00:00.000Z');
  });

  it('defaults from to 30 days before an explicit to', () => {
    const w = parseWindow({ to: '2026-04-01' }, NOW);
    expect(w.from.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('clamps a future to to now', () => {
    const w = parseWindow({ from: '2026-10-01', to: '2027-01-01' }, NOW);
    expect(w.to).toEqual(NOW);
  });

  it('rejects from >= to', () => {
    expect(() => parseWindow({ from: '2026-03-16', to: '2026-03-16' }, NOW)).toThrow(BadRequestError);
    expect(() => parseWindow({ from: '2026-03-17', to: '2026-03-16' }, NOW)).toThrow(BadRequestError);
  });

  it('allows 366 days and rejects 367', () => {
    expect(() => parseWindow({ from: '2025-01-01', to: '2026-01-02' }, NOW)).not.toThrow();
    expect(() => parseWindow({ from: '2025-01-01', to: '2026-01-03' }, NOW)).toThrow(BadRequestError);
  });

  it.each(['yesterday', '2026-02-30', '2026-3-1', '2026-03-01T10:00:00', '2026-03-01T25:00Z', ''])(
    'rejects malformed value %j',
    (value) => {
      expect(() => parseWindow({ from: value, to: '2026-03-16' }, NOW)).toThrow(BadRequestError);
    },
  );
});

describe('inWindow', () => {
  const w = { from: new Date('2026-03-02T00:00:00Z'), to: new Date('2026-03-16T00:00:00Z') };

  it('includes from and excludes to', () => {
    expect(inWindow('2026-03-02T00:00:00Z', w)).toBe(true);
    expect(inWindow('2026-03-15T23:59:59Z', w)).toBe(true);
    expect(inWindow('2026-03-16T00:00:00Z', w)).toBe(false);
    expect(inWindow('2026-03-01T23:59:59Z', w)).toBe(false);
  });

  it('treats null as outside', () => {
    expect(inWindow(null, w)).toBe(false);
  });
});
