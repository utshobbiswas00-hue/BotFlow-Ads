/**
 * Money helpers.
 *
 * HARD RULE: money is ALWAYS an integer in minor units (cents / paisa).
 * Floating point is never used for balances, and never stored in the DB.
 * 100 cents = 1 unit of currency.
 */

export const CENTS_PER_UNIT = 100;

/**
 * Convert a human amount (5.25 or "5.25") into cents (525).
 *
 * Parsed as a decimal STRING with integer arithmetic — `Math.round(n * 100)`
 * loses a cent on inputs like 1.005 because the binary float for 1.005 is
 * 1.00499999999999989....
 */
export function toCents(amount: number | string): number {
  const raw = (typeof amount === 'string' ? amount : String(amount)).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new Error(`toCents: invalid amount "${amount}"`);
  }
  const negative = raw.startsWith('-');
  const digits = raw.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = digits.split('.');
  const cents = Number(whole) * CENTS_PER_UNIT + Number((fraction + '00').slice(0, 2));
  // Round half-up on the third decimal place, still in integers.
  const rounded = Number(fraction[2] ?? '0') >= 5 ? cents + 1 : cents;
  return negative ? -rounded : rounded;
}

/** Convert cents (525) into a human amount (5.25). Display only. */
export function fromCents(cents: number): number {
  return cents / CENTS_PER_UNIT;
}

/** Format cents for display: `formatMoney(525)` -> "$5.25" */
export function formatMoney(
  cents: number,
  currency = 'USD',
  locale = 'en-US',
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  }).format(fromCents(cents));
}

/** Compact display for dashboards: 125000 -> "$1.25K" */
export function formatMoneyCompact(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(fromCents(cents));
}

/**
 * Take a percentage of a cent amount, rounded to the nearest cent.
 * Rounding is `half-up` and deterministic — the platform never gains a
 * fractional cent it did not charge for.
 */
export function percentOf(cents: number, percent: number): number {
  // Guards keep NaN / Infinity out of money paths (a NaN here would poison
  // every downstream balance). For the integer percentages this platform uses,
  // `cents * percent` stays exactly representable and the result is an integer.
  if (!Number.isFinite(cents) || !Number.isFinite(percent)) return 0;
  return Math.round((cents * percent) / 100);
}

/** Split a gross amount into platform fee + publisher net. */
export function splitRevenue(
  grossCents: number,
  platformFeePercent: number,
): { grossCents: number; platformFeeCents: number; netCents: number } {
  const platformFeeCents = percentOf(grossCents, platformFeePercent);
  return {
    grossCents,
    platformFeeCents,
    netCents: grossCents - platformFeeCents,
  };
}

/** CPM: cost per 1000 views. */
export function cpmCost(views: number, cpmRateCents: number): number {
  if (views <= 0) return 0;
  return Math.round((views * cpmRateCents) / 1000);
}

/** CPC: cost per click. */
export function cpcCost(clicks: number, cpcRateCents: number): number {
  if (clicks <= 0) return 0;
  return clicks * cpcRateCents;
}

export function assertPositiveCents(cents: number, label = 'amount'): void {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`${label} must be a positive integer number of cents`);
  }
}

export function sumCents(...values: number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}
