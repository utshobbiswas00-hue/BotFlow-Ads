import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { campaignTargetingSchema, channelCategorySchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { listMarketplace, type MarketplaceFilter } from '../services/channel.service';
import { estimateCampaignCost, countMatchingChannels } from '../services/targeting.service';

/**
 * Advertiser-facing marketplace: browse deliverable channels and get a
 * cost estimate BEFORE creating a campaign. The estimate uses the exact
 * same resolution path as the charge, so the quoted price is the real price.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const browseQuery = z.object({
  category: channelCategorySchema.optional(),
  country: z.string().length(2).optional(),
  language: z.string().min(2).max(8).optional(),
  minSubs: z.coerce.number().int().min(0).optional(),
  maxSubs: z.coerce.number().int().min(0).optional(),
  minViews: z.coerce.number().int().min(0).optional(),
  search: z.string().max(100).optional(),
  // Extended filters the service already supports. Without them declared here
  // `validate()` strips the keys and the service never sees them, so the UI's
  // price/pricing-model/sort controls silently return unfiltered results.
  minPriceCents: z.coerce.number().int().min(0).optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  pricingModel: z.enum(['FIXED', 'CPM', 'CPC', 'HYBRID']).optional(),
  sort: z
    .enum(['reach_desc', 'subscribers_desc', 'price_asc', 'price_desc', 'quality_desc'])
    .default('reach_desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const estimateBody = z.object({
  isAutoTargeting: z.boolean().default(false),
  targeting: campaignTargetingSchema.default({} as never),
  channelIds: z.array(z.string()).default([]),
  budgetCents: z.number().int().min(0).default(0),
  frequencyPerChannel: z.number().int().min(1).max(3).default(1),
});

export const marketplaceRouter = Router();

/** GET /api/marketplace — browse approved, deliverable channels. */
marketplaceRouter.get('/marketplace', validate({ query: browseQuery }), async (req, res, next) => {
  try {
    requireUser(req);
    const q = req.validated?.query as z.infer<typeof browseQuery>;
    const filter: MarketplaceFilter = {
      category: q.category,
      country: q.country,
      language: q.language,
      minSubs: q.minSubs,
      maxSubs: q.maxSubs,
      minViews: q.minViews,
      search: q.search,
      minPriceCents: q.minPriceCents,
      maxPriceCents: q.maxPriceCents,
      pricingModel: q.pricingModel,
      sort: q.sort,
    };
    res.json({ ok: true, data: await listMarketplace(filter, getPagination(q)) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/marketplace/estimate — campaign-wizard cost preview. */
marketplaceRouter.post('/marketplace/estimate', validate({ body: estimateBody }), async (req, res, next) => {
  try {
    requireUser(req);
    const body = req.body as z.infer<typeof estimateBody>;

    const [estimate, matches] = await Promise.all([
      estimateCampaignCost({
        isAutoTargeting: body.isAutoTargeting,
        channelIds: body.channelIds,
        filter: body.targeting,
        budgetCents: body.budgetCents,
        frequencyPerChannel: body.frequencyPerChannel,
      }),
      countMatchingChannels(body.targeting),
    ]);

    res.json({
      ok: true,
      data: {
        channels: estimate.channels,
        totalCostCents: estimate.totalCostCents,
        avgPriceCents: estimate.avgPriceCents,
        totalReach: estimate.totalReach,
        matches,
      },
    });
  } catch (err) {
    next(err);
  }
});
