import { prisma } from '../db/prisma';
import { ConflictError, NotFoundError } from '../utils/errors';
import { deleteChannelPost, describeTelegramError, messageOf } from '../utils/telegram';
import { validateAdText } from '../templates/adPost.template';
import { recordAudit } from './audit.service';
import { logger } from '../config/logger';

/**
 * Content moderation: pre-publish copy checks and post-publish enforcement
 * (taking a live sponsored post down, approving held posts, reporting on
 * what has been removed and why).
 */

/* ------------------------------------------------------------------
 *  Text validation (pre-publish)
 * ------------------------------------------------------------------ */

/**
 * Moderation gate for campaign copy. Delegates to the shared ad-text
 * validator (length, emoji-only walls, all-caps spam, link flooding).
 */
export function moderateCampaignText(text: string): { allowed: boolean; reason?: string } {
  const result = validateAdText(text ?? '');
  return result.ok ? { allowed: true } : { allowed: false, reason: result.reason };
}

/* ------------------------------------------------------------------
 *  Post-publish enforcement
 * ------------------------------------------------------------------ */

/**
 * Take a live sponsored post down (REMOVE) or release a held post (APPROVE).
 *
 * REMOVE: the Telegram message is deleted first (best effort — Telegram
 * errors are swallowed so the DB row is removed regardless, e.g. the post
 * may already be gone), then the AdPost is marked DELETED and the action
 * is audited.
 *
 * APPROVE: only applies to posts sitting in AWAITING_APPROVAL; the post is
 * put back in the delivery queue so the worker can publish it.
 */
export async function moderateAdPost(adminId: string, adPostId: string, action: 'REMOVE' | 'APPROVE') {
  const post = await prisma.adPost.findUnique({
    where: { id: adPostId },
    select: {
      id: true,
      status: true,
      telegramMessageId: true,
      campaignId: true,
      publisherId: true,
      channel: { select: { id: true, telegramChannelId: true, title: true } },
    },
  });
  if (!post) throw new NotFoundError('Ad post');

  if (action === 'REMOVE') {
    if (post.status === 'DELETED') {
      throw new ConflictError('This ad post is already deleted');
    }

    // 1. Delete the live Telegram message. Swallowed on purpose: the DB row
    //    must come down even if Telegram is unreachable or the message is
    //    already gone.
    if (post.telegramMessageId !== null) {
      try {
        await deleteChannelPost(post.channel.telegramChannelId, post.telegramMessageId);
      } catch (err) {
        logger.warn(
          {
            err: messageOf(err),
            code: describeTelegramError(err),
            adPostId,
            telegramMessageId: post.telegramMessageId.toString(),
          },
          'moderateAdPost: Telegram delete failed — continuing with DB removal',
        );
      }
    }

    // 2. Mark deleted in the DB.
    const updated = await prisma.adPost.update({
      where: { id: adPostId },
      data: { status: 'DELETED', deletedAt: new Date() },
    });

    // 3. Audit — who removed it, from which state.
    await recordAudit({
      actorId: adminId,
      actorType: 'ADMIN',
      action: 'AD_POST_REMOVED',
      targetType: 'AD_POST',
      targetId: adPostId,
      oldValue: { status: post.status, telegramMessageId: post.telegramMessageId?.toString() ?? null },
      newValue: { status: 'DELETED' },
    });

    logger.warn({ adPostId, adminId, previousStatus: post.status }, 'ad post removed by moderation');
    return updated;
  }

  // ---- APPROVE ---------------------------------------------------------
  if (post.status !== 'AWAITING_APPROVAL') {
    throw new ConflictError(`Only posts awaiting approval can be approved (current status: ${post.status})`);
  }

  const updated = await prisma.adPost.update({
    where: { id: adPostId },
    data: { status: 'QUEUED' },
  });

  await recordAudit({
    actorId: adminId,
    actorType: 'ADMIN',
    action: 'AD_POST_APPROVED',
    targetType: 'AD_POST',
    targetId: adPostId,
    oldValue: { status: 'AWAITING_APPROVAL' },
    newValue: { status: 'QUEUED' },
  });

  logger.info({ adPostId, adminId }, 'ad post approved for delivery');
  return updated;
}

/* ------------------------------------------------------------------
 *  Removal report
 * ------------------------------------------------------------------ */

export interface BlockedAdsSummary {
  total: number;
  byErrorCode: Record<string, number>;
}

/**
 * How many AdPost rows are DELETED, grouped by the errorCode recorded on
 * them. Posts deleted without a specific code (e.g. manual moderation
 * removals) are grouped under "UNKNOWN".
 */
export async function blockedAdsSummary(): Promise<BlockedAdsSummary> {
  const rows = await prisma.adPost.groupBy({
    by: ['errorCode'],
    where: { status: 'DELETED' },
    _count: { _all: true },
  });

  const byErrorCode: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const key = row.errorCode ?? 'UNKNOWN';
    byErrorCode[key] = (byErrorCode[key] ?? 0) + row._count._all;
    total += row._count._all;
  }

  return { total, byErrorCode };
}
