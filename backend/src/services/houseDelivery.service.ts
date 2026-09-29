import { prisma, transaction } from '../db/prisma';
import { redis } from '../db/redis';
import { pickHouseAd, formatHousePost, checkMonetizationEligibility, HOUSE_POST_LABEL } from './houseAd.service';
import { checkChannelFrequency } from './frequency.service';
import { getNumberSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
import { sendChannelPost, describeTelegramError, messageOf } from '../utils/telegram';
import { createNotification, alertAdmins } from './notification.service';
import { logger } from '../config/logger';

/**
 * HOUSE FILL — posting must never stop.
 *
 * When there is no paid inventory to deliver, a channel is not simply left
 * silent: the bot publishes one of BotFlow's own promotions instead. This does two
 * things at once:
 *
 *   • the publisher's channel keeps a steady flow of content, and
 *   • the bot keeps its presence in every channel where it is an administrator,
 *     which is what keeps the audience reachable when paid inventory returns.
 *
 * The publisher is paid for these posts too, on the same $1.80-per-1,000-views
 * basis, because they are still giving the platform their audience. That payout
 * is funded by the platform, not by an advertiser, so each house post carries a
 * `house_post_payout_cap_cents` ceiling to bound the cost.
 */

const HOUSE_PUBLISH_SOURCE = 'HOUSE_FILL';

export interface HousePublishResult {
  published: boolean;
  adPostId?: string;
  messageId?: string;
  reason?: string;
}

/**
 * Publish one house post into a channel.
 * Idempotency note: this is deliberately NOT keyed on a reference — a house post
 * is a real post, and two calls are two posts. The caller decides the cadence
 * (see `fillHouseSlots`).
 */
export async function publishHousePost(
  channelId: string,
  opts: { reason?: string; forcedBy?: string | null } = {},
): Promise<HousePublishResult> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      ownerId: true,
      title: true,
      username: true,
      status: true,
      telegramChannelId: true,
      botIsAdmin: true,
      canPostMessages: true,
      acceptAds: true,
      subscriberCount: true,
      language: true,
      earningModel: true,
    },
  });

  if (!channel) return { published: false, reason: 'channel not found' };
  if (channel.status !== 'APPROVED') return { published: false, reason: `channel is ${channel.status}` };
  if (!channel.botIsAdmin || !channel.canPostMessages) {
    return { published: false, reason: 'bot lacks posting permission' };
  }

  // A channel below the monetization threshold still receives house posts, so the
  // audience keeps growing — but only when the operator has allowed it.
  const eligibility = await checkMonetizationEligibility(channel);
  if (!eligibility.eligible) {
    const allowed = await prisma.setting
      .findUnique({ where: { key: SETTING_KEYS.BELOW_THRESHOLD_RECEIVES_POSTS } })
      .then((r) => r?.value === true)
      .catch(() => false);
    if (!allowed) {
      return { published: false, reason: 'below the monetization threshold' };
    }
  }

  // Avoid repeating the same creative twice in a row in one channel.
  const recent = await prisma.adPost.findMany({
    where: { channelId, houseAdId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { houseAdId: true },
  });

  const creative = await pickHouseAd({ excludeIds: recent.map((r) => r.houseAdId!).filter(Boolean) });
  const formatted = formatHousePost(creative);

  // The cap bounds what the platform can pay out for a post no advertiser funded.
  const payoutCapCents = await getNumberSetting(SETTING_KEYS.HOUSE_POST_PAYOUT_CAP_CENTS, 1000);

  let sent: { messageId: bigint };
  try {
    sent = await sendChannelPost({
      chatId: channel.telegramChannelId,
      text: formatted.text,
      imageUrl: creative.imageUrl,
      buttonText: formatted.buttonText,
      buttonUrl: formatted.buttonUrl,
      disablePreview: Boolean(formatted.buttonText),
    });
  } catch (err) {
    const code = describeTelegramError(err);
    const message = messageOf(err);
    logger.error({ channelId, code, message }, 'house post failed to publish');

    const permanent = ['BOT_NOT_ADMIN', 'MISSING_POST_PERMISSION', 'CHANNEL_NOT_FOUND', 'CHAT_WRITE_FORBIDDEN'];
    if (permanent.includes(code)) {
      await prisma.channel
        .update({
          where: { id: channelId },
          data: { status: 'ATTENTION_REQUIRED', botIsAdmin: false, canPostMessages: false, healthStatus: 'ATTENTION_REQUIRED', lastPermissionCheck: new Date() },
        })
        .catch(() => undefined);

      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_PERMISSION_PROBLEM',
        title: 'Channel needs attention',
        body: `BotFlow could not post in “${channel.title}”. Please re-add the bot as an administrator with the "Post Messages" permission.`,
        data: { channelId },
      }).catch(() => undefined);
    }

    return { published: false, reason: message };
  }

  let adPost: { id: string };
  try {
    adPost = await recordHousePost(channel, creative, sent, payoutCapCents);
  } catch (err) {
    // The post is already live but nothing recorded it. Log loudly and page an
    // admin rather than failing silently — the next sweep would otherwise treat
    // the channel as still-idle and publish a second house post.
    logger.error(
      { err, channelId, messageId: sent.messageId.toString() },
      'CRITICAL: house post published on Telegram but recording it failed',
    );
    await alertAdmins(
      `House post published in “${channel.title}” (Telegram message ${sent.messageId.toString()}) but recording it failed. Manual check required.`,
    ).catch(() => undefined);
    return { published: false, reason: 'published but recording failed' };
  }

  logger.info(
    { channelId, adPostId: adPost.id, creativeId: creative.id, reason: opts.reason ?? HOUSE_PUBLISH_SOURCE },
    'house post published',
  );

  return { published: true, adPostId: adPost.id, messageId: sent.messageId.toString() };
}

/** Persist one published house post (AdPost + delivery log) in one transaction. */
async function recordHousePost(
  channel: { id: string; ownerId: string },
  creative: { id: string },
  sent: { messageId: bigint },
  payoutCapCents: number,
): Promise<{ id: string }> {
  return transaction(async (tx) => {
    const created = await tx.adPost.create({
      data: {
        // A house post genuinely has no campaign and no advertiser creative.
        // `houseAdId` is what identifies what was published.
        campaignId: null,
        adId: null,
        channelId: channel.id,
        publisherId: channel.ownerId,
        telegramMessageId: sent.messageId,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceCents: payoutCapCents,
        publisherEarningCents: 0,
        platformFeeCents: 0,
        earningModel: 'CPM',
        billingMode: 'HOUSE',
        houseAdId: creative.id === 'builtin' ? null : creative.id,
      },
      select: { id: true },
    });

    await tx.channelDeliveryLog.create({ data: { channelId: channel.id, adPostId: created.id } });

    return created;
  });
}

/* ------------------------------------------------------------------
 *  Cadence — keep every channel alive
 * ------------------------------------------------------------------ */

const DEFAULT_IDLE_HOURS = 12;

/**
 * Cross-process lock for the fill sweep.
 *
 * `concurrency: 1` only serialises runs *within one process*. With two worker
 * instances (or a re-run after a lock timeout) the same quiet channel could be
 * filled twice in a row, because a house post is deliberately not idempotent.
 */
const HOUSE_FILL_LOCK_KEY = 'lock:house_fill';
const HOUSE_FILL_LOCK_TTL_MS = 10 * 60 * 1000;

async function acquireHouseFillLock(): Promise<boolean> {
  try {
    const res = await redis.set(HOUSE_FILL_LOCK_KEY, String(process.pid), 'PX', HOUSE_FILL_LOCK_TTL_MS, 'NX');
    return res === 'OK';
  } catch (err) {
    // Redis is the queue's own backend; if it is unreachable, failing closed is
    // safer than risking a second concurrent sweep.
    logger.warn({ err }, 'house fill lock unavailable — skipping this run');
    return false;
  }
}

async function releaseHouseFillLock(): Promise<void> {
  try {
    await redis.del(HOUSE_FILL_LOCK_KEY);
  } catch {
    // The TTL clears it; a stale lock only delays the next sweep.
  }
}

/**
 * Publish a house post into any channel that has gone quiet.
 *
 * A channel is "quiet" when it has had no sponsored post (paid OR house) for
 * longer than `house_post_idle_hours`. Channels that have never had a post are
 * included, so a newly approved channel starts receiving content immediately.
 *
 * Respects the channel's own cooldown AND its daily cap (`checkChannelFrequency`,
 * the same gate paid delivery uses), so a house post can never be the thing that
 * pushes a channel past its limits.
 */
export async function fillHouseSlots(opts: { limit?: number; idleHours?: number } = {}): Promise<number> {
  if (!(await acquireHouseFillLock())) {
    logger.info('house fill skipped: another sweep holds the lock');
    return 0;
  }

  try {
    return await runHouseFill(opts);
  } finally {
    await releaseHouseFillLock();
  }
}

async function runHouseFill(opts: { limit?: number; idleHours?: number }): Promise<number> {
  const idleHours = opts.idleHours ?? (await getNumberSetting(SETTING_KEYS.HOUSE_POST_IDLE_HOURS, DEFAULT_IDLE_HOURS));
  const limit = opts.limit ?? 50;
  const cutoff = new Date(Date.now() - idleHours * 60 * 60 * 1000);

  const channels = await prisma.channel.findMany({
    where: {
      status: 'APPROVED',
      botIsAdmin: true,
      canPostMessages: true,
      acceptAds: true,
    },
    select: {
      id: true,
      title: true,
      minHoursBetweenAds: true,
      maxPostsPerDay: true,
      maxCampaignsPerHour: true,
      postingSchedule: true,
      adPosts: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
    take: 500,
  });

  const now = Date.now();
  const due = channels.filter((c) => {
    const last = c.adPosts[0]?.createdAt;
    if (!last) return true;
    const cooldownMs = Math.max(0, c.minHoursBetweenAds) * 60 * 60 * 1000;
    const readyAt = Math.max(last.getTime() + cooldownMs, last.getTime() + idleHours * 60 * 60 * 1000);
    return readyAt <= now && last.getTime() <= cutoff.getTime();
  });

  let published = 0;
  for (const channel of due.slice(0, limit)) {
    try {
      // Same per-channel gate as paid delivery: the daily ceiling and the
      // hour/cooldown rules apply to house posts too, so filling a quiet channel
      // never floods it.
      const frequency = await checkChannelFrequency({
        id: channel.id,
        maxPostsPerDay: channel.maxPostsPerDay,
        minHoursBetweenAds: channel.minHoursBetweenAds,
        maxCampaignsPerHour: channel.maxCampaignsPerHour ?? null,
        postingSchedule: channel.postingSchedule,
      });
      if (!frequency.allowed) continue;

      const result = await publishHousePost(channel.id, { reason: 'idle_channel_fill' });
      if (result.published) published += 1;
    } catch (err) {
      logger.error({ err, channelId: channel.id }, 'house fill failed for channel');
    }
  }

  if (published) logger.info({ published, considered: channels.length }, 'house fill completed');
  return published;
}

/**
 * Called by the delivery engine when a paid slot has nothing to deliver.
 * Converts the dead slot into a house post rather than dropping it.
 */
export async function fallbackToHousePost(
  channelId: string,
  reason: string,
): Promise<HousePublishResult> {
  logger.info({ channelId, reason }, 'paid slot had no inventory — falling back to a house post');
  return publishHousePost(channelId, { reason });
}

/** Headline numbers for the admin dashboard. */
export async function houseFillStats(): Promise<{
  housePostsToday: number;
  housePostsTotal: number;
  activeCreatives: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [today, total, activeCreatives] = await Promise.all([
    prisma.adPost.count({ where: { houseAdId: { not: null }, createdAt: { gte: startOfDay } } }),
    prisma.adPost.count({ where: { houseAdId: { not: null } } }),
    prisma.houseAd.count({ where: { isActive: true } }),
  ]);

  return { housePostsToday: today, housePostsTotal: total, activeCreatives };
}

export { HOUSE_POST_LABEL };
