import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(timezone);

/** 12500 -> "12.5K", 1250000 -> "1.25M" */
export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.?0+$/, '')}K`;
  return String(n);
}

export function withThousands(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** 12.34% — always 2 decimals, safe against divide-by-zero. */
export function ctrPercent(clicks: number, views: number): number {
  if (!views || views <= 0) return 0;
  return Math.round((clicks / views) * 10000) / 100;
}

export function ctrString(clicks: number, views: number): string {
  return `${ctrPercent(clicks, views).toFixed(2)}%`;
}

export function fromNow(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return dayjs(date).fromNow();
}

export function formatDate(date: Date | string | null | undefined, tz = 'Asia/Dhaka'): string {
  if (!date) return '—';
  return dayjs(date).tz(tz).format('DD MMM YYYY, HH:mm');
}

export function formatDateOnly(date: Date | string | null | undefined, tz = 'Asia/Dhaka'): string {
  if (!date) return '—';
  return dayjs(date).tz(tz).format('DD MMM YYYY');
}

/** Telegram HTML escaping — required because we send parse_mode: 'HTML'. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Normalise an @username or t.me link down to a bare username. */
export function normaliseChannelUsername(input: string): string | null {
  let value = input.trim();
  if (!value) return null;

  value = value.replace(/^https?:\/\//i, '');
  value = value.replace(/^t\.me\//i, '');
  value = value.replace(/^telegram\.me\//i, '');
  value = value.replace(/^@/, '');
  value = value.replace(/\/.*$/, '');
  value = value.trim().toLowerCase();

  if (!/^[a-z0-9_]{4,64}$/.test(value)) return null;
  return value;
}

export function maskTelegramId(id: bigint | string): string {
  const s = typeof id === 'bigint' ? id.toString() : id;
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

export function displayName(u: { firstName?: string | null; lastName?: string | null; username?: string | null }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (u.username) return `@${u.username}`;
  return 'Unknown user';
}
