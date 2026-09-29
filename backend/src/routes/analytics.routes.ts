import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { validate } from '../middleware/validate';
import {
  advertiserAnalytics,
  advertiserAnalyticsHistory,
  publisherAnalytics,
} from '../services/analytics.service';

/**
 * Read-only dashboard analytics. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const analyticsRouter = Router();

/** GET /api/analytics/advertiser — lifetime spend, reach and CTR. */
analyticsRouter.get('/analytics/advertiser', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await advertiserAnalytics(user.id) });
  } catch (err) {
    next(err);
  }
});

const historyQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).default(30),
});

/**
 * GET /api/analytics/advertiser/history — PREMIUM (advancedAnalytics).
 * Per-day posts / views / clicks / spend plus the top channels in the window.
 * A free advertiser gets a typed 403 with an upgrade message, never empty data.
 */
analyticsRouter.get(
  '/analytics/advertiser/history',
  validate({ query: historyQuery }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const q = req.validated?.query as z.infer<typeof historyQuery>;
      res.json({ ok: true, data: await advertiserAnalyticsHistory(user.id, q.days) });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/analytics/publisher — lifetime earnings, posts and CTR. */
analyticsRouter.get('/analytics/publisher', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await publisherAnalytics(user.id) });
  } catch (err) {
    next(err);
  }
});
