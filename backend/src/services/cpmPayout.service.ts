import { prisma, transaction } from '../db/prisma';
import { postLedger, ref } from './transaction.service';
import { getNumberSetting, getBoolSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { splitRevenue } from '../utils/money';
import { logger } from '../config/logger';

/**
 * PUBLISHER CPM PAYOUT — $1.80 per 1,000 measured views
 *
 * WHO GETS PAID: the PUBLISHER — the channel owner who let the bot post in their
 * channel. An advertiser never earns here; they PAY to run campaigns.
 *
 *   publisher adds the bot as a channel admin
 *     -> bot posts a sponsored post in that channel
 *       -> the post's MEASURED views are counted
 *         -> publisher earns views / 1000 * $1.80
 *
 * THE HARD CONSTRAINT: the Telegram Bot API does NOT expose per-post view
 * counts. Views are therefore only ever written from a real, traceable source
 * (see viewSource.service.ts). When nothing can measure a post, no payout is
 * made for it — we never synthesise, estimate or back-fill a view number.
 *
 * THE SECOND HARD CONSTRAINT: the platform must never pay out more than the
 * advertiser was charged for that post, so the payout is capped at
 * `AdPost.priceCents`. The remainder beyond the cap is simply not paid.
 */

export type ViewInputSource = 'MTPROTO' | 'ADMIN' | 'NONE';

export interface ApplyViewsResult {
  updated: boolean;
  earnedCents: number;
  cappedByAdvertiserPrice: boolean;
  reason?: string;
}

/* ------------------------------------------------------------------
 *  Rate
 * ------------------------------------------------------------------ */

/** What this channel's publisher earns per 1,000 views. */
export async function publisherCpmRateCents(channel: {
  publisherCpmRateCents: number | null;
}): Promise<number> {
  if (channel.publisherCpmRateCents !== null && channel.publisherCpmRateCents > 0) {
    return channel.publisherCpmRateCents;
  }
  const platform = await getNumberSetting(SETTING_KEYS.PUBLISHER_CPM_RATE_CENTS, 180);
  return platform > 0 ? platform : 180;
}

/** Pure. 25,000 views at 180c/1000 = 4500c = $45.00 */
export function computeCpmEarning(views: number, rateCents: number): number {
  if (!Number.isFinite(views) || views <= 0 || rateCents <= 0) return 0;
  return Math.round((views * rateCents) / 1000);
}

/* ------------------------------------------------------------------
 *  Apply measured views — the core
 * ------------------------------------------------------------------ */

/**
 * @param opts.force  Skip the monotonic guard. Used by reconciliation, which
 *                    re-derives a payout from views we already stored. The
 *                    ledger reference still includes the view count, so forcing
 *                    a re-run is idempotent and cannot double-pay.
 */
export async function applyViews(
  adPostId: string,
  views: number,
  source: ViewInputSource,
  opts: { force?: boolean } = {},
): Promise<ApplyViewsResult> {
  if (!Number.isFinite(views) || !Number.isInteger(views) || views < 0) {
    return { updated: false, earnedCents: 0, cappedByAdvertiserPrice: false, reason: 'invalid view count' };
  }

  const cpmEnabled = await getBoolSetting(SETTING_KEYS.PUBLISHER_CPM_ENABLED, true);

  return transaction(
    async (tx) => {
      const adPost = await tx.adPost.findUnique({
        where: { id: adPostId },
        select: {
          id: true,
          status: true,
          views: true,
          priceCents: true,
          platformFeeCents: true,
          publisherEarningCents: true,
          earningModel: true,
          publisherId: true,
          campaignId: true,
          channelId: true,
          adId: true,
          channel: {
            select: { publisherCpmRateCents: true, earningModel: true },
          },
          earning: { select: { id: true, grossCents: true, platformFeeCents: true, netCents: true, status: true } },
        },
      });

      if (!adPost) {
        return { updated: false, earnedCents: 0, cappedByAdvertiserPrice: false, reason: 'post not found' };
      }
      if (adPost.status !== 'PUBLISHED') {
        return { updated: false, earnedCents: 0, cappedByAdvertiserPrice: false, reason: 'post is not published' };
      }
      if (!opts.force && views <= adPost.views) {
        // Views are monotonic: a counter can briefly regress, and we must never
        // pay twice for the same views.
        return {
          updated: false,
          earnedCents: adPost.publisherEarningCents,
          cappedByAdvertiserPrice: false,
          reason: 'views did not increase',
        };
      }

      // 1. Record the measurement — real data, always kept even when payout is off.
      await tx.adPost.update({
        where: { id: adPostId },
        data: { views, viewSource: source, viewsSyncedAt: new Date() },
      });

      // Only record an impression when the measurement actually moved, so a
      // reconciliation run does not litter the history with duplicates.
      if (views !== adPost.views) {
        await tx.impression.create({
          data: { adId: adPost.adId, adPostId, views, source },
        });
      }

      // 2. Payout only applies to CPM channels, and only when enabled.
      // A HOUSE post is always CPM-eligible: no advertiser funds it, so the
      // platform pays the publisher from its own margin. The payout is bounded by
      // the post's priceCents, which for a house post is
      // `house_post_payout_cap_cents` rather than an advertiser price.
      const isCpmChannel = adPost.channel.earningModel === 'CPM' || adPost.earningModel === 'CPM';
      if (!isCpmChannel || !cpmEnabled) {
        return {
          updated: true,
          earnedCents: adPost.publisherEarningCents,
          cappedByAdvertiserPrice: false,
          reason: cpmEnabled ? 'channel is not on the CPM earning model' : 'publisher CPM payouts are disabled',
        };
      }

      const rate = await publisherCpmRateCents(adPost.channel);
      const raw = computeCpmEarning(views, rate);

      // 3. Never pay more than the advertiser was charged for this post.
      const capped = Math.min(raw, adPost.priceCents);
      const cappedByAdvertiserPrice = raw > adPost.priceCents;
      if (cappedByAdvertiserPrice) {
        logger.warn(
          { adPostId, views, rate, raw, cap: adPost.priceCents },
          'CPM entitlement exceeded the advertiser price and was capped',
        );
      }

      // 4. Reconcile against what has already been credited for this post.
      const alreadyCredited = adPost.publisherEarningCents;
      const delta = capped - alreadyCredited;

      if (delta <= 0) {
        // No new money to pay (the rate fell, or the cap engaged). Update only
        // the reporting figure — NEVER move `publisherEarningCents` down, or the
        // stored earning would disagree with the wallet we already credited.
        await tx.adPost.update({
          where: { id: adPostId },
          data: { cpmEarnedCents: capped, earningModel: 'CPM' },
        });
        return { updated: true, earnedCents: capped, cappedByAdvertiserPrice };
      }

      // Post the publisher ledger row FIRST. The view count is part of the
      // reference, so re-running with the SAME count is a no-op via the unique
      // index, while a genuine increase writes a new, distinct ledger row. Only
      // a NON-replayed post may touch the denormalized counters — otherwise a
      // replay would bump `netCents`/`publisherEarningCents` for views that were
      // already paid, leaving three different numbers for one post.
      const posted = await postLedger(tx, {
        userId: adPost.publisherId,
        type: 'PUBLISHER_EARNING',
        amountCents: delta,
        reference: `cpm:${adPostId}:${views}`,
        referenceType: 'CPM_PAYOUT',
        walletDelta: { pending: delta, totalEarned: delta },
        description: `CPM earning for ${views.toLocaleString('en-US')} measured views`,
        campaignId: adPost.campaignId,
        channelId: adPost.channelId,
        adPostId,
        earningId: adPost.earning?.id ?? null,
      });
      if (posted.replayed) {
        return { updated: false, earnedCents: capped, cappedByAdvertiserPrice };
      }

      await tx.adPost.update({
        where: { id: adPostId },
        data: { cpmEarnedCents: capped, earningModel: 'CPM', publisherEarningCents: capped },
      });

      if (adPost.earning) {
        await tx.publisherEarning.update({
          where: { id: adPost.earning.id },
          data: {
            grossCents: { increment: delta },
            netCents: { increment: delta },
            ...(adPost.earning.status === 'REVERSED' ? { status: 'PENDING' } : {}),
          },
        });
      } else {
        await tx.publisherEarning.create({
          data: {
            publisherId: adPost.publisherId,
            adPostId,
            channelId: adPost.channelId,
            campaignId: adPost.campaignId,
            grossCents: capped,
            platformFeeCents: 0,
            netCents: capped,
            status: 'PENDING',
          },
        });
      }

      logger.info({ adPostId, views, rate, delta, capped }, 'CPM payout applied');

      return { updated: true, earnedCents: capped, cappedByAdvertiserPrice };
    },
    { timeout: 20_000, retries: 2 },
  );
}

/* ------------------------------------------------------------------
 *  Reconciliation & reporting
 * ------------------------------------------------------------------ */

/** Re-derive a single post's payout from its stored view count. Idempotent. */
export async function settleCpmPost(adPostId: string): Promise<{ settledCents: number }> {
  const post = await prisma.adPost.findUnique({
    where: { id: adPostId },
    select: { views: true, viewSource: true, publisherEarningCents: true },
  });
  if (!post || post.views <= 0) return { settledCents: 0 };

  const result = await applyViews(
    adPostId,
    post.views,
    (post.viewSource as ViewInputSource) ?? 'NONE',
    { force: true },
  );

  return { settledCents: result.earnedCents };
}

export async function recalculateCpmForChannel(channelId: string, limit = 100): Promise<number> {
  const posts = await prisma.adPost.findMany({
    where: { channelId, status: 'PUBLISHED', views: { gt: 0 } },
    select: { id: true, views: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  let changed = 0;
  for (const post of posts) {
    try {
      const before = await prisma.adPost.findUnique({
        where: { id: post.id },
        select: { publisherEarningCents: true },
      });
      await applyViews(post.id, post.views, 'NONE', { force: true });
      const after = await prisma.adPost.findUnique({
        where: { id: post.id },
        select: { publisherEarningCents: true },
      });
      if ((after?.publisherEarningCents ?? 0) !== (before?.publisherEarningCents ?? 0)) changed += 1;
    } catch (err) {
      logger.error({ err, adPostId: post.id }, 'CPM recalculation failed for post');
    }
  }
  return changed;
}

export interface CpmSummary {
  measuredPosts: number;
  unmeasuredPosts: number;
  totalViews: number;
  totalCpmEarnedCents: number;
  rateCents: number;
  /** The headline promise, so the UI never has to hard-code it. */
  rateLabel: string;
}

export async function cpmEarningsSummary(publisherId: string): Promise<CpmSummary> {
  const [measured, unmeasured, agg, rate] = await Promise.all([
    prisma.adPost.count({ where: { publisherId, status: 'PUBLISHED', views: { gt: 0 } } }),
    prisma.adPost.count({ where: { publisherId, status: 'PUBLISHED', views: 0 } }),
    prisma.adPost.aggregate({
      where: { publisherId, status: 'PUBLISHED' },
      _sum: { views: true, cpmEarnedCents: true },
    }),
    publisherCpmRateCents({ publisherCpmRateCents: null }),
  ]);

  return {
    measuredPosts: measured,
    unmeasuredPosts: unmeasured,
    totalViews: agg._sum.views ?? 0,
    totalCpmEarnedCents: agg._sum.cpmEarnedCents ?? 0,
    rateCents: rate,
    rateLabel: `$${(rate / 100).toFixed(2)} per 1,000 views`,
  };
}

/** Estimate only — used for a "potential earnings" hint, never for billing. */
export function projectEarnings(views: number, rateCents: number): { cents: number; label: string } {
  const cents = computeCpmEarning(views, rateCents);
  return { cents, label: `$${(cents / 100).toFixed(2)}` };
}

export { ref, splitRevenue };
