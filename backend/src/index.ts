import http from 'node:http';
import { env } from './config/env';
import { logger } from './config/logger';
import { createApp } from './app';
import { prisma } from './db/prisma';
import { redis, pingRedis, gracefulRedisShutdown } from './db/redis';
import { closeQueues } from './queues/queue';
import { setupWebhook } from './bot/webhook';
import { configureBotCommands, startBotPolling } from './bot/bot';
import { seedDefaultPlans } from './services/premium.service';

/**
 * BotFlow Ads — API process entry point.
 *
 * Boot sequence:
 *   1. Verify the database (hard dependency — exit if unreachable).
 *   2. Verify Redis (soft dependency — log loudly and continue; the
 *      rate limiter fails open and queues retry once Redis returns).
 *   3. Start the HTTP server (bound to 0.0.0.0 — Render requirement).
 *   4. Register the Telegram bot: webhook in production, long polling
 *      everywhere else.
 *   5. Graceful shutdown on SIGTERM/SIGINT (Render sends SIGTERM on
 *      every deploy/scale-down; the container must drain, not die).
 */

async function verifyInfrastructure(): Promise<void> {
  // Database — the API is useless without it, so this is fatal.
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info('database connection verified at boot');
  } catch (err) {
    logger.error({ err }, 'FATAL: database unreachable at boot — exiting');
    process.exit(1);
  }

  // Redis — a degradation, not a death. Say it LOUDLY so ops notice.
  if (await pingRedis()) {
    logger.info('redis connection verified at boot');
  } else {
    logger.error(
      'REDIS UNAVAILABLE AT BOOT — continuing anyway. Rate limiting, idempotency ' +
        'locks and BullMQ producers are degraded until Redis recovers; queued ' +
        'work (ad delivery) will be delayed.',
    );
  }
}

/** Stop accepting connections and resolve when the last request finishes. */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

let shuttingDown = false;

async function shutdown(signal: string, server: http.Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');

  // Hard deadline — a stuck dependency must not hold the container past
  // Render's 30-second kill window.
  const deadline = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 20_000);
  deadline.unref();

  try {
    // 1. Stop accepting new connections; let in-flight requests finish.
    await closeServer(server);
    // 2. Drain BullMQ producers (queues live on in the worker service).
    await closeQueues();
    // 3. Close the shared Redis connection.
    await gracefulRedisShutdown();
    // 4. Disconnect Prisma.
    await prisma.$disconnect();
    logger.info('graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during graceful shutdown — forcing exit');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await verifyInfrastructure();

  // Seed the default membership plans so the Premium page has something to sell.
  // Best-effort and non-fatal: if the table is briefly unavailable the API must
  // still boot, and the daily worker sweep (or the next boot) will create them.
  try {
    const created = await seedDefaultPlans();
    if (created > 0) {
      logger.info({ created }, 'seeded default premium plans');
    } else {
      logger.info('default premium plans already present — nothing seeded');
    }
  } catch (err) {
    logger.error({ err }, 'CRITICAL: failed to seed default premium plans — continuing without them');
  }

  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0 is REQUIRED on Render — binding the loopback makes the
    // platform's health probes and ingress traffic unreachable.
    server.listen(env.PORT, '0.0.0.0', () => {
      logger.info(
        { port: env.PORT, env: env.NODE_ENV, redisStatus: redis.status },
        'API server listening',
      );
      resolve();
    });
  });

  // Telegram bot — webhook in production, long polling in development.
  if (env.TELEGRAM_BOT_TOKEN) {
    if (env.NODE_ENV === 'production') {
      try {
        await setupWebhook();
        await configureBotCommands();
        logger.info({ url: `${env.APP_URL}/webhook/telegram` }, 'telegram webhook registered');
      } catch (err) {
        // Keep serving the API — bot updates can be re-registered on the
        // next deploy; log loud so a dead webhook is not invisible.
        logger.error({ err }, 'CRITICAL: failed to register telegram webhook');
      }
    } else {
      void startBotPolling().catch((err) => logger.error({ err }, 'telegram long polling failed'));
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN is not set — bot updates and initData auth are disabled');
  }

  // Render sends SIGTERM on every deploy and scale-down; local Ctrl-C sends
  // SIGINT. Both must drain the server instead of being killed mid-request.
  process.on('SIGTERM', () => void shutdown('SIGTERM', server));
  process.on('SIGINT', () => void shutdown('SIGINT', server));
}

// Process-level guards — a stray rejection must not kill the API.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection — continuing');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — process state is unknown, exiting');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'failed to start the API');
  process.exit(1);
});
