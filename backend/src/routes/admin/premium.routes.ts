import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requirePermission } from '../../middleware/adminAuth';
import { getPlanByCode, listPlans, setPlanActive, upsertPlan } from '../../services/premium.service';
import { recordAudit } from '../../services/audit.service';
import { adminUserId, respondOk } from './common';

export const planPremiumRouter = Router();

/**
 * Subscription plan management.
 *
 * Why this exists: `upsertPlan()` was written to be driven from the admin panel
 * ("pricing and perks change from the admin panel without a deploy") but no route
 * ever called it, so plans could only be created by the boot-time seeder. That
 * left the price and every benefit value unreachable without a database edit.
 *
 * A plan's `benefits` object holds entitlement overrides. Only the keys declared
 * by `Entitlements` are honoured, and a value whose type does not match the
 * baseline is ignored rather than corrupting the resolved entitlement set, so a
 * malformed benefit cannot widen someone's limits by accident.
 */
const planParams = z.object({ code: z.string().min(1).max(64) });

const planBody = z.object({
  code: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'Use A-Z, 0-9 and _ only'),
  name: z.string().min(2).max(120),
  // Send an empty string (not null) to clear this field — `PlanInput` is
  // `string | undefined` and maps a missing value to NULL itself.
  description: z.string().max(300).optional(),
  tier: z.enum(['FREE', 'PREMIUM', 'BUSINESS']).optional(),
  period: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).optional(),
  priceCents: z.number().int().min(0).max(100_000_000),
  durationDays: z.number().int().min(1).max(3650).optional(),
  benefits: z.record(z.string(), z.union([z.number().int(), z.boolean()])).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isFeatured: z.boolean().optional(),
  badgeText: z.string().max(40).optional(),
});

const activeBody = z.object({ isActive: z.boolean() });

/** Every plan, including disabled ones — admins need to see what is switched off. */
planPremiumRouter.get('/', requirePermission('settings.manage'), async (_req, res, next) => {
  try {
    respondOk(res, await listPlans(false));
  } catch (err) {
    next(err);
  }
});

planPremiumRouter.get(
  '/:code',
  requirePermission('settings.manage'),
  validate({ params: planParams }),
  async (req, res, next) => {
    try {
      respondOk(res, await getPlanByCode(req.params.code as string));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Create or update a plan. Upsert on `code`, so re-running an edit is safe.
 * Takes effect immediately: the next `entitlementsFor()` read picks it up.
 */
planPremiumRouter.post(
  '/',
  requirePermission('settings.manage'),
  validate({ body: planBody }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof planBody>;
      const { id } = await upsertPlan(body);

      await recordAudit({
        actorId: adminUserId(req),
        action: 'PREMIUM_PLAN_UPSERTED',
        targetType: 'SUBSCRIPTION_PLAN',
        targetId: id,
        newValue: {
          code: body.code,
          name: body.name,
          priceCents: body.priceCents,
          period: body.period ?? 'MONTHLY',
          benefits: body.benefits ?? {},
        },
      });

      respondOk(res, { id, code: body.code });
    } catch (err) {
      next(err);
    }
  },
);

/** Disable (or re-enable) a plan. A disabled plan can no longer be bought. */
planPremiumRouter.patch(
  '/:code/active',
  requirePermission('settings.manage'),
  validate({ params: planParams, body: activeBody }),
  async (req, res, next) => {
    try {
      const code = req.params.code as string;
      const { isActive } = req.body as z.infer<typeof activeBody>;
      await setPlanActive(code, isActive);

      await recordAudit({
        actorId: adminUserId(req),
        action: isActive ? 'PREMIUM_PLAN_ENABLED' : 'PREMIUM_PLAN_DISABLED',
        targetType: 'SUBSCRIPTION_PLAN',
        targetId: code,
        newValue: { isActive },
      });

      respondOk(res, { code, isActive });
    } catch (err) {
      next(err);
    }
  },
);
