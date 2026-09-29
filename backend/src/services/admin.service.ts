import { Prisma } from '@prisma/client';
import type { CampaignStatus, ChannelStatus, DeliveryJobStatus } from '@prisma/client';
import type { UserProfile } from '@botflow/shared';
import { prisma, transaction } from '../db/prisma';
import { randomToken } from '../utils/crypto';
import {
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { recordAudit } from './audit.service';
import {
  CAMPAIGN_SELECT,
  approveCampaign,
  rejectCampaign,
  setCampaignStatus,
} from './campaign.service';
import { CHANNEL_SELECT } from './channel.service';
import { createNotification } from './notification.service';
import { postLedger, ref } from './transaction.service';

/**
 * Admin Panel business logic.
 *
 * Every mutating function takes the acting admin's userId as its first
 * argument and writes an audit trail row. Money movements always go through
 * the ledger (`postLedger`) — wallet rows are never written directly.
 */

/* ------------------------------------------------------------------
 *  Dashboard
 * ------------------------------------------------------------------ */

export interface AdminDashboard {
  totalUsers: number;
  activeUsers: number;
  advertisers: number;
  publishers: number;
  approvedChannels: number;
  activeCampaigns: number;
  todayRevenueCents: number;
  totalRevenueCents: number;
  pendingDeposits: number;
  pendingWithdrawals: number;
  pendingCampaigns: number;
  failedDeliveries: number;
  fraudAlerts: number;
}

/**
 * KPI tile data for the admin dashboard.
 * Platform revenue = SUM(AdPost.platformFeeCents) over PUBLISHED posts,
 * i.e. what the platform actually earned from live ads.
 */
export async function adminDashboard(): Promise<AdminDashboard> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    totalUsers,
    activeUsers,
    advertiserGroups,
    publisherGroups,
    approvedChannels,
    activeCampaigns,
    todayRevenue,
    totalRevenue,
    pendingDeposits,
    pendingWithdrawals,
    pendingCampaigns,
    failedDeliveries,
    fraudAlerts,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.campaign.groupBy({ by: ['advertiserId'] }),
    prisma.channel.groupBy({ by: ['ownerId'] }),
    prisma.channel.count({ where: { status: 'APPROVED' } }),
    prisma.campaign.count({ where: { status: { in: ['RUNNING', 'SCHEDULED'] } } }),
    prisma.adPost.aggregate({
      where: { status: 'PUBLISHED', publishedAt: { gte: startOfToday } },
      _sum: { platformFeeCents: true },
    }),
    prisma.adPost.aggregate({
      where: { status: 'PUBLISHED' },
      _sum: { platformFeeCents: true },
    }),
    prisma.deposit.count({ where: { status: 'PENDING' } }),
    prisma.withdrawal.count({ where: { status: 'PENDING' } }),
    prisma.campaign.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.deliveryJob.count({ where: { status: 'FAILED' } }),
    prisma.fraudEvent.count({ where: { resolved: false } }),
  ]);

  return {
    totalUsers,
    activeUsers,
    advertisers: advertiserGroups.length,
    publishers: publisherGroups.length,
    approvedChannels,
    activeCampaigns,
    todayRevenueCents: todayRevenue._sum.platformFeeCents ?? 0,
    totalRevenueCents: totalRevenue._sum.platformFeeCents ?? 0,
    pendingDeposits,
    pendingWithdrawals,
    pendingCampaigns,
    failedDeliveries,
    fraudAlerts,
  };
}

/* ------------------------------------------------------------------
 *  Users
 * ------------------------------------------------------------------ */

export type AdminUserListItem = UserProfile & { balanceCents: number };

interface AdminUserRow {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  status: string;
  isAdvertiser: boolean;
  isPublisher: boolean;
  referralCode: string;
  totalEarnedCents: number;
  totalSpentCents: number;
  totalWithdrawnCents: number;
  totalDepositedCents: number;
  createdAt: Date;
  adminUser: { role: string; isActive: boolean } | null;
  wallet: { availableCents: number } | null;
}

const ADMIN_USER_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  firstName: true,
  lastName: true,
  photoUrl: true,
  status: true,
  isAdvertiser: true,
  isPublisher: true,
  referralCode: true,
  totalEarnedCents: true,
  totalSpentCents: true,
  totalWithdrawnCents: true,
  totalDepositedCents: true,
  createdAt: true,
  adminUser: { select: { role: true, isActive: true } },
  wallet: { select: { availableCents: true } },
} satisfies Prisma.UserSelect;

function toAdminUserListItem(row: AdminUserRow): AdminUserListItem {
  return {
    id: row.id,
    telegramId: row.telegramId.toString(),
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    photoUrl: row.photoUrl,
    status: row.status,
    isAdvertiser: row.isAdvertiser,
    isPublisher: row.isPublisher,
    referralCode: row.referralCode,
    totalEarnedCents: row.totalEarnedCents,
    totalSpentCents: row.totalSpentCents,
    totalWithdrawnCents: row.totalWithdrawnCents,
    totalDepositedCents: row.totalDepositedCents,
    createdAt: row.createdAt.toISOString(),
    isAdmin: row.adminUser !== null,
    adminRole: row.adminUser?.role ?? null,
    balanceCents: row.wallet?.availableCents ?? 0,
  };
}

/** Escape LIKE wildcards so a search term matches literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `telegramId` is a BigInt column, which Prisma cannot "contains"-match.
 * A raw cast-to-text LIKE covers it; the text fields stay in Prisma land.
 */
async function findUserIdsByTelegramIdSearch(term: string): Promise<string[]> {
  const like = `%${escapeLike(term)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users" WHERE CAST("telegram_id" AS TEXT) LIKE ${like} ESCAPE '\\'`,
  );
  return rows.map((r) => r.id);
}

export async function listUsersAdmin(search: string | undefined, p: Pagination) {
  const term = search?.trim();
  const where: Prisma.UserWhereInput = {};

  if (term) {
    const telegramMatches = await findUserIdsByTelegramIdSearch(term);
    where.OR = [
      { username: { contains: term, mode: 'insensitive' } },
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      ...(telegramMatches.length > 0 ? [{ id: { in: telegramMatches } }] : []),
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: ADMIN_USER_SELECT,
    }),
  ]);

  return buildPaginated(rows.map(toAdminUserListItem), total, p);
}

export interface UserEarningsSummary {
  totalPosts: number;
  totalGrossCents: number;
  totalNetCents: number;
  pendingCents: number;
  availableCents: number;
  paidCents: number;
}

interface EarningStatusGroup {
  status: string;
  _sum: { grossCents: number | null; netCents: number | null };
  _count: { _all: number };
}

function summarizeEarnings(groups: EarningStatusGroup[]): UserEarningsSummary {
  const netCents = (status: string) => groups.find((g) => g.status === status)?._sum.netCents ?? 0;
  return {
    totalPosts: groups.reduce((acc, g) => acc + g._count._all, 0),
    totalGrossCents: groups.reduce((acc, g) => acc + (g._sum.grossCents ?? 0), 0),
    totalNetCents: groups.reduce((acc, g) => acc + (g._sum.netCents ?? 0), 0),
    pendingCents: netCents('PENDING'),
    availableCents: netCents('AVAILABLE'),
    paidCents: netCents('PAID'),
  };
}

/** Full user dossier for the admin user detail screen. */
export async function getUserAdminDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: ADMIN_USER_SELECT,
  });
  if (!user) throw new NotFoundError('User');

  const [channels, campaigns, transactions, deposits, withdrawals, earningGroups] =
    await Promise.all([
      prisma.channel.findMany({
        where: { ownerId: userId },
        orderBy: { createdAt: 'desc' },
        select: CHANNEL_SELECT,
      }),
      prisma.campaign.findMany({
        where: { advertiserId: userId },
        orderBy: { createdAt: 'desc' },
        select: CAMPAIGN_SELECT,
      }),
      prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          type: true,
          status: true,
          amountCents: true,
          currency: true,
          reference: true,
          referenceType: true,
          description: true,
          createdAt: true,
        },
      }),
      prisma.deposit.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          amountCents: true,
          currency: true,
          method: true,
          status: true,
          createdAt: true,
          verifiedAt: true,
        },
      }),
      prisma.withdrawal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          amountCents: true,
          feeCents: true,
          netAmountCents: true,
          currency: true,
          method: true,
          status: true,
          createdAt: true,
          processedAt: true,
        },
      }),
      prisma.publisherEarning.groupBy({
        by: ['status'],
        where: { publisherId: userId },
        _sum: { grossCents: true, netCents: true },
        _count: { _all: true },
      }),
    ]);

  return {
    profile: toAdminUserListItem(user),
    channels,
    campaigns,
    transactions,
    deposits,
    withdrawals,
    earnings: summarizeEarnings(earningGroups),
  };
}

/* ------------------------------------------------------------------
 *  Listings (admin view — no ownership scoping)
 * ------------------------------------------------------------------ */

export interface AdminListCampaignsFilter {
  status?: CampaignStatus;
}

export async function listCampaignsAdmin(filter: AdminListCampaignsFilter, p: Pagination) {
  const where: Prisma.CampaignWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        ...CAMPAIGN_SELECT,
        advertiserId: true,
        advertiser: { select: { firstName: true, username: true } },
      },
    }),
  ]);

  const items = rows.map(({ advertiser, ...campaign }) => ({
    ...campaign,
    advertiserName:
      advertiser.firstName || (advertiser.username ? `@${advertiser.username}` : null),
  }));

  return buildPaginated(items, total, p);
}

export interface AdminListChannelsFilter {
  status?: ChannelStatus;
}

export async function listChannelsAdmin(filter: AdminListChannelsFilter, p: Pagination) {
  const where: Prisma.ChannelWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.channel.count({ where }),
    prisma.channel.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        ...CHANNEL_SELECT,
        ownerId: true,
        owner: { select: { firstName: true, username: true } },
      },
    }),
  ]);

  const items = rows.map(({ owner, ...channel }) => ({
    ...channel,
    ownerName: owner.firstName || (owner.username ? `@${owner.username}` : null),
  }));

  return buildPaginated(items, total, p);
}

export interface AdminListDeliveryJobsFilter {
  status?: DeliveryJobStatus;
}

export async function listDeliveryJobs(filter: AdminListDeliveryJobsFilter, p: Pagination) {
  const where: Prisma.DeliveryJobWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.deliveryJob.count({ where }),
    prisma.deliveryJob.findMany({
      where,
      orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }],
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        status: true,
        attempts: true,
        errorCode: true,
        errorMessage: true,
        scheduledAt: true,
        campaign: { select: { name: true } },
        channel: { select: { title: true } },
      },
    }),
  ]);

  const items = rows.map(({ campaign, channel, ...job }) => ({
    ...job,
    campaignName: campaign.name,
    channelTitle: channel.title,
  }));

  return buildPaginated(items, total, p);
}

/* ------------------------------------------------------------------
 *  Campaign actions (admin overrides owner permissions)
 * ------------------------------------------------------------------ */

export type AdminCampaignAction = 'APPROVE' | 'REJECT' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'SUSPEND';

export interface AdminCampaignActionInput {
  campaignId: string;
  action: AdminCampaignAction;
  note?: string;
}

export interface AdminCampaignActionResult {
  campaignId: string;
  action: AdminCampaignAction;
  status: CampaignStatus;
  /** Jobs pushed to the delivery queue (APPROVE / RESUME). */
  enqueued?: number;
  /** Jobs cancelled because delivery stopped (SUSPEND). */
  cancelledJobs?: number;
}

export async function adminCampaignAction(
  adminId: string,
  input: AdminCampaignActionInput,
): Promise<AdminCampaignActionResult> {
  const { campaignId, action, note } = input;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, advertiserId: true },
  });
  if (!campaign) throw new NotFoundError('Campaign');

  let enqueued: number | undefined;
  let cancelledJobs: number | undefined;

  switch (action) {
    case 'APPROVE': {
      const res = await approveCampaign(adminId, campaignId, note);
      enqueued = res.enqueued;
      break;
    }

    case 'REJECT': {
      await rejectCampaign(adminId, campaignId, note ?? 'Rejected by admin');
      break;
    }

    case 'PAUSE':
    case 'RESUME':
    case 'CANCEL': {
      // Owner-scoped transitions, called on behalf of the real advertiser
      // so the escrow release / queue logic runs exactly as for the owner.
      await setCampaignStatus(
        campaign.advertiserId,
        campaignId,
        action.toLowerCase() as 'pause' | 'resume' | 'cancel',
      );
      break;
    }

    case 'SUSPEND': {
      // Hard stop: flag the campaign and kill every job that has not
      // started yet, so paid money cannot be spent while under review.
      cancelledJobs = await transaction(async (tx) => {
        await tx.campaign.update({
          where: { id: campaignId },
          data: {
            status: 'SUSPENDED',
            reviewedById: adminId,
            reviewedAt: new Date(),
            reviewNote: note ?? null,
          },
        });
        const res = await tx.deliveryJob.updateMany({
          where: { campaignId, status: { in: ['PENDING', 'SCHEDULED'] } },
          data: { status: 'CANCELLED' },
        });
        return res.count;
      });
      break;
    }
  }

  const after = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });

  await recordAudit({
    actorId: adminId,
    action: `CAMPAIGN_${action.toLowerCase()}_BY_ADMIN`,
    targetType: 'CAMPAIGN',
    targetId: campaignId,
    oldValue: { status: campaign.status },
    newValue: { status: after?.status ?? null, note: note ?? null },
  });

  return {
    campaignId,
    action,
    status: after?.status ?? campaign.status,
    ...(enqueued !== undefined ? { enqueued } : {}),
    ...(cancelledJobs !== undefined ? { cancelledJobs } : {}),
  };
}

/* ------------------------------------------------------------------
 *  Channel actions
 * ------------------------------------------------------------------ */

export type AdminChannelAction = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REACTIVATE';

export interface AdminChannelActionInput {
  channelId: string;
  action: AdminChannelAction;
  note?: string;
}

export interface AdminChannelActionResult {
  channelId: string;
  action: AdminChannelAction;
  status: ChannelStatus;
  /** Jobs cancelled because delivery stopped (SUSPEND). */
  cancelledJobs?: number;
}

export async function adminChannelAction(
  adminId: string,
  input: AdminChannelActionInput,
): Promise<AdminChannelActionResult> {
  const { channelId, action, note } = input;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, status: true, ownerId: true, title: true, botIsAdmin: true, canPostMessages: true },
  });
  if (!channel) throw new NotFoundError('Channel');

  let cancelledJobs: number | undefined;

  switch (action) {
    case 'APPROVE': {
      // The owner can now submit for review before the bot is an admin (see
      // channel.service.ts:addChannel) — approving it here anyway would
      // publish a channel that cannot actually receive posts yet.
      if (!channel.botIsAdmin || !channel.canPostMessages) {
        throw new ValidationError(
          `BotFlow Bot is not yet an administrator with post rights in "${channel.title}". ` +
            'Ask the owner to add the bot as an admin before approving — the permission snapshot ' +
            'updates automatically once they do, no re-submission needed.',
        );
      }
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          rejectionReason: null,
          adminNote: note ?? null,
        },
      });
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_APPROVED',
        title: 'Channel approved',
        body: `Your channel "${channel.title}" has been approved. Advertisers can now buy posts on it.`,
        data: { channelId },
        link: '/publisher/channels',
      });
      break;
    }

    case 'REJECT': {
      const reason = note?.trim() || 'This channel does not meet our requirements';
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'REJECTED',
          rejectionReason: reason,
          adminNote: note ?? null,
        },
      });
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_REJECTED',
        title: 'Channel not approved',
        body: `Your channel "${channel.title}" was not approved for ad delivery. Reason: ${reason}`,
        data: { channelId },
        link: '/publisher/channels',
      });
      break;
    }

    case 'SUSPEND': {
      cancelledJobs = await transaction(async (tx) => {
        await tx.channel.update({
          where: { id: channelId },
          data: { status: 'SUSPENDED', adminNote: note ?? null },
        });
        const res = await tx.deliveryJob.updateMany({
          where: {
            channelId,
            status: { in: ['PENDING', 'SCHEDULED', 'AWAITING_APPROVAL'] },
          },
          data: { status: 'CANCELLED' },
        });
        return res.count;
      });
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_PERMISSION_PROBLEM',
        title: 'Channel suspended',
        body: `Your channel "${channel.title}" has been suspended, so no new ads will be delivered there. Contact support for details.`,
        data: { channelId },
        link: '/publisher/channels',
      });
      break;
    }

    case 'REACTIVATE': {
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          rejectionReason: null,
          adminNote: note ?? null,
        },
      });
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_APPROVED',
        title: 'Channel reactivated',
        body: `Your channel "${channel.title}" has been reactivated and can receive ads again.`,
        data: { channelId },
        link: '/publisher/channels',
      });
      break;
    }
  }

  const after = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { status: true },
  });

  await recordAudit({
    actorId: adminId,
    action: `CHANNEL_${action.toLowerCase()}_BY_ADMIN`,
    targetType: 'CHANNEL',
    targetId: channelId,
    oldValue: { status: channel.status },
    newValue: { status: after?.status ?? null, note: note ?? null },
  });

  return {
    channelId,
    action,
    status: after?.status ?? channel.status,
    ...(cancelledJobs !== undefined ? { cancelledJobs } : {}),
  };
}

/* ------------------------------------------------------------------
 *  Manual balance adjustment
 * ------------------------------------------------------------------ */

export interface AdjustBalanceResult {
  transactionId: string;
  reference: string;
  previousBalanceCents: number;
  newBalanceCents: number;
}

/**
 * Credit (positive) or debit (negative) a user's available balance.
 * Runs through the ledger inside a single transaction so the wallet
 * arithmetic and the immutable ledger row can never diverge.
 */
export async function adjustUserBalance(
  adminId: string,
  userId: string,
  amountCents: number,
  reason: string,
): Promise<AdjustBalanceResult> {
  if (!Number.isInteger(amountCents) || amountCents === 0) {
    throw new ValidationError('Amount must be a non-zero whole number of cents (negative to debit)');
  }
  const trimmedReason = reason?.trim() ?? '';
  if (!trimmedReason) {
    throw new ValidationError('A reason is required for manual balance adjustments');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, wallet: { select: { availableCents: true } } },
  });
  if (!user) throw new NotFoundError('User');

  const previousBalanceCents = user.wallet?.availableCents ?? 0;
  if (amountCents < 0 && previousBalanceCents + amountCents < 0) {
    throw new InsufficientBalanceError('Adjustment would take the available balance below zero', {
      requiredCents: -amountCents,
      availableCents: previousBalanceCents,
    });
  }

  const reference = ref.manual(adminId, randomToken(6));

  const posted = await transaction(async (tx) =>
    postLedger(tx, {
      userId,
      type: 'MANUAL_ADJUSTMENT',
      amountCents,
      reference,
      walletDelta: { available: amountCents },
      description: trimmedReason,
      metadata: {
        adminId,
        previousBalanceCents,
        newBalanceCents: previousBalanceCents + amountCents,
      },
    }),
  );

  const newBalanceCents = previousBalanceCents + amountCents;

  await recordAudit({
    actorId: adminId,
    action: 'USER_BALANCE_ADJUSTED',
    targetType: 'USER',
    targetId: userId,
    oldValue: { availableCents: previousBalanceCents },
    newValue: {
      availableCents: newBalanceCents,
      amountCents,
      reason: trimmedReason,
      reference,
    },
  });

  return {
    transactionId: posted.transaction.id,
    reference,
    previousBalanceCents,
    newBalanceCents,
  };
}
