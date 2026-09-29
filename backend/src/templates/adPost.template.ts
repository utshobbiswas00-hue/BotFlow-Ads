import { SPONSORED_LABEL, TELEGRAM_MAX_CAPTION_LENGTH, TELEGRAM_MAX_TEXT_LENGTH } from '@botflow/shared';
import { escapeHtml } from '../utils/format';

/**
 * Sponsored post formatting.
 *
 * Section 19 of the spec: every paid post must be visibly labelled so
 * subscribers can tell advertising apart from the channel's own content.
 * We label at the TOP, which is the Telegram convention.
 */

export interface SponsoredPostInput {
  /** The advertiser's own copy. Plain text; will be HTML-escaped. */
  text: string;
  /** Optional extra line under the label, e.g. "Promoted by XYZ". */
  disclosure?: string;
  /** Custom label override — defaults to "📢 Sponsored". */
  label?: string;
  hasImage?: boolean;
}

export function buildSponsoredPostText(input: SponsoredPostInput): string {
  const limit = input.hasImage ? TELEGRAM_MAX_CAPTION_LENGTH : TELEGRAM_MAX_TEXT_LENGTH;

  const parts: string[] = [];

  // 1. Label + disclosure
  parts.push(`<b>${escapeHtml(input.label ?? SPONSORED_LABEL)}</b>`);
  if (input.disclosure) parts.push(`<i>${escapeHtml(input.disclosure)}</i>`);

  parts.push('');

  // 2. Advertiser copy — escaped so a stray "<" cannot break the message.
  // Truncate the RAW copy (before escaping) so the cut can never land inside an
  // HTML entity such as "&amp;". Cutting the already-assembled HTML string did
  // exactly that, and Telegram then rejected the whole post with "can't parse
  // entities" — a permanent delivery failure for a correctly-priced ad.
  const overhead = parts.join('\n').length + 1; // + the '\n' before the copy
  parts.push(fitEscapedText(input.text.trim(), limit - overhead));

  return parts.join('\n');
}

/**
 * HTML-escape `raw` and fit it into `budget` characters without ever splitting
 * an entity, appending a "…" marker when it has to cut. Returns "" when there is
 * no room at all.
 */
function fitEscapedText(raw: string, budget: number): string {
  if (budget <= 0) return '';
  if (escapeHtml(raw).length <= budget) return escapeHtml(raw);

  const marker = '…';
  const target = Math.max(0, budget - marker.length);

  // Longest prefix whose escaped length fits the target (binary search).
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeHtml(raw.slice(0, mid)).length <= target) lo = mid;
    else hi = mid - 1;
  }

  return lo === 0 ? '' : `${escapeHtml(raw.slice(0, lo))}${marker}`;
}

/** Preview text for the Mini App — plain, no HTML, no label. */
export function buildPreviewText(text: string, limit = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Telegram shows a link preview unless disabled. For button posts we keep the
 * preview off so the inline button is the single call to action.
 */
export function shouldDisablePreview(hasButton: boolean): boolean {
  return hasButton;
}

/** Sanity-check advertiser copy before it is ever queued for delivery. */
export function validateAdText(text: string): { ok: boolean; reason?: string } {
  const t = text.trim();

  if (t.length < 5) return { ok: false, reason: 'Ad text is too short' };
  if (t.length > 2000) return { ok: false, reason: 'Ad text must be under 2000 characters' };

  // Obvious formatting abuse — a wall of emoji reads as spam to Telegram too.
  const emojiOnly = /^[\p{Emoji}\s]+$/u.test(t);
  if (emojiOnly) return { ok: false, reason: 'Ad text cannot be only emoji' };

  const shouty = (t.match(/[A-Z]/g)?.length ?? 0) / Math.max(1, t.length);
  if (t.length > 40 && shouty > 0.85) {
    return { ok: false, reason: 'Ad text is mostly capital letters and looks like spam' };
  }

  if (/(https?:\/\/\S+){4,}/i.test(t)) {
    return { ok: false, reason: 'Too many links in the ad text' };
  }

  return { ok: true };
}
