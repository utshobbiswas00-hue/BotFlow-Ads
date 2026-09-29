import { Router } from 'express';
import { prisma } from '../db/prisma';
import { pingRedis } from '../db/redis';
import { getQueueHealth } from '../queues/queue';
import { logger } from '../config/logger';
import { telegramAuth } from '../middleware/telegramAuth';
import { requireAdmin } from '../middleware/adminAuth';

/**
 * Public health endpoints (NO auth) — consumed by Render uptime probes and
 * the admin dashboard. Mounted directly on the app, outside /api (see app.ts).
 *
 *   GET /health          → process + infrastructure status
 *   GET /health/queues   → BullMQ job counts per queue
 */

// Kept in sync with backend/package.json. Importing that file directly
// would break the `rootDir: ./src` TypeScript configuration (TS6059).
const VERSION = '1.0.0';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const [dbUp, redisUp] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch((err) => {
        logger.error({ err }, 'health check: database probe failed');
        return false;
      }),
    pingRedis(),
  ]);

  const checks = {
    database: dbUp ? ('up' as const) : ('down' as const),
    redis: redisUp ? ('up' as const) : ('down' as const),
  };

  // 200 while the database is reachable, 503 when it is down.
  // A Redis outage alone is NOT a service outage — rate limiting,
  // idempotency and queues all fail open / retry (see middleware/rateLimit.ts).
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'error',
    uptime: process.uptime(),
    version: VERSION,
    checks,
  });
});

// Operational state (live job counts per queue) — admin only. The public probe
// above stays unauthenticated; this one does not leak queue internals.
healthRouter.get(
  '/queues',
  telegramAuth({ autoProvision: false, requireActive: true }),
  requireAdmin(),
  async (_req, res, next) => {
    try {
      res.json({ ok: true, data: await getQueueHealth() });
    } catch (err) {
      next(err);
    }
  },
);
