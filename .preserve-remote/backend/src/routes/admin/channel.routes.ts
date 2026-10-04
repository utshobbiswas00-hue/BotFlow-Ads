import { Router } from 'express';
import { ChannelStatus } from '@prisma/client';
import { adminChannelActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { adminChannelAction, listChannelsAdmin } from '../../services/admin.service';
import { blockedAdsSummary } from '../../services/moderation.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const channelRouter = Router();

const channelsQuery = paginationSchema.extend({
  status: z.nativeEnum(ChannelStatus).optional(),
});

type ChannelsQuery = z.infer<typeof channelsQuery>;

/** All channels (admin view), newest first, optionally filtered by status. */
channelRouter.get('/', requirePermission('channels.view'), validate({ query: channelsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as ChannelsQuery;
    const data = await listChannelsAdmin({ status: query.status }, getPagination(query));
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
