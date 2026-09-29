import { DEFAULT_CURRENCY, SPONSORED_LABEL } from '@botflow/shared';

/** Format integer cents as a currency string, e.g. 1250 -> "$12.50". */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY): string {
  const value = cents / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Unknown currency code — fall back to a plain number with symbol hint.
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * Parse a user-typed decimal amount ("12.5", "0.99", "1000") into integer
 * cents using string arithmetic — never a float multiply, which loses
 * precision on large or long-decimal values. Returns null when the text is not
 * a plain number.
 */
export function parseCents(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const sign = m[1] ?? '';
  const whole = m[2] ?? '';
  const frac = m[3] ?? '';
  if (!whole && !frac) return null;
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  const extra = frac.slice(2);
  const rounded = extra && Number(`0.${extra}`) >= 0.5 ? cents + 1 : cents;
  if (!Number.isSafeInteger(rounded)) return null;
  return sign === '-' ? -rounded : rounded;
}

/** Integer cents -> plain decimal string for a form field, e.g. 1250 -> "12.50". */
export function centsToDecimalString(cents: number): string {
  const safe = Math.trunc(cents);
  const abs = Math.abs(safe);
  return `${safe < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Signed variant for transaction rows, e.g. "+$12.50" / "-$3.00". */
export function formatMoneySigned(cents: number, currency: string = DEFAULT_CURRENCY): string {
  const base = formatMoney(Math.abs(cents), currency);
  if (cents > 0) return `+${base}`;
  if (cents < 0) return `-${base}`;
  return base;
}

/** Compact number, e.g. 15000 -> "15K", 2300000 -> "2.3M". */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Plain grouped number, e.g. 15000 -> "15,000". */
export function groupNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat('en-US').format(n);
}

/** CTR ratio (0.034) -> "3.40%". */
/**
 * Format a click-through rate that is ALREADY a percentage.
 *
 * Every `.ctr` the API returns is a percentage — the backend computes
 * `ctrPercent = clicks / views * 100` (`backend/src/utils/format.ts`), so 3.4
 * means 3.4%. This helper used to scale by 100 a second time, and so did three
 * call sites, which printed a 3.4% CTR as "340.00%".
 *
 * Callers holding a raw ratio must convert first.
 */
export function ctrString(ctrPercent: number): string {
  if (!Number.isFinite(ctrPercent) || ctrPercent <= 0) return '0%';
  return `${ctrPercent >= 10 ? ctrPercent.toFixed(1) : ctrPercent.toFixed(2)}%`;
}

/** ISO date -> "Sep 25, 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** ISO date -> "Sep 25, 2026 3:40 PM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** ISO date -> relative "just now / 5m ago / 2h ago / 3d ago". */
export function fromNow(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const hour = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);
  const future = diff > 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  if (hour < 24) return future ? `in ${hour}h` : `${hour}h ago`;
  if (day < 7) return future ? `in ${day}d` : `${day}d ago`;
  return formatDate(iso);
}

/** "Jane Doe" from nullable profile fields, falling back to @username. */
export function displayName(u: {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
}): string {
  const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
  if (name) return name;
  if (u.username) return `@${u.username.replace(/^@/, '')}`;
  return 'User';
}

/** "TECHNOLOGY" -> "Technology". */
export function humanize(value: string): string {
  return value
    .split(/[_\s-]+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Category code -> friendly label (defaults to humanized code). */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Other';
  const map: Record<string, string> = {
    NEWS: 'News',
    TECHNOLOGY: 'Technology',
    EDUCATION: 'Education',
    ENTERTAINMENT: 'Entertainment',
    GAMING: 'Gaming',
    BUSINESS: 'Business',
    SHOPPING: 'Shopping',
    DEALS: 'Deals',
    JOBS: 'Jobs',
    SPORTS: 'Sports',
    CRYPTO: 'Crypto',
    COMMUNITY: 'Community',
    OTHER: 'Other',
  };
  return map[category] ?? humanize(category);
}

/** Pricing model + cents -> "per post" / "per 1,000 views" / "per click". */
export function pricingLabel(pricingModel: string, cents: number, currency: string = DEFAULT_CURRENCY): string {
  const amount = formatMoney(cents, currency);
  switch (pricingModel) {
    case 'CPM':
      return `${amount} / 1K views`;
    case 'CPC':
      return `${amount} / click`;
    case 'HYBRID':
      return `from ${amount}`;
    case 'FIXED':
    default:
      return `${amount} / post`;
  }
}

export { SPONSORED_LABEL };

/** "2026-09-25T15:40:00Z" <-> <input type="datetime-local"> helpers. */
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
