import type { UserProfile, WalletSummary } from '@botflow/shared';
import { prisma } from '../db/prisma';
import { getWallet } from './wallet.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * User profile & dashboard.
 *
 * The Transaction ledger is the source of truth for money; the running
 * totals on the `users` row are denormalised specifically for fast
 * dashboards, so we read them directly here. Balances always come from
 * `wallet.service` — this module never touches the wallets table itself.
 */

export const ACTIVE_CAMPAIGN_STATUSES = ['SCHEDULED', 'RUNNING'] as const;

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
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
      adminUser: { select: { role: true } },
    },
  });

  if (!user) throw new NotFoundError('User');

  // `users.total_earned_cents` / `total_spent_cents` are read here but are NOT
  // written by any code path (only the denormalised copies on `wallets` are,
  // via postLedger). Reading them reported $0.00 for every account, so take
  // the authoritative wallet totals instead — same field names, correct value.
  const wallet = await getWallet(userId);

  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    status: user.status,
    isAdvertiser: user.isAdvertiser,
    isPublisher: user.isPublisher,
    referralCode: user.referralCode,
    totalEarnedCents: wallet.totalEarnedCents,
    totalSpentCents: wallet.totalSpentCents,
    totalWithdrawnCents: user.totalWithdrawnCents,
    totalDepositedCents: user.totalDepositedCents,
    createdAt: user.createdAt.toISOString(),
    isAdmin: Boolean(user.adminUser),
    adminRole: user.adminUser?.role ?? null,
  };
}

export interface UserDashboard {
  balance: WalletSummary;
  /** Total channels owned by the user. */
  channels: number;
  /** Campaigns currently live or about to run (SCHEDULED / RUNNING). */
  activeCampaigns: number;
  /** Lifetime net earnings (denormalised on the user row). */
  totalEarnedCents: number;
  /** Lifetime spend (denormalised on the user row). */
  totalSpentCents: number;
  /** Net cents still inside the post-earning hold period. */
  pendingEarningsCents: number;
}

export async function getDashboard(userId: string): Promise<UserDashboard> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) throw new NotFoundError('User');

  const [wallet, channels, activeCampaigns, pending] = await Promise.all([
    getWallet(userId),
    prisma.channel.count({ where: { ownerId: userId } }),
    prisma.campaign.count({
      where: { advertiserId: userId, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } },
    }),
    prisma.publisherEarning.aggregate({
      where: { publisherId: userId, status: 'PENDING' },
      _sum: { netCents: true },
    }),
  ]);

  const balance: WalletSummary = {
    availableCents: wallet.availableCents,
    reservedCents: wallet.reservedCents,
    pendingCents: wallet.pendingCents,
    currency: wallet.currency,
    totalDepositedCents: wallet.totalDepositedCents,
    totalSpentCents: wallet.totalSpentCents,
    totalEarnedCents: wallet.totalEarnedCents,
    totalWithdrawnCents: wallet.totalWithdrawnCents,
    totalRefundedCents: wallet.totalRefundedCents,
  };

  return {
    balance,
    channels,
    activeCampaigns,
    // Wallet totals are the maintained copies; the `users` duplicates are
    // never written (see getUserProfile).
    totalEarnedCents: wallet.totalEarnedCents,
    totalSpentCents: wallet.totalSpentCents,
    pendingEarningsCents: pending._sum.netCents ?? 0,
  };
}

export interface UpdateUserProfileInput {
  isAdvertiser?: boolean;
  isPublisher?: boolean;
}

/**
 * Toggle the user's roles. A user must always keep at least one role —
 * an account with neither role cannot be used for anything on the platform.
 */
export async function updateUserProfile(
  userId: string,
  input: UpdateUserProfileInput,
): Promise<UserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isAdvertiser: true, isPublisher: true },
  });
  if (!user) throw new NotFoundError('User');

  const isAdvertiser = input.isAdvertiser ?? user.isAdvertiser;
  const isPublisher = input.isPublisher ?? user.isPublisher;

  if (!isAdvertiser && !isPublisher) {
    throw new ValidationError('A user must be at least an advertiser or a publisher');
  }

  if (isAdvertiser !== user.isAdvertiser || isPublisher !== user.isPublisher) {
    await prisma.user.update({
      where: { id: userId },
      data: { isAdvertiser, isPublisher },
    });
    logger.info({ userId, isAdvertiser, isPublisher }, 'user profile roles updated');
  }

  return getUserProfile(userId);
}
