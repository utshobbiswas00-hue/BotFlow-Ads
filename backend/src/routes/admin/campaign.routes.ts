import { Router } from 'express';
import { CampaignStatus } from '@prisma/client';
import { adminCampaignActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { CAMPAIGN_SORT_KEYS, adminCampaignAction, listCampaignsAdmin } from '../../services/admin.service';
import { requirePermission } from '../../middleware/adminAuth';
import { AppError } from '../../utils/errors';
import { adminId, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const campaignRouter = Router();

/**
 * Optional date window (§79). `z.coerce.date()` matches the audit-log query in
 * settings.routes.ts. `from` is inclusive, `to` is exclusive.
 */
const dateRangeQuery = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/** A backwards window (`from > to`) is a client mistake → 400. */
function assertDateRange(q: { from?: Date; to?: Date }): void {
  if (q.from && q.to && q.from > q.to) {
    throw new AppError('`from` must be earlier than or equal to `to`', 400);
  }
}

const campaignsQuery = paginationSchema.extend({
  status: z.nativeEnum(CampaignStatus).optional(),
  ...dateRangeQuery,
  // Whitelisted sort keys; `listCampaignsAdmin` maps each key to an explicit
  // Prisma orderBy, so a client string never reaches the query builder (§79).
  sort: z.enum(CAMPAIGN_SORT_KEYS).optional(),
});

type CampaignsQuery = z.infer<typeof campaignsQuery>;

/**
 * All campaigns (admin view), newest first by default, optionally filtered by
 * status and a `from`/`to` window on `createdAt` (§79). `sort` reorders within
 * the whitelist.
 */
campaignRouter.get('/', requirePermission('campaigns.view'), validate({ query: campaignsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as CampaignsQuery;
    assertDateRange(query);
    const data = await listCampaignsAdmin(
      { status: query.status, from: query.from, to: query.to, sort: query.sort },
      getPagination(query),
    );
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
