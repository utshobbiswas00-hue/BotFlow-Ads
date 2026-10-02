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
import {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS,
  streamCsv,
  type CsvColumn,
} from '../../utils/csv';
import { buildXlsx, type XlsxCell } from '../../utils/xlsx';
import { adminId } from './common';

/**
 * Admin exports (spec §78).
 *
 * Mounted by the parent admin router at `/api/admin/export`; the auth gate
 * (`adminPanelAuth`, `requireAdmin`, the admin rate limiter) is applied by that
 * parent, so each route below only adds its own `requirePermission` key.
 *
 * Each entity is downloadable in two formats — `.csv` and `.xlsx` — and they
 * share one definition: the same query schema, the same column/value builders
 * and the same batched fetch. `registerExport` wires the pair together, so a
 * filter added for a list screen cannot end up applied to one format and not
 * the other. The two runners differ only in how the already-selected rows are
 * serialised.
 *
 * Every handler follows the same contract:
 *  - it accepts the SAME filters as the matching list endpoint (status / type /
 *    userId / search — plus from/to where the list actually has a date range),
 *    and ignores page/limit;
 *  - it is bounded by the same hard row cap ({@link EXPORT_MAX_ROWS}). CSV streams
 *    through `streamCsv`; XLSX builds the same rows in memory and emits an .xlsx;
 *  - it writes exactly ONE `recordAudit` row describing what was exported. The
 *    audit is about the EXPORT, not the format, so both write the same action and
 *    the same `newValue` shape.
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
  /** Used in the download filename: `botflow-<entity>-<YYYY-MM-DD>.<ext>`. */
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

/**
 * Convert a row value to something the workbook can hold. Dates become ISO-8601
 * strings (never locale-dependent), integral BigInts stay numeric, and a
 * non-finite number falls back to its text form rather than producing `<v>NaN</v>`,
 * which Excel treats as a corrupt cell.
 */
function toXlsxCell(value: unknown): XlsxCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? null;
  }
  return String(value);
}

/**
 * Pull every exportable row through the same bounded batching `streamCsv` uses,
 * stopping at {@link EXPORT_MAX_ROWS} and probing once beyond the cap so
 * "complete" and "truncated" are distinguishable. The CSV path streams; XLSX
 * needs all rows before it can write the sheet, so this collects them.
 */
async function collectExportRows<T>(
  fetchBatch: (args: { skip: number; take: number }) => Promise<T[]>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let truncated = false;

  for (;;) {
    const remaining = EXPORT_MAX_ROWS - rows.length;
    if (remaining <= 0) {
      truncated = (await fetchBatch({ skip: rows.length, take: 1 })).length > 0;
      break;
    }

    const take = Math.min(EXPORT_BATCH_SIZE, remaining);
    const batch = await fetchBatch({ skip: rows.length, take });
    if (batch.length === 0) break;

    rows.push(...batch);
    if (batch.length < take) break; // source exhausted
    if (rows.length < EXPORT_MAX_ROWS) continue;

    truncated = (await fetchBatch({ skip: rows.length, take: 1 })).length > 0;
    break;
  }

  return { rows, truncated };
}

/**
 * The audit row for one export. Deliberately independent of the output format:
 * what an audit exists to answer is "who pulled which rows", not "as what file".
 */
async function recordExportAudit<T>(
  req: Request,
  spec: ExportSpec<T>,
  rows: number,
  truncated: boolean,
): Promise<void> {
  // Mandatory: exports of user / financial data are sensitive. ONE row per
  // export, recording the acting admin, the row count and the filters used.
  await recordAudit({
    actorId: adminId(req),
    action: spec.action,
    targetType: 'EXPORT',
    newValue: { rows, truncated, filters: spec.filters },
  });
}

async function runCsvExport<T>(req: Request, res: Response, next: NextFunction, spec: ExportSpec<T>): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="botflow-${spec.entity}-${stamp}.csv"`);

    const result = await streamCsv(res, spec.columns, spec.fetchBatch);
    res.end();

    await recordExportAudit(req, spec, result.rows, result.truncated);
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

async function runXlsxExport<T>(req: Request, res: Response, next: NextFunction, spec: ExportSpec<T>): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const { rows, truncated } = await collectExportRows(spec.fetchBatch);

    const header: XlsxCell[] = spec.columns.map((column) => column.header);
    const body: XlsxCell[][] = rows.map((row) =>
      spec.columns.map((column) => toXlsxCell(column.value(row))),
    );
    const sheetRows: XlsxCell[][] = [header, ...body];
    if (truncated) {
      // Same contract as CSV: a truncation is stated, never silent.
      sheetRows.push([
        `# EXPORT TRUNCATED: returned the first ${rows.length} rows (hard cap ${EXPORT_MAX_ROWS}). ` +
          'Narrow the filters for a complete file.',
      ]);
    }

    const buffer = buildXlsx([{ name: spec.entity, rows: sheetRows }]);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="botflow-${spec.entity}-${stamp}.xlsx"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);

    await recordExportAudit(req, spec, rows.length, truncated);
  } catch (err) {
    // The workbook is assembled fully before any byte is written, so a failure
    // here has not sent headers and can still be a normal JSON error.
    if (res.headersSent) {
      logger.error({ err, entity: spec.entity }, 'admin XLSX export failed mid-stream');
      res.end();
      return;
    }
    next(err);
  }
}

/* ------------------------------------------------------------------
 *  Entity specs — one definition per table, reused by both formats.
 * ------------------------------------------------------------------ */

function usersSpec(query: z.infer<typeof usersExportQuery>): ExportSpec<AdminUserListItem> {
  return {
    entity: 'users',
    action: 'EXPORT_USERS',
    filters: { search: query.search ?? null },
    columns: USER_COLUMNS,
    fetchBatch: async ({ skip, take }) => {
      const page = await listUsersAdmin(query.search, batchPager(skip, take));
      return page.items;
    },
  };
}

function channelsSpec(query: z.infer<typeof channelsExportQuery>): ExportSpec<AdminChannelItem> {
  return {
    entity: 'channels',
    action: 'EXPORT_CHANNELS',
    filters: { status: query.status ?? null },
    columns: CHANNEL_COLUMNS,
    fetchBatch: async ({ skip, take }) => {
      const page = await listChannelsAdmin({ status: query.status }, batchPager(skip, take));
      return page.items;
    },
  };
}

function campaignsSpec(query: z.infer<typeof campaignsExportQuery>): ExportSpec<AdminCampaignItem> {
  return {
    entity: 'campaigns',
    action: 'EXPORT_CAMPAIGNS',
    filters: { status: query.status ?? null },
    columns: CAMPAIGN_COLUMNS,
    fetchBatch: async ({ skip, take }) => {
      const page = await listCampaignsAdmin({ status: query.status }, batchPager(skip, take));
      return page.items;
    },
  };
}

function transactionsSpec(query: z.infer<typeof transactionsExportQuery>): ExportSpec<AdminTransactionRow> {
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

  return {
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
  };
}

function depositsSpec(query: z.infer<typeof depositsExportQuery>): ExportSpec<AdminDepositItem> {
  return {
    entity: 'deposits',
    action: 'EXPORT_DEPOSITS',
    filters: { status: query.status ?? null },
    columns: DEPOSIT_COLUMNS,
    fetchBatch: async ({ skip, take }) => {
      const page = await listDepositsAdmin({ status: query.status }, batchPager(skip, take));
      return page.items;
    },
  };
}

function withdrawalsSpec(query: z.infer<typeof withdrawalsExportQuery>): ExportSpec<AdminWithdrawalItem> {
  return {
    entity: 'withdrawals',
    action: 'EXPORT_WITHDRAWALS',
    filters: { status: query.status ?? null },
    columns: WITHDRAWAL_COLUMNS,
    fetchBatch: async ({ skip, take }) => {
      const page = await listWithdrawalsAdmin({ status: query.status }, batchPager(skip, take));
      return page.items;
    },
  };
}

function earningsSpec(query: z.infer<typeof earningsExportQuery>): ExportSpec<AdminEarningRow> {
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

  return {
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
  };
}

function revenueSpec(query: z.infer<typeof revenueExportQuery>): ExportSpec<RevenueRow> {
  const days = query.days ?? 30;
  return {
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
  };
}

/* ------------------------------------------------------------------
 *  Route wiring — both formats per entity, one spec each.
 * ------------------------------------------------------------------ */

/**
 * Register `/<entity>.csv` and `/<entity>.xlsx` from a single spec builder, so
 * the two files always select the same rows. `permission` is the same key for
 * both, matching the entity's list screen.
 */
function registerExport<Q, T>(
  entity: string,
  permission: string,
  schema: z.ZodTypeAny,
  build: (query: Q) => ExportSpec<T>,
): void {
  exportRouter.get(
    `/${entity}.csv`,
    requirePermission(permission),
    validate({ query: schema }),
    async (req, res, next) => {
      await runCsvExport(req, res, next, build(req.query as unknown as Q));
    },
  );

  exportRouter.get(
    `/${entity}.xlsx`,
    requirePermission(permission),
    validate({ query: schema }),
    async (req, res, next) => {
      await runXlsxExport(req, res, next, build(req.query as unknown as Q));
    },
  );
}

registerExport('users', 'users.view', usersExportQuery, usersSpec);
registerExport('channels', 'channels.view', channelsExportQuery, channelsSpec);
registerExport('campaigns', 'campaigns.view', campaignsExportQuery, campaignsSpec);
registerExport('transactions', 'deposits.view', transactionsExportQuery, transactionsSpec);
registerExport('deposits', 'deposits.view', depositsExportQuery, depositsSpec);
registerExport('withdrawals', 'withdrawals.view', withdrawalsExportQuery, withdrawalsSpec);
registerExport('earnings', 'deposits.view', earningsExportQuery, earningsSpec);
registerExport('revenue', 'dashboard.view', revenueExportQuery, revenueSpec);
