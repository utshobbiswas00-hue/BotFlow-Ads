import type { Channel, ChannelCategory, ChannelStatus } from '@prisma/client';
import { AppError } from '../utils/errors';
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
import { businessRules, getNumberSetting } from './settings.service';
import { SETTING_KEYS } from '../config/constants';
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

  // 2. Record the bot's rights, but never block submission on them. The
  //    owner can add the bot afterwards — the "Open access" banner on the
  //    channel page (and Telegram's own my_chat_member push) carries it from
  //    PENDING to APPROVED the moment the bot actually gets those rights, so
  //    nobody has to retry this form once Telegram is sorted out.
  //
  //    `checkBotPermissions` never throws — a lookup failure reads as "not
  //    admin yet" — so a Telegram hiccup here never turns into a 500.
  const perms = await checkBotPermissions(chat.id);
  const botReady = perms.botIsAdmin && perms.canPostMessages;

  const minPrice = await businessRules.minChannelPostPriceCents();
  const defaultPrice = Math.max(minPrice, 100);
  
  const existing = await prisma.channel.findUnique({
    where: { telegramChannelId: chat.id },
    select: { id: true, ownerId: true, status: true },
  });

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
      // APPROVED only if the bot already has the rights; otherwise PENDING —
      // the "Open access" banner and the my_chat_member webhook take it from
      // there the moment the owner finishes granting access in Telegram.
      status: botReady ? 'APPROVED' : 'PENDING',
      ...(input.postingSchedule !== undefined ? { postingSchedule: input.postingSchedule } : {}),
      botIsAdmin: perms.botIsAdmin,
      canPostMessages: perms.canPostMessages,
      canEditMessages: perms.canEditMessages,
      canDeleteMessages: perms.canDeleteMessages,
      canInviteUsers: perms.canInviteUsers,
      lastPermissionCheck: new Date(),
      adPriceCents: defaultPrice,
      pricingModel: 'FIXED',
      ...(botReady ? { approvedAt: new Date(), verifiedAt: new Date() } : {}),
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

export interface ChannelOnboardingStatus {
  /** What the publisher sees right now. */
  publisherStage: 'NO_ACCESS' | 'ON_HOLD' | 'PENDING_REVIEW' | 'NEEDS_GROWTH' | 'ACTIVE' | 'SUSPENDED';
  /** True when every Telegram permission the bot needs is recorded as granted. */
  botHasAccess: boolean;
  /** True when the channel passes the marketplace gate (subscribers, posts). */
  meetsMarketplaceFloor: boolean;
  /** The current DB status — for callers that need to switch on it. */
  status: ChannelStatus;
  /** The exact count the floor check was applied to. */
  subscribers: number;
  /** Required minimum — mirrored here so the publisher does not have to know the setting name. */
  minSubscribers: number;
  /** Channel's @username on Telegram (without the leading @) — needed so the
   *  client can build a deep-link straight to the channel's admin settings.
   *  May be null for invite-link-only channels. */
  username: string | null;
  /** Telegram numeric id of the channel — used as the deep-link fallback when
   *  no username is available. */
  telegramChannelId: string;
}

/**
 * Publisher-facing status. Translates the underlying ChannelStatus + permission snapshot
 * into the five-stage UI the channel page renders:
 *   NO_ACCESS        — bot lacks some permission; show "Open access".
 *   ON_HOLD          — bot has every permission; show "Send to moderation".
 *   PENDING_REVIEW   — publisher submitted; admin has not approved; show "On hold".
 *   NEEDS_GROWTH     — bot has access and the channel passed review, but subscribers /
 *                      posts are below the marketplace floor (the "Almost there" card).
 *   ACTIVE           — approved and over the floor; show the channel monetising normally.
 *
 * Centralising the mapping here keeps the UI dumb — it reads `publisherStage` and never
 * has to know about the enum.
 */
export async function getChannelOnboardingStatus(channelId: string): Promise<ChannelOnboardingStatus> {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
  const settingValue = await getNumberSetting(SETTING_KEYS.MIN_SUBSCRIBERS_FOR_MONETIZATION, 500);
  const botHasAccess = Boolean(channel.botIsAdmin && channel.canPostMessages && channel.canEditMessages);

  let publisherStage: ChannelOnboardingStatus['publisherStage'];
  switch (channel.status) {
    case 'PENDING':
      publisherStage = 'NO_ACCESS';
      break;
    case 'READY_FOR_REVIEW':
      publisherStage = 'ON_HOLD';
      break;
    case 'INACTIVE':
      publisherStage = 'PENDING_REVIEW';
      break;
    case 'APPROVED':
      publisherStage = channel.subscriberCount >= settingValue ? 'ACTIVE' : 'NEEDS_GROWTH';
      break;
    case 'SUSPENDED':
    case 'REJECTED':
    case 'ATTENTION_REQUIRED':
      publisherStage = 'SUSPENDED';
      break;
    default:
      publisherStage = 'NO_ACCESS';
  }

  return {
    publisherStage,
    botHasAccess,
    meetsMarketplaceFloor: channel.subscriberCount >= settingValue,
    status: channel.status,
    subscribers: channel.subscriberCount,
    minSubscribers: settingValue,
    username: channel.username,
    telegramChannelId: channel.telegramChannelId.toString(),
  };
}

/**
 * Publisher clicked "Send to moderation". Allowed only from READY_FOR_REVIEW, and only
 * if every bot permission is currently recorded as granted (a publisher could otherwise
 * submit a channel whose perms have just lapsed — the moderator would see "no admin").
 *
 * Idempotent: re-clicking the button is a no-op, never an error. Returns the channel
 * after the move so the UI can re-render.
 */
export async function submitChannelForReview(channelId: string, ownerId: string): Promise<Channel> {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
  if (channel.ownerId !== ownerId) throw new ForbiddenError('Not the channel owner');

  if (channel.status === 'INACTIVE') return channel; // already submitted — idempotent
  if (channel.status !== 'READY_FOR_REVIEW') {
    throw new AppError('Grant the bot every required permission in Telegram before submitting for review', 400, 'CHANNEL_NOT_READY');
  }
  if (!channel.botIsAdmin || !channel.canPostMessages || !channel.canEditMessages) {
    throw new AppError('The bot no longer has the permissions it needs', 400, 'BOT_ACCESS_LOST');
  }

  return prisma.channel.update({
    where: { id: channelId },
    data: { status: 'INACTIVE', submittedForReviewAt: new Date() },
  });
}

export interface VerifyResult {
  channelId: string;
  status: ChannelStatus;
  botIsAdmin: boolean;
  canPostMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
  canInviteUsers: boolean;
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
  // Permission lost when any of the four flags is missing — mirrors the three-permission
  // checklist the publisher panel renders, so the banner stays in sync with what we ask
  // the owner to enable in Telegram.
  const permissionLost =
    !perms.botIsAdmin ||
    !perms.canPostMessages ||
    !perms.canEditMessages ||
    !perms.canInviteUsers;

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
    canEditMessages: perms.canEditMessages,
    canDeleteMessages: perms.canDeleteMessages,
    canInviteUsers: perms.canInviteUsers,
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
