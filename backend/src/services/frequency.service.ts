import { prisma } from '../db/prisma';
import { businessRules } from './settings.service';
import { entitlementsFor } from './premium.service';
import { childLogger } from '../config/logger';
import { msUntilAllowedSlot } from '../utils/postingSchedule';

const log = childLogger('frequency');

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Fallback for Channel.maxCampaignsPerHour when null/absent. */
const DEFAULT_MAX_CAMPAIGNS_PER_HOUR = 2;

export interface FrequencyCheckResult {
  allowed: boolean;
  retryAfterMs: number;
  reason?: string;
}

/**
 * Advertiser-side cooldown: how long before this advertiser may deliver to
 * this channel again. Measured from the advertiser's most recent DeliveryJob
 * on the channel (DeliveryJob.campaign -> advertiserId).
 */
export async function checkAdvertiserChannelCooldown(
  advertiserId: string,
  channelId: string,
): Promise<FrequencyCheckResult> {
  const [globalCooldownHours, entitlement] = await Promise.all([
    businessRules.advertiserChannelCooldownHours(),
    entitlementsFor(advertiserId),
  ]);

  // The advertiser's own entitlement may SHORTEN this cooldown (a premium perk),
  // but never lengthen it past the platform setting. A shorter cooldown only
  // affects the advertiser who paid for it — it harms no publisher — so
  // `min(global, entitlement)` is the safe direction. FREE resolves to 24, the
  // same as the global default (and to the global value even if an admin tuned
  // it, because min() keeps the more restrictive one only when the entitlement is
  // larger). A negative entitlement means "no cooldown".
  const cooldownHours =
    entitlement.channelCooldownHours < 0
      ? 0
      : Math.min(globalCooldownHours, entitlement.channelCooldownHours);

  const latest = await prisma.deliveryJob.findFirst({
    where: { channelId, campaign: { advertiserId } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!latest) return { allowed: true, retryAfterMs: 0 };

  const retryAfterMs = latest.createdAt.getTime() + cooldownHours * HOUR_MS - Date.now();
  if (retryAfterMs <= 0) return { allowed: true, retryAfterMs: 0 };

  return {
    allowed: false,
    retryAfterMs,
    reason: 'you have advertised in this channel recently',
  };
}

/**
 * Platform-wide per-channel daily cap: ChannelDeliveryLog rows in the rolling
 * 24h window vs `platform_max_ads_per_channel_per_day`. A non-positive cap
 * disables the check.
 */
export async function platformDailyCapReached(channelId: string): Promise<boolean> {
  const cap = await businessRules.platformMaxAdsPerChannelPerDay();
  if (cap <= 0) return false;

  const count = await prisma.channelDeliveryLog.count({
    where: { channelId, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
  });
  return count >= cap;
}

/**
 * Distinct campaigns actually DELIVERED to a channel since `since`
 * (ChannelDeliveryLog rows), mapped to each campaign's latest delivery-log
 * time inside the window.
 *
 * ChannelDeliveryLog has no Prisma relation to AdPost, so the join
 * ChannelDeliveryLog -> AdPost -> DeliveryJob -> campaignId is done in code:
 * log.adPostId matches the AdPost that a DeliveryJob published. Logs without
 * an adPostId (e.g. house posts) carry no campaign and are skipped.
 */
async function deliveredCampaignsSince(
  channelId: string,
  since: Date,
): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();

  const logs = await prisma.channelDeliveryLog.findMany({
    where: { channelId, createdAt: { gte: since } },
    select: { adPostId: true, createdAt: true },
  });

  const adPostIds = logs
    .map((l) => l.adPostId)
    .filter((id): id is string => id !== null && id !== undefined);
  if (adPostIds.length === 0) return result;

  const jobs = await prisma.deliveryJob.findMany({
    where: { channelId, adPost: { id: { in: adPostIds } } },
    select: { campaignId: true, adPost: { select: { id: true } } },
  });

  const campaignByAdPost = new Map<string, string>();
  for (const job of jobs) {
    if (job.adPost) campaignByAdPost.set(job.adPost.id, job.campaignId);
  }

  for (const entry of logs) {
    if (!entry.adPostId) continue;
    const campaignId = campaignByAdPost.get(entry.adPostId);
    if (!campaignId) continue;
    const previous = result.get(campaignId);
    if (!previous || entry.createdAt.getTime() > previous.getTime()) {
      result.set(campaignId, entry.createdAt);
    }
  }

  return result;
}

/**
 * Read-only frequency numbers for the UI.
 *  - last24h:                   ChannelDeliveryLog rows in the last 24h
 *  - lastHour:                  ChannelDeliveryLog rows in the last hour
 *  - lastPostAt:                timestamp of the most recent log row (or null)
 *  - distinctCampaignsLastHour: distinct campaigns delivered in the last hour
 */
export async function channelFrequencySnapshot(channelId: string): Promise<{
  last24h: number;
  lastHour: number;
  lastPostAt: Date | null;
  distinctCampaignsLastHour: number;
}> {
  const now = Date.now();
  const hourAgo = new Date(now - HOUR_MS);
  const dayAgo = new Date(now - DAY_MS);

  const [last24h, lastHour, lastPost, deliveredLastHour] = await Promise.all([
    prisma.channelDeliveryLog.count({ where: { channelId, createdAt: { gte: dayAgo } } }),
    prisma.channelDeliveryLog.count({ where: { channelId, createdAt: { gte: hourAgo } } }),
    prisma.channelDeliveryLog.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    deliveredCampaignsSince(channelId, hourAgo),
  ]);

  return {
    last24h,
    lastHour,
    lastPostAt: lastPost ? lastPost.createdAt : null,
    distinctCampaignsLastHour: deliveredLastHour.size,
  };
}

/**
 * Channel-side delivery gate. Enforces ALL of, in one pass:
 *   1. `maxPostsPerDay`      vs ChannelDeliveryLog rows in the last 24h
 *   2. `minHoursBetweenAds`  vs the most recent log row
 *   3. `maxCampaignsPerHour` vs DISTINCT campaigns delivered in the last hour
 *      (DeliveryJob -> ChannelDeliveryLog). The publisher's explicit cap wins; it
 *      falls back to the advertiser's entitlement when the publisher left it
 *      unset, and to a default of 2 only when neither is available.
 *   4. the platform-wide cap `platform_max_ads_per_channel_per_day`
 *
 * Each breach's retryAfterMs is the exact moment that constraint frees up
 * (oldest window row rolling out of the window, last post's interval
 * expiring, or the first campaign's latest log leaving the hour window).
 * When several constraints are breached, the returned retryAfterMs/reason is
 * the binding one — the longest wait.
 */
export async function checkChannelFrequency(channel: {
  id: string;
  maxPostsPerDay: number;
  minHoursBetweenAds: number;
  maxCampaignsPerHour?: number | null;
  /**
   * The advertiser this delivery belongs to, when the caller knows it (a paid
   * delivery always does). Used ONLY to let a premium advertiser raise the
   * per-hour campaign cap when the publisher left their own cap unset.
   */
  advertiserId?: string | null;
  /**
   * The publisher's weekly posting schedule (Channel.postingSchedule). When
   * set, a post may only go out inside one of the times they picked for that
   * weekday; outside them the job waits for the next slot. Typed loosely
   * because it arrives as Prisma `JsonValue`; the helper validates it.
   */
  postingSchedule?: unknown;
}): Promise<FrequencyCheckResult> {
  const now = Date.now();
  const hourAgo = new Date(now - HOUR_MS);
  const dayAgo = new Date(now - DAY_MS);

  // The publisher's explicit cap is authoritative and is never overridden. Only
  // when the publisher has NOT set one may the advertiser's entitlement raise the
  // effective ceiling: `effective = channel.maxCampaignsPerHour ?? entitlement`.
  // Without an advertiserId (e.g. house ads) or with a free advertiser the value
  // stays at today's fallback (2), so nothing changes for them. A negative
  // entitlement keeps the codebase's "unlimited" semantics.
  let maxCampaignsPerHour = channel.maxCampaignsPerHour ?? DEFAULT_MAX_CAMPAIGNS_PER_HOUR;
  if (channel.maxCampaignsPerHour === null || channel.maxCampaignsPerHour === undefined) {
    if (channel.advertiserId) {
      const entitlement = await entitlementsFor(channel.advertiserId);
      maxCampaignsPerHour = entitlement.maxCampaignsPerHour;
    }
  }

  const [logTimes24h, lastPost, deliveredLastHour, platformCap] = await Promise.all([
    prisma.channelDeliveryLog.findMany({
      where: { channelId: channel.id, createdAt: { gte: dayAgo } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.channelDeliveryLog.findFirst({
      where: { channelId: channel.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    deliveredCampaignsSince(channel.id, hourAgo),
    businessRules.platformMaxAdsPerChannelPerDay(),
  ]);

  let retryAfterMs = 0;
  let reason: string | undefined;
  const consider = (candidateRetry: number, candidateReason: string): void => {
    if (candidateRetry > retryAfterMs) {
      retryAfterMs = candidateRetry;
      reason = candidateReason;
    }
  };

  // 1) Channel daily limit.
  if (channel.maxPostsPerDay > 0 && logTimes24h.length >= channel.maxPostsPerDay) {
    const oldest = logTimes24h[0];
    consider(
      oldest.createdAt.getTime() + DAY_MS - now,
      `this channel has reached its daily limit of ${channel.maxPostsPerDay} sponsored posts`,
    );
  }

  // 2) Minimum interval between ads.
  if (lastPost && channel.minHoursBetweenAds > 0) {
    const retry = lastPost.createdAt.getTime() + channel.minHoursBetweenAds * HOUR_MS - now;
    if (retry > 0) {
      consider(retry, `this channel needs ${channel.minHoursBetweenAds} hours between ads`);
    }
  }

  // 3) Distinct campaigns delivered in the last hour. The set shrinks once
  // the FIRST campaign's latest log rolls out of the hour window, so the
  // earliest of those roll-out times frees a slot.
  if (maxCampaignsPerHour > 0 && deliveredLastHour.size >= maxCampaignsPerHour) {
    let earliest = Infinity;
    for (const latestLog of deliveredLastHour.values()) {
      const rollOut = latestLog.getTime() + HOUR_MS - now;
      if (rollOut < earliest) earliest = rollOut;
    }
    consider(
      earliest,
      `this channel allows at most ${maxCampaignsPerHour} different campaigns per hour`,
    );
  }

  // 4) Platform-wide daily cap (same 24h window as constraint 1).
  if (platformCap > 0 && logTimes24h.length >= platformCap) {
    const oldest = logTimes24h[0];
    consider(
      oldest.createdAt.getTime() + DAY_MS - now,
      `this channel has reached the platform daily cap of ${platformCap} ads`,
    );
  }

  // 5) The publisher's own weekly schedule. Time is the one cadence limit the
  //    publisher states explicitly, so it is enforced here rather than left to
  //    the dispatcher: a post outside the chosen slots waits for the next one
  //    instead of landing in the middle of their night.
  const slotWaitMs = msUntilAllowedSlot(channel.postingSchedule, now);
  if (slotWaitMs > 0) {
    consider(slotWaitMs, 'this channel only accepts posts at the times its publisher scheduled');
  }

  if (reason !== undefined) {
    log.info({ channelId: channel.id, retryAfterMs, reason }, 'channel frequency check blocked');
    return { allowed: false, retryAfterMs, reason };
  }
  return { allowed: true, retryAfterMs: 0 };
}
