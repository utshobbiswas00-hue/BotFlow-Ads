import { Router } from 'express';
import { revenueByDay } from '../../services/analytics.service';
import { requirePermission } from '../../middleware/adminAuth';
import { respondOk } from './common';

export const analyticsRouter = Router();

analyticsRouter.use(requirePermission('dashboard.view'));

/**
 * Platform revenue per day (UTC) for the last `?days=` days (default 30,
 * max 366 — clamped in the service). Revenue = platform fees booked on
 * PUBLISHED posts, in integer cents.
 */
analyticsRouter.get('/revenue', async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 30;
    const data = { byDay: await revenueByDay(days) };
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});
