import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import {
  listNotifications,
  countUnread,
  markNotificationsRead,
  markAllRead,
} from '../services/notification.service';

/**
 * In-app notification inbox. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 *
 * NOTE: the specific paths (read, read-all, unread-count) are declared
 * before any parameterised route could shadow them.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const markReadBody = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export const notificationRouter = Router();

/** GET /api/notifications — newest first, paginated. */
notificationRouter.get('/notifications', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listNotifications(user.id, getPagination(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/notifications/read — mark specific notifications read. */
notificationRouter.post(
  '/notifications/read',
  validate({ body: markReadBody }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { ids } = req.body as z.infer<typeof markReadBody>;
      const marked = await markNotificationsRead(user.id, ids);
      res.json({ ok: true, data: { marked } });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/notifications/read-all — mark the whole inbox read. */
notificationRouter.post('/notifications/read-all', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const marked = await markAllRead(user.id);
    res.json({ ok: true, data: { marked } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/notifications/unread-count — the header badge. */
notificationRouter.get('/notifications/unread-count', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: { count: await countUnread(user.id) } });
  } catch (err) {
    next(err);
  }
});
