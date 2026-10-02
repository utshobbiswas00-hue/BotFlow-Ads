import { describe, expect, it } from 'vitest';
import {
  clampDays,
  dayWindow,
  mergeUserGrowth,
  round2,
  toNumber,
  utcDayKey,
  windowStart,
} from '../analyticsExtra.helpers';

/**
 * DB-FREE unit tests for the pure analytics helpers.
 *
 * These functions are the parts of analyticsExtra.routes.ts that are easy to get
 * subtly wrong (window clamping, UTC day bucketing, bigint conversion), so they
 * are exercised directly with no Prisma / Redis / HTTP anywhere near them.
 */

const NOW = new Date('2026-03-15T13:45:00.000Z');

describe('clampDays', () => {
  it('falls back for missing / empty / non-numeric input', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(null)).toBe(30);
    expect(clampDays('')).toBe(30);
    expect(clampDays('not-a-number')).toBe(30);
    expect(clampDays(NaN)).toBe(30);
  });

  it('falls back to a caller-provided default', () => {
    expect(clampDays(undefined, 7)).toBe(7);
  });

  it('clamps into [1, max]', () => {
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-99)).toBe(1);
    expect(clampDays(500)).toBe(366);
    expect(clampDays(999, 30, 90)).toBe(90);
  });

  it('accepts numeric strings and truncates fractions', () => {
    expect(clampDays('12')).toBe(12);
    expect(clampDays('7.9')).toBe(7);
    expect(clampDays(45.6)).toBe(45);
  });
});

describe('toNumber', () => {
  it('converts bigint (which would throw on JSON.stringify) to a number', () => {
    expect(toNumber(9007199254740993n)).toBe(9007199254740992);
    expect(toNumber(0n)).toBe(0);
  });

  it('passes numbers through and maps null/undefined to 0', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });
});

describe('round2', () => {
  it('rounds to two decimal places', () => {
    expect(round2(1 / 3)).toBe(0.33);
    expect(round2(2.5)).toBe(2.5);
    expect(round2(2.005)).toBe(2.01);
  });
});

describe('utcDayKey', () => {
  it('formats a Date as a UTC YYYY-MM-DD key', () => {
    expect(utcDayKey(new Date('2026-03-15T23:59:59.999Z'))).toBe('2026-03-15');
    expect(utcDayKey(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03-15');
  });
});

describe('windowStart', () => {
  it('is UTC midnight of today for a one-day window', () => {
    expect(windowStart(1, NOW).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('reaches back days-1 days for a longer window', () => {
    expect(windowStart(30, NOW).toISOString()).toBe('2026-02-14T00:00:00.000Z');
  });
});

describe('dayWindow', () => {
  it('returns exactly `days` ascending keys ending today (UTC)', () => {
    expect(dayWindow(3, NOW)).toEqual(['2026-03-13', '2026-03-14', '2026-03-15']);
    expect(dayWindow(1, NOW)).toEqual(['2026-03-15']);
    expect(dayWindow(4, NOW)).toHaveLength(4);
  });
});

describe('mergeUserGrowth', () => {
  it('zero-fills days with no rows and keeps date order', () => {
    const merged = mergeUserGrowth(
      3,
      [{ date: '2026-03-15', count: 5 }],
      [{ date: '2026-03-14', count: 2 }],
      [{ date: '2026-03-15', count: 1 }],
      NOW,
    );

    expect(merged).toEqual([
      { date: '2026-03-13', newUsers: 0, publishers: 0, advertisers: 0 },
      { date: '2026-03-14', newUsers: 0, publishers: 2, advertisers: 0 },
      { date: '2026-03-15', newUsers: 5, publishers: 0, advertisers: 1 },
    ]);
  });

  it('ignores series entries outside the window', () => {
    const merged = mergeUserGrowth(2, [{ date: '2020-01-01', count: 99 }], [], [], NOW);
    expect(merged).toEqual([
      { date: '2026-03-14', newUsers: 0, publishers: 0, advertisers: 0 },
      { date: '2026-03-15', newUsers: 0, publishers: 0, advertisers: 0 },
    ]);
  });
});
