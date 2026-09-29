import { Router } from 'express';
import { CampaignStatus } from '@prisma/client';
import { adminCampaignActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { adminCampaignAction, listCampaignsAdmin } from '../../services/admin.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const campaignRouter = Router();

const campaignsQuery = paginationSchema.extend({
  status: z.nativeEnum(CampaignStatus).optional(),
});

type CampaignsQuery = z.infer<typeof campaignsQuery>;

/** All campaigns (admin view), newest first, optionally filtered by status. */
campaignRouter.get('/', requirePermission('campaigns.view'), validate({ query: campaignsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as CampaignsQuery;
    const data = await listCampaignsAdmin({ status: query.status }, getPagination(query));
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * Admin override actions: APPROVE / REJECT / PAUSE / RESUME / CANCEL / SUSPEND.
 * PAUSE / RESUME / CANCEL run through the owner-scoped transitions so the
 * escrow release and queue logic behaves exactly as for the advertiser.
 */
campaignRouter.post('/action', requirePermission('campaigns.manage'), validate({ body: adminCampaignActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof adminCampaignActionSchema>;
    const data = await adminCampaignAction(adminId(req), {
      campaignId: body.campaignId,
      action: body.action,
      note: body.note ?? undefined,
    });
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});
