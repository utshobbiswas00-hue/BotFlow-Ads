import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { prisma } from '../db/prisma';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { enqueueCampaignJobs, finaliseExpiredCampaign } from '../services/campaign.service';
import { expireStaleApprovals, reclaimStaleDeliveryJobs, sweepDueJobs } from '../services/delivery.service';
import { schedulerQueue } from '../queues/queue';
import { register } from './registry';

/** All scheduler safety-net jobs are enqueued without a payload. */
export interface SchedulerJobData {}

/**
 * Daily re-seed of the default membership plans. The API seeds them at boot, but
 * a database created (or restored) after boot would otherwise stay empty until
 * the next deploy. Kept out of `JOB` because that enum is shared; the name is
 * matched locally in the processor below.
 */
const SEED_DEFAULT_PLANS_JOB = 'seed-default-plans';

const log = childLogger('scheduler-worker');

/** Cap per sweep so a backlog can never monopolise the (concurrency 1) worker. */
const MAX_CAMPAIGNS_PER_SWEEP = 200;

/**
 * Flip SCHEDULED campaigns whose start time has arrived to RUNNING and push
 * their delivery jobs onto the queue. The conditional updateMany makes this
 * safe even if the API or an admin transition starts the campaign first.
 */
async function startScheduledCampaigns(): Promise<void> {
  const now = new Date();
  const due = await prisma.campaign.findMany({
    where: { status: 'SCHEDULED', startAt: { lte: now } },
    orderBy: { startAt: 'asc' },
    take: MAX_CAMPAIGNS_PER_SWEEP,
    select: { id: true },
  });

  let started = 0;
  for (const { id } of due) {
    const updated = await prisma.campaign.updateMany({
      where: { id, status: 'SCHEDULED' },
      data: { status: 'RUNNING' },
    });
    if (updated.count === 0) continue; // already moved by someone else

    const enqueued = await enqueueCampaignJobs(id);
    started += 1;
    log.info({ campaignId: id, enqueued }, 'scheduled campaign started');
  }

  log.info({ due: due.length, started }, 'start-scheduled-campaigns sweep finished');
}

/**
 * Expire campaigns whose end time has passed: cancel their still-queued
 * delivery jobs, then let `finaliseExpiredCampaign` write the terminal status —
 * EXPIRED when the deadline cost the campaign a slot, COMPLETED when it did not — and
 * release the escrow once nothing is left in flight. Jobs in AWAITING_APPROVAL resolve through the
 * normal approve/reject flow (publish is refused after endAt, so they all
 * converge to a terminal state).
 */
async function expireCampaigns(): Promise<void> {
  const now = new Date();
  const due = await prisma.campaign.findMany({
    where: {
      endAt: { lt: now },
      status: { in: ['APPROVED', 'SCHEDULED', 'RUNNING'] },
    },
    orderBy: { endAt: 'asc' },
    take: MAX_CAMPAIGNS_PER_SWEEP,
    select: { id: true },
  });

  for (const { id } of due) {
    const cancelled = await prisma.deliveryJob.updateMany({
      where: { campaignId: id, status: { in: ['PENDING', 'SCHEDULED'] } },
      data: { status: 'CANCELLED', processedAt: now, errorMessage: 'campaign_expired' },
    });

    // Approval requests belonging to an expired campaign lapse immediately.
    // They are not cancelled here because cancelling them must also release the
    // reservation for that slot — `expireStaleApprovals` does both atomically.
    await prisma.deliveryJob.updateMany({
      where: { campaignId: id, status: 'AWAITING_APPROVAL' },
      data: { approvalExpiresAt: now },
    });

    // `finaliseExpiredCampaign`, not `maybeCompleteCampaign`: this path is about the end
    // time having passed, and it has to be able to write EXPIRED. It still moves a
    // fully-delivered campaign to COMPLETED — see the note on its definition.
    const closed = await finaliseExpiredCampaign(id).catch((err) => {
      log.error({ err, campaignId: id }, 'failed to close expired campaign');
      return false;
    });

    log.info({ campaignId: id, cancelledJobs: cancelled.count, closed }, 'campaign end time passed');
  }
}

/**
 * SCHEDULER WORKER — the safety net for delayed BullMQ jobs.
 * Precise timing comes from delayed delivery jobs; these repeatable sweeps
 * guarantee that a lost queue entry, a missed start or a lapsed end is
 * eventually corrected. Concurrency is 1 so sweeps never overlap.
 */
const processor: Processor<SchedulerJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.SWEEP_DUE_JOBS: {
        // First recover jobs a dead worker left in PROCESSING — otherwise they
        // block the campaign from ever completing (and its escrow from being
        // released), and are invisible to every other sweep.
        const reclaimed = await reclaimStaleDeliveryJobs();
        if (reclaimed > 0) log.warn({ jobId: job.id, reclaimed }, 'reclaimed stale PROCESSING delivery jobs');
        const swept = await sweepDueJobs();
        log.info({ jobId: job.id, swept, reclaimed }, 'swept due delivery jobs');
        return;
      }
      case JOB.START_SCHEDULED_CAMPAIGNS: {
        await startScheduledCampaigns();
        return;
      }
      case JOB.EXPIRE_CAMPAIGNS: {
        await expireCampaigns();
        return;
      }
      case JOB.FILL_HOUSE_SLOTS: {
        const { fillHouseSlots } = await import('../services/houseDelivery.service');
        const published = await fillHouseSlots();
        if (published > 0) log.info({ jobId: job.id, published }, 'house posts filled quiet channels');
        return;
      }
      case JOB.EXPIRE_SUBSCRIPTIONS: {
        const { expireSubscriptions } = await import('../services/premium.service');
        const expired = await expireSubscriptions();
        if (expired > 0) log.info({ jobId: job.id, expired }, 'expired lapsed subscriptions');
        return;
      }
      case SEED_DEFAULT_PLANS_JOB: {
        // Idempotent by design: only entirely absent plans are created, so an
        // admin-edited plan is never overwritten.
        const { seedDefaultPlans } = await import('../services/premium.service');
        const created = await seedDefaultPlans();
        if (created > 0) log.info({ jobId: job.id, created }, 'seeded default premium plans');
        return;
      }
      case JOB.EXPIRE_STALE_APPROVALS: {
        const expired = await expireStaleApprovals();
        if (expired > 0) log.info({ jobId: job.id, expired }, 'expired stale approval requests');
        return;
      }
      default:
        throw new Error(`unknown scheduler job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'scheduler processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-scheduler');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<SchedulerJobData>(QUEUE_NAMES.SCHEDULER, processor, {
  connection,
  concurrency: 1,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.SCHEDULER);

// Daily safety net: seed the default plans even if the database was created
// after the API booted. Idempotent (see seedDefaultPlans) so re-running is safe.
void schedulerQueue
  .add(SEED_DEFAULT_PLANS_JOB, {}, { repeat: { pattern: '15 3 * * *' }, jobId: 'repeat:seed-plans' })
  .catch((err) => log.error({ err }, 'failed to register the daily plan-seed job'));
