import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { NotFoundError, UnauthorizedError } from '../../utils/errors';
import { getPagination } from '../../utils/pagination';
import {
  countUnreadAdminNotifications,
  listAdminNotifications,
  markAdminNotificationsRead,
  markAllAdminNotificationsRead,
} from '../../services/notification.service';
import { idParams, respondOk } from './common';

/**
 * Admin notification inbox — backed by `AdminNotification`, keyed on the acting
 * `AdminUser` id (`req.admin.id`), NOT the user-scoped `Notification` table.
 *
 * READ THIS BEFORE CHANGING THE FILE: the separate table is the point. Ops
 * alerts are addressed to the admin ROLE, so:
 *  - ops history survives the person — deleting an `AdminUser` cascades its
 *    alerts, but the record is keyed to the role rather than to the human's
 *    personal account, so a support inbox and an ops log never share a read
 *    state;
 *  - the same human's personal `Notification` inbox stays free of ops noise;
 *  - revoking admin rights implicitly stops delivery without touching a row.
 *
 * Scoping rule, deliberately non-negotiable: the admin id comes from `req.admin`
 * (the `AdminUser` id, never the underlying `User` id), NEVER from a query/param.
 * There is no way for an admin to read or mutate another admin's inbox, and a
 * cross-admin id returns 404 (not 403) so the route does not leak whether a
 * notification id exists at all.
 *
 * Mounted by the caller (intentionally NOT wired into index.ts) — the intended
 * mount is `/api/admin/notifications`. Gated with `dashboard.view`, the same key
 * the panel's Overview uses, which every admin screen already holds.
 */

export const notificationsRouter = Router();

notificationsRouter.use(requirePermission('dashboard.view'));

/**
 * The list query: pagination plus the optional unread filter.
 *
 * `page`/`limit` deliberately carry NO upper bound here: `getPagination` is the
 * single place that clamps `limit` to `PAGINATION.MAX_LIMIT`, so an over-large
 * limit is CAPPED (to 100) rather than rejected — matching every other admin
 * list. A non-numeric value still 422s.
 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  /** The client sends the literal string 'true'; anything else means "all". */
  unreadOnly: z.enum(['true', 'false']).optional(),
});

/**
 * The acting admin's `AdminUser` id. `adminPanelAuth`/`telegramAuth` set
 * `req.admin`; an unauthenticated caller (no admin record) is a 401.
 */
function actingAdminId(req: Request): string {
  const admin = req.admin;
  if (!admin) throw new UnauthorizedError('Authentication required');
  return admin.id;
}

/** GET / — the acting admin's notifications, newest first, paginated. */
export async function listAdminNotificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = actingAdminId(req);
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;
    const p = getPagination(query);
    const unreadOnly = query.unreadOnly === 'true';

    // `unread` travels WITH the page so the list and the nav badge are computed
    // from one request and cannot disagree after a mark-as-read.
    const [page, unread] = await Promise.all([
      listAdminNotifications(adminId, p, unreadOnly),
      countUnreadAdminNotifications(adminId),
    ]);

    respondOk(res, { ...page, unread });
  } catch (err) {
    next(err);
  }
}

/** GET /unread-count — the badge number for the acting admin. */
export async function adminUnreadCountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = actingAdminId(req);
    respondOk(res, { unread: await countUnreadAdminNotifications(adminId) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /:id/read — mark one notification read.
 *
 * Idempotent: an already-read row returns 200 with `isRead: true` rather than an
 * error, so a double-click or a retried request is harmless. A row that does not
 * belong to the acting admin (or does not exist) is a 404 in both cases — the
 * response is identical, so existence is not leaked.
 */
export async function markAdminNotificationReadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = actingAdminId(req);
    const id = req.params.id;

    const existing = await prisma.adminNotification.findFirst({
      where: { id, adminId },
      select: { id: true, isRead: true },
    });
    if (!existing) throw new NotFoundError('Notification');

    if (!existing.isRead) {
      await markAdminNotificationsRead(adminId, [id]);
    }

    respondOk(res, { id, isRead: true });
  } catch (err) {
    next(err);
  }
}

/** POST /read-all — mark the acting admin's whole inbox read. */
export async function markAllAdminNotificationsReadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const adminId = actingAdminId(req);
    respondOk(res, { updated: await markAllAdminNotificationsRead(adminId) });
  } catch (err) {
    next(err);
  }
}

// Specific paths are declared before `/:id/read` so nothing can shadow them.
notificationsRouter.get('/', validate({ query: listQuerySchema }), listAdminNotificationsHandler);

notificationsRouter.get('/unread-count', adminUnreadCountHandler);

notificationsRouter.post('/read-all', markAllAdminNotificationsReadHandler);

notificationsRouter.post(
  '/:id/read',
  validate({ params: idParams }),
  markAdminNotificationReadHandler,
);
