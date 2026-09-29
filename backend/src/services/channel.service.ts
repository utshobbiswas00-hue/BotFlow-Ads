import type { ChannelCategory, ChannelStatus } from '@prisma/client';
import {
  type MarketplaceSort,
  type PostingSchedule,
  type PricingModel,
  marketplaceFilterSchema,
} from '@botflow/shared';
import { Prisma, prisma } from '../db/prisma';
import { getChatInfo, checkBotPermissions } from '../utils/telegram';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { normaliseChannelUsername } from '../utils/format';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { businessRules } from './settings.service';
import { recordAudit } from './audit.service';
import { enqueueChannelStatsRefresh } from '../queues/producers';
import { logger } from '../config/logger';

/**
 * Publisher-side channel lifecycle:
 *   add -> verify bot permissions -> admin approval -> marketplace listing
 */

export const CHANNEL_SELECT = {
  id: true,
  telegramChannelId: true,
  username: true,
  title: true,
  description: true,
  photoUrl: true,
  inviteLink: true,
  category: true,
  language: true,
  country: true,
  subscriberCount: true,
  avgViews: true,
  avgPostPerformance: true,
  status: true,
  rejectionReason: true,
  adminNote: true,
  botIsAdmin: true,
  canPostMessages: true,
  canEditMessages: true,
  canDeleteMessages: true,
  lastPermissionCheck: true,
  pricingModel: true,
  adPriceCents: true,
  cpmRateCents: true,
  cpcRateCents: true,
  autoApprovePosts: true,
  maxPostsPerDay: true,
  minHoursBetweenAds: true,
  acceptAds: true,
  minAdPriceCents: true,
  postingSchedule: true,
  totalAdsPublished: true,
  totalEarnedCents: true,
  approvedAt: true,
  verifiedAt: true,
  createdAt: true,
} satisfies Prisma.ChannelSelect;

/* ------------------------------------------------------------------
 *  Add channel
 * ------------------------------------------------------------------ */

export interface AddChannelInput {
  channelUsername: string;
  category?: ChannelCategory;
  language?: string;
  country?: string;
  /** The publisher's weekly posting schedule (shared/src/schemas.ts). */
  postingSchedule?: PostingSchedule;
}

export async function addChannel(ownerId: string, input: AddChannelInput) {
  const username = normaliseChannelUsername(input.channelUsername);
  if (!username) {
    throw new ValidationError(
      'Enter a valid public channel username, for example @MyNewsChannel or https://t.me/MyNewsChannel',
    );
  }

  // 1. Resolve the channel through the Telegram API. This is the only way to
  //    learn the numeric channel id, which never changes even if the
  //    username is renamed later.
  const chat = await getChatInfo(`@${username}`);
  if (!chat) {
    throw new ValidationError(
      'Channel not found. Make sure the username is correct and the channel is public.',
    );
  }
  if (chat.type !== 'channel') {
    throw new ValidationError('Only Telegram channels can be added. Groups are not supported for ad delivery.');
  }

  // 2. The bot's rights are the gate, not a later review step.
  //
  //    There is no PENDING stage: a channel either has the bot as an
  //    administrator with "Post Messages" and is therefore deliverable, or it
  //    is not added at all and the owner is told to grant the rights first.
  //    That keeps `ChannelStatus` honest — an APPROVED channel here means
  //    "sponsored posts can actually go out right now" — and removes the
  //    half-added row that used to sit in the owner's list waiting for a
  //    permission that may never come.
  //
  //    `checkBotPermissions` never throws — a lookup failure reads as "not
  //    admin yet" — so a Telegram hiccup produces the same clear instruction
  //    rather than a 500.
  const perms = await checkBotPermissions(chat.id);
  const botReady = perms.botIsAdmin && perms.canPostMessages;

  const minPrice = await businessRules.minChannelPostPriceCents();
  const defaultPrice = Math.max(minPrice, 100);
  
  const existing = await prisma.channel.findUnique({
    where: { telegramChannelId: chat.id },
    select: { id: true, ownerId: true, status: true },
  });

  if (!botReady && !existing) {
    throw new ValidationError(
      `@BotflowadsBot is not an administrator of "${chat.title}" with the "Post Messages" permission yet. ` +
        'Add the bot as an administrator (Post Messages ON), then press Verify Channel again.',
    );
  }

  if (existing) {
    if (existing.ownerId !== ownerId) {
      throw new ConflictError('This channel is already registered by another BotFlow Ads user.');
    }
    // Re-adding an own channel = refresh its details and put it back in review.
    const updated = await prisma.channel.update({
      where: { id: existing.id },
      data: {
        title: chat.title,
        username: chat.username,
        description: chat.description ?? null,
        photoUrl: chat.photoUrl ?? null,
        inviteLink: chat.inviteLink ?? null,
        subscriberCount: chat.memberCount ?? 0,
        botIsAdmin: perms.botIsAdmin,
        canPostMessages: perms.canPostMessages,
        canEditMessages: perms.canEditMessages,
        canDeleteMessages: perms.canDeleteMessages,
        lastPermissionCheck: new Date(),
        ...(input.postingSchedule !== undefined ? { postingSchedule: input.postingSchedule } : {}),
        // A re-add never demotes: rights that are still missing leave the
        // existing status alone (verifyChannel owns the ATTENTION_REQUIRED
        // transition), while rights that are present promote a rejected or
        // flagged channel straight back to APPROVED.
        ...(botReady && existing.status !== 'APPROVED'
          ? { status: 'APPROVED' as ChannelStatus, rejectionReason: null }
          : {}),
        ...(botReady && existing.status !== 'APPROVED'
          ? { approvedAt: new Date(), verifiedAt: new Date() }
          : {}),
      },
      select: CHANNEL_SELECT,
    });
    await enqueueChannelStatsRefresh(updated.id);
    return updated;
  }

  const channel = await prisma.channel.create({
    data: {
      ownerId,
      telegramChannelId: chat.id,
      username: chat.username,
      title: chat.title,
      description: chat.description ?? null,
      photoUrl: chat.photoUrl ?? null,
      inviteLink: chat.inviteLink ?? null,
      category: input.category ?? 'OTHER',
      language: input.language ?? 'en',
      country: input.country ?? 'BD',
      subscriberCount: chat.memberCount ?? 0,
      // No PENDING: reaching this line means the bot already has the rights.
      status: 'APPROVED',
      ...(input.postingSchedule !== undefined ? { postingSchedule: input.postingSchedule } : {}),
      botIsAdmin: perms.botIsAdmin,
      canPostMessages: perms.canPostMessages,
      canEditMessages: perms.canEditMessages,
      canDeleteMessages: perms.canDeleteMessages,
      lastPermissionCheck: new Date(),
      adPriceCents: defaultPrice,
      pricingModel: 'FIXED',
      approvedAt: new Date(),
      verifiedAt: new Date(),
    },
    select: CHANNEL_SELECT,
  });

  await enqueueChannelStatsRefresh(channel.id);
  logger.info({ channelId: channel.id, ownerId, username }, 'channel added');

  return channel;
}

/* ------------------------------------------------------------------
 *  Read
 * ------------------------------------------------------------------ */

export interface ListChannelsFilter {
  status?: ChannelStatus;
  category?: ChannelCategory;
  country?: string;
}

export async function listChannels(ownerId: string, filter: ListChannelsFilter, p: Pagination) {
  const where: Prisma.ChannelWhereInput = {
    ownerId,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.country ? { country: filter.country } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.channel.count({ where }),
    prisma.channel.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: p.skip,
      take: p.take,
      select: CHANNEL_SELECT,
    }),
  ]);

  return buildPaginated(items, total, p);
}

export async function getChannel(ownerId: string, channelId: string) {
  // Pending channels are re-checked automatically. This also repairs older
  // PENDING rows that were created before the bot became an administrator.
  // Throttle Telegram lookups so opening/polling the page cannot hammer the
  // Bot API. Ten seconds is short enough to feel automatic in the UI.
  const current = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      ownerId: true,
      status: true,
      lastPermissionCheck: true,
    },
  });

  if (!current) throw new NotFoundError('Channel');
  if (current.ownerId !== ownerId) {
    throw new ForbiddenError('This channel belongs to another account');
  }

  if (current.status === 'PENDING') {
    const lastCheck = current.lastPermissionCheck?.getTime() ?? 0;
    const stale = Date.now() - lastCheck >= 10_000;
    if (stale) {
      try {
        await verifyChannel(channelId);
      } catch (err) {
        // A transient Telegram/API failure must not make the channel detail
        // page fail. The next automatic poll will retry the permission check.
        logger.warn({ err, channelId }, 'automatic pending-channel verification failed');
      }
    }
  }

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      ...CHANNEL_SELECT,
      stats: {
        orderBy: { date: 'desc' },
        take: 30,
        select: { date: true, subscribers: true, avgViews: true, clicksTotal: true },
      },
      adPosts: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          publishedAt: true,
          views: true,
          clicks: true,
          publisherEarningCents: true,
          campaign: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!channel) throw new NotFoundError('Channel');
  return channel;
}

export async function ownsChannel(userId: string, channelId: string): Promise<boolean> {
  const row = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { ownerId: true },
  });
  return row?.ownerId === userId;
}

/** Throws unless `userId` owns `channelId`. Used by ad-request approve/reject. */
export async function assertChannelOwner(userId: string, channelId: string): Promise<void> {
  if (!(await ownsChannel(userId, channelId))) {
    throw new ForbiddenError('This channel belongs to another account');
  }
}

/* ------------------------------------------------------------------
 *  Update
 * ------------------------------------------------------------------ */

export interface UpdateChannelInput {
  category?: ChannelCategory;
  language?: string;
  country?: string;
  adPriceCents?: number;
  pricingModel?: 'FIXED' | 'CPM' | 'CPC' | 'HYBRID';
  autoApprovePosts?: boolean;
  maxPostsPerDay?: number;
  minHoursBetweenAds?: number;
  /** Publisher switch: false pauses new sponsored delivery, channel stays listed. */
  acceptAds?: boolean;
  /** Publisher floor. 0 = no floor. Blocks any advertiser offer below this. */
  minAdPriceCents?: number;
  /** Replace the weekly posting schedule. `null` clears it. */
  postingSchedule?: PostingSchedule | null;
}

export async function updateChannel(ownerId: string, channelId: string, input: UpdateChannelInput) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      ownerId: true,
      status: true,
      adPriceCents: true,
      minAdPriceCents: true,
      postingSchedule: true,
    },
  });
  if (!channel) throw new NotFoundError('Channel');
  if (channel.ownerId !== ownerId) throw new ForbiddenError('This channel belongs to another account');
  if (channel.status === 'SUSPENDED') {
    throw new ForbiddenError('This channel is suspended and cannot be edited. Contact support.');
  }

  if (input.adPriceCents !== undefined) {
    const min = await businessRules.minChannelPostPriceCents();
    const max = await businessRules.maxChannelPostPriceCents();
    if (input.adPriceCents < min || input.adPriceCents > max) {
      throw new ValidationError(
        `Ad price must be between ${(min / 100).toFixed(2)} and ${(max / 100).toFixed(2)}`,
      );
    }
  }

  // The floor is what an advertiser must clear before this channel can be
  // targeted. A floor above the platform's own maximum would make the channel
  // permanently undeliverable, so it is refused rather than silently stored.
  if (input.minAdPriceCents !== undefined) {
    if (!Number.isInteger(input.minAdPriceCents) || input.minAdPriceCents < 0) {
      throw new ValidationError('The minimum ad price must be a whole number of cents, zero or more.');
    }
    const maxPost = await businessRules.maxChannelPostPriceCents();
    if (input.minAdPriceCents > maxPost) {
      throw new ValidationError(
        `The minimum ad price cannot be higher than the platform maximum of ${(maxPost / 100).toFixed(2)}.`,
      );
    }
  }

  const updated = await prisma.channel.update({
    where: { id: channelId },
    data: {
      ...(input.category ? { category: input.category } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.adPriceCents !== undefined ? { adPriceCents: input.adPriceCents } : {}),
      ...(input.pricingModel ? { pricingModel: input.pricingModel } : {}),
      ...(input.autoApprovePosts !== undefined ? { autoApprovePosts: input.autoApprovePosts } : {}),
      ...(input.maxPostsPerDay !== undefined ? { maxPostsPerDay: input.maxPostsPerDay } : {}),
      ...(input.minHoursBetweenAds !== undefined ? { minHoursBetweenAds: input.minHoursBetweenAds } : {}),
      ...(input.acceptAds !== undefined ? { acceptAds: input.acceptAds } : {}),
      ...(input.minAdPriceCents !== undefined ? { minAdPriceCents: input.minAdPriceCents } : {}),
      ...(input.postingSchedule !== undefined
        ? { postingSchedule: input.postingSchedule ?? Prisma.DbNull }
        : {}),
    },
    select: CHANNEL_SELECT,
  });

  if (input.minAdPriceCents !== undefined && input.minAdPriceCents !== channel.minAdPriceCents) {
    await recordAudit({
      actorId: ownerId,
      actorType: 'USER',
      action: 'CHANNEL_MIN_PRICE_CHANGED',
      targetType: 'CHANNEL',
      targetId: channelId,
      oldValue: { minAdPriceCents: channel.minAdPriceCents },
      newValue: { minAdPriceCents: input.minAdPriceCents },
    });
  }

  if (input.adPriceCents !== undefined && input.adPriceCents !== channel.adPriceCents) {
    await recordAudit({
      actorId: ownerId,
      actorType: 'USER',
      action: 'CHANNEL_PRICE_CHANGED',
      targetType: 'CHANNEL',
      targetId: channelId,
      oldValue: { adPriceCents: channel.adPriceCents },
      newValue: { adPriceCents: input.adPriceCents },
    });
  }

  return updated;
}

/**
 * Remove a channel. Refused while campaigns still have live delivery jobs,
 * because deleting would orphan an advertiser's paid inventory.
 */
export async function deleteChannel(ownerId: string, channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { ownerId: true, status: true },
  });
  if (!channel) throw new NotFoundError('Channel');
  if (channel.ownerId !== ownerId) throw new ForbiddenError('This channel belongs to another account');

  const liveJobs = await prisma.deliveryJob.count({
    where: {
      channelId,
      status: { in: ['PENDING', 'SCHEDULED', 'PROCESSING', 'LOCKED', 'AWAITING_APPROVAL'] },
    },
  });
  if (liveJobs > 0) {
    throw new ConflictError(
      `This channel has ${liveJobs} ad(s) waiting to be delivered. Wait for them to finish or pause them first.`,
    );
  }

  await prisma.channel.delete({ where: { id: channelId } });
  logger.info({ channelId, ownerId }, 'channel deleted');
}

/* ------------------------------------------------------------------
 *  Verification & permission monitoring
 * ------------------------------------------------------------------ */

export interface VerifyResult {
  channelId: string;
  status: ChannelStatus;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  permissionLost: boolean;
}

/**
 * Re-check the bot's rights inside a channel.
 * If rights disappeared we set ATTENTION_REQUIRED and notify the publisher —
 * otherwise the advertiser would pay for posts that can never be delivered.
 */
export async function verifyChannel(channelId: string): Promise<VerifyResult> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, telegramChannelId: true, ownerId: true, status: true, title: true },
  });
  if (!channel) throw new NotFoundError('Channel');

  const perms = await checkBotPermissions(channel.telegramChannelId);
  const permissionLost = !perms.botIsAdmin || !perms.canPostMessages;

  let nextStatus: ChannelStatus = channel.status;

  if (permissionLost && channel.status === 'APPROVED') {
    nextStatus = 'ATTENTION_REQUIRED';
  } else if (
    !permissionLost &&
    (channel.status === 'ATTENTION_REQUIRED' || channel.status === 'PENDING')
  ) {
    nextStatus = 'APPROVED';
  }

  await prisma.channel.update({
    where: { id: channelId },
    data: {
      botIsAdmin: perms.botIsAdmin,
      canPostMessages: perms.canPostMessages,
      canEditMessages: perms.canEditMessages,
      canDeleteMessages: perms.canDeleteMessages,
      lastPermissionCheck: new Date(),
      ...(nextStatus !== channel.status ? { status: nextStatus } : {}),
      ...(nextStatus === 'APPROVED' && channel.status !== 'APPROVED' ? { approvedAt: new Date() } : {}),
      ...(perms.botIsAdmin && perms.canPostMessages ? { verifiedAt: new Date() } : {}),
    },
  });

  if (permissionLost && channel.status === 'APPROVED') {
    logger.warn({ channelId, title: channel.title }, 'channel permission lost — marked ATTENTION_REQUIRED');
  }

  return {
    channelId,
    status: nextStatus,
    botIsAdmin: perms.botIsAdmin,
    canPostMessages: perms.canPostMessages,
    permissionLost,
  };
}

/* ------------------------------------------------------------------
 *  Marketplace (advertiser-facing browse)
 * ------------------------------------------------------------------ */

/**
 * Query params for GET /api/marketplace. New fields (price range, pricing
 * model, sort) are validated with `marketplaceFilterSchema` from
 * @botflow/shared — the same schema the route uses, so route and service can
 * never disagree about what a filter value means.
 */
export interface MarketplaceFilter {
  category?: ChannelCategory;
  country?: string;
  language?: string;
  minSubs?: number;
  maxSubs?: number;
  minViews?: number;
  search?: string;
  /** Inclusive range on adPriceCents. 0 = "no bound on this side". */
  minPriceCents?: number;
  maxPriceCents?: number;
  pricingModel?: PricingModel;
  /** reach_desc | subscribers_desc | price_asc | price_desc | quality_desc */
  sort?: MarketplaceSort;
}

/** Deterministic order for each sort; `id` is the final tiebreaker so paging is stable. */
const MARKETPLACE_ORDER_BY: Record<MarketplaceSort, Prisma.ChannelOrderByWithRelationInput> = {
  reach_desc: { avgViews: 'desc' },
  subscribers_desc: { subscriberCount: 'desc' },
  price_asc: { adPriceCents: 'asc' },
  price_desc: { adPriceCents: 'desc' },
  quality_desc: { healthScore: 'desc' },
};

export async function listMarketplace(filter: MarketplaceFilter, p: Pagination) {
  // Normalise through the shared schema (coerces raw query strings, applies
  // the sort default). If a caller passes something the schema cannot
  // validate, fall back to the legacy interpretation of the old fields so a
  // bad new value can never take the whole listing down.
  const parsed = marketplaceFilterSchema.safeParse(filter);
  const f = parsed.success ? parsed.data : filter;
  const sort: MarketplaceSort = (f.sort ?? 'reach_desc') as MarketplaceSort;

  const where: Prisma.ChannelWhereInput = {
    status: 'APPROVED',
    botIsAdmin: true,
    canPostMessages: true,
    ...(f.category ? { category: f.category } : {}),
    ...(f.country ? { country: f.country } : {}),
    ...(f.language ? { language: f.language } : {}),
    ...(f.search ? { title: { contains: f.search, mode: 'insensitive' } } : {}),
    ...(f.minSubs || f.maxSubs
      ? {
          subscriberCount: {
            ...(f.minSubs ? { gte: f.minSubs } : {}),
            ...(f.maxSubs ? { lte: f.maxSubs } : {}),
          },
        }
      : {}),
    ...(f.minViews ? { avgViews: { gte: f.minViews } } : {}),
    ...((typeof f.minPriceCents === 'number' || typeof f.maxPriceCents === 'number')
      ? {
          adPriceCents: {
            ...(typeof f.minPriceCents === 'number' ? { gte: f.minPriceCents } : {}),
            ...(typeof f.maxPriceCents === 'number' ? { lte: f.maxPriceCents } : {}),
          },
        }
      : {}),
    ...(f.pricingModel ? { pricingModel: f.pricingModel } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.channel.count({ where }),
    prisma.channel.findMany({
      where,
      orderBy: [MARKETPLACE_ORDER_BY[sort], { id: 'asc' }],
      skip: p.skip,
      take: p.take,
      // Deliberate whitelist — the public listing must not expose ownership
      // or the raw Telegram id.
      select: {
        id: true,
        title: true,
        username: true,
        photoUrl: true,
        category: true,
        country: true,
        language: true,
        subscriberCount: true,
        avgViews: true,
        adPriceCents: true,
        pricingModel: true,
        healthStatus: true,
        healthScore: true,
      },
    }),
  ]);

  return buildPaginated(rows, total, p);
}

/** Channels a publisher can host ads in right now. */
export async function listDeliverableChannels(tx: Prisma.TransactionClient = prisma) {
  return tx.channel.findMany({
    where: { status: 'APPROVED', botIsAdmin: true, canPostMessages: true },
    select: {
      id: true,
      ownerId: true,
      telegramChannelId: true,
      title: true,
      category: true,
      country: true,
      language: true,
      subscriberCount: true,
      avgViews: true,
      adPriceCents: true,
      cpmRateCents: true,
      cpcRateCents: true,
      pricingModel: true,
      maxPostsPerDay: true,
      minHoursBetweenAds: true,
      autoApprovePosts: true,
    },
  });
}

/** Channel stats used by analytics and the admin dashboard. */
export async function channelSummaryStats(ownerId: string) {
  const [total, approved, pending, attention] = await Promise.all([
    prisma.channel.count({ where: { ownerId } }),
    prisma.channel.count({ where: { ownerId, status: 'APPROVED' } }),
    prisma.channel.count({ where: { ownerId, status: 'PENDING' } }),
    prisma.channel.count({ where: { ownerId, status: 'ATTENTION_REQUIRED' } }),
  ]);

  const agg = await prisma.channel.aggregate({
    where: { ownerId },
    _sum: { totalEarnedCents: true, totalAdsPublished: true, subscriberCount: true },
  });

  return {
    total,
    approved,
    pending,
    attention,
    totalEarnedCents: agg._sum.totalEarnedCents ?? 0,
    totalAdsPublished: agg._sum.totalAdsPublished ?? 0,
    totalSubscribers: agg._sum.subscriberCount ?? 0,
  };
}
