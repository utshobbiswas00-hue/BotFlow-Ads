import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { prisma } from '../db/prisma';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { alertAdmins } from '../services/notification.service';
import { getBoolSetting } from '../services/settings.service';
import { approveWithdrawal } from '../services/withdrawal.service';
import { register } from './registry';

/** JOB.PROCESS_WITHDRAWAL payload (see producers.ts). */
export interface ProcessWithdrawalJobData {
  withdrawalId: string;
}

const log = childLogger('withdrawal-worker');

const AUTO_PROCESS_KEY = 'auto_process_withdrawals';

/**
 * WITHDRAWAL WORKER — decides what happens to a freshly requested
 * withdrawal:
 *   - `auto_process_withdrawals` ON  → approve it (system as actor)
 *   - OFF (default)                  → page the admins for manual review
 *
 * Concurrency is 1 so two workers can never approve the same withdrawal
 * in parallel; the status re-check below makes the job idempotent anyway.
 */
const processor: Processor<ProcessWithdrawalJobData> = async (job) => {
  try {
    if (job.name !== JOB.PROCESS_WITHDRAWAL) {
      throw new Error(`unknown withdrawal job: ${job.name}`);
    }

    const { withdrawalId } = job.data;
    if (!withdrawalId) throw new Error('process-withdrawal job has no withdrawalId');

    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      select: {
        id: true,
        status: true,
        userId: true,
        amountCents: true,
        currency: true,
        method: true,
        accountMasked: true,
      },
    });

    if (!withdrawal) {
      log.warn({ jobId: job.id, withdrawalId }, 'withdrawal not found — nothing to process');
      return;
    }

    if (withdrawal.status !== 'PENDING') {
      log.info(
        { jobId: job.id, withdrawalId, status: withdrawal.status },
        'withdrawal already processed — skipping',
      );
      return;
    }

    const autoProcess = await getBoolSetting(AUTO_PROCESS_KEY, false);

    if (autoProcess) {
      await approveWithdrawal('system', withdrawal.id);
      log.info(
        { jobId: job.id, withdrawalId, amountCents: withdrawal.amountCents },
        'withdrawal auto-approved',
      );
    } else {
      await alertAdmins(
        `Withdrawal ${withdrawal.id} is awaiting review: ${(withdrawal.amountCents / 100).toFixed(2)} ${withdrawal.currency} via ${withdrawal.method} (${withdrawal.accountMasked ?? 'account not on file'}).`,
      );
      log.info({ jobId: job.id, withdrawalId }, 'withdrawal paged to admins for manual review');
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'withdrawal processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-withdrawal');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<ProcessWithdrawalJobData>(QUEUE_NAMES.WITHDRAWAL, processor, {
  connection,
  concurrency: 1,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.WITHDRAWAL);
