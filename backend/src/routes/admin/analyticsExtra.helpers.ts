/**
 * Pure, dependency-free helpers for the extra analytics aggregates
 * (analyticsExtra.routes.ts).
 *
 * Kept in their own module with ZERO imports so they can be unit-tested with no
 * database, no Redis and no queue connection (see ../__tests__/). The route file
 * itself pulls in Prisma, so anything shared here must stay inert.
 */

/** Default rolling window for endpoints that accept `?days=`. */
export const DEFAULT_WINDOW_DAYS = 30;
/** Hard upper bound for `?days=` (one year of days). */
export const MAX_WINDOW_DAYS = 366;

/**
 * Parse and clamp a `?days=` query value server-side.
 *
 * Missing / empty / non-numeric values fall back to `fallback`; anything else is
 * truncated to an integer and clamped into `[1, max]`. Never trust the client to
 * bound its own window.
 */
export function clampDays(raw: unknown, fallback = DEFAULT_WINDOW_DAYS, max = MAX_WINDOW_DAYS): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/**
 * Convert a Prisma aggregate result to a plain JS number.
 *
 * Prisma returns `Int`/`Float` sums as `number`, but `BigInt` columns and some
 * raw-query results come back as `bigint` — and a raw `bigint` throws on
 * `JSON.stringify`. Every aggregate we surface runs through here.
 */
export function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Round to 2 decimal places (used for averages). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** UTC `YYYY-MM-DD` key for a Date. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Inclusive UTC start of a rolling window of `days` days ending today.
 * `days = 1` returns today's UTC midnight.
 */
export function windowStart(days: number, now: Date = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/**
 * Ascending list of the last `days` UTC day keys, ending at `now` (inclusive).
 * UTC is used so the day boundaries match the `date_trunc('day', ...)` buckets
 * the SQL series are grouped by.
 */
export function dayWindow(days: number, now: Date = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

/** A single `{ date, count }` point produced by one SQL series. */
export interface DailyCount {
  date: string;
  count: number;
}

/** One row of the `/users` growth series. */
export interface UserGrowthDay {
  date: string;
  newUsers: number;
  publishers: number;
  advertisers: number;
}

/**
 * Merge three independent day series into one zero-filled, date-ascending list.
 *
 * Days with no rows appear with zeros so the client always receives exactly
 * `days` points and can chart the window without patching gaps.
 */
export function mergeUserGrowth(
  days: number,
  newUsers: DailyCount[],
  publishers: DailyCount[],
  advertisers: DailyCount[],
  now: Date = new Date(),
): UserGrowthDay[] {
  const toMap = (rows: DailyCount[]): Map<string, number> => new Map(rows.map((r) => [r.date, r.count]));
  const byNew = toMap(newUsers);
  const byPublisher = toMap(publishers);
  const byAdvertiser = toMap(advertisers);
  return dayWindow(days, now).map((date) => ({
    date,
    newUsers: byNew.get(date) ?? 0,
    publishers: byPublisher.get(date) ?? 0,
    advertisers: byAdvertiser.get(date) ?? 0,
  }));
}

/**
 * A ratio expressed as a percentage, rounded to 2dp — or `null` when there is no
 * data to divide by.
 *
 * Returning `null` rather than `0` for a zero denominator is deliberate and is
 * the whole point of the column being `number | null` in the frontend types: a
 * "0%" that actually means "nothing has run yet" is a lie the panel would render
 * as a real measurement. Only a genuine numerator of 0 over real data is a real
 * 0%. A negative denominator is impossible in practice and is treated as "no
 * data" too, defensively.
 */
export function percentage(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round2((numerator / denominator) * 100);
}

/**
 * What is left of a campaign budget: `total - spent - reserved`, floored at 0.
 *
 * Reserved money is already committed to in-flight slots, so it is NOT spendable
 * again — subtracting only `spent` would overstate the budget. The floor matters
 * because a release/refund can momentarily make `spent + reserved` exceed the
 * total, and a negative "remaining" would be nonsense on the panel.
 */
export function remainingBudgetCents(
  totalCents: number,
  spentCents: number,
  reservedCents: number,
): number {
  return Math.max(0, totalCents - spentCents - reservedCents);
}

/**
 * Delivery-job states that are NOT yet terminal. A job counts as "scheduled"
 * while it is still waiting to go out: queued (PENDING/SCHEDULED/RETRYING),
 * in flight (LOCKED/PROCESSING) or waiting on the publisher (AWAITING_APPROVAL).
 *
 * This mirrors the pipeline grouping in `delivery.service.deliveryQueueStats`
 * (`pending` = PENDING + SCHEDULED + PROCESSING), widened to include every other
 * non-terminal state so `scheduled + published + failed + cancelled` accounts for
 * every delivery job a campaign/channel has.
 */
export const DELIVERY_SCHEDULED_STATUSES: readonly string[] = [
  'PENDING',
  'SCHEDULED',
  'LOCKED',
  'PROCESSING',
  'RETRYING',
  'AWAITING_APPROVAL',
];

/** The four-state split of a delivery job set (see DELIVERY_SCHEDULED_STATUSES). */
export interface DeliveryStatusCounts {
  scheduled: number;
  published: number;
  failed: number;
  cancelled: number;
}

/**
 * Fold a `groupBy(status)` result into the four buckets the detail panels show.
 * Pure, so the classification is unit-tested without a database.
 */
export function summarizeDeliveryJobs(
  groups: ReadonlyArray<{ status: string; count: number }>,
): DeliveryStatusCounts {
  const counts: DeliveryStatusCounts = { scheduled: 0, published: 0, failed: 0, cancelled: 0 };
  for (const group of groups) {
    if (group.status === 'COMPLETED') counts.published += group.count;
    else if (group.status === 'FAILED') counts.failed += group.count;
    else if (group.status === 'CANCELLED') counts.cancelled += group.count;
    else if (DELIVERY_SCHEDULED_STATUSES.includes(group.status)) {
      counts.scheduled += group.count;
    }
  }
  return counts;
}
