import { prisma } from '../db/prisma';
import { incrWindow } from '../db/redis';
import { env } from '../config/env';
import { hashIp, hashUserAgent } from '../utils/crypto';
import { getChatInfo, mapWithConcurrency } from '../utils/telegram';
import { logger } from '../config/logger';

/**
 * Click tracking for the public redirect endpoint (/c/:slug).
 *
 * Golden rule: tracking must NEVER break the redirect. Every failure is
 * logged and swallowed so the end user still lands on the advertiser's
 * destination.
 */

export interface TrackingTarget {
  adId: string;
  campaignId: string;
  /** The most recently PUBLISHED post for this ad, if any. */
  adPostId: string | null;
  destinationUrl: string | null;
  channelId: string | null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a public tracking slug to the ad it belongs to, together with the
 * currently live post (if any) so counters can be attributed.
 */
export async function resolveTrackingSlug(slug: string): Promise<TrackingTarget | null> {
  try {
    const ad = await prisma.ad.findUnique({
      where: { trackingSlug: slug },
      select: {
        id: true,
        campaignId: true,
        destinationUrl: true,
        isActive: true,
        adPosts: {
          where: { status: 'PUBLISHED' },
          orderBy: { publishedAt: 'desc' },
          take: 1,
          select: { id: true, channelId: true },
        },
      },
    });

    if (!ad || !ad.isActive) return null;

    const post = ad.adPosts[0] ?? null;
    return {
      adId: ad.id,
      campaignId: ad.campaignId,
      adPostId: post?.id ?? null,
      destinationUrl: ad.destinationUrl,
      channelId: post?.channelId ?? null,
    };
  } catch (err) {
    logger.error({ err: errMessage(err), slug }, 'resolveTrackingSlug failed');
    return null;
  }
}

/* ------------------------------------------------------------------
 *  Click recording
 * ------------------------------------------------------------------ */

export interface RecordClickInput {
  slug: string;
  telegramUserId?: string | null;
  userId?: string | null;
  ip: string;
  userAgent: string;
  country?: string | null;
}

function toBigIntOrNull(value: string | null | undefined): bigint | null {
  if (!value) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Record a click on a tracking slug.
 *
 *  - `isUnique` is true only when this IP has no other click on the same ad
 *    within the last 24 hours.
 *  - The live post's `clicks` counter is always bumped; `uniqueClicks` only
 *    when the click is unique.
 *  - A per-(ad, ip) 60-second Redis window flags click-flood fraud.
 *
 * This function MUST NEVER THROW — it is on the hot redirect path.
 */
export async function recordClick(input: RecordClickInput): Promise<void> {
  try {
    const target = await resolveTrackingSlug(input.slug);
    if (!target) {
      logger.warn({ slug: input.slug }, 'recordClick: unknown or inactive tracking slug');
      return;
    }

    const ipHash = hashIp(input.ip);
    const userAgentHash = hashUserAgent(input.userAgent ?? '');
    const telegramUserId = toBigIntOrNull(input.telegramUserId);

    // 1. Uniqueness check against the last 24h.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const priorClicks = await prisma.click.count({
      where: { adId: target.adId, ipHash, createdAt: { gte: dayAgo } },
    });
    const isUnique = priorClicks === 0;

    // 2. Flood window. A Redis outage must not kill tracking — degrade to
    //    "not flagged" and keep recording.
    let isFraud = false;
    let fraudReason: string | null = null;
    try {
      const windowCount = await incrWindow(`click:${target.adId}:${ipHash}`, 60);
      if (windowCount > env.MAX_CLICKS_PER_IP_PER_MINUTE) {
        isFraud = true;
        fraudReason = `More than ${env.MAX_CLICKS_PER_IP_PER_MINUTE} clicks per minute from one IP`;
      }
    } catch (err) {
      logger.warn({ err: errMessage(err), adId: target.adId }, 'recordClick: rate window unavailable');
    }

    // 3. Persist the click row.
    const click = await prisma.click.create({
      data: {
        adId: target.adId,
        adPostId: target.adPostId,
        campaignId: target.campaignId,
        channelId: target.channelId,
        userId: input.userId ?? null,
        telegramUserId,
        ipHash,
        userAgentHash,
        country: input.country ?? null,
        isUnique,
        isFraud,
        fraudReason,
      },
    });

    // 4. Bump the live post counters (always clicks, sometimes uniqueClicks).
    if (target.adPostId) {
      try {
        await prisma.adPost.update({
          where: { id: target.adPostId },
          data: {
            clicks: { increment: 1 },
            ...(isUnique ? { uniqueClicks: { increment: 1 } } : {}),
          },
        });
      } catch (err) {
        logger.warn({ err: errMessage(err), adPostId: target.adPostId }, 'recordClick: post counter update failed');
      }
    }

    if (isFraud) {
      logger.warn({ clickId: click.id, adId: target.adId, reason: fraudReason }, 'recordClick: click flagged as fraud');
    }
  } catch (err) {
    // Never throw from tracking — the user's redirect must survive.
    logger.error({ err: errMessage(err), slug: input.slug }, 'recordClick failed');
  }
}

/* ------------------------------------------------------------------
 *  Stats sync
 * ------------------------------------------------------------------ */

/**
 * Refresh channel subscriber counts for recently published posts and stamp
 * `lastStatsSyncAt` on each post we were able to check.
 *
 * IMPORTANT: the Telegram Bot API does NOT reliably expose per-post view
 * counts for channel posts, so `views` is deliberately left untouched — we
 * never invent a number. Only the channel's subscriber count (from
 * getChatMemberCount, when available) is updated.
 *
 * Returns the number of ad posts actually touched.
 */
export async function syncPostViews(limit = 200): Promise<number> {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const posts = await prisma.adPost.findMany({
      where: {
        status: 'PUBLISHED',
        telegramMessageId: { not: null },
        publishedAt: { lte: tenMinutesAgo },
      },
      orderBy: { publishedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        channelId: true,
        channel: { select: { id: true, telegramChannelId: true, subscriberCount: true } },
      },
    });

    if (!posts.length) return 0;

    let touched = 0;
    await mapWithConcurrency(posts, 4, async (post) => {
      try {
        const info = await getChatInfo(post.channel.telegramChannelId);
        // Telegram unreachable / chat gone: nothing to refresh — do not stamp,
        // so the post is picked up again on the next run.
        if (!info) return;

        if (typeof info.memberCount === 'number' && info.memberCount !== post.channel.subscriberCount) {
          await prisma.channel.update({
            where: { id: post.channelId },
            data: { subscriberCount: info.memberCount },
          });
        }

        await prisma.adPost.update({
          where: { id: post.id },
          data: { lastStatsSyncAt: new Date() },
        });
        touched += 1;
      } catch (err) {
        logger.warn({ err: errMessage(err), adPostId: post.id }, 'syncPostViews: row failed');
      }
    });

    logger.info({ candidates: posts.length, touched }, 'syncPostViews completed');
    return touched;
  } catch (err) {
    logger.error({ err: errMessage(err) }, 'syncPostViews failed');
    return 0;
  }
}
