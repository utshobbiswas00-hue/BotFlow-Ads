import { describe, expect, it } from 'vitest';
import {
  percentage,
  remainingBudgetCents,
  summarizeDeliveryJobs,
} from '../analyticsExtra.helpers';

/**
 * DB-FREE unit tests for the per-entity detail helpers (§40, §41).
 *
 * These cover the two places the detail endpoints are most likely to lie:
 * a rate over a zero denominator, and a budget that has been over-committed.
 * No Prisma / Redis / HTTP is involved — the helpers are pure.
 */

describe('percentage', () => {
  it('is NULL when the denominator is 0 (no data must not read as 0%)', () => {
    expect(percentage(0, 0)).toBeNull();
    expect(percentage(5, 0)).toBeNull();
  });

  it('is NULL for a negative denominator (defensive — treated as no data)', () => {
    expect(percentage(5, -1)).toBeNull();
  });

  it('returns the rounded percentage when there is real data', () => {
    expect(percentage(1, 2)).toBe(50);
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(2, 3)).toBe(66.67);
    expect(percentage(7, 7)).toBe(100);
    // A real 0 over real data IS a real 0 — distinct from the null above.
    expect(percentage(0, 5)).toBe(0);
  });
});

describe('remainingBudgetCents', () => {
  it('subtracts both spent and reserved', () => {
    expect(remainingBudgetCents(10_000, 3_000, 2_000)).toBe(5_000);
  });

  it('floors at 0 when spent + reserved exceeds the total', () => {
    expect(remainingBudgetCents(10_000, 8_000, 5_000)).toBe(0);
    expect(remainingBudgetCents(0, 1, 1)).toBe(0);
  });

  it('is 0 for an exhausted budget and the full total when nothing is used', () => {
    expect(remainingBudgetCents(10_000, 10_000, 0)).toBe(0);
    expect(remainingBudgetCents(10_000, 0, 0)).toBe(10_000);
  });
});

describe('summarizeDeliveryJobs', () => {
  it('partitions terminal states and lumps every in-flight state into scheduled', () => {
    expect(
      summarizeDeliveryJobs([
        { status: 'COMPLETED', count: 4 },
        { status: 'FAILED', count: 1 },
        { status: 'CANCELLED', count: 2 },
        { status: 'PENDING', count: 3 },
        { status: 'SCHEDULED', count: 1 },
        { status: 'LOCKED', count: 1 },
        { status: 'PROCESSING', count: 2 },
        { status: 'RETRYING', count: 1 },
        { status: 'AWAITING_APPROVAL', count: 1 },
      ]),
    ).toEqual({ scheduled: 9, published: 4, failed: 1, cancelled: 2 });
  });

  it('is all zeros for an empty group set', () => {
    expect(summarizeDeliveryJobs([])).toEqual({
      scheduled: 0,
      published: 0,
      failed: 0,
      cancelled: 0,
    });
  });
});
