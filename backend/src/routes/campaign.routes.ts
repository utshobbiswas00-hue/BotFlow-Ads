import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { createCampaignSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { limiters } from '../middleware/rateLimit';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import {
  createCampaign,
  getCampaignDetail,
  listCampaigns,
  setCampaignStatus,
} from '../services/campaign.service';

/**
 * Advertiser campaign lifecycle routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const CAMPAIGN_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'SUSPENDED',
] as const;

const listQuery = z.object({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const campaignRouter = Router();

/** GET /api/campaigns — the advertiser's campaigns, optionally filtered. */
campaignRouter.get('/campaigns', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const q = req.validated?.query as z.infer<typeof listQuery>;
    res.json({
      ok: true,
      data: await listCampaigns(user.id, { status: q.status }, getPagination(q)),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/campaigns — create a campaign (escrows the budget on submit). */
campaignRouter.post(
  '/campaigns',
  limiters.createCampaign,
  validate({ body: createCampaignSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const data = await createCampaign(user.id, req.body);
      res.json({ ok: true, data });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/campaigns/:id — full campaign detail (owner only). */
campaignRouter.get('/campaigns/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await getCampaignDetail(user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** Owner status transitions — pause / resume / cancel. */
function statusTransition(action: 'pause' | 'resume' | 'cancel') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = requireUser(req);
      res.json({ ok: true, data: await setCampaignStatus(user.id, req.params.id, action) });
    } catch (err) {
      next(err);
    }
  };
}

campaignRouter.post('/campaigns/:id/pause', statusTransition('pause'));
campaignRouter.post('/campaigns/:id/resume', statusTransition('resume'));
campaignRouter.post('/campaigns/:id/cancel', statusTransition('cancel'));

/** GET /api/campaigns/:id/stats — delivery breakdown (owner only). */
campaignRouter.get('/campaigns/:id/stats', async (req, res, next) => {
  try {
    const user = requireUser(req);
    // getCampaignDetail asserts ownership (403/404) before we expose stats.
    const detail = await getCampaignDetail(user.id, req.params.id);
    res.json({ ok: true, data: detail.stats });
  } catch (err) {
    next(err);
  }
});
