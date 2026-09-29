import { Router } from 'express';
import { z } from 'zod';
import {
  activeSubscription,
  cancelSubscription,
  checkQuota,
  describeEntitlement,
  entitlementsFor,
  listPlans,
  purchaseSubscription,
  BENEFIT_LABELS,
} from '../services/premium.service';
import type { Entitlements } from '../services/premium.service';
import { getBoolSetting } from '../services/settings.service';
import { SETTING_KEYS } from '../config/constants';
import { limiters } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';

/**
 * PREMIUM MEMBERSHIP
 *
 * Upgrade, see what you get, cancel. The plan list is data-driven, so an admin
 * can add a tier or change a perk without a deploy.
 */

export const premiumRouter = Router();

const subscribeSchema = z.object({
  planCode: z.string().min(1).max(64),
  /**
   * Unique reference from the payment that funded this purchase. The backend is
   * idempotent on it, so a retried request cannot grant a second term.
   */
  paymentReference: z.string().min(6).max(128),
});

const cancelSchema = z.object({
  reason: z.string().max(300).optional(),
});

function requireUser(req: { user?: { id: string } }) {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

/** GET /api/premium/plans — the pricing page. */
premiumRouter.get('/premium/plans', async (req, res, next) => {
  try {
    const enabled = await getBoolSetting(SETTING_KEYS.PREMIUM_ENABLED, true);
    const plans = await listPlans();

    // Render-ready rows so the client never has to know the benefit shape.
    const withPerks = plans.map((plan) => {
      const benefits = (plan.benefits ?? {}) as Partial<Entitlements>;
      return {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        tier: plan.tier,
        period: plan.period,
        priceCents: plan.priceCents,
        currency: plan.currency,
        durationDays: plan.durationDays,
        isFeatured: plan.isFeatured,
        badgeText: plan.badgeText,
        perks: (Object.keys(benefits) as Array<keyof Entitlements>)
          .filter((key) => key in BENEFIT_LABELS)
          .map((key) => ({
            key,
            label: BENEFIT_LABELS[key],
            value: benefits[key],
            display: describeEntitlement(key, benefits[key] as number | boolean),
          })),
      };
    });

    let current: Awaited<ReturnType<typeof activeSubscription>> = null;
    let entitlements: Entitlements | null = null;
    if (req.user) {
      [current, entitlements] = await Promise.all([
        activeSubscription(req.user.id),
        entitlementsFor(req.user.id),
      ]);
    }

    res.json({
      ok: true,
      data: {
        enabled,
        plans: withPerks,
        current: current
          ? { code: current.plan.code, name: current.plan.name, expiresAt: current.expiresAt, autoRenew: current.autoRenew }
          : null,
        entitlements,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/premium/me — my membership and current limits. */
premiumRouter.get('/premium/me', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [sub, entitlements, channels, campaigns] = await Promise.all([
      activeSubscription(user.id),
      entitlementsFor(user.id),
      checkQuota(user.id, 'channels'),
      checkQuota(user.id, 'activeCampaigns'),
    ]);

    res.json({
      ok: true,
      data: {
        subscription: sub
          ? {
              id: sub.id,
              code: sub.plan.code,
              name: sub.plan.name,
              tier: sub.tier,
              startedAt: sub.startedAt,
              expiresAt: sub.expiresAt,
              autoRenew: sub.autoRenew,
            }
          : null,
        tier: sub?.tier ?? 'FREE',
        entitlements,
        quotas: { channels, campaigns },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/premium/entitlements — the caller's resolved limits plus their active
 * plan tier and expiry, so the client can render "your current limits" and gate
 * upgrade prompts without reconstructing the merge from the plan list.
 */
premiumRouter.get('/premium/entitlements', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [sub, entitlements] = await Promise.all([
      activeSubscription(user.id),
      entitlementsFor(user.id),
    ]);

    res.json({
      ok: true,
      data: {
        tier: sub?.tier ?? 'FREE',
        planCode: sub?.plan.code ?? null,
        planName: sub?.plan.name ?? null,
        expiresAt: sub?.expiresAt ?? null,
        entitlements,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/premium/subscribe */
premiumRouter.post(
  '/premium/subscribe',
  limiters.deposit,
  validate({ body: subscribeSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const body = req.body as z.infer<typeof subscribeSchema>;

      const result = await purchaseSubscription({
        userId: user.id,
        planCode: body.planCode,
        paymentReference: body.paymentReference,
      });

      const entitlements = await entitlementsFor(user.id);

      res.json({
        ok: true,
        data: {
          subscriptionId: result.subscriptionId,
          expiresAt: result.expiresAt,
          // true when this exact payment had already been applied
          replayed: result.replayed,
          entitlements,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/premium/cancel — stops auto-renew; the term is honoured to the end. */
premiumRouter.post(
  '/premium/cancel',
  validate({ body: cancelSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const body = req.body as z.infer<typeof cancelSchema>;
      await cancelSubscription(user.id, body.reason);

      res.json({
        ok: true,
        data: {
          cancelled: true,
          note: 'Auto-renew is off. Your benefits continue until the current term ends.',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
