import { prisma } from '../db/prisma';
import { getChatInfo } from '../utils/telegram';
import { NotFoundError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Channel statistics refresh.
 *
 * Subscriber counts are only ever written from a live Telegram API response
 * (`getChatInfo`). When the API is unavailable we keep the last known count
 * instead of guessing. Views/clicks come exclusively from the AdPost rows
 * that were filled from Telegram snapshots at delivery time.
 */

export interface ChannelStatsRefreshResult {
  channelId: string;
  /** Live memberCount from Telegram, or null when the API was unavailable. */
  telegramMemberCount: number | null;
  /** Value now stored on the channel (live count, or last known). */
  subscriberCount: number;
  /** Average views over PUBLISHED posts that have views > 0. */
  avgViews: number;
}

/** UTC midnight of the given instant — used for the @db.Date stat row. */
function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function refreshChannelStats(channelId: string): Promise<ChannelStatsRefreshResult> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, telegramChannelId: true, title: true, subscriberCount: true },
  });
  if (!channel) throw new NotFoundError('Channel');

  // 1. Live metrics from the Telegram API.
  const chat = await getChatInfo(channel.telegramChannelId);
  const liveMemberCount = chat?.memberCount ?? null;
  if (!chat) {
    logger.warn(
      { channelId, title: channel.title },
      'channel stats: chat info unavailable, keeping last known subscriber count',
    );
  }

  // 2. Delivery metrics stored from real Telegram snapshots.
  const today = startOfTodayUtc();
  const [perf, totals, postsToday] = await Promise.all([
    // Average is taken over PUBLISHED posts that actually reported views.
    prisma.adPost.aggregate({
      where: { channelId, status: 'PUBLISHED', views: { gt: 0 } },
      _avg: { views: true },
    }),
    prisma.adPost.aggregate({
      where: { channelId, status: 'PUBLISHED' },
      _sum: { views: true, clicks: true },
    }),
    prisma.adPost.count({
      where: { channelId, status: 'PUBLISHED', publishedAt: { gte: today } },
    }),
  ]);

  const avgViews = Math.round(perf._avg.views ?? 0);
  const viewsTotal = totals._sum.views ?? 0;
  const clicksTotal = totals._sum.clicks ?? 0;
  const subscriberCount = liveMemberCount ?? channel.subscriberCount;

  // 3. Persist: channel row (never a stale/fabricated subscriber count)
  //    plus one ChannelStat snapshot per day, unique on channelId + date.
  await prisma.channel.update({
    where: { id: channelId },
    data: {
      avgViews,
      ...(liveMemberCount !== null ? { subscriberCount: liveMemberCount } : {}),
    },
  });

  await prisma.channelStat.upsert({
    where: { channelId_date: { channelId, date: today } },
    create: {
      channelId,
      date: today,
      subscribers: subscriberCount,
      avgViews,
      postsCount: postsToday,
      viewsTotal,
      clicksTotal,
    },
    update: {
      subscribers: subscriberCount,
      avgViews,
      postsCount: postsToday,
      viewsTotal,
      clicksTotal,
    },
  });

  return {
    channelId,
    telegramMemberCount: liveMemberCount,
    subscriberCount,
    avgViews,
  };
}

/**
 * Refresh stats for a batch of APPROVED channels, oldest
 * `lastPermissionCheck` first (most stale first). A single channel failing
 * (e.g. Telegram rate limit) must not stop the rest of the batch.
 *
 * @returns the number of channels actually refreshed.
 */
export async function refreshAllChannelStats(limit = 100): Promise<number> {
  const channels = await prisma.channel.findMany({
    where: { status: 'APPROVED' },
    orderBy: { lastPermissionCheck: 'asc' },
    take: Math.max(1, Math.trunc(limit)),
    select: { id: true },
  });

  let refreshed = 0;
  for (const channel of channels) {
    try {
      await refreshChannelStats(channel.id);
      refreshed += 1;
    } catch (err) {
      logger.warn({ channelId: channel.id, err }, 'channel stats refresh failed');
    }
  }

  if (channels.length > 0) {
    logger.info({ refreshed, candidates: channels.length }, 'channel stats batch refreshed');
  }
  return refreshed;
}
