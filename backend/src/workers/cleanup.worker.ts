import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { prisma } from '../db/prisma';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { alertAdmins } from '../services/notification.service';
import { auditNegativeBalances } from '../services/wallet.service';
import { purgeWebhookDeliveries } from '../services/webhook.service';
import { runCryptoScan } from '../services/cryptoDeposit.service';
import { register } from './registry';

/** All cleanup jobs are enqueued without a payload; limits are fixed here. */
export interface CleanupJobData {}

const log = childLogger('cleanup-worker');

const CLICK_RETENTION_DAYS = 90;
const STALE_JOB_RETENTION_DAYS = 30;
const PURGE_BATCH_SIZE = 5000;

/**
 * Delete clicks older than the retention window, batch by batch.
 * Each statement removes at most PURGE_BATCH_SIZE rows (raw SQL keeps it
 * to a single index scan per batch), and the loop stops as soon as a
 * batch deletes fewer than that many rows.
 */
async function purgeOldClicks(): Promise<number> {
  const cutoff = new Date(Date.now() - CLICK_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let batch: number;

  do {
    batch = await prisma.$executeRaw`
      DELETE FROM clicks
      WHERE id IN (
        SELECT id FROM clicks
        WHERE "created_at" < ${cutoff}
        ORDER BY "created_at" ASC
        LIMIT ${PURGE_BATCH_SIZE}
      )
    `;
    deleted += batch;
  } while (batch === PURGE_BATCH_SIZE);

  log.info({ deleted, cutoff }, 'purged clicks past retention window');
  return deleted;
}

/** Delete terminal delivery jobs (COMPLETED / CANCELLED) past retention. */
async function purgeStaleDeliveryJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const deleted = await prisma.$executeRaw`
    DELETE FROM delivery_jobs
    WHERE status IN ('COMPLETED', 'CANCELLED')
      AND COALESCE("processed_at", "created_at") < ${cutoff}
  `;

  log.info({ deleted, cutoff }, 'purged stale delivery jobs');
  return deleted;
}

/**
 * CLEANUP WORKER — housekeeping that keeps the database lean and the
 * money rails honest. Runs nightly (repeatable jobs in queues/queue.ts),
 * concurrency 1 so the big deletes never overlap each other.
 */
const processor: Processor<CleanupJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.PURGE_OLD_CLICKS: {
        await purgeOldClicks();
        return;
      }
      case JOB.PURGE_STALE_JOBS: {
        await purgeStaleDeliveryJobs();
        return;
      }
      case JOB.AUDIT_BALANCES: {
        const negatives = await auditNegativeBalances();
        if (negatives.length) {
          log.error({ count: negatives.length, userIds: negatives }, 'negative wallet balances detected');
          await alertAdmins(
            `Wallet integrity check found ${negatives.length} user(s) with a negative balance: ${negatives.slice(0, 10).join(', ')}${negatives.length > 10 ? ' …' : ''}. Manual review required.`,
          );
        } else {
          log.info({ jobId: job.id }, 'wallet balance audit clean');
        }
        return;
      }
      case JOB.PURGE_WEBHOOK_DELIVERIES: {
        const purged = await purgeWebhookDeliveries();
        log.info({ jobId: job.id, ...purged }, 'purged old webhook deliveries');
        return;
      }
      case JOB.SCAN_CRYPTO_DEPOSITS: {
        // Records what the chains showed us and nothing more. Crediting is a
        // separate deliberate step, because a chain cannot say who a transfer
        // belongs to.
        const summary = await runCryptoScan();
        log.info({ jobId: job.id, ...summary }, 'crypto deposit scan finished');
        return;
      }
      default:
        throw new Error(`unknown cleanup job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'cleanup processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-cleanup');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<CleanupJobData>(QUEUE_NAMES.CLEANUP, processor, {
  connection,
  concurrency: 1,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.CLEANUP);
