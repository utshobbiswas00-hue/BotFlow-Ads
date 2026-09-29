/**
 * BOTFLOW ADS — BullMQ WORKER process entry point.
 *
 * A separate, always-on service (`npm run worker`). The Express API only
 * PRODUCES jobs; every delayed and recurring piece of work executes here:
 *
 *   delivery      — publish sponsored posts to Telegram
 *   scheduler     — sweep due jobs, start & expire campaigns
 *   permission    — re-verify bot rights in publisher channels
 *   stats         — channel stat refresh + post view sync
 *   payout        — release matured earnings, daily revenue snapshot
 *   withdrawal    — auto-approve or page admins for withdrawals
 *   fraud         — click-pattern scan, user risk recalculation
 *   notification  — Telegram fan-out, email, admin alerts
 *   webhook       — outbound advertiser webhooks (signed HTTP + retries)
 *   cleanup       — purge old clicks / stale jobs / webhook deliveries, balance audit
 *
 * All recurring schedules are BullMQ repeatable jobs registered in
 * `queues/queue.ts` — this process never uses setTimeout / setInterval /
 * node-cron for scheduling.
 */
import { childLogger, logger } from '../config/logger';
import { prisma } from '../db/prisma';
import { gracefulRedisShutdown } from '../db/redis';
import { closeQueues, getQueueHealth, registerRepeatableJobs } from '../queues/queue';
import { closeAllWorkers } from './registry';

// Side-effect imports: each module constructs and registers its Worker.
import './delivery.worker';
import './scheduler.worker';
import './permission.worker';
import './stats.worker';
import './payout.worker';
import './withdrawal.worker';
import './fraud.worker';
import './notification.worker';
import './webhook.worker';
import './cleanup.worker';

const log = childLogger('workers');

async function bootstrap(): Promise<void> {
  // Recurring safety-net schedules (idempotent jobIds — re-runs are safe).
  await registerRepeatableJobs();

  // Startup banner with a live view of every queue.
  const health = await getQueueHealth();
  const queueLines = health.map(
    (h) =>
      `  ${h.name.padEnd(24)} waiting=${h.waiting} active=${h.active} delayed=${h.delayed} failed=${h.failed} completed=${h.completed}`,
  );

  logger.info(
    { queueHealth: health, pid: process.pid, node: process.version, env: process.env.NODE_ENV },
    [
      '============================================================',
      '  BOTFLOW ADS — BULLMQ WORKER',
      `  pid: ${process.pid}   node: ${process.version}   env: ${process.env.NODE_ENV}`,
      '  queues:',
      ...queueLines,
      '============================================================',
    ].join('\n'),
  );
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutdown signal received');

  try {
    // 1. Stop workers first so no new jobs start while we tear down.
    await closeAllWorkers();
    // 2. Close the producer-side queue instances + shared producer connection.
    await closeQueues();
    // 3. Quit the shared Redis client.
    await gracefulRedisShutdown();
    // 4. Release the Prisma pool.
    await prisma.$disconnect();
    log.info('graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during graceful shutdown — forcing exit');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection — exiting');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});

bootstrap().catch((err) => {
  logger.fatal({ err }, 'worker bootstrap failed');
  process.exit(1);
});
