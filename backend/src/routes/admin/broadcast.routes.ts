import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { BroadcastRecipientStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { prisma } from '../../db/prisma';
import { enqueueBroadcast } from '../../queues/producers';
import {
  createBroadcastJob,
  getBroadcastJob,
  listBroadcastHistory,
  listBroadcastRecipients,
  markBroadcastEnqueueFailed,
} from '../../services/broadcast.service';
import { recordAudit } from '../../services/audit.service';
import { AppError } from '../../utils/errors';
import { getPagination } from '../../utils/pagination';
import { adminId, idParams, respondOk } from './common';

/**
 * Admin broadcast (spec §52).
 *
 * WHY THIS ROUTE EXISTS
 * `broadcast.send` has been declared in `middleware/adminAuth.ts` since the
 * permission catalogue was written, but no route ever read it — the only
 * broadcast machinery was the `broadcast-admin-alert` queue job, which pages the
 * ADMIN team (`alertAdmins` → `TELEGRAM_ADMIN_IDS`) and has no HTTP entry point.
 * There was no way to send a message to USERS, so the permission was decorative.
 *
 * WHAT IT BUILDS ON
 * The notification queue already carries per-user messages: `enqueueNotification`
 * produces `send-telegram-notification` jobs which the notification worker
 * delivers with `deliverToTelegram`, and `notification.service.createBulkNotifications`
 * fans one message out to many users (persist the in-app rows, then enqueue one
 * Telegram push per recipient). That is a real per-user fan-out path, so the
 * broadcast is built on top of it rather than in parallel: this route enqueues ONE
 * `send-broadcast` job carrying the resolved recipient list, and the existing
 * notification worker expands it via `createBulkNotifications`. No second queue is
 * introduced — the broadcast rides the same `botflow-notification` queue.
 *
 * RECIPIENT RULE
 * A broadcast fans out to real Telegram chats, so the audience is capped at 100
 * (server-side). The audience is reported EXACTLY as counted and an over-limit send
 * is REJECTED — never silently truncated, which would deliver a partial broadcast
 * while telling the operator it reached everyone.
 *
 * AUDIENCE DERIVATION
 * PUBLISHERS / ADVERTISERS are derived from the RELATIONSHIPS (a channel / a
 * campaign row), never from the cached `User.isPublisher` / `User.isAdvertiser`
 * booleans. Those flags are derived state that can drift from the rows that
 * actually exist; the same reasoning the admin users-list filter uses.
 */

export const BROADCAST_MAX_RECIPIENTS = 100;

export const BROADCAST_AUDIENCES = ['ALL', 'PUBLISHERS', 'ADVERTISERS'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

/**
 * The audience → Prisma where-clause mapping. Pure and dependency-free so it can
 * be unit-tested without a database.
 *
 *  - ALL         → every user (no filter)
 *  - PUBLISHERS  → has at least one Channel
 *  - ADVERTISERS → has at least one Campaign
 */
export function broadcastAudienceWhere(audience: BroadcastAudience): Prisma.UserWhereInput {
  switch (audience) {
    case 'ALL':
      return {};
    case 'PUBLISHERS':
      return { channels: { some: {} } };
    case 'ADVERTISERS':
      return { campaigns: { some: {} } };
  }
}

/**
 * The recipient-limit rule, isolated as a pure predicate.
 *
 * Uses `>` so the limit is INCLUSIVE: exactly 100 recipients is allowed, 101 is
 * not. Kept separately testable so the rule cannot drift from the count the
 * audience endpoint reports.
 */
export function exceedsRecipientLimit(count: number): boolean {
  return count > BROADCAST_MAX_RECIPIENTS;
}

/** 400 naming the actual count and the limit — the operator must see both. */
export function recipientLimitError(count: number): AppError {
  return new AppError(
    `Broadcast audience of ${count} recipients exceeds the maximum of ${BROADCAST_MAX_RECIPIENTS}. Narrow the audience before sending.`,
    400,
  );
}

export const broadcastRouter = Router();

const audienceQuery = z.object({
  audience: z.enum(BROADCAST_AUDIENCES),
});

const sendBroadcastSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  audience: z.enum(BROADCAST_AUDIENCES),
  /** Validate + count without enqueueing anything (the confirmation step). */
  dryRun: z.boolean().optional(),
});

type SendBroadcastBody = z.infer<typeof sendBroadcastSchema>;

/** Pagination for the report lists; `getPagination` clamps the real bounds. */
const broadcastPageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

/** Recipient list adds the status filter. */
const broadcastRecipientQuery = broadcastPageQuery.extend({
  status: z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED']).optional(),
});

/**
 * How many users an audience would reach. Call this before sending: the composer
 * shows the number so "ALL" is a decision, not a guess. Reporting an over-limit
 * count here is deliberate — the operator sees the real size and the POST rejects.
 */
broadcastRouter.get(
  '/audience',
  requirePermission('broadcast.send'),
  validate({ query: audienceQuery }),
  async (req, res, next) => {
    try {
      const { audience } = req.query as unknown as z.infer<typeof audienceQuery>;
      const recipients = await prisma.user.count({ where: broadcastAudienceWhere(audience) });
      respondOk(res, { audience, recipients });
    } catch (err) {
      next(err);
    }
  },
);

/* ------------------------------------------------------------------
 *  Delivery report (spec §52)
 * ------------------------------------------------------------------ */

/**
 * `GET /api/admin/broadcast/history?page&limit` — paginated job list, newest
 * first. Exported so the endpoint is unit-testable without a live server.
 */
export async function listBroadcastHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listBroadcastHistory(getPagination(req.query));
    respondOk(res, result);
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /api/admin/broadcast/:id` — the job plus live per-status counts.
 *
 * `counts` comes from a `groupBy` on the recipients, NOT from the job's
 * denormalised `sentCount`/`failedCount`; both are returned so any drift is
 * visible rather than hidden.
 */
export async function getBroadcastJobHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { job, counts } = await getBroadcastJob(req.params.id);
    respondOk(res, { job, counts });
  } catch (err) {
    next(err);
  }
}

/** `GET /api/admin/broadcast/:id/recipients?page&limit&status`. */
export async function listBroadcastRecipientsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status } = req.query as { status?: BroadcastRecipientStatus };
    const result = await listBroadcastRecipients(
      req.params.id,
      getPagination(req.query),
      status,
    );
    respondOk(res, result);
  } catch (err) {
    next(err);
  }
}

broadcastRouter.get(
  '/history',
  requirePermission('broadcast.send'),
  validate({ query: broadcastPageQuery }),
  listBroadcastHistoryHandler,
);

// Registered after `/history` and `/audience` so those literal paths win over
// the `:id` wildcard.
broadcastRouter.get(
  '/:id',
  requirePermission('broadcast.send'),
  validate({ params: idParams }),
  getBroadcastJobHandler,
);

broadcastRouter.get(
  '/:id/recipients',
  requirePermission('broadcast.send'),
  validate({ params: idParams, query: broadcastRecipientQuery }),
  listBroadcastRecipientsHandler,
);

/**
 * Queue a broadcast to USERS (not admins).
 *
 *  - `dryRun: true` → validate + count, enqueue NOTHING, `{ enqueued: false, jobId: null }`.
 *  - over the recipient limit → 400 naming the actual count and the limit (both
 *    dry and real — the limit is a hard rule, not a property of the send).
 *  - real send → enqueue ONE job carrying the recipient list, audit it, and return
 *    `{ enqueued: true, jobId }`.
 */
broadcastRouter.post(
  '/',
  requirePermission('broadcast.send'),
  validate({ body: sendBroadcastSchema }),
  async (req, res, next) => {
    try {
      const { title, body, audience, dryRun } = req.body as SendBroadcastBody;

      const where = broadcastAudienceWhere(audience);
      const recipients = await prisma.user.count({ where });

      // Report the EXACT count and refuse rather than sending a truncated blast.
      if (exceedsRecipientLimit(recipients)) {
        throw recipientLimitError(recipients);
      }

      if (dryRun) {
        respondOk(res, { enqueued: false, jobId: null, audience, recipients });
        return;
      }

      // Fix the audience at confirm time: the job carries the resolved ids, so a
      // user created between the count and the worker run is not silently added
      // (and the count the operator confirmed is exactly who is messaged).
      const users = await prisma.user.findMany({ where, select: { id: true } });
      const userIds = users.map((u) => u.id);

      // Durability FIRST: create the BroadcastJob and one PENDING recipient row
      // per user, atomically, before anything is queued. If the process dies
      // between here and the enqueue, the broadcast is recorded as QUEUED rather
      // than vanishing — and the delivery report has rows to fill in. This is
      // the only write the composer performs before the send is irreversible.
      const created = await createBroadcastJob({
        title,
        body,
        audience,
        createdById: adminId(req),
        userIds,
      });

      // One queue job carrying the recipient list AND the per-recipient ids, so
      // the existing notification worker can attribute each send's outcome back
      // to its row. The notification fan-out itself is the same path as always.
      try {
        await enqueueBroadcast({
          title,
          body,
          audience,
          userIds,
          broadcastJobId: created.jobId,
          recipients: created.recipients,
        });
      } catch (err) {
        // The queue rejected it, so nothing will ever process this job. Fail it
        // rather than leave a phantom QUEUED entry in the report.
        await markBroadcastEnqueueFailed(created.jobId).catch(() => undefined);
        throw err;
      }

      // An audit row records the ACTS of an operator, not secrets. The broadcast
      // body IS user-visible content the panel must be able to attribute later, so
      // it is recorded here on purpose — an audit row is not a place for secrets,
      // and no token/credential ever belongs in `newValue`.
      await recordAudit({
        actorId: adminId(req),
        action: 'BROADCAST_SENT',
        targetType: 'BROADCAST',
        newValue: { audience, recipients, title, broadcastJobId: created.jobId },
        ip: req.ctx?.ip ?? req.ip ?? null,
        userAgent: req.ctx?.userAgent ?? req.header('user-agent') ?? null,
      });

      // `jobId` is the durable BroadcastJob id — the handle the delivery report
      // is read by. The other keys are unchanged from before.
      respondOk(res, { enqueued: true, jobId: created.jobId, audience, recipients });
    } catch (err) {
      next(err);
    }
  },
);
