import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { prisma } from '../db/prisma';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { recordAudit } from '../services/audit.service';
import { alertAdmins } from '../services/notification.service';
import { releaseMaturedEarnings } from '../services/earnings.service';
import { register } from './registry';

/** Both payout jobs are enqueued without a payload. */
export interface PayoutJobData {}

const log = childLogger('payout-worker');

/** Local calendar date (YYYY-MM-DD) of the given instant. */
function localDateKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * PAYOUT WORKER — money movements on the publisher side.
 * Concurrency is 1: earnings release and the revenue snapshot must never
 * interleave, and both are short.
 */
const processor: Processor<PayoutJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.RELEASE_MATURED_EARNINGS: {
        // Move earnings past their hold period from pending to available.
        const released = await releaseMaturedEarnings();
        if (released > 0) {
          log.info({ jobId: job.id, released }, 'matured earnings released to available balances');
          await alertAdmins(
            `Earnings sweep: ${released} matured publisher earning(s) released from hold to available balances.`,
          );
        } else {
          log.debug({ jobId: job.id }, 'no matured earnings to release');
        }
        return;
      }
      case JOB.SETTLE_CPC_BILLING: {
        const { settleAllCpcPosts } = await import('../services/cpcBilling.service');
        const settled = await settleAllCpcPosts();
        if (settled > 0) log.info({ jobId: job.id, settled }, 'settled CPC posts on valid clicks');
        return;
      }
      case JOB.SETTLE_REFERRALS: {
        // Backstop for the deposit-time hook: a referral only becomes payable
        // once the referred account is old enough and has a verified deposit,
        // so it can mature with no event to trigger it.
        const { rewardEligibleReferrals } = await import('../services/referral.service');
        const rewarded = await rewardEligibleReferrals();
        if (rewarded > 0) log.info({ jobId: job.id, rewarded }, 'referral rewards paid out');
        return;
      }
      case JOB.SETTLE_PLATFORM_REVENUE: {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // Platform take = the fee kept on every post published today.
        const agg = await prisma.adPost.aggregate({
          where: { status: 'PUBLISHED', publishedAt: { gte: startOfToday } },
          _sum: { platformFeeCents: true },
        });
        const revenueCents = agg._sum.platformFeeCents ?? 0;
        const date = localDateKey(startOfToday);

        await recordAudit({
          actorType: 'SYSTEM',
          action: 'DAILY_REVENUE_SNAPSHOT',
          newValue: { revenueCents, date },
        });

        log.info({ jobId: job.id, revenueCents, date }, 'daily platform revenue snapshot recorded');
        return;
      }
      default:
        throw new Error(`unknown payout job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'payout processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-payout');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<PayoutJobData>(QUEUE_NAMES.PAYOUT, processor, {
  connection,
  concurrency: 1,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.PAYOUT);
