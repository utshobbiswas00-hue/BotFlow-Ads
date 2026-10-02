import { Router } from 'express';
import { getBotSelf } from '../../bot/api';
import { prisma } from '../../db/prisma';
import { pingRedis } from '../../db/redis';
import { getQueueHealth } from '../../queues/queue';
import { requirePermission } from '../../middleware/adminAuth';
import {
  botStatus,
  queueStatus,
  webhookStatus,
  withTimeout,
  type SubsystemStatus,
} from './systemStatus.helpers';
import { respondOk } from './common';

/**
 * Admin "system status" board (spec §27, §28, §83).
 *
 * Mounted by the caller at `/api/admin/system`. Read-only, `dashboard.view`.
 *
 * Design rules that keep this endpoint safe to poll:
 *  - every probe is wrapped (`Promise.allSettled`) so ONE failing dependency can
 *    never fail the whole response — a dead Redis must not blank out the page;
 *  - every probe has its own try/catch AND a short timeout, so a hung dependency
 *    degrades to UNKNOWN/OFFLINE instead of holding the request open;
 *  - `detail` is always a short, safe, human sentence. No secret, no connection
 *    string, and no raw error text ever reaches the client;
 *  - NO live Telegram API call: the bot probe only reads grammY's cached
 *    identity (see `probeTelegramBot`).
 */

export const systemStatusRouter = Router();

systemStatusRouter.use(requirePermission('dashboard.view'));

/** Upper bound for a single probe. A status page must answer, not hang. */
const PROBE_TIMEOUT_MS = 2_000;

const checkedAt = (): string => new Date().toISOString();

/** The API itself: if this handler is running, it is by definition answering. */
function probeApi(): Promise<SubsystemStatus> {
  return Promise.resolve({
    name: 'api',
    status: 'ONLINE',
    detail: 'API process is answering admin requests.',
    checkedAt: checkedAt(),
  });
}

/** PostgreSQL — a single `SELECT 1`. The error is swallowed, never echoed. */
async function probeDatabase(): Promise<SubsystemStatus> {
  try {
    await withTimeout<unknown>(prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, null);
    return { name: 'database', status: 'ONLINE', detail: 'Database answered a SELECT 1 probe.', checkedAt: checkedAt() };
  } catch {
    return { name: 'database', status: 'OFFLINE', detail: 'Database did not answer a SELECT 1 probe.', checkedAt: checkedAt() };
  }
}

/** Redis — `PING` via the shared helper (which never throws). */
async function probeRedis(): Promise<SubsystemStatus> {
  try {
    const up = await withTimeout(pingRedis(), PROBE_TIMEOUT_MS, false);
    return up
      ? { name: 'redis', status: 'ONLINE', detail: 'Redis answered a PING with PONG.', checkedAt: checkedAt() }
      : { name: 'redis', status: 'OFFLINE', detail: 'Redis did not answer a PING.', checkedAt: checkedAt() };
  } catch {
    return { name: 'redis', status: 'OFFLINE', detail: 'Redis probe failed.', checkedAt: checkedAt() };
  }
}

/**
 * BullMQ queues. Redis is checked first: with Redis down, `getQueueHealth()`
 * would block (BullMQ queues its commands), so we short-circuit to OFFLINE
 * rather than paying the timeout.
 */
async function probeQueues(): Promise<SubsystemStatus> {
  try {
    const redisUp = await withTimeout(pingRedis(), PROBE_TIMEOUT_MS, false);
    if (!redisUp) {
      return { name: 'queues', ...queueStatus(false, []), checkedAt: checkedAt() };
    }
    const health = await withTimeout(getQueueHealth(), PROBE_TIMEOUT_MS, null);
    if (!health) {
      return { name: 'queues', status: 'UNKNOWN', detail: 'Queue health did not respond in time.', checkedAt: checkedAt() };
    }
    return { name: 'queues', ...queueStatus(true, health), checkedAt: checkedAt() };
  } catch {
    return { name: 'queues', status: 'UNKNOWN', detail: 'Queue health probe failed.', checkedAt: checkedAt() };
  }
}

/**
 * Telegram bot — read grammY's CACHED identity only.
 *
 * `getBotSelf()` (backend/src/bot/api.ts) caches `getMe()` for the life of the
 * process and returns `null` instead of throwing, so:
 *   - we never call `tgApi.getMe()` directly from a status endpoint;
 *   - after the first successful call the value is a pure in-memory read (at most
 *     one live call per process), so polling the board cannot rate-limit the bot.
 * A cold cache is still raced against a short timeout, and an unresolved identity
 * degrades to UNKNOWN rather than blocking the page.
 */
async function probeTelegramBot(): Promise<SubsystemStatus> {
  try {
    const self = await withTimeout(getBotSelf(), PROBE_TIMEOUT_MS, null);
    return { name: 'telegramBot', ...botStatus(self), checkedAt: checkedAt() };
  } catch {
    return { name: 'telegramBot', status: 'UNKNOWN', detail: 'Telegram bot probe failed.', checkedAt: checkedAt() };
  }
}

/**
 * Advertiser webhooks — recent `WebhookDelivery` rows grouped by status (last
 * 24h). DEGRADED when any recent delivery failed (FAILED or EXHAUSTED).
 *
 * COST: one grouped scan over `webhook_deliveries` restricted to the last 24h,
 * served by `@@index([endpointId, createdAt])`... which does not cover
 * `created_at` alone. On a large table add `@@index([createdAt])` (or
 * `@@index([status, createdAt])`) so the window is an index range, not a scan.
 */
async function probeWebhook(): Promise<SubsystemStatus> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const groups = await withTimeout(
      prisma.webhookDelivery.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      PROBE_TIMEOUT_MS,
      null,
    );
    if (!groups) {
      return { name: 'webhook', status: 'UNKNOWN', detail: 'Webhook delivery counts did not respond in time.', checkedAt: checkedAt() };
    }

    let total = 0;
    let failed = 0;
    for (const group of groups) {
      const count = group._count._all;
      total += count;
      if (group.status === 'FAILED' || group.status === 'EXHAUSTED') failed += count;
    }

    return { name: 'webhook', ...webhookStatus({ total, failed }), checkedAt: checkedAt() };
  } catch {
    return { name: 'webhook', status: 'UNKNOWN', detail: 'Webhook delivery probe failed.', checkedAt: checkedAt() };
  }
}

/**
 * GET / — the health of every subsystem.
 *
 * Response: `{ ok: true, data: [{ name, status, detail, checkedAt }] }`.
 * Each probe is independent; `Promise.allSettled` means a thrown probe yields a
 * UNKNOWN tile instead of a 500 for the whole board.
 */
systemStatusRouter.get('/', async (_req, res, next) => {
  try {
    const names = ['api', 'database', 'redis', 'queues', 'telegramBot', 'webhook'] as const;
    const settled = await Promise.allSettled([
      probeApi(),
      probeDatabase(),
      probeRedis(),
      probeQueues(),
      probeTelegramBot(),
      probeWebhook(),
    ]);

    const subsystems: SubsystemStatus[] = settled.map((result, index) =>
      result.status === 'fulfilled'
        ? result.value
        : { name: names[index], status: 'UNKNOWN', detail: 'Probe did not complete.', checkedAt: checkedAt() },
    );

    respondOk(res, subsystems);
  } catch (err) {
    next(err);
  }
});
