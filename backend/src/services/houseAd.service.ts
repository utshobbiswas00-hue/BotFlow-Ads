import { prisma } from '../db/prisma';
import { getNumberSetting, getBoolSetting, getStringSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { escapeHtml, truncate } from '../utils/format';
import { TELEGRAM_MAX_CAPTION_LENGTH, TELEGRAM_MAX_TEXT_LENGTH, SUPPORT_URL, SUPPORT_USERNAME } from '@botflow/shared';
import { logger } from '../config/logger';

/**
 * HOUSE ADS — BotFlow's own promotions.
 *
 * Two responsibilities:
 *
 *  1. FILL THE RESERVED SHARE. By product rule 60% of the sponsored slots in a
 *     channel are BotFlow's own promotions and 40% are paying advertisers. The
 *     paid/house split itself is decided by slotPlanner.service.ts; this module
 *     supplies the creative that goes into a HOUSE slot.
 *
 *  2. NEVER LET POSTING STOP. If there is no paid inventory to deliver, the slot
 *     becomes a house post rather than being skipped. A publisher's channel is
 *     never left silent, and the bot keeps its presence in every channel where it
 *     is an administrator.
 *
 * LANGUAGE RULE: house posts are ALWAYS English. They speak for the platform, so
 * they are written once and used everywhere. Only a PAID creative follows the
 * advertiser's chosen language. This is enforced here, not left to callers.
 */

export const HOUSE_POST_LABEL = '📣 BotFlow Ads';
export const REQUIRED_HOUSE_LANGUAGE = 'en';

/* ------------------------------------------------------------------
 *  Monetization eligibility — the 500 subscriber gate
 * ------------------------------------------------------------------ */

export interface MonetizationEligibility {
  eligible: boolean;
  subscribers: number;
  minSubscribers: number;
  reason?: string;
  message: string;
}

/**
 * A channel must have at least `min_subscribers_for_monetization` subscribers
 * (500 by default) before its owner can earn. Below the threshold the channel
 * is not monetizable — this is a product rule, not a technical limitation.
 */
export async function minSubscribersForMonetization(): Promise<number> {
  const v = await getNumberSetting(SETTING_KEYS.MIN_SUBSCRIBERS_FOR_MONETIZATION, 500);
  return v > 0 ? v : 500;
}

export async function checkMonetizationEligibility(channel: {
  subscriberCount: number;
}): Promise<MonetizationEligibility> {
  const min = await minSubscribersForMonetization();
  const subscribers = Math.max(0, channel.subscriberCount);
  const eligible = subscribers >= min;

  return {
    eligible,
    subscribers,
    minSubscribers: min,
    ...(eligible ? {} : { reason: 'BELOW_MONETIZATION_THRESHOLD' }),
    message: eligible
      ? `Eligible to earn. You have ${subscribers.toLocaleString('en-US')} subscribers.`
      : `You need at least ${min.toLocaleString('en-US')} subscribers to monetize this channel. You currently have ${subscribers.toLocaleString('en-US')}.`,
  };
}

/**
 * Whether a below-threshold channel should still receive posts.
 * Off by default: an unmonetizable channel should not consume advertising
 * inventory. Turn it on to keep such channels active while they grow.
 */
export async function belowThresholdReceivesPosts(): Promise<boolean> {
  return getBoolSetting(SETTING_KEYS.BELOW_THRESHOLD_RECEIVES_POSTS, false);
}

/**
 * The single gate every delivery path should consult before publishing.
 *
 * Health rules, in order:
 *   - healthStatus SUSPENDED or RESTRICTED is refused outright — both mean
 *     "do not deliver" in the health scorer (suspension; repeated delivery
 *     failures or unresolved fraud), and RESTRICTED's score (50-60) sits
 *     ABOVE the numeric cutoff, so the status check is the only guard.
 *   - healthScore below the `channel_health_min_for_delivery` setting
 *     (default 40) is refused. An ATTENTION_REQUIRED channel scores 25, so it
 *     is caught here in addition to the permission check above.
 */
export async function canReceivePaidPost(channel: {
  subscriberCount: number;
  status: string;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  acceptAds: boolean;
  /** Health snapshot written by the channel-health sweep. */
  healthStatus?: string;
  healthScore?: number;
}): Promise<{ allowed: boolean; reason?: string }> {
  if (channel.status !== 'APPROVED') return { allowed: false, reason: `channel is ${channel.status.toLowerCase()}` };
  if (!channel.botIsAdmin || !channel.canPostMessages) {
    return { allowed: false, reason: 'bot lacks posting permission' };
  }
  if (!channel.acceptAds) return { allowed: false, reason: 'publisher has paused sponsored ads' };

  if (channel.healthStatus === 'SUSPENDED') {
    return { allowed: false, reason: 'channel is suspended, so delivery is blocked until the suspension is lifted' };
  }
  if (channel.healthStatus === 'RESTRICTED') {
    return {
      allowed: false,
      reason: 'channel delivery is restricted after repeated failures or unresolved violations',
    };
  }
  // Deliberate fail-open: some callers pass a minimal channel object without
  // the health fields (legacy selections, tests, partial rows). We cannot see
  // every caller of this gate, so missing health data means "allow" — the
  // hourly health sweep keeps the fields populated on the real delivery
  // paths, and refusing here would silently stop all delivery for callers
  // we do not control.
  if (channel.healthScore !== undefined) {
    const min = await getNumberSetting(SETTING_KEYS.CHANNEL_HEALTH_MIN_FOR_DELIVERY, 40);
    if (channel.healthScore < min) {
      return { allowed: false, reason: `channel health is ${channel.healthScore}, below the ${min} minimum` };
    }
  }

  const elig = await checkMonetizationEligibility(channel);
  if (!elig.eligible && !(await belowThresholdReceivesPosts())) {
    return { allowed: false, reason: 'below the monetization threshold' };
  }

  return { allowed: true };
}

/* ------------------------------------------------------------------
 *  Creative selection
 * ------------------------------------------------------------------ */

export interface HouseCreative {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  buttonText: string | null;
  buttonUrl: string | null;
  links: Array<{ label: string; url: string }>;
  weight: number;
}

function normaliseLinks(raw: unknown): Array<{ label: string; url: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object')
    .map((l) => ({ label: String(l.label ?? ''), url: String(l.url ?? '') }))
    .filter((l) => l.label && l.url);
}

/**
 * Weighted rotation over the active house creatives, so the same promo does not
 * appear every single time. Falls back to the built-in creative when the table is
 * empty, because posting must never fail for want of content.
 */
export async function pickHouseAd(
  options: { excludeIds?: string[] } = {},
): Promise<HouseCreative> {
  const rows = await prisma.houseAd.findMany({
    where: { isActive: true },
    orderBy: [{ weight: 'desc' }, { sortOrder: 'asc' }],
    select: {
      id: true, title: true, body: true, imageUrl: true,
      buttonText: true, buttonUrl: true, links: true, weight: true, language: true,
    },
  });

  const englishOnly = rows.filter((r) => (r.language || REQUIRED_HOUSE_LANGUAGE).toLowerCase() === REQUIRED_HOUSE_LANGUAGE);
  const excluded = options.excludeIds?.length
    ? englishOnly.filter((r) => !options.excludeIds?.includes(r.id))
    : englishOnly;

  const pool = excluded.length ? excluded : englishOnly;

  if (!pool.length) {
    logger.warn('no house ad creatives configured — using the built-in fallback');
    return builtInHouseAd();
  }

  const total = pool.reduce((sum, r) => sum + Math.max(1, r.weight), 0);
  let roll = Math.random() * total;
  for (const row of pool) {
    roll -= Math.max(1, row.weight);
    if (roll <= 0) {
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        imageUrl: row.imageUrl,
        buttonText: row.buttonText,
        buttonUrl: row.buttonUrl,
        links: normaliseLinks(row.links),
        weight: row.weight,
      };
    }
  }

  const first = pool[0]!;
  return {
    id: first.id,
    title: first.title,
    body: first.body,
    imageUrl: first.imageUrl,
    buttonText: first.buttonText,
    buttonUrl: first.buttonUrl,
    links: normaliseLinks(first.links),
    weight: first.weight,
  };
}

/** Used when the table is empty. English, and it always names the support handle. */
export function builtInHouseAd(): HouseCreative {
  return {
    id: 'builtin',
    title: 'Grow your Telegram channel with BotFlow Ads',
    body: [
      'BotFlow Ads connects channel owners with advertisers.',
      '',
      '• Add the bot as a channel admin and earn for every 1,000 views on sponsored posts',
      '• Or run a campaign and reach a real audience',
      '',
      'Advertise. Monetize. Grow.',
    ].join('\n'),
    imageUrl: null,
    buttonText: 'Open BotFlow Ads',
    buttonUrl: SUPPORT_URL,
    links: [{ label: 'Support', url: SUPPORT_URL }],
    weight: 1,
  };
}

/* ------------------------------------------------------------------
 *  Post formatting
 * ------------------------------------------------------------------ */

export interface FormattedHousePost {
  text: string;
  hasImage: boolean;
  buttonText: string | null;
  buttonUrl: string | null;
}

/**
 * Build the Telegram post for a house creative.
 *
 * ALWAYS English, and deliberately NOT labelled "Sponsored": a sponsored label
 * marks paid advertising, and a house post is the platform's own announcement.
 * Labelling it sponsored would be misleading to subscribers.
 */
export function formatHousePost(creative: HouseCreative): FormattedHousePost {
  const hasImage = Boolean(creative.imageUrl);
  const limit = hasImage ? TELEGRAM_MAX_CAPTION_LENGTH : TELEGRAM_MAX_TEXT_LENGTH;

  const parts: string[] = [`<b>${escapeHtml(creative.title)}</b>`, '', escapeHtml(creative.body.trim())];

  if (creative.links.length) {
    parts.push('');
    parts.push(...creative.links.map((l) => `• <a href="${l.url}">${escapeHtml(l.label)}</a>`));
  }

  let text = parts.join('\n');
  if (text.length > limit) text = truncate(text, limit);

  const button = creative.buttonText && creative.buttonUrl
    ? { text: creative.buttonText.slice(0, 64), url: creative.buttonUrl }
    : creative.links.length
      ? { text: 'Open BotFlow Ads', url: creative.links[0]!.url }
      : null;

  return {
    text,
    hasImage,
    buttonText: button?.text ?? null,
    buttonUrl: button?.url ?? null,
  };
}

/** Short description of the language rule, for the admin UI. */
export function languageRuleNote(): string {
  return 'House posts are always written in English. A paid post is published in the advertiser\u2019s own language.';
}

/* ------------------------------------------------------------------
 *  Admin CRUD
 * ------------------------------------------------------------------ */

export interface HouseAdInput {
  code?: string | null;
  title: string;
  body: string;
  imageUrl?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  links?: Array<{ label: string; url: string }>;
  weight?: number;
  isActive?: boolean;
  sortOrder?: number;
  note?: string | null;
}

/** Create or update. `language` is not settable — house posts are English. */
export async function upsertHouseAd(input: HouseAdInput): Promise<{ id: string }> {
  const data = {
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 2000),
    imageUrl: input.imageUrl ?? null,
    buttonText: input.buttonText ?? null,
    buttonUrl: input.buttonUrl ?? null,
    links: (input.links ?? []) as never,
    weight: Math.min(Math.max(input.weight ?? 1, 1), 10),
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    note: input.note ?? null,
    language: REQUIRED_HOUSE_LANGUAGE,
  };

  if (input.code) {
    const existing = await prisma.houseAd.findUnique({ where: { code: input.code }, select: { id: true } });
    if (existing) {
      await prisma.houseAd.update({ where: { id: existing.id }, data });
      return { id: existing.id };
    }
    const created = await prisma.houseAd.create({ data: { ...data, code: input.code }, select: { id: true } });
    return { id: created.id };
  }

  const created = await prisma.houseAd.create({ data, select: { id: true } });
  return { id: created.id };
}

export async function listHouseAds(activeOnly = false) {
  return prisma.houseAd.findMany({
    where: activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true, code: true, title: true, body: true, imageUrl: true,
      buttonText: true, buttonUrl: true, links: true, language: true,
      weight: true, isActive: true, sortOrder: true, note: true, createdAt: true,
    },
  });
}

export async function setHouseAdActive(id: string, isActive: boolean): Promise<void> {
  await prisma.houseAd.update({ where: { id }, data: { isActive } });
}

export async function deleteHouseAd(id: string): Promise<void> {
  await prisma.houseAd.delete({ where: { id } });
}

/** How many house posts actually ran. Useful for judging creative performance. */
export async function houseAdStats() {
  const [active, posts] = await Promise.all([
    prisma.houseAd.count({ where: { isActive: true } }),
    prisma.adPost.count({ where: { houseAdId: { not: null } } }),
  ]);
  return { activeCreatives: active, housePostsPublished: posts };
}

/**
 * Default self-promotion, modelled on the platform's own announcement style:
 * a heading, a short body, and the places to follow.
 */
export async function seedDefaultHouseAds(): Promise<number> {
  const existing = await prisma.houseAd.count();
  if (existing > 0) return 0;

  const builtIn = builtInHouseAd();
  await prisma.houseAd.create({
    data: {
      code: 'WELCOME_EN',
      title: builtIn.title,
      body: builtIn.body,
      buttonText: builtIn.buttonText,
      buttonUrl: builtIn.buttonUrl,
      links: [
        { label: 'Talk to support', url: SUPPORT_URL },
        { label: `@${SUPPORT_USERNAME}`, url: SUPPORT_URL },
      ] as never,
      language: REQUIRED_HOUSE_LANGUAGE,
      weight: 5,
      sortOrder: 10,
      note: 'Default English self-promotion. Shown when no paid inventory is available.',
    },
  });

  await prisma.houseAd.create({
    data: {
      code: 'PUBLISHER_EN',
      title: 'Turn your Telegram channel into income',
      body: [
        'Add the BotFlow bot as an administrator and start earning.',
        '',
        '• Get paid for every 1,000 views on sponsored posts',
        '• Approve or reject any post before it goes live',
        '• Withdraw whenever you like',
      ].join('\n'),
      buttonText: 'Start earning',
      buttonUrl: SUPPORT_URL,
      links: [] as never,
      language: REQUIRED_HOUSE_LANGUAGE,
      weight: 3,
      sortOrder: 20,
      note: 'Recruits new publishers. English only.',
    },
  });

  await prisma.houseAd.create({
    data: {
      code: 'ADVERTISER_EN',
      title: 'Reach a real Telegram audience',
      body: [
        'Set a budget and we show you the estimated reach before you pay.',
        '',
        '• Pay only for posts that actually publish',
        '• Choose your channels or let us target for you',
        '• A failed post costs you nothing',
      ].join('\n'),
      buttonText: 'Start advertising',
      buttonUrl: SUPPORT_URL,
      links: [] as never,
      language: REQUIRED_HOUSE_LANGUAGE,
      weight: 3,
      sortOrder: 30,
      note: 'Recruits new advertisers. English only.',
    },
  });

  return 3;
}

/** Language a post should actually be published in. */
export function resolvePostLanguage(kind: 'PAID' | 'HOUSE', advertiserLanguage?: string | null): string {
  if (kind === 'HOUSE') return REQUIRED_HOUSE_LANGUAGE;
  return (advertiserLanguage || 'en').toLowerCase();
}

export { getStringSetting };
