import { Router } from 'express';
import { ChannelStatus } from '@prisma/client';
import { adminChannelActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { CHANNEL_SORT_KEYS, adminChannelAction, listChannelsAdmin } from '../../services/admin.service';
import { blockedAdsSummary } from '../../services/moderation.service';
import { requirePermission } from '../../middleware/adminAuth';
import { AppError } from '../../utils/errors';
import { adminId, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const channelRouter = Router();

/**
 * Optional date window (§79). `z.coerce.date()` matches the audit-log query in
 * settings.routes.ts. `from` is inclusive, `to` is exclusive.
 */
const dateRangeQuery = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/** A backwards window (`from > to`) is a client mistake → 400. */
function assertDateRange(q: { from?: Date; to?: Date }): void {
  if (q.from && q.to && q.from > q.to) {
    throw new AppError('`from` must be earlier than or equal to `to`', 400);
  }
}

const channelsQuery = paginationSchema.extend({
  status: z.nativeEnum(ChannelStatus).optional(),
  ...dateRangeQuery,
  // Whitelisted sort keys; `listChannelsAdmin` maps each key to an explicit
  // Prisma orderBy, so a client string never reaches the query builder (§79).
  sort: z.enum(CHANNEL_SORT_KEYS).optional(),
});

type ChannelsQuery = z.infer<typeof channelsQuery>;

/**
 * All channels (admin view), newest first by default, optionally filtered by
 * status and a `from`/`to` window on `createdAt` (§79). `sort` reorders within
 * the whitelist.
 */
channelRouter.get('/', requirePermission('channels.view'), validate({ query: channelsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as ChannelsQuery;
    assertDateRange(query);
    const data = await listChannelsAdmin(
      { status: query.status, from: query.from, to: query.to, sort: query.sort },
      getPagination(query),
    );
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Admin actions: APPROVE / REJECT / SUSPEND / REACTIVATE. */
channelRouter.post('/action', requirePermission('channels.manage'), validate({ body: adminChannelActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof adminChannelActionSchema>;
    const data = await adminChannelAction(adminId(req), {
      channelId: body.channelId,
      action: body.action,
      note: body.note ?? undefined,
    });
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** How many ad posts were removed, grouped by the recorded error code. */
channelRouter.get('/blocked', requirePermission('channels.view'), async (_req, res, next) => {
  try {
    const data = await blockedAdsSummary();
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});
