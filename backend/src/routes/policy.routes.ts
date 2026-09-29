import { Router } from 'express';
import { z } from 'zod';
import { advertiserMetrics, publisherMetrics, metricBadge } from '../services/metrics.service';
import { checkWithdrawalLimits, withdrawalUsage } from '../services/payoutLimits.service';
import {
  listBlocklist,
  addBlocklistEntry,
  removeBlocklistEntry,
  blocklistSummary,
} from '../services/blocklist.service';
import {
  listCategoryPolicies,
  setCategoryPolicy,
  evaluateCampaignCategory,
} from '../services/categoryPolicy.service';
import { computeChannelHealth, refreshChannelHealth, refreshAllChannelHealth } from '../services/channelHealth.service';
import {
  listCreativeVersions,
  updateCreative,
  reviewCreativeVersion,
  pendingReviewVersions,
} from '../services/creative.service';
import { listHouseAds, upsertHouseAd, setHouseAdActive, houseAdStats, languageRuleNote } from '../services/houseAd.service';
import { houseFillStats } from '../services/houseDelivery.service';
import {
  listBlockedDomains,
  addBlockedDomain,
  removeBlockedDomain,
  validateDestinationUrl,
} from '../services/urlSecurity.service';
import { deliveryQueueStats, retryDeliveryJob } from '../services/delivery.service';
import { getDeliveryTimeline, recentDeliveryEvents, deliveryEventCounts } from '../services/deliveryEvent.service';
import { settleAllCpcPosts, cpcBillingSummary } from '../services/cpcBilling.service';
import { rewardEligibleReferrals, referralQueueStats } from '../services/referral.service';
import { requireAdmin, requirePermission, requireRole } from '../middleware/adminAuth';
import { limiters } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { getPagination } from '../utils/pagination';
import { NotFoundError, UnauthorizedError } from '../utils/errors';
import { prisma } from '../db/prisma';
import { assertChannelOwner } from '../services/channel.service';

/**
 * Policy, quality and finance-control endpoints.
 *
 * Split by audience: everything below requires a signed-in Telegram user, and the
 * sections marked ADMIN additionally require an active AdminUser row.
 */

export const policyRouter = Router();

function requireUser(req: { user?: { id: string } }) {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

/* ==================================================================
 *  METRICS — with provenance
 * ================================================================== */

/** GET /api/metrics/advertiser */
policyRouter.get('/metrics/advertiser', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const sets = await advertiserMetrics(user.id);
    res.json({
      ok: true,
      data: {
        ...sets,
        legend: {
          tracked: metricBadge('TRACKED'),
          reported: metricBadge('REPORTED'),
          estimated: metricBadge('ESTIMATED'),
        },
        note: 'Tracked figures are measured by BotFlow. Reported figures are what Telegram actually returned. Estimated figures are derived and are never presented as measured.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/metrics/publisher */
policyRouter.get('/metrics/publisher', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const sets = await publisherMetrics(user.id);
    res.json({
      ok: true,
      data: {
        ...sets,
        legend: {
          tracked: metricBadge('TRACKED'),
          reported: metricBadge('REPORTED'),
          estimated: metricBadge('ESTIMATED'),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ==================================================================
 *  PAYOUT LIMITS
 * ================================================================== */

/** GET /api/payout/limits — what the user may still withdraw today. */
policyRouter.get('/payout/limits', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await withdrawalUsage(user.id) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/payout/limits/check — pre-flight before a withdrawal is submitted. */
policyRouter.post(
  '/payout/limits/check',
  validate({ body: z.object({ amountCents: z.number().int().min(1) }) }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { amountCents } = req.body as { amountCents: number };
      res.json({ ok: true, data: await checkWithdrawalLimits(user.id, amountCents) });
    } catch (err) {
      next(err);
    }
  },
);

/* ==================================================================
 *  PUBLISHER BLOCKLIST
 * ================================================================== */

policyRouter.get('/channels/:id/blocklist', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await assertChannelOwner(user.id, req.params.id as string);
    res.json({
      ok: true,
      data: { entries: await listBlocklist(req.params.id as string), summary: await blocklistSummary(req.params.id as string) },
    });
  } catch (err) {
    next(err);
  }
});

policyRouter.post(
  '/channels/:id/blocklist',
  validate({
    body: z.object({
      scope: z.enum(['ADVERTISER', 'CAMPAIGN', 'CATEGORY', 'DOMAIN']),
      value: z.string().min(1).max(200),
      label: z.string().max(120).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const body = req.body as { scope: 'ADVERTISER' | 'CAMPAIGN' | 'CATEGORY' | 'DOMAIN'; value: string; label?: string };
      const entry = await addBlocklistEntry(user.id, {
        channelId: req.params.id as string,
        scope: body.scope,
        value: body.value,
        label: body.label,
      });
      res.json({ ok: true, data: entry });
    } catch (err) {
      next(err);
    }
  },
);

policyRouter.delete('/channels/:id/blocklist/:entryId', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await removeBlocklistEntry(user.id, req.params.entryId as string);
    res.json({ ok: true, data: { removed: true } });
  } catch (err) {
    next(err);
  }
});

/* ==================================================================
 *  CHANNEL HEALTH
 * ================================================================== */

policyRouter.get('/channels/:id/health', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await assertChannelOwner(user.id, req.params.id as string);
    res.json({ ok: true, data: await computeChannelHealth(req.params.id as string) });
  } catch (err) {
    next(err);
  }
});

policyRouter.post('/channels/:id/health/refresh', async (req, res, next) => {
  try {
    const user = requireUser(req);
    await assertChannelOwner(user.id, req.params.id as string);
    res.json({ ok: true, data: { healthStatus: await refreshChannelHealth(req.params.id as string) } });
  } catch (err) {
    next(err);
  }
});

/* ==================================================================
 *  CATEGORY POLICY (read by anyone; writes are admin-only)
 * ================================================================== */

policyRouter.get('/categories/policies', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await listCategoryPolicies() });
  } catch (err) {
    next(err);
  }
});

policyRouter.get('/categories/:category/policy', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await evaluateCampaignCategory(req.params.category as string) });
  } catch (err) {
    next(err);
  }
});

/* ==================================================================
 *  CREATIVE VERSIONING
 * ================================================================== */

policyRouter.get('/ads/:adId/versions', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const adId = req.params.adId as string;
    const ad = await prisma.ad.findUnique({
      where: { id: adId },
      select: { campaign: { select: { advertiserId: true } } },
    });
    // Same ownership convention as updateCreative: another advertiser's ad is
    // indistinguishable from a missing one (404, no existence oracle).
    if (!ad || ad.campaign.advertiserId !== user.id) throw new NotFoundError('Ad');
    res.json({ ok: true, data: await listCreativeVersions(adId) });
  } catch (err) {
    next(err);
  }
});

policyRouter.patch(
  '/ads/:adId/creative',
  limiters.createCampaign,
  validate({
    body: z.object({
      text: z.string().min(1).max(2000).optional(),
      imageUrl: z.string().url().nullable().optional(),
      buttonText: z.string().max(64).nullable().optional(),
      buttonUrl: z.string().url().nullable().optional(),
      destinationUrl: z.string().url().nullable().optional(),
      changeNote: z.string().max(300).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const result = await updateCreative(user.id, req.params.adId as string, req.body as never);
      res.json({
        ok: true,
        data: {
          ...result,
          note: result.requiresReview
            ? 'This campaign is already approved, so the change must be reviewed before it goes live. The current creative keeps running until then.'
            : 'Creative updated.',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ==================================================================
 *  URL CHECK — so the wizard can warn before submit
 * ================================================================== */

policyRouter.post(
  '/url/validate',
  validate({ body: z.object({ url: z.string().url() }) }),
  async (req, res, next) => {
    try {
      requireUser(req);
      const { url } = req.body as { url: string };
      res.json({ ok: true, data: await validateDestinationUrl(url) });
    } catch (err) {
      next(err);
    }
  },
);

/* ==================================================================
 *  ADMIN
 * ================================================================== */

const adminOps = Router();
adminOps.use(requireAdmin());
adminOps.use(limiters.admin);

/** GET /api/admin/ops/house-ads */
adminOps.get('/summary', requirePermission('dashboard.view'), async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      data: {
        delivery: await deliveryQueueStats(),
        house: await houseFillStats(),
        houseAds: await houseAdStats(),
        deliveryEvents: await deliveryEventCounts(24),
        creativeQueue: await pendingReviewVersions(),
        referrals: await referralQueueStats(),
      },
    });
  } catch (err) {
    next(err);
  }
});

adminOps.get('/house-ads', requirePermission('settings.manage'), async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { ads: await listHouseAds(false), languageRule: languageRuleNote() } });
  } catch (err) {
    next(err);
  }
});

adminOps.post(
  '/house-ads',
  requirePermission('settings.manage'),
  validate({
    body: z.object({
      code: z.string().max(64).optional(),
      title: z.string().min(3).max(200),
      body: z.string().min(3).max(2000),
      imageUrl: z.string().url().nullable().optional(),
      buttonText: z.string().max(64).nullable().optional(),
      buttonUrl: z.string().url().nullable().optional(),
      links: z.array(z.object({ label: z.string().max(60), url: z.string().url() })).optional(),
      weight: z.number().int().min(1).max(10).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      note: z.string().max(300).nullable().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      res.json({ ok: true, data: await upsertHouseAd(req.body as never) });
    } catch (err) {
      next(err);
    }
  },
);

adminOps.post(
  '/house-ads/:id/active',
  requirePermission('settings.manage'),
  validate({ body: z.object({ isActive: z.boolean() }) }),
  async (req, res, next) => {
    try {
      await setHouseAdActive(req.params.id as string, (req.body as { isActive: boolean }).isActive);
      res.json({ ok: true, data: { updated: true } });
    } catch (err) {
      next(err);
    }
  },
);

adminOps.get('/blocked-domains', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    res.json({ ok: true, data: await listBlockedDomains(getPagination(req.query as never)) });
  } catch (err) {
    next(err);
  }
});

adminOps.post(
  '/blocked-domains',
  requirePermission('settings.manage'),
  validate({
    body: z.object({
      domain: z.string().min(3).max(253),
      reason: z.string().max(300).optional(),
      hardBlock: z.boolean().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const admin = req.admin!;
      res.json({ ok: true, data: await addBlockedDomain(req.body as never, admin.id) });
    } catch (err) {
      next(err);
    }
  },
);

adminOps.delete('/blocked-domains/:id', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    await removeBlockedDomain(req.params.id as string, req.admin!.id);
    res.json({ ok: true, data: { removed: true } });
  } catch (err) {
    next(err);
  }
});

adminOps.post(
  '/categories/policies',
  requirePermission('settings.manage'),
  validate({
    body: z.object({
      category: z.string().min(2),
      policy: z.enum(['ALLOWED', 'REVIEW_REQUIRED', 'BLOCKED']),
      note: z.string().max(300).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const body = req.body as { category: never; policy: never; note?: string };
      res.json({
        ok: true,
        data: await setCategoryPolicy(body.category, body.policy, body.note, req.admin!.id),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminOps.post(
  '/creative-versions/:id/review',
  requirePermission('campaigns.manage'),
  validate({
    body: z.object({ action: z.enum(['APPROVE', 'REJECT']), note: z.string().max(300).optional() }),
  }),
  async (req, res, next) => {
    try {
      const body = req.body as { action: 'APPROVE' | 'REJECT'; note?: string };
      await reviewCreativeVersion(req.admin!.id, req.params.id as string, body.action, body.note);
      res.json({ ok: true, data: { reviewed: true } });
    } catch (err) {
      next(err);
    }
  },
);

adminOps.post('/health/refresh-all', requirePermission('delivery.manage'), async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { changed: await refreshAllChannelHealth() } });
  } catch (err) {
    next(err);
  }
});

adminOps.get('/delivery/:id/timeline', requirePermission('delivery.view'), async (req, res, next) => {
  try {
    res.json({ ok: true, data: await getDeliveryTimeline(req.params.id as string) });
  } catch (err) {
    next(err);
  }
});

adminOps.get('/delivery/events/recent', requirePermission('delivery.view'), async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await recentDeliveryEvents(100) });
  } catch (err) {
    next(err);
  }
});

adminOps.post('/delivery/:id/retry', requirePermission('delivery.manage'), async (req, res, next) => {
  try {
    await retryDeliveryJob(req.params.id as string);
    res.json({ ok: true, data: { retried: true } });
  } catch (err) {
    next(err);
  }
});

adminOps.post('/cpc/settle', requireRole('ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER'), async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { settled: await settleAllCpcPosts() } });
  } catch (err) {
    next(err);
  }
});

adminOps.get('/cpc/summary/:advertiserId', requirePermission('delivery.view'), async (req, res, next) => {
  try {
    res.json({ ok: true, data: await cpcBillingSummary(req.params.advertiserId as string) });
  } catch (err) {
    next(err);
  }
});

/**
 * Run the referral-reward sweep on demand. The scheduled job already does this
 * every 30 minutes; this exists so support can pay a specific referrer without
 * waiting, and so the outcome of a held reward can be explained.
 */
adminOps.post('/referrals/settle', requireRole('ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER'), async (_req, res, next) => {
  try {
    res.json({ ok: true, data: { rewarded: await rewardEligibleReferrals() } });
  } catch (err) {
    next(err);
  }
});

policyRouter.use('/admin/ops', adminOps);

/**
 * CPC billing note, surfaced in one place so the API documents the model.
 * A CPC post is charged on VALID tracked clicks (fraud-flagged clicks are
 * excluded) and settlement is idempotent per click count.
 */
export const cpcBillingNote =
  'CPC is billed on valid tracked clicks only. Settlement is idempotent per click count.';
