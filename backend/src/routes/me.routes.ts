import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { getUserProfile, getDashboard, updateUserProfile } from '../services/user.service';
import { getWallet, withdrawableCents, netWorthCents } from '../services/wallet.service';
import { countUnread } from '../services/notification.service';
import { channelSummaryStats } from '../services/channel.service';
import { env } from '../config/env';

/**
 * Account / dashboard routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const meRouter = Router();

/** GET /api/me — profile, wallet and admin flags in one round trip. */
meRouter.get('/me', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [profile, wallet] = await Promise.all([getUserProfile(user.id), getWallet(user.id)]);
    res.json({
      ok: true,
      data: {
        user: profile,
        wallet,
        isAdmin: profile.isAdmin,
        adminRole: profile.adminRole,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/dashboard — landing-screen numbers plus the unread badge. */
meRouter.get('/dashboard', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [dashboard, unreadNotifications] = await Promise.all([
      getDashboard(user.id),
      countUnread(user.id),
    ]);
    res.json({ ok: true, data: { ...dashboard, unreadNotifications } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/app-config — small, static, non-secret values the frontend needs
 * but has no other way to read (there is no build-time env injection here).
 * Cheap and cacheable forever within a session: nothing on this response
 * changes without a redeploy.
 */
meRouter.get('/app-config', (_req, res) => {
  res.json({ ok: true, data: { botUsername: env.TELEGRAM_BOT_USERNAME } });
});

/** PATCH /api/me — toggle the advertiser / publisher roles. */
meRouter.patch(
  '/me',
  validate({
    body: z.object({
      isAdvertiser: z.boolean().optional(),
      isPublisher: z.boolean().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const data = await updateUserProfile(user.id, req.body);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/me/summary — channel counts plus withdrawable / net worth. */
meRouter.get('/me/summary', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [summary, wallet] = await Promise.all([channelSummaryStats(user.id), getWallet(user.id)]);
    res.json({
      ok: true,
      data: {
        ...summary,
        withdrawableCents: withdrawableCents(wallet),
        netWorthCents: netWorthCents(wallet),
      },
    });
  } catch (err) {
    next(err);
  }
});
