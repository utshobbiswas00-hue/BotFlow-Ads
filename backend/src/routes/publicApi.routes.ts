import { Router } from 'express';
import { z } from 'zod';
import { conversionIngestSchema } from '@botflow/shared';
import type { ConversionInput, ConversionStatsRange } from '../services/conversion.service';
import { getConversionStats, recordConversion } from '../services/conversion.service';
import { prisma } from '../db/prisma';
import { apiKeyAuth, requireScope } from '../middleware/apiKeyAuth';
import { rateLimit } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';

/**
 * Public advertiser API — authenticated by API key, NOT by Telegram.
 *
 * Mounted at the app root (like trackRouter), so routes declare their full
 * `/api/v1/...` paths. Every route:
 *   1. rate-limits by client IP (public surface — the key is the only auth),
 *   2. authenticates with `apiKeyAuth` (sets req.apiKey),
 *   3. enforces the required scope with `requireScope`.
 *
 * Scope rule that keeps one advertiser from reading another: handlers may only
 * query with `req.apiKey.userId`. No handler below takes an advertiser id from
 * the client.
 */

export const publicApiRouter = Router();

/** Ingest is the expensive write path — a per-IP ceiling keeps one bad
 *  actor from flooding conversion rows for every advertiser. */
const ingestLimiter = rateLimit({ windowSeconds: 60, max: 120, prefix: 'rl:publicapi:ingest' });
/** Read endpoints — generous, but bounded. */
const readLimiter = rateLimit({ windowSeconds: 60, max: 240, prefix: 'rl:publicapi:read' });

const metricsQuerySchema = z.object({
  /** Inclusive ISO-8601 start. Omitted = all time. */
  from: z.coerce.date().optional(),
  /** Inclusive ISO-8601 end. Omitted = now. */
  to: z.coerce.date().optional(),
});

function requireApiKey(req: { apiKey?: { id: string; userId: string } }) {
  if (!req.apiKey) throw new UnauthorizedError('Missing API key.');
  return req.apiKey;
}

/**
 * POST /api/v1/conversions — report a conversion (WRITE scope).
 *
 * Idempotent: the same event (same dedupeKey, or same slug/clickId + eventName
 * within the same minute) returns 200 with `duplicate: true` and the original
 * row, instead of creating a second one. A genuinely new conversion returns 201.
 */
publicApiRouter.post(
  '/api/v1/conversions',
  ingestLimiter,
  apiKeyAuth,
  requireScope('WRITE'),
  validate({ body: conversionIngestSchema }),
  async (req, res, next) => {
    try {
      const apiKey = requireApiKey(req);
      const result = await recordConversion(req.body as unknown as ConversionInput, {
        apiKeyId: apiKey.id,
        advertiserId: apiKey.userId,
        source: 'postback',
      });
      res.status(result.duplicate ? 200 : 201).json({ ok: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/campaigns — the key owner's own campaigns (READ scope).
 *
 * A deliberately narrow select: no targeting JSON, no plan snapshots — the
 * public surface returns what an integrator needs to reconcile, nothing that
 * one other advertiser could misuse.
 */
publicApiRouter.get(
  '/api/v1/campaigns',
  readLimiter,
  apiKeyAuth,
  requireScope('READ'),
  async (req, res, next) => {
    try {
      const apiKey = requireApiKey(req);
      const campaigns = await prisma.campaign.findMany({
        where: { advertiserId: apiKey.userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          name: true,
          status: true,
          pricingModel: true,
          budgetTotalCents: true,
          budgetSpentCents: true,
          startAt: true,
          endAt: true,
          createdAt: true,
        },
      });
      res.json({ ok: true, data: { campaigns } });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/metrics?from=&to= — the key owner's attributed conversions
 * (READ scope): totals and per-campaign groups, straight from stored
 * ConversionEvent rows. Zeros until a conversion actually exists — nothing
 * estimated, nothing invented.
 */
publicApiRouter.get(
  '/api/v1/metrics',
  readLimiter,
  apiKeyAuth,
  requireScope('READ'),
  validate({ query: metricsQuerySchema }),
  async (req, res, next) => {
    try {
      const apiKey = requireApiKey(req);
      const range = req.query as unknown as ConversionStatsRange;
      const stats = await getConversionStats(apiKey.userId, range);
      res.json({ ok: true, data: { conversions: stats, range: { from: range.from ?? null, to: range.to ?? null } } });
    } catch (err) {
      next(err);
    }
  },
);
