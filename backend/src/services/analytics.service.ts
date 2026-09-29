import type { AnalyticsSummary, PublisherAnalytics } from '@botflow/shared';
import { prisma } from '../db/prisma';
import { getWallet } from './wallet.service';
import { remainingBudgetCents as campaignRemainingBudgetCents } from './escrow.service';
import { entitlementsFor } from './premium.service';
import { ForbiddenError } from '../utils/errors';
import { ctrPercent } from '../utils/format';

/**
 * Read-only analytics for the advertiser and publisher dashboards, plus
 * platform revenue reporting.
 *
 * Every number comes from real ledger / delivery rows — views and clicks
 * are stored from Telegram snapshots and are never estimated or invented.
 */

/** Campaign statuses that still hold reserved budget. */
const BUDGET_HOLDING_STATUSES = ['APPROVED', 'SCHEDULED', 'RUNNING'] as const;
/** Campaign statuses counted as "active" on the advertiser side. */
const ACTIVE_CAMPAIGN_STATUSES = ['SCHEDULED', 'RUNNING'] as const;

export async function advertiserAnalytics(userId: string): Promise<AnalyticsSummary> {
  // `users.total_spent_cents` is never written; the wallet copy is the one
  // postLedger maintains, so read that (same output field, real value).
  const [wallet, campaigns] = await Promise.all([
    getWallet(userId),
    prisma.campaign.findMany({
      where: { advertiserId: userId },
      select: { id: true, status: true, budgetTotalCents: true, budgetSpentCents: true },
    }),
  ]);

  const campaignIds = campaigns.map((c) => c.id);
  const activeCampaignIds = campaigns
    .filter((c) => (ACTIVE_CAMPAIGN_STATUSES as readonly string[]).includes(c.status))
    .map((c) => c.id);
  const completedCampaignIds = campaigns.filter((c) => c.status === 'COMPLETED').map((c) => c.id);

  const [totalPosts, totals, activeChannelRows, completedChannelRows] = await Promise.all([
    prisma.adPost.count({ where: { campaignId: { in: campaignIds }, status: 'PUBLISHED' } }),
    prisma.adPost.aggregate({
      where: { campaignId: { in: campaignIds }, status: 'PUBLISHED' },
      _sum: { views: true, clicks: true },
    }),
    // Distinct channels actually receiving ads per campaign bucket.
    prisma.adPost.findMany({
      where: { campaignId: { in: activeCampaignIds }, status: 'PUBLISHED' },
      select: { channelId: true },
    }),
    prisma.adPost.findMany({
      where: { campaignId: { in: completedCampaignIds }, status: 'PUBLISHED' },
      select: { channelId: true },
    }),
  ]);

  const totalViews = totals._sum.views ?? 0;
  const totalClicks = totals._sum.clicks ?? 0;

  const remainingBudgetCents = campaigns
    .filter((c) => (BUDGET_HOLDING_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + campaignRemainingBudgetCents(c), 0);

  return {
    totalSpendCents: wallet.totalSpentCents,
    totalPosts,
    totalViews,
    totalClicks,
    ctr: ctrPercent(totalClicks, totalViews),
    activeChannels: new Set(activeChannelRows.map((r) => r.channelId)).size,
    completedChannels: new Set(completedChannelRows.map((r) => r.channelId)).size,
    remainingBudgetCents,
  };
}

export async function publisherAnalytics(userId: string): Promise<PublisherAnalytics> {
  const [wallet, sponsoredPosts, totals, earningsByStatus] = await Promise.all([
    getWallet(userId),
    prisma.adPost.count({ where: { publisherId: userId, status: 'PUBLISHED' } }),
    prisma.adPost.aggregate({
      where: { publisherId: userId, status: 'PUBLISHED' },
      _sum: { views: true, clicks: true },
    }),
    prisma.publisherEarning.groupBy({
      by: ['status'],
      where: { publisherId: userId },
      _sum: { netCents: true },
    }),
  ]);

  const totalViews = totals._sum.views ?? 0;
  const totalClicks = totals._sum.clicks ?? 0;
  const netByStatus = new Map(earningsByStatus.map((row) => [row.status, row._sum.netCents ?? 0]));

  return {
    sponsoredPosts,
    totalViews,
    totalClicks,
    ctr: ctrPercent(totalClicks, totalViews),
    totalEarningsCents: wallet.totalEarnedCents,
    pendingEarningsCents: netByStatus.get('PENDING') ?? 0,
    availableBalanceCents: wallet.availableCents,
    paidEarningsCents: netByStatus.get('PAID') ?? 0,
  };
}

export interface RevenueDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  /** Platform fee collected on published posts that day, in cents. */
  revenueCents: number;
}

/**
 * Platform revenue per day over the last `days` days (today included).
 * Revenue is the `platform_fee_cents` booked on PUBLISHED posts — the same
 * integer-cent figure recorded by the ledger at delivery time.
 */
export async function revenueByDay(days = 30): Promise<RevenueDay[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days), 1), 366);

  const rows = await prisma.$queryRaw<
    Array<{ date: Date; revenue_cents: number }>
  >`
    SELECT
      date_trunc('day', "published_at") AS "date",
      CAST(COALESCE(SUM("platform_fee_cents"), 0) AS INTEGER) AS "revenue_cents"
    FROM "ad_posts"
    WHERE "status" = 'PUBLISHED'
      AND "published_at" >= CURRENT_DATE - (${clampedDays} - 1) * INTERVAL '1 day'
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    revenueCents: row.revenue_cents,
  }));
}

/* ------------------------------------------------------------------
 *  Premium gate — advanced analytics
 * ------------------------------------------------------------------ */

/**
 * `advancedAnalytics` is a premium ability. The lifetime summary endpoints stay
 * free (they are exactly what the dashboard already shows); the longer history
 * windows and per-day / per-channel breakdowns below are what a subscription
 * unlocks.
 *
 * This fails LOUDLY: a blocked caller gets a typed 403 with an actionable
 * message, so the client can show an upgrade prompt — never an empty success.
 */
export async function assertAdvancedAnalytics(userId: string): Promise<void> {
  const entitlements = await entitlementsFor(userId);
  if (!entitlements.advancedAnalytics) {
    throw new ForbiddenError(
      'Advanced analytics is a Premium feature. Upgrade to Premium to unlock history beyond the current period and per-day breakdowns.',
      { premiumRequired: true, entitlement: 'advancedAnalytics' },
    );
  }
}

export interface AdvertiserHistoryDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  posts: number;
  views: number;
  clicks: number;
  /** Advertiser spend booked on published posts that day, in integer cents. */
  spendCents: number;
}

export interface AdvertiserHistoryChannel {
  channelId: string;
  title: string;
  posts: number;
  views: number;
  clicks: number;
}

export interface AdvertiserAnalyticsHistory {
  /** Window actually applied, after clamping. */
  days: number;
  /** Inclusive UTC date range, YYYY-MM-DD. */
  from: string;
  to: string;
  daily: AdvertiserHistoryDay[];
  totals: {
    posts: number;
    views: number;
    clicks: number;
    spendCents: number;
    /** Percent, 2dp — same convention as the free summary. */
    ctr: number;
  };
  topChannels: AdvertiserHistoryChannel[];
}

const MAX_HISTORY_DAYS = 366;

/** UTC `YYYY-MM-DD` for a Date. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * PREMIUM: per-day delivery history for the advertiser's own published posts over
 * a rolling window, plus the best-performing channels in that window. Every
 * figure comes from real `ad_posts` rows — nothing is estimated.
 */
export async function advertiserAnalyticsHistory(
  userId: string,
  days = 30,
): Promise<AdvertiserAnalyticsHistory> {
  await assertAdvancedAnalytics(userId);

  const clampedDays = Math.min(Math.max(Math.trunc(days) || 1, 1), MAX_HISTORY_DAYS);
  const since = new Date(Date.now() - (clampedDays - 1) * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);

  const [dailyRows, channelRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ date: Date; posts: number; views: number; clicks: number; spend_cents: number }>
    >`
      SELECT
        date_trunc('day', p."published_at") AS "date",
        CAST(COUNT(*) AS INTEGER) AS "posts",
        CAST(COALESCE(SUM(p."views"), 0) AS INTEGER) AS "views",
        CAST(COALESCE(SUM(p."clicks"), 0) AS INTEGER) AS "clicks",
        CAST(COALESCE(SUM(p."price_cents"), 0) AS INTEGER) AS "spend_cents"
      FROM "ad_posts" p
      JOIN "campaigns" c ON c."id" = p."campaign_id"
      WHERE c."advertiser_id" = ${userId}
        AND p."status" = 'PUBLISHED'
        AND p."published_at" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `,
    prisma.$queryRaw<
      Array<{ channelId: string; title: string; posts: number; views: number; clicks: number }>
    >`
      SELECT
        p."channel_id" AS "channelId",
        ch."title" AS "title",
        CAST(COUNT(*) AS INTEGER) AS "posts",
        CAST(COALESCE(SUM(p."views"), 0) AS INTEGER) AS "views",
        CAST(COALESCE(SUM(p."clicks"), 0) AS INTEGER) AS "clicks"
      FROM "ad_posts" p
      JOIN "campaigns" c ON c."id" = p."campaign_id"
      JOIN "channels" ch ON ch."id" = p."channel_id"
      WHERE c."advertiser_id" = ${userId}
        AND p."status" = 'PUBLISHED'
        AND p."published_at" >= ${since}
      GROUP BY 1, 2
      ORDER BY "views" DESC
      LIMIT 10
    `,
  ]);

  const daily: AdvertiserHistoryDay[] = dailyRows.map((row) => ({
    date: isoDay(row.date),
    posts: row.posts,
    views: row.views,
    clicks: row.clicks,
    spendCents: row.spend_cents,
  }));

  const totals = daily.reduce(
    (acc, day) => ({
      posts: acc.posts + day.posts,
      views: acc.views + day.views,
      clicks: acc.clicks + day.clicks,
      spendCents: acc.spendCents + day.spendCents,
    }),
    { posts: 0, views: 0, clicks: 0, spendCents: 0 },
  );

  return {
    days: clampedDays,
    from: isoDay(since),
    to: isoDay(new Date()),
    daily,
    totals: { ...totals, ctr: ctrPercent(totals.clicks, totals.views) },
    topChannels: channelRows.map((row) => ({
      channelId: row.channelId,
      title: row.title,
      posts: row.posts,
      views: row.views,
      clicks: row.clicks,
    })),
  };
}
