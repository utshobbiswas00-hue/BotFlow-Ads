import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import {
  buildPaginated,
  getPagination,
  type PaginatedResult,
  type Pagination,
} from '../../utils/pagination';
import { respondOk } from './common';

/**
 * Integration failure view (spec §27).
 *
 * IMPORTANT — scope. Outbound Telegram HTTP calls are NOT logged at the transport
 * level; there is no request/response table for them. What this endpoint shows is
 * the union of the records that DO exist when something fails:
 *
 *   - `error_logs`     — errors already persisted by the central error handler,
 *                        restricted to the integration sources TELEGRAM / PAYMENT
 *                        / WEBHOOK.
 *   - `delivery_events`— Telegram POSTING failures (`errorCode` + `message`).
 *   - `webhook_deliveries` — outbound webhook failures (`error`, `responseStatus`).
 *
 * This must never be described as a full API request log, and the field names do
 * not pretend to be one: there is no latency, request body or response body here.
 *
 * Mounted by the caller at `/api/admin/api-logs` (NOT wired into index.ts).
 */
export const apiLogsRouter = Router();

/** The only error_logs sources this view represents. */
export const API_LOG_SOURCES = ['TELEGRAM', 'PAYMENT', 'WEBHOOK'] as const;

/** The normalised row shape (`ApiLogRow` on the client). */
export interface ApiLogRow {
  id: string;
  source: string;
  level: string;
  code: string | null;
  message: string;
  context: string | null;
  createdAt: string;
}

export interface ApiLogsFilter {
  source?: string;
  from?: Date;
  to?: Date;
}

interface SourcePage {
  total: number;
  rows: ApiLogRow[];
}

/** Stable newest-first merge. ISO-8601 strings compare chronologically. */
export function mergeApiLogRows(rows: ApiLogRow[]): ApiLogRow[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A model-agnostic date window, structurally valid as any `DateTimeFilter`. */
interface DateWindow {
  gte?: Date;
  lt?: Date;
}

function dateWindow(filter: ApiLogsFilter): DateWindow | undefined {
  if (!filter.from && !filter.to) return undefined;
  return {
    ...(filter.from ? { gte: filter.from } : {}),
    ...(filter.to ? { lt: filter.to } : {}),
  };
}

async function collectErrorLogs(
  where: Prisma.ErrorLogWhereInput,
  take: number,
): Promise<SourcePage> {
  const [total, rows] = await Promise.all([
    prisma.errorLog.count({ where }),
    prisma.errorLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        source: true,
        level: true,
        code: true,
        message: true,
        context: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      source: r.source,
      level: r.level,
      code: r.code,
      message: r.message,
      context: r.context,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

async function collectDeliveryEvents(
  where: Prisma.DeliveryEventWhereInput,
  take: number,
): Promise<SourcePage> {
  const [total, rows] = await Promise.all([
    prisma.deliveryEvent.count({ where }),
    prisma.deliveryEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, deliveryJobId: true, message: true, errorCode: true, createdAt: true },
    }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      source: 'TELEGRAM',
      level: 'ERROR',
      code: r.errorCode ? String(r.errorCode) : null,
      message: r.message ?? 'Telegram delivery failed',
      context: `delivery:${r.deliveryJobId}`,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

async function collectWebhookDeliveries(
  where: Prisma.WebhookDeliveryWhereInput,
  take: number,
): Promise<SourcePage> {
  const [total, rows] = await Promise.all([
    prisma.webhookDelivery.count({ where }),
    prisma.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, event: true, responseStatus: true, error: true, createdAt: true },
    }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      source: 'WEBHOOK',
      level: 'ERROR',
      code: r.responseStatus != null ? String(r.responseStatus) : null,
      message: r.error ?? 'Webhook delivery failed',
      context: `webhook:${r.event}`,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * The merged, page-sliced union. Each source is fetched newest-first for as many
 * rows as the requested page needs (`skip + take`): any row that belongs on the
 * global page is necessarily within the top `skip + take` of its own source, so
 * this yields the correct page without pulling either table in full. Totals are
 * the sum of the per-source counts.
 */
export async function buildApiLogs(
  filter: ApiLogsFilter,
  p: Pagination,
): Promise<PaginatedResult<ApiLogRow>> {
  const window = dateWindow(filter);
  // Restrict error_logs to this view's sources AND to the requested one (an
  // unknown source yields `in: []`, i.e. no rows, rather than leaking HTTP rows).
  const allowed = API_LOG_SOURCES.filter((s) => !filter.source || s === filter.source);
  const errorLogWhere: Prisma.ErrorLogWhereInput = { source: { in: allowed }, createdAt: window };
  const deliveryWhere: Prisma.DeliveryEventWhereInput = {
    errorCode: { not: null },
    createdAt: window,
  };
  const webhookWhere: Prisma.WebhookDeliveryWhereInput = { error: { not: null }, createdAt: window };

  const wantTelegram = allowed.includes('TELEGRAM');
  const wantWebhook = allowed.includes('WEBHOOK');
  const perSourceTake = p.skip + p.take;

  const empty: SourcePage = { total: 0, rows: [] };
  const [errorPage, deliveryPage, webhookPage] = await Promise.all([
    collectErrorLogs(errorLogWhere, perSourceTake),
    wantTelegram ? collectDeliveryEvents(deliveryWhere, perSourceTake) : Promise.resolve(empty),
    wantWebhook ? collectWebhookDeliveries(webhookWhere, perSourceTake) : Promise.resolve(empty),
  ]);

  const total = errorPage.total + deliveryPage.total + webhookPage.total;
  const merged = mergeApiLogRows([...errorPage.rows, ...deliveryPage.rows, ...webhookPage.rows]);
  const items = merged.slice(p.skip, p.skip + p.take);

  return buildPaginated(items, total, p);
}

const apiLogsQuery = paginationSchema.extend({
  source: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

type ApiLogsQuery = z.infer<typeof apiLogsQuery>;

apiLogsRouter.get(
  '/',
  requirePermission('dashboard.view'),
  validate({ query: apiLogsQuery }),
  async (req, res, next) => {
    try {
      const query = req.query as unknown as ApiLogsQuery;
      const data = await buildApiLogs(
        { source: query.source, from: query.from, to: query.to },
        getPagination(query),
      );
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);
