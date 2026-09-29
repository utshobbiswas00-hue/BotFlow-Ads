import { Worker, type Processor } from 'bullmq';
import { childLogger } from '../config/logger';
import { prisma } from '../db/prisma';
import { createQueueConnection } from '../db/redis';
import { JOB, QUEUE_NAMES } from '../queues/names';
import { verifyChannel } from '../services/channel.service';
import { createNotification } from '../services/notification.service';
import { chunk } from '../utils/retry';
import { register } from './registry';

/** JOB.CHECK_SINGLE_CHANNEL payload (see producers.ts). */
export interface CheckSingleChannelJobData {
  channelId: string;
}

/** The scheduled sweep carries no payload; a single check carries one id. */
export interface PermissionJobData {
  channelId?: string;
}

const log = childLogger('permission-worker');

const PAGE_SIZE = 50;
const MAX_CHANNELS_PER_SWEEP = 500;

/**
 * Re-verify the bot's posting rights across all APPROVED channels.
 *
 * Oldest `lastPermissionCheck` first (never-checked channels surface first),
 * processed in pages of 50 and capped at 500 per run. The repeatable job
 * (every 6 hours) guarantees every channel is re-seen on a rotation.
 */
async function checkAllChannelPermissions(): Promise<void> {
  const targets = await prisma.channel.findMany({
    where: { status: 'APPROVED' },
    orderBy: [{ lastPermissionCheck: 'asc' }, { createdAt: 'asc' }],
    take: MAX_CHANNELS_PER_SWEEP,
    select: { id: true, ownerId: true, title: true },
  });

  let checked = 0;
  let lost = 0;

  for (const batch of chunk(targets, PAGE_SIZE)) {
    for (const channel of batch) {
      checked += 1;

      const result = await verifyChannel(channel.id).catch((err) => {
        log.warn({ err, channelId: channel.id }, 'channel verification failed');
        return null;
      });
      if (!result) continue;

      if (result.permissionLost) {
        lost += 1;
        await createNotification({
          userId: channel.ownerId,
          type: 'CHANNEL_PERMISSION_PROBLEM',
          title: 'Channel needs attention',
          body: `BotFlow Bot lost its posting rights in “${channel.title}”. Please re-add the bot as an administrator with the “Post Messages” permission so sponsored posts can keep running.`,
          data: { channelId: channel.id },
        });
      }
    }
  }

  log.info({ targets: targets.length, checked, lost }, 'channel permission sweep finished');
}

/**
 * PERMISSION WORKER — verifies that the bot still has posting rights in
 * publisher channels. Without this, the bot would quietly fail on every
 * delivery and advertisers would pay for posts that never appear.
 */
const processor: Processor<PermissionJobData> = async (job) => {
  try {
    switch (job.name) {
      case JOB.CHECK_CHANNEL_PERMISSIONS: {
        await checkAllChannelPermissions();
        return;
      }
      case JOB.CHECK_SINGLE_CHANNEL: {
        const { channelId } = job.data as CheckSingleChannelJobData;
        if (!channelId) throw new Error('check-single-channel job has no channelId');

        const result = await verifyChannel(channelId);
        log.info(
          { jobId: job.id, channelId, permissionLost: result.permissionLost, status: result.status },
          'single channel verified',
        );
        return;
      }
      default:
        throw new Error(`unknown permission job: ${job.name}`);
    }
  } catch (err) {
    log.error({ err, jobId: job.id, jobName: job.name }, 'permission processor failed');
    throw err;
  }
};

const connection = createQueueConnection('botflow-worker-permission');
connection.on('error', (err) => log.error({ err: err.message }, 'worker redis error'));

const worker = new Worker<PermissionJobData>(QUEUE_NAMES.PERMISSION, processor, {
  connection,
  concurrency: 2,
  lockDuration: 300_000,
});

register(worker, QUEUE_NAMES.PERMISSION);
