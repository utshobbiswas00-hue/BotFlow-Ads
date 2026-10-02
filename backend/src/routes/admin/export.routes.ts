import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  CampaignStatus,
  ChannelStatus,
  DepositStatus,
  EarningStatus,
  TransactionStatus,
  TransactionType,
  WithdrawalStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { logger } from '../../config/logger';
import { prisma } from '../../db/prisma';
import { requirePermission } from '../../middleware/adminAuth';
import { validate } from '../../middleware/validate';
import {
  listCampaignsAdmin,
  listChannelsAdmin,
  listUsersAdmin,
  type AdminUserListItem,
} from '../../services/admin.service';
import { revenueByDay } from '../../services/analytics.service';
import { recordAudit } from '../../services/audit.service';
import { listDepositsAdmin } from '../../services/deposit.service';
import { listWithdrawalsAdmin } from '../../services/withdrawal.service';
import { displayName } from '../../utils/format';
import { streamCsv, type CsvColumn } from '../../utils/csv';
import { adminId } from './common';

/**
 * Admin CSV exports (spec §78).
 *
 * Mounted by the parent admin router at `/api/admin/export`; the auth gate
 * (`adminPanelAuth`, `requireAdmin`, the admin rate limiter) is applied by that
 * parent, so each route below only adds its own `requirePermission` key.
 *
 * Every handler follows the same contract:
 *  - it accepts the SAME filters as the matching list endpoint (status / type /
 *    userId / search — plus from/to where the list actually has a date range),
 *    and ignores page/limit;
 *  - it streams through `streamCsv` (bounded batches, hard row cap, UTF-8 BOM,
 *    formula-injection-safe cells);
 *  - it writes exactly ONE `recordAudit` row describing what was exported.
 *
 * Row selection is reused from the existing admin services wherever possible so
 * an export can never drift from what the panel shows on screen. The two
 * exceptions are the ledger (`transactions`) and publisher earnings, which have
 * no admin-wide service, so they are queried here with the exact same `select`
 * shape their list endpoints use.
 */

export const exportRouter = Router();

/* ------------------------------------------------------------------
 *  Query schemas — mirror the corresponding list endpoints.
 * ------------------------------------------------------------------ */

const usersExportQuery = z.object({
  search: z.string().max(100).trim().optional(),
});

const channelsExportQuery = z.object({
  status: z.nativeEnum(ChannelStatus).optional(),
});

const campaignsExportQuery = z.object({
  status: z.nativeEnum(CampaignStatus).optional(),
});

const depositsExportQuery = z.object({
  status: z.nativeEnum(DepositStatus).optional(),
});

const withdrawalsExportQuery = z.object({
  status: z.nativeEnum(WithdrawalStatus).optional(),
});

const transactionsExportQuery = z.object({
  type: z.nativeEnum(TransactionType).optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  userId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const earningsExportQuery = z.object({
  status: z.nativeEnum(EarningStatus).optional(),
  userId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const revenueExportQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).optional(),
});

/* ------------------------------------------------------------------
 *  Row shapes
 * ------------------------------------------------------------------ */

type AdminChannelItem = Awaited<ReturnType<typeof listChannelsAdmin>>['items'][number];
type AdminCampaignItem = Awaited<ReturnType<typeof listCampaignsAdmin>>['items'][number];
type AdminDepositItem = Awaited<ReturnType<typeof listDepositsAdmin>>['items'][number];
type AdminWithdrawalItem = Awaited<ReturnType<typeof listWithdrawalsAdmin>>['items'][number];

interface AdminTransactionRow {
  id: string;
  userId: string;
  userName: string;
  type: TransactionType;
  status: TransactionStatus;
  amountCents: number;
  currency: string;
  balanceAfter: number | null;
  reference: string;
  referenceType: string | null;
  description: string | null;
  createdAt: Date;
}

interface AdminEarningRow {
  id: string;
  publisherId: string;
  publisherName: string;
  channelId: string;
  channelTitle: string;
  campaignId: string | null;
  grossCents: number;
  platformFeeCents: number;
  netCents: number;
  status: EarningStatus;
  availableAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

interface RevenueRow {
  date: string;
  revenueCents: number;
}

/* ------------------------------------------------------------------
 *  Column definitions
 * ------------------------------------------------------------------ */

const USER_COLUMNS: ReadonlyArray<CsvColumn<AdminUserListItem>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'telegramId', value: (r) => r.telegramId },
  { header: 'username', value: (r) => r.username },
  { header: 'firstName', value: (r) => r.firstName },
  { header: 'lastName', value: (r) => r.lastName },
  { header: 'status', value: (r) => r.status },
  { header: 'isAdvertiser', value: (r) => r.isAdvertiser },
  { header: 'isPublisher', value: (r) => r.isPublisher },
  { header: 'referralCode', value: (r) => r.referralCode },
  { header: 'balanceCents', value: (r) => r.balanceCents },
  { header: 'totalEarnedCents', value: (r) => r.totalEarnedCents },
  { header: 'totalSpentCents', value: (r) => r.totalSpentCents },
  { header: 'totalDepositedCents', value: (r) => r.totalDepositedCents },
  { header: 'totalWithdrawnCents', value: (r) => r.totalWithdrawnCents },
  { header: 'isAdmin', value: (r) => r.isAdmin },
  { header: 'adminRole', value: (r) => r.adminRole },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const CHANNEL_COLUMNS: ReadonlyArray<CsvColumn<AdminChannelItem>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'telegramChannelId', value: (r) => r.telegramChannelId },
  { header: 'username', value: (r) => r.username },
  { header: 'title', value: (r) => r.title },
  { header: 'ownerId', value: (r) => r.ownerId },
  { header: 'ownerName', value: (r) => r.ownerName },
  { header: 'category', value: (r) => r.category },
  { header: 'language', value: (r) => r.language },
  { header: 'country', value: (r) => r.country },
  { header: 'subscriberCount', value: (r) => r.subscriberCount },
  { header: 'avgViews', value: (r) => r.avgViews },
  { header: 'status', value: (r) => r.status },
  { header: 'pricingModel', value: (r) => r.pricingModel },
  { header: 'adPriceCents', value: (r) => r.adPriceCents },
  { header: 'cpmRateCents', value: (r) => r.cpmRateCents },
  { header: 'totalEarnedCents', value: (r) => r.totalEarnedCents },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const CAMPAIGN_COLUMNS: ReadonlyArray<CsvColumn<AdminCampaignItem>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'name', value: (r) => r.name },
  { header: 'advertiserId', value: (r) => r.advertiserId },
  { header: 'advertiserName', value: (r) => r.advertiserName },
  { header: 'status', value: (r) => r.status },
  { header: 'promotionTarget', value: (r) => r.promotionTarget },
  { header: 'pricingModel', value: (r) => r.pricingModel },
  { header: 'budgetTotalCents', value: (r) => r.budgetTotalCents },
  { header: 'budgetSpentCents', value: (r) => r.budgetSpentCents },
  { header: 'budgetReservedCents', value: (r) => r.budgetReservedCents },
  { header: 'platformFeePercent', value: (r) => r.platformFeePercent },
  { header: 'startAt', value: (r) => r.startAt },
  { header: 'endAt', value: (r) => r.endAt },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const DEPOSIT_COLUMNS: ReadonlyArray<CsvColumn<AdminDepositItem>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'userName', value: (r) => r.userName },
  { header: 'amountCents', value: (r) => r.amountCents },
  { header: 'method', value: (r) => r.method },
  { header: 'status', value: (r) => r.status },
  { header: 'proofUrl', value: (r) => r.proofUrl },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const WITHDRAWAL_COLUMNS: ReadonlyArray<CsvColumn<AdminWithdrawalItem>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'userName', value: (r) => r.userName },
  { header: 'amountCents', value: (r) => r.amountCents },
  { header: 'netAmountCents', value: (r) => r.netAmountCents },
  { header: 'method', value: (r) => r.method },
  { header: 'status', value: (r) => r.status },
  { header: 'accountMasked', value: (r) => r.accountMasked },
  { header: 'requiresReview', value: (r) => r.requiresReview },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const TRANSACTION_COLUMNS: ReadonlyArray<CsvColumn<AdminTransactionRow>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'userId', value: (r) => r.userId },
  { header: 'userName', value: (r) => r.userName },
  { header: 'type', value: (r) => r.type },
  { header: 'status', value: (r) => r.status },
  { header: 'amountCents', value: (r) => r.amountCents },
  { header: 'currency', value: (r) => r.currency },
  { header: 'balanceAfter', value: (r) => r.balanceAfter },
  { header: 'reference', value: (r) => r.reference },
  { header: 'referenceType', value: (r) => r.referenceType },
  { header: 'description', value: (r) => r.description },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const EARNING_COLUMNS: ReadonlyArray<CsvColumn<AdminEarningRow>> = [
  { header: 'id', value: (r) => r.id },
  { header: 'publisherId', value: (r) => r.publisherId },
  { header: 'publisherName', value: (r) => r.publisherName },
  { header: 'channelId', value: (r) => r.channelId },
  { header: 'channelTitle', value: (r) => r.channelTitle },
  { header: 'campaignId', value: (r) => r.campaignId },
  { header: 'grossCents', value: (r) => r.grossCents },
  { header: 'platformFeeCents', value: (r) => r.platformFeeCents },
  { header: 'netCents', value: (r) => r.netCents },
  { header: 'status', value: (r) => r.status },
  { header: 'availableAt', value: (r) => r.availableAt },
  { header: 'paidAt', value: (r) => r.paidAt },
  { header: 'createdAt', value: (r) => r.createdAt },
];

const REVENUE_COLUMNS: ReadonlyArray<CsvColumn<RevenueRow>> = [
  { header: 'date', value: (r) => r.date },
  { header: 'revenueCents', value: (r) => r.revenueCents },
];

/* ------------------------------------------------------------------
 *  Shared runner
 * ------------------------------------------------------------------ */

interface ExportSpec<T> {
  /** Used in the download filename: `botflow-<entity>-<YYYY-MM-DD>.csv`. */
  entity: string;
  /** Audit action, e.g. EXPORT_USERS. */
  action: string;
  /** Filters as applied — recorded on the audit row for reproducibility. */
  filters: Record<string, unknown>;
  columns: ReadonlyArray<CsvColumn<T>>;
  fetchBatch: (args: { skip: number; take: number }) => Promise<T[]>;
}

/** A `Pagination`-shaped object for the reused admin service functions. */
function batchPager(skip: number, take: number): { page: number; limit: number; skip: number; take: number } {
  return { page: skip / take + 1, limit: take, skip, take };
}

async function runExport<T>(req: Request, res: Response, next: NextFunction, spec: ExportSpec<T>): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="botflow-${spec.entity}-${stamp}.csv"`);

    const result = await streamCsv(res, spec.columns, spec.fetchBatch);
    res.end();

    // Mandatory: exports of user / financial data are sensitive. ONE row per
    // export, recording the acting admin, the row count and the filters used.
    await recordAudit({
      actorId: adminId(req),
      action: spec.action,
      targetType: 'EXPORT',
      newValue: { rows: result.rows, truncated: result.truncated, filters: spec.filters },
    });
  } catch (err) {
    // A failure before the first byte can still produce a normal JSON error;
    // once the CSV has started streaming that is impossible, so the response
    // is simply closed (the audit row is skipped — the export did not happen).
    if (res.headersSent) {
      logger.error({ err, entity: spec.entity }, 'admin CSV export failed mid-stream');
      res.end();
      return;
    }
    next(err);
  }
}

/* ------------------------------------------------------------------
 *  GET /api/admin/export/*.csv
 * ------------------------------------------------------------------ */

exportRouter.get(
  '/users.csv',
  requirePermission('users.view'),
  validate({ query: usersExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof usersExportQuery>;
    await runExport(req, res, next, {
      entity: 'users',
      action: 'EXPORT_USERS',
      filters: { search: query.search ?? null },
      columns: USER_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const page = await listUsersAdmin(query.search, batchPager(skip, take));
        return page.items;
      },
    });
  },
);

exportRouter.get(
  '/channels.csv',
  requirePermission('channels.view'),
  validate({ query: channelsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof channelsExportQuery>;
    await runExport(req, res, next, {
      entity: 'channels',
      action: 'EXPORT_CHANNELS',
      filters: { status: query.status ?? null },
      columns: CHANNEL_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const page = await listChannelsAdmin({ status: query.status }, batchPager(skip, take));
        return page.items;
      },
    });
  },
);

exportRouter.get(
  '/campaigns.csv',
  requirePermission('campaigns.view'),
  validate({ query: campaignsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof campaignsExportQuery>;
    await runExport(req, res, next, {
      entity: 'campaigns',
      action: 'EXPORT_CAMPAIGNS',
      filters: { status: query.status ?? null },
      columns: CAMPAIGN_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const page = await listCampaignsAdmin({ status: query.status }, batchPager(skip, take));
        return page.items;
      },
    });
  },
);

exportRouter.get(
  '/transactions.csv',
  requirePermission('deposits.view'),
  validate({ query: transactionsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof transactionsExportQuery>;
    const where: Prisma.TransactionWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    await runExport(req, res, next, {
      entity: 'transactions',
      action: 'EXPORT_TRANSACTIONS',
      filters: {
        type: query.type ?? null,
        status: query.status ?? null,
        userId: query.userId ?? null,
        from: query.from ? query.from.toISOString() : null,
        to: query.to ? query.to.toISOString() : null,
      },
      columns: TRANSACTION_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const rows = await prisma.transaction.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
          select: {
            id: true,
            userId: true,
            type: true,
            status: true,
            amountCents: true,
            currency: true,
            balanceAfter: true,
            reference: true,
            referenceType: true,
            description: true,
            createdAt: true,
            user: { select: { id: true, username: true, firstName: true, lastName: true } },
          },
        });
        return rows.map(({ user, ...tx }): AdminTransactionRow => ({ ...tx, userName: displayName(user) }));
      },
    });
  },
);

exportRouter.get(
  '/deposits.csv',
  requirePermission('deposits.view'),
  validate({ query: depositsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof depositsExportQuery>;
    await runExport(req, res, next, {
      entity: 'deposits',
      action: 'EXPORT_DEPOSITS',
      filters: { status: query.status ?? null },
      columns: DEPOSIT_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const page = await listDepositsAdmin({ status: query.status }, batchPager(skip, take));
        return page.items;
      },
    });
  },
);

exportRouter.get(
  '/withdrawals.csv',
  requirePermission('withdrawals.view'),
  validate({ query: withdrawalsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof withdrawalsExportQuery>;
    await runExport(req, res, next, {
      entity: 'withdrawals',
      action: 'EXPORT_WITHDRAWALS',
      filters: { status: query.status ?? null },
      columns: WITHDRAWAL_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const page = await listWithdrawalsAdmin({ status: query.status }, batchPager(skip, take));
        return page.items;
      },
    });
  },
);

exportRouter.get(
  '/earnings.csv',
  requirePermission('deposits.view'),
  validate({ query: earningsExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof earningsExportQuery>;
    const where: Prisma.PublisherEarningWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { publisherId: query.userId } : {}),
      ...(query.channelId ? { channelId: query.channelId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    await runExport(req, res, next, {
      entity: 'earnings',
      action: 'EXPORT_EARNINGS',
      filters: {
        status: query.status ?? null,
        userId: query.userId ?? null,
        channelId: query.channelId ?? null,
        from: query.from ? query.from.toISOString() : null,
        to: query.to ? query.to.toISOString() : null,
      },
      columns: EARNING_COLUMNS,
      fetchBatch: async ({ skip, take }) => {
        const rows = await prisma.publisherEarning.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
          select: {
            id: true,
            publisherId: true,
            channelId: true,
            campaignId: true,
            grossCents: true,
            platformFeeCents: true,
            netCents: true,
            status: true,
            availableAt: true,
            paidAt: true,
            createdAt: true,
            channel: { select: { title: true } },
            publisher: { select: { username: true, firstName: true, lastName: true } },
          },
        });
        return rows.map(
          ({ channel, publisher, ...earning }): AdminEarningRow => ({
            ...earning,
            channelTitle: channel.title,
            publisherName: displayName(publisher),
          }),
        );
      },
    });
  },
);

exportRouter.get(
  '/revenue.csv',
  requirePermission('dashboard.view'),
  validate({ query: revenueExportQuery }),
  async (req, res, next) => {
    const query = req.query as unknown as z.infer<typeof revenueExportQuery>;
    const days = query.days ?? 30;

    await runExport(req, res, next, {
      entity: 'revenue',
      action: 'EXPORT_REVENUE',
      filters: { days },
      columns: REVENUE_COLUMNS,
      fetchBatch: async ({ skip }) => {
        // Revenue is an aggregated per-day series (≤366 rows), so it is built
        // once and served in a single batch.
        if (skip > 0) return [];
        const byDay = await revenueByDay(days);
        return byDay.map((day): RevenueRow => ({ date: day.date, revenueCents: day.revenueCents }));
      },
    });
  },
);
