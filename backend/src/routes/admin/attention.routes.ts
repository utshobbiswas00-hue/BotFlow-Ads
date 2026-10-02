import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { requirePermission } from '../../middleware/adminAuth';
import { respondOk } from './common';

/**
 * Operator "needs attention" feed (spec §52, §65).
 *
 * Read-only and COMPUTED — it is a live snapshot assembled from existing state,
 * NOT a notification centre and NOT an inbox. Nothing is stored, nothing is
 * persisted, there is no model behind it and therefore no mark-as-read: the same
 * request tomorrow simply recomputes from the database. Calling it an inbox
 * would promise a persistence/read-state that does not exist.
 *
 * COST: this handler issues N `count()` queries per request (N = 11 today, one
 * per source below) in a single `Promise.all`. That is fine at admin traffic
 * levels, but it is O(sources) round-trips on EVERY hit and each count is a
 * sequential scan unless an index exists. At scale this wants a materialised
 * view (or a cached snapshot refreshed on a timer) rather than 11 live counts.
 *
 * Mounted by the caller (this file is intentionally NOT wired into index.ts) —
 * the intended mount is `/api/admin/attention`. Gated with `dashboard.view`.
 */

export const attentionRouter = Router();

attentionRouter.use(requirePermission('dashboard.view'));

export type AttentionSeverity = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

export interface AttentionItem {
  kind: string;
  severity: AttentionSeverity;
  count: number;
  label: string;
  href: string;
  detail: string;
}

/** Every counter the feed is composed from. */
export interface AttentionCounts {
  pendingDeposits: number;
  pendingWithdrawals: number;
  campaignsAwaitingReview: number;
  channelsAwaitingApproval: number;
  creativeVersionsAwaitingReview: number;
  failedDeliveryJobs24h: number;
  unresolvedFraudEvents: number;
  openReports: number;
  openSupportTickets: number;
  cryptoTransfersAwaitingCredit: number;
  adminsWithoutPermissions: number;
}

/** Lower rank = more urgent. Exported so the ordering is unit-testable. */
export const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

/**
 * Pure, dependency-free builder: turns raw counts into the sorted, filtered
 * item list. Only sources with `count > 0` survive; the rest are dropped so the
 * feed never shows empty noise. `Array.prototype.sort` is stable, so items of
 * the same severity keep their declared order.
 */
export function buildAttentionItems(counts: AttentionCounts): AttentionItem[] {
  const items: AttentionItem[] = [
    {
      kind: 'WITHDRAWALS_PENDING',
      severity: 'CRITICAL',
      count: counts.pendingWithdrawals,
      label: 'Withdrawals awaiting approval',
      href: '/admin/finance/withdrawals',
      detail: 'Money requested out of the platform and waiting on a payout decision.',
    },
    {
      kind: 'FRAUD_EVENTS_UNRESOLVED',
      severity: 'CRITICAL',
      count: counts.unresolvedFraudEvents,
      label: 'Unresolved fraud events',
      href: '/admin/moderation',
      detail: 'Fraud signals that have not been reviewed or dismissed yet.',
    },
    {
      kind: 'DEPOSITS_PENDING',
      severity: 'HIGH',
      count: counts.pendingDeposits,
      label: 'Deposits awaiting verification',
      href: '/admin/finance/deposits',
      detail: 'Deposits waiting on a manual credit decision.',
    },
    {
      kind: 'CRYPTO_TRANSFERS_AWAITING_CREDIT',
      severity: 'HIGH',
      count: counts.cryptoTransfersAwaitingCredit,
      label: 'Crypto transfers awaiting a credit decision',
      href: '/admin/crypto-transfers',
      detail: 'On-chain transfers detected but not yet credited or ignored.',
    },
    {
      kind: 'DELIVERY_JOBS_FAILED_24H',
      severity: 'HIGH',
      count: counts.failedDeliveryJobs24h,
      label: 'Failed delivery jobs (last 24h)',
      href: '/admin/delivery',
      detail: 'Delivery jobs that failed in the last 24 hours and may need a retry or a fix.',
    },
    {
      kind: 'ADMINS_WITHOUT_PERMISSIONS',
      severity: 'HIGH',
      count: counts.adminsWithoutPermissions,
      label: 'Admin accounts with no permissions',
      href: '/admin/admins',
      detail: 'Active non-super-admin accounts that hold no permission keys and can do nothing.',
    },
    {
      kind: 'CAMPAIGNS_AWAITING_REVIEW',
      severity: 'NORMAL',
      count: counts.campaignsAwaitingReview,
      label: 'Campaigns awaiting review',
      href: '/admin/campaigns',
      detail: 'Campaigns submitted and waiting on an approval decision.',
    },
    {
      kind: 'CHANNELS_AWAITING_APPROVAL',
      severity: 'NORMAL',
      count: counts.channelsAwaitingApproval,
      label: 'Channels awaiting approval',
      href: '/admin/channels',
      detail: 'Publisher channels waiting to be reviewed and approved.',
    },
    {
      kind: 'CREATIVE_VERSIONS_AWAITING_REVIEW',
      severity: 'NORMAL',
      count: counts.creativeVersionsAwaitingReview,
      label: 'Creative versions awaiting review',
      href: '/admin/ops/creative',
      detail: 'Creative versions that need an approval before they can run.',
    },
    {
      kind: 'REPORTS_OPEN',
      severity: 'NORMAL',
      count: counts.openReports,
      label: 'Open reports',
      href: '/admin/moderation',
      detail: 'User reports that have not been resolved or dismissed.',
    },
    {
      kind: 'SUPPORT_TICKETS_OPEN',
      severity: 'NORMAL',
      count: counts.openSupportTickets,
      label: 'Open support tickets',
      href: '/admin/support',
      detail: 'Support tickets still open with the support team.',
    },
  ];

  return items
    .filter((item) => item.count > 0)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * The computed feed. Every entry appears only when its counter is > 0, and the
 * whole list is sorted most-urgent first.
 */
attentionRouter.get('/', async (_req, res, next) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    /*
     * SUPER_ADMIN bypasses every permission check, so an empty permission list
     * is harmless on a super-admin; only an ACTIVE non-super-admin with `[]` is
     * actually unusable. `permissions` is a Json column defaulting to "[]".
     */
    const unusableAdminWhere: Prisma.AdminUserWhereInput = {
      role: { not: 'SUPER_ADMIN' },
      isActive: true,
      permissions: { equals: [] },
    };

    const [
      pendingDeposits,
      pendingWithdrawals,
      campaignsAwaitingReview,
      channelsAwaitingApproval,
      creativeVersionsAwaitingReview,
      failedDeliveryJobs24h,
      unresolvedFraudEvents,
      openReports,
      openSupportTickets,
      cryptoTransfersAwaitingCredit,
      adminsWithoutPermissions,
    ] = await Promise.all([
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.withdrawal.count({ where: { status: 'PENDING' } }),
      prisma.campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.channel.count({ where: { status: 'PENDING' } }),
      prisma.adCreativeVersion.count({
        where: { OR: [{ status: 'PENDING_REVIEW' }, { requiresReview: true }] },
      }),
      prisma.deliveryJob.count({ where: { status: 'FAILED', updatedAt: { gte: since24h } } }),
      prisma.fraudEvent.count({ where: { resolved: false } }),
      prisma.report.count({ where: { status: 'OPEN' } }),
      prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      prisma.cryptoChainTransfer.count({ where: { status: 'DETECTED' } }),
      prisma.adminUser.count({ where: unusableAdminWhere }),
    ]);

    const counts: AttentionCounts = {
      pendingDeposits,
      pendingWithdrawals,
      campaignsAwaitingReview,
      channelsAwaitingApproval,
      creativeVersionsAwaitingReview,
      failedDeliveryJobs24h,
      unresolvedFraudEvents,
      openReports,
      openSupportTickets,
      cryptoTransfersAwaitingCredit,
      adminsWithoutPermissions,
    };

    respondOk(res, { items: buildAttentionItems(counts), generatedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});
