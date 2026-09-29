import { Router } from 'express';
import {
  allBenefits,
  advertiserBenefits,
  publisherBenefits,
  publisherEarningsTable,
  quickEarningsMilestones,
} from '../services/benefits.service';
import { getSlotMix, explainSlotMix } from '../services/slotPlanner.service';
import { cpmEarningsSummary } from '../services/cpmPayout.service';
import { entitlementsFor, describeEntitlement, BENEFIT_LABELS } from '../services/premium.service';
import type { Entitlements } from '../services/premium.service';

/**
 * "What does this platform give me?"
 *
 * Every figure is read from the same settings the billing code uses, so the app
 * can never advertise a rate the backend will not honour. The publisher section
 * states the $1.80-per-1,000-views promise, and the advertiser section states
 * what a budget buys in REACH — two different numbers that must never be
 * presented as the same thing.
 */

export const benefitsRouter = Router();

/** GET /api/benefits — everything a Benefits page needs, in one request. */
benefitsRouter.get('/benefits', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await allBenefits() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/benefits/publisher */
benefitsRouter.get('/benefits/publisher', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await publisherBenefits() });
  } catch (err) {
    next(err);
  }
});

/** GET /api/benefits/advertiser */
benefitsRouter.get('/benefits/advertiser', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await advertiserBenefits() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/benefits/earnings-table
 * The "$1.80 per 1,000 views" table: 1,000 -> $1.80, 25,000 -> $45.00, ...
 */
benefitsRouter.get('/benefits/earnings-table', async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      data: {
        table: await publisherEarningsTable(),
        milestones: await quickEarningsMilestones(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/benefits/slot-mix — how paid and house slots are split. */
benefitsRouter.get('/benefits/slot-mix', async (_req, res, next) => {
  try {
    const mix = await getSlotMix();
    res.json({ ok: true, data: explainSlotMix(mix) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/benefits/me
 * The signed-in user's own numbers: what they earn per 1,000 views, how many
 * posts could not be measured, and which premium perks they currently hold.
 */
benefitsRouter.get('/benefits/me', async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Open the app from Telegram.' } });
      return;
    }

    const [summary, entitlements] = await Promise.all([
      cpmEarningsSummary(req.user.id),
      entitlementsFor(req.user.id),
    ]);

    const perks = (Object.keys(BENEFIT_LABELS) as Array<keyof Entitlements>).map((key) => ({
      key,
      label: BENEFIT_LABELS[key],
      value: entitlements[key],
      display: describeEntitlement(key, entitlements[key]),
    }));

    res.json({ ok: true, data: { earnings: summary, perks } });
  } catch (err) {
    next(err);
  }
});
