import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { addChannelSchema, updateChannelSchema, channelCategorySchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { limiters } from '../middleware/rateLimit';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import {
  addChannel,
  listChannels,
  getChannel,
  updateChannel,
  deleteChannel,
  verifyChannel,
  assertChannelOwner,
  type ListChannelsFilter,
} from '../services/channel.service';
import { approveAdRequest, rejectAdRequest, listChannelAdRequests } from '../services/delivery.service';
import { refreshChannelStats } from '../services/channelStats.service';

/**
 * Publisher "My Channels" routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const CHANNEL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE', 'ATTENTION_REQUIRED'] as const;

const listQuery = z.object({
  status: z.enum(CHANNEL_STATUSES).optional(),
  category: channelCategorySchema.optional(),
  country: z.string().length(2).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// RESTful: the :id param carries the channel id, so drop the redundant field.
const updateBody = updateChannelSchema.omit({ channelId: true });

const requestActionBody = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
});

export const channelRouter = Router();

/** GET /api/channels — the user's channels, optionally filtered. */
channelRouter.get('/channels', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const q = req.validated?.query as z.infer<typeof listQuery>;
    const p = getPagination(q);
    const filter: ListChannelsFilter = {
      status: q.status,
      category: q.category,
      country: q.country,
    };
    res.json({ ok: true, data: await listChannels(user.id, filter, p) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/channels — register a channel (hits the Telegram API). */
channelRouter.post('/channels', limiters.addChannel, validate({ body: addChannelSchema }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const data = await addChannel(user.id, req.body);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

/** GET /api/channels/:id — full channel detail (owner only). */
channelRouter.get('/channels/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await getChannel(user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/channels/:id — pricing, category, cadence (owner only). */
channelRouter.patch('/channels/:id', validate({ body: updateBody }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const data = await updateChannel(user.id, req.params.id, req.body);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/channels/:id — remove (owner only, refuses live jobs). */
channelRouter.delete('/channels/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await deleteChannel(user.id, req.params.id);
    res.json({ ok: true, data: { removed: true } });
  } catch (err) {
    next(err);
  }
});

/** POST /api/channels/:id/verify — re-check bot permissions (owner only). */
channelRouter.post('/channels/:id/verify', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await assertChannelOwner(user.id, req.params.id);
    res.json({ ok: true, data: await verifyChannel(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/channels/:id/requests — ad posts awaiting the publisher's approval. */
channelRouter.get('/channels/:id/requests', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const p = getPagination(req.query);
    await assertChannelOwner(user.id, req.params.id);
    res.json({
      ok: true,
      data: await listChannelAdRequests(req.params.id, { skip: p.skip, take: p.take }),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/channels/:id/requests/:jobId — approve or reject one ad request. */
channelRouter.post(
  '/channels/:id/requests/:jobId',
  validate({ body: requestActionBody }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { action, reason } = req.body as z.infer<typeof requestActionBody>;
      const data =
        action === 'approve'
          ? await approveAdRequest(user.id, req.params.jobId)
          : await rejectAdRequest(user.id, req.params.jobId, reason);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/channels/:id/stats/refresh — pull fresh subscriber stats (owner only). */
channelRouter.post('/channels/:id/stats/refresh', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await assertChannelOwner(user.id, req.params.id);
    res.json({ ok: true, data: await refreshChannelStats(req.params.id) });
  } catch (err) {
    next(err);
  }
});
