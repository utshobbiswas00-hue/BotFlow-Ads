import { Queue, type JobsOptions, type QueueOptions } from 'bullmq';
import type Redis from 'ioredis';
import { createQueueConnection } from '../db/redis';
import { QUEUE_NAMES } from './names';
import { logger } from '../config/logger';

/**
 * BullMQ producers.
 *
 * Producers share a single Redis connection; each Worker opens its own
 * (BullMQ blocks on a dedicated connection, which would stall a shared one).
 *
 * Why a queue at all: Render web services sleep when idle, so delivery MUST
 * NOT depend on an in-process timer. Scheduled work is expressed as a delayed
 * BullMQ job and executed by the always-on worker service.
 */

let producerConnection: Redis | null = null;

function connection(): Redis {
  if (!producerConnection) {
    producerConnection = createQueueConnection('botflow-producer');
    producerConnection.on('error', (err) => logger.error({ err: err.message }, 'producer redis error'));
  }
  return producerConnection;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

function makeQueue(name: string, overrides: Partial<QueueOptions> = {}): Queue {
  return new Queue(name, {
    connection: connection(),
    defaultJobOptions,
    ...overrides,
  });
}

/* ------------------------------------------------------------------
 *  Queue instances
 * ------------------------------------------------------------------ */

export const deliveryQueue = makeQueue(QUEUE_NAMES.DELIVERY, {
  defaultJobOptions: {
    ...defaultJobOptions,
    // Publishing is user-visible: retry harder, but never infinitely.
    attempts: 4,
    backoff: { type: 'exponential', delay: 10_000 },
  },
});

export const schedulerQueue = makeQueue(QUEUE_NAMES.SCHEDULER);
export const permissionQueue = makeQueue(QUEUE_NAMES.PERMISSION);
export const statsQueue = makeQueue(QUEUE_NAMES.STATS);
export const payoutQueue = makeQueue(QUEUE_NAMES.PAYOUT);
export const withdrawalQueue = makeQueue(QUEUE_NAMES.WITHDRAWAL);
export const fraudQueue = makeQueue(QUEUE_NAMES.FRAUD);
export const notificationQueue = makeQueue(QUEUE_NAMES.NOTIFICATION);
export const cleanupQueue = makeQueue(QUEUE_NAMES.CLEANUP);

export const webhookQueue = makeQueue(QUEUE_NAMES.WEBHOOK, {
  defaultJobOptions: {
    ...defaultJobOptions,
    // A subscriber's endpoint is outside our control and its handler may be slow.
    // Retries are longer-lived than a Telegram push, which we only try a few times.
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 20_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 20_000 },
  },
});

export const ALL_QUEUES: Queue[] = [
  deliveryQueue,
  schedulerQueue,
  permissionQueue,
  statsQueue,
  payoutQueue,
  withdrawalQueue,
  fraudQueue,
  notificationQueue,
  cleanupQueue,
  webhookQueue,
];

export function getQueue(name: string): Queue {
  const found = ALL_QUEUES.find((q) => q.name === name);
  if (!found) throw new Error(`Unknown queue: ${name}`);
  return found;
}

/**
 * Register the recurring safety-net schedules.
 * These are NOT the primary mechanism — delayed jobs do the precise work.
 * They exist so a missed or lost job is always eventually picked up.
 */
export async function registerRepeatableJobs(): Promise<void> {
  const repeat = { pattern: '*/5 * * * *' }; // every 5 minutes

  await Promise.all([
    schedulerQueue.add('sweep-due-jobs', {}, { repeat, jobId: 'repeat:sweep-due-jobs' }),
    schedulerQueue.add('start-scheduled-campaigns', {}, { repeat, jobId: 'repeat:start-campaigns' }),
    schedulerQueue.add('expire-campaigns', {}, { repeat: { pattern: '0 * * * *' }, jobId: 'repeat:expire-campaigns' }),
    // Publisher approval requests must not sit pending forever — run often so a
    // lapsed request releases the advertiser's reserved money promptly.
    schedulerQueue.add('expire-stale-approvals', {}, { repeat: { pattern: '*/15 * * * *' }, jobId: 'repeat:expire-approvals' }),
    // Lapsed premium memberships drop back to the free tier. Hourly is plenty.
    schedulerQueue.add('expire-subscriptions', {}, { repeat: { pattern: '20 * * * *' }, jobId: 'repeat:expire-subs' }),
    // Posting must never stop. Every 30 minutes, top up any channel that has gone
    // quiet with a house post.
    schedulerQueue.add('fill-house-slots', {}, { repeat: { pattern: '*/30 * * * *' }, jobId: 'repeat:house-fill' }),

    // Channel health has to be refreshed on a clock: it gates delivery, and the
    // inputs (recent job failures, unresolved reports) change without an event.
    // `limit` bounds one run so the sweep can never load every channel into
    // memory or overrun the worker's lock; oldest-checked channels come first.
    statsQueue.add(
      'refresh-channel-health',
      { limit: 300 },
      { repeat: { pattern: '25 * * * *' }, jobId: 'repeat:channel-health' },
    ),

    permissionQueue.add('check-channel-permissions', {}, { repeat: { pattern: '0 */6 * * *' }, jobId: 'repeat:permissions' }),

    statsQueue.add('refresh-channel-stats', {}, { repeat: { pattern: '15 */2 * * *' }, jobId: 'repeat:channel-stats' }),
    statsQueue.add('sync-post-views', {}, { repeat: { pattern: '*/30 * * * *' }, jobId: 'repeat:post-views' }),

    payoutQueue.add('release-matured-earnings', {}, { repeat: { pattern: '*/15 * * * *' }, jobId: 'repeat:earnings' }),
    // Daily platform-revenue snapshot. The handler existed but nothing ever
    // enqueued it, so the admin revenue history stayed empty.
    payoutQueue.add('settle-platform-revenue', {}, { repeat: { pattern: '55 23 * * *' }, jobId: 'repeat:platform-revenue' }),
    // CPC is billed on clicks that have already happened, so settlement runs on a
    // schedule rather than at publish time.
    payoutQueue.add('settle-cpc-billing', {}, { repeat: { pattern: '*/30 * * * *' }, jobId: 'repeat:cpc-settle' }),
    // Referral rewards mature on a clock (referred account age + first verified
    // deposit), not on an event we are guaranteed to see, so they are swept too.
    payoutQueue.add('settle-referrals', {}, { repeat: { pattern: '*/30 * * * *' }, jobId: 'repeat:referrals' }),

    fraudQueue.add('scan-click-patterns', {}, { repeat: { pattern: '*/10 * * * *' }, jobId: 'repeat:fraud-clicks' }),

    // Advertiser webhooks: a delivery row is written before the HTTP call, so a
    // lost job (deploy mid-flight, eviction) must be re-queued rather than left
    // pending forever. This is what makes delivery at-least-once.
    webhookQueue.add('dispatch-pending-webhooks', {}, { repeat: { pattern: '*/5 * * * *' }, jobId: 'repeat:dispatch-webhooks' }),

    // Crypto deposits: poll the chain for incoming transfers. Every 10 minutes
    // is a compromise — a slower poll delays a customer's balance, a faster one
    // burns rate limit on providers that meter it. Recording only; crediting
    // stays a deliberate step.
    cleanupQueue.add('scan-crypto-deposits', {}, { repeat: { pattern: '*/10 * * * *' }, jobId: 'repeat:scan-crypto' }),

    // Advertiser webhooks: a delivered row is kept for the subscriber's log, but
    // not forever. Failed rows are kept longer so a support question can still
    // be answered after the fact.
    cleanupQueue.add('purge-webhook-deliveries', {}, { repeat: { pattern: '30 4 * * *' }, jobId: 'repeat:purge-webhooks' }),

    cleanupQueue.add('purge-old-clicks', {}, { repeat: { pattern: '0 4 * * *' }, jobId: 'repeat:purge-clicks' }),
    cleanupQueue.add('purge-stale-jobs', {}, { repeat: { pattern: '0 5 * * *' }, jobId: 'repeat:purge-jobs' }),
    cleanupQueue.add('audit-balances', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'repeat:audit-balances' }),
  ]);

  logger.info('repeatable safety-net jobs registered');
}

export async function getQueueHealth(): Promise<
  Array<{ name: string; waiting: number; active: number; failed: number; delayed: number; completed: number }>
> {
  return Promise.all(
    ALL_QUEUES.map(async (q) => {
      const counts = await q.getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed');
      return {
        name: q.name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        completed: counts.completed ?? 0,
      };
    }),
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(ALL_QUEUES.map((q) => q.close()));
  if (producerConnection) {
    producerConnection.disconnect();
    producerConnection = null;
  }
}
