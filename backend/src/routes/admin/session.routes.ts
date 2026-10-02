import { Router } from 'express';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { readSession } from '../../services/adminSession.service';
import { readCookie } from '../../utils/cookies';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { displayName } from '../../utils/format';
import { respondOk } from './common';

/**
 * The acting admin's own session.
 *
 * Why this exists: every other admin route is gated by `requirePermission`, but
 * nothing told the client WHICH permissions the signed-in admin holds. `GET
 * /api/me` reports `isAdmin` / `adminRole` only, so a UI built on it would have
 * to guess a role -> permission mapping — and that guess would be wrong for
 * every account whose `AdminUser.permissions` array has been tuned by hand.
 *
 * The result is the authoritative answer, read from the same row `requireAdmin`
 * reads, so the panel can hide exactly the actions that would 403. It is
 * render-only: the API stays the security boundary.
 *
 * Mounted with `requireAdmin` only (see index.ts) — an admin with an empty
 * permission array must still be able to ask what it has, otherwise the panel
 * can only show a blank 403 with no explanation.
 */
export const sessionRouter = Router();

sessionRouter.get('/', async (req, res, next) => {
  try {
    const admin = req.admin;
    if (!admin) throw new ForbiddenError('Admin access required');

    const row = await prisma.adminUser.findUnique({
      where: { id: admin.id },
      select: {
        id: true,
        role: true,
        permissions: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            telegramId: true,
            username: true,
            firstName: true,
            lastName: true,
            photoUrl: true,
            status: true,
          },
        },
      },
    });

    if (!row) throw new NotFoundError('Admin');

    const permissions = Array.isArray(row.permissions)
      ? (row.permissions as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];

    // Which door this request came through, plus the CSRF value to echo back.
    //
    // Reported here rather than behind a second call so the panel's bootstrap is
    // one request. `csrf` is null when the caller authenticated with Telegram:
    // there is no cookie session, so there is nothing to echo and nothing to sign
    // out of. The client uses `active` to decide whether to offer a sign-out.
    const sid = readCookie(req.headers.cookie, env.ADMIN_PANEL_SESSION_COOKIE);
    const cookieSession = sid ? await readSession(sid) : null;

    respondOk(res, {
      session: {
        active: cookieSession !== null,
        csrf: cookieSession?.csrf ?? null,
      },
      admin: {
        id: row.id,
        role: row.role,
        isActive: row.isActive,
        /** SUPER_ADMIN bypasses every permission check in adminAuth. */
        isSuperAdmin: row.role === 'SUPER_ADMIN',
        permissions,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
      },
      user: {
        id: row.user.id,
        telegramId: row.user.telegramId.toString(),
        username: row.user.username,
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        photoUrl: row.user.photoUrl,
        status: row.user.status,
        name: displayName(row.user),
      },
    });
  } catch (err) {
    next(err);
  }
});
