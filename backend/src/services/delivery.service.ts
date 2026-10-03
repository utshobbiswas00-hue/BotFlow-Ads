import type { DeliveryErrorCode, Prisma } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { chargeDelivery, releaseJobReservation } from './escrow.service';
import { businessRules } from './settings.service';
import { checkChannelFrequency, checkAdvertiserChannelCooldown } from './frequency.service';
import { recordDeliveryEvent } from './deliveryEvent.service';
import { userMessage } from '../utils/userMessages';
import { maybeCompleteCampaign } from './campaign.service';
import { createNotification, alertAdmins } from './notification.service';
import { buildSponsoredPostText } from '../templates/adPost.template';
import {
  describeTelegramError,
  messageOf,
  sendChannelPost,
  truncateForTelegram,
} from '../utils/telegram';
import { enqueuePublishAd } from '../queues/producers';
import { ref } from './transaction.service';
import { isBlocked } from './blocklist.service';
import { logger } from '../config/logger';

/**
 * AD DELIVERY ENGINE — the most important backend system in BotFlow Ads.
 *
 * Flow (spec section 24):
 *   Campaign -> Target Channels -> Channel status -> Bot permission ->
 *   Budget -> Schedule -> Delivery Queue -> Bot -> Telegram Channel
 *
 * Design rules that must never be relaxed:
 *  1. A post is charged ONLY inside the same DB transaction that records it
 *     as published. If Telegram succeeds but the DB write fails, the retry
 *     re-reads state and will not double-charge (the charge reference is
 *     `charge:<adPostId>` and is unique).
 *  2. A job is claimed with a conditional `updateMany` so two workers can
 *     never publish the same job twice.
 *  3. Any pre-flight failure reschedules rather than discards, unless the
 *     failure is permanent.
 */

const CLAIMABLE: string[] = ['PENDING', 'SCHEDULED', 'RETRYING'];

/**
 * A job left in PROCESSING by a worker that died mid-publish is reclaimable
 * once its lock is older than this. Matches the delivery worker's BullMQ
 * `lockDuration` (300 s): at that point BullMQ itself considers the job stalled
 * and re-delivers it, so the row must no longer be treated as locked.
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/** How long a job for a PAUSED campaign waits before re-checking. */
const PAUSED_RECHECK_MS = 30 * 60 * 1000;

/**
 * RETRY CLASSIFICATION.
 *
 * A failed delivery is not automatically retryable. Transient infrastructure
 * problems should be retried; a broken channel or a revoked permission must
 * fail immediately, because retrying it only delays the advertiser's refund and
 * spams the publisher with notifications.
 */
const RETRYABLE_ERRORS = new Set<DeliveryErrorCode>([
  'TELEGRAM_API_ERROR',
  'RATE_LIMITED',
  // The rules that guard a post could not be read. Nothing was published, so retrying
  // is safe and is the only correct answer — see the blocklist check below.
  'POLICY_CHECK_UNAVAILABLE',
]);

/**
 * `UNKNOWN` is deliberately NON-retryable. It is only produced by unexpected
 * exceptions, and an unexpected exception on the publish path may happen
 * *after* Telegram has already accepted the post — retrying then would publish
 * (and charge, and pay for) the same ad a second time. An unexpected failure is
 * therefore terminal and paged to an admin instead of silently re-run.
 */
const NON_RETRYABLE_ERRORS = new Set<DeliveryErrorCode>([
  'BOT_NOT_ADMIN',
  'MISSING_POST_PERMISSION',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_UNAVAILABLE',
  'CHAT_WRITE_FORBIDDEN',
  'CHANNEL_SUSPENDED',
  'PUBLISHER_REJECTED',
  'BUDGET_EXHAUSTED',
  'UNKNOWN',
]);

/**
 * `EscrowGuardError` (code `ESCROW_INSUFFICIENT`) means the campaign's reserved
 * budget no longer covers this delivery. Retrying cannot fix that — the
 * advertiser has to fund the campaign — so it is reported as the terminal
 * `BUDGET_EXHAUSTED` rather than the retryable `UNKNOWN`, which otherwise loops
 * the job and pages an admin about a possible duplicate that never happened.
 */
function isEscrowGuardError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ESCROW_INSUFFICIENT';
}

export function isRetryable(errorCode: DeliveryErrorCode): boolean {
  if (NON_RETRYABLE_ERRORS.has(errorCode)) return false;
  return RETRYABLE_ERRORS.has(errorCode);
}

/** Exponential-ish backoff for the retryable cases: 1m, 5m, 30m. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

function backoffFor(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 30 * 60_000;
}

export interface PublishOutcome {
  deliveryJobId: string;
  result:
    | 'published'
    | 'awaiting_publisher_approval'
    | 'rescheduled'
    | 'skipped'
    | 'failed'
    | 'retrying'
    | 'already_processed';
  messageId?: string;
  errorCode?: DeliveryErrorCode;
  reason?: string;
  nextAttemptMs?: number;
}

/* ------------------------------------------------------------------
 *  Entry point (called by the delivery worker)
 * ------------------------------------------------------------------ */

export async function publishDeliveryJob(deliveryJobId: string): Promise<PublishOutcome> {
  const job = await loadJob(deliveryJobId);
  if (!job) return { deliveryJobId, result: 'skipped', reason: 'job_not_found' };

  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
    return { deliveryJobId, result: 'already_processed', reason: job.status };
  }

  // ---- 1. Claim the job atomically ------------------------------------
  // A row can be claimed when it is in a normal claimable state, OR when it is
  // stuck in PROCESSING with a lock older than the worker's lockDuration (the
  // worker that held it crashed — see `reclaimStaleDeliveryJobs`). Without the
  // second branch such a row could never be reclaimed and its escrow, plus the
  // campaign's completion, would be stranded forever.
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await prisma.deliveryJob.updateMany({
    where: {
      id: deliveryJobId,
      OR: [
        { status: { in: CLAIMABLE as never } },
        { status: 'PROCESSING', lockedAt: { lt: staleBefore } },
        { status: 'PROCESSING', lockedAt: null },
      ],
    },
    data: { status: 'PROCESSING', lockedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return { deliveryJobId, result: 'already_processed', reason: 'claimed_by_another_worker' };
  }

  // Reload with fresh attempt count.
  const fresh = await loadJob(deliveryJobId);
  if (!fresh) return { deliveryJobId, result: 'skipped', reason: 'job_vanished' };

  // ---- 1b. Reconcile a post that a previous attempt already published ---
  // If a prior attempt sent the post to Telegram and recorded the AdPost but
  // then died before charging it, the row is the durable proof that the ad is
  // already live. Finalise the charge — never send again, or the advertiser is
  // billed twice and the audience sees the same ad twice.
  const alreadyPublished = await prisma.adPost.findUnique({
    where: { deliveryJobId: fresh.id },
    select: { id: true },
  });
  if (alreadyPublished) {
    try {
      await finalisePublished(fresh, fresh.channel, fresh.campaign, fresh.priceCents, alreadyPublished.id);
      return { deliveryJobId: fresh.id, result: 'published', reason: 'reconciled_already_published' };
    } catch (err) {
      logger.error(
        { err, deliveryJobId: fresh.id, adPostId: alreadyPublished.id },
        'reconcile: post already published but the charge transaction failed',
      );
      const escrowGuard = isEscrowGuardError(err);
      return await fail(
        fresh,
        escrowGuard ? 'BUDGET_EXHAUSTED' : 'UNKNOWN',
        escrowGuard
          ? 'The campaign budget no longer covers this delivery. Top up the campaign to continue.'
          : messageOf(err),
        escrowGuard ? undefined : { retryable: true },
      );
    }
  }

  try {
    // ---- 2. Pre-flight checks ----------------------------------------
    const campaign = fresh.campaign;
    const channel = fresh.channel;

    // A PAUSED campaign must NOT have its pending slots cancelled: pause is
    // temporary, and cancelling here (as `finish()` would) permanently drops a
    // post the advertiser paid for. Defer the job instead, so resuming the
    // campaign does not wait on a lost queue entry.
    if (campaign.status === 'PAUSED') {
      return await reschedule(fresh, PAUSED_RECHECK_MS, 'campaign_paused');
    }

    if (!['APPROVED', 'SCHEDULED', 'RUNNING'].includes(campaign.status)) {
      return await finish(fresh, 'skipped', `campaign_status_${campaign.status}`);
    }

    const now = Date.now();

    if (campaign.startAt && campaign.startAt.getTime() > now) {
      const delayMs = campaign.startAt.getTime() - now;
      return await reschedule(fresh, delayMs, 'campaign_not_started');
    }

    if (campaign.endAt && campaign.endAt.getTime() < now) {
      return await finish(fresh, 'skipped', 'campaign_ended');
    }

    if (channel.status !== 'APPROVED') {
      return await fail(fresh, 'CHANNEL_SUSPENDED', `Channel is ${channel.status}`);
    }

    if (!channel.botIsAdmin || !channel.canPostMessages) {
      return await fail(fresh, 'MISSING_POST_PERMISSION', 'Bot lost posting rights in this channel');
    }

    // ---- 3. Budget guard ---------------------------------------------
    // Charge the price FROZEN onto this job when the campaign was planned.
    // Reading Channel.adPriceCents here would silently overcharge the
    // advertiser whenever a publisher raises their price mid-campaign.
    const priceCents = fresh.priceCents;
    if (priceCents <= 0) {
      return await fail(fresh, 'UNKNOWN', 'Channel has no valid ad price');
    }

    if (campaign.budgetReservedCents < priceCents) {
      return await fail(fresh, 'BUDGET_EXHAUSTED', 'Campaign reserved budget is exhausted');
    }

    // ---- 4. Channel frequency limits (spec sections 27-28) -----------
    // Per-channel limits enforced together: the publisher's own settings, the
    // per-hour campaign cap, and the platform-wide daily ceiling. A breach
    // reschedules to the exact moment the constraint frees up.
    const channelFrequency = await checkChannelFrequency({
      id: channel.id,
      maxPostsPerDay: channel.maxPostsPerDay,
      minHoursBetweenAds: channel.minHoursBetweenAds,
      maxCampaignsPerHour: channel.maxCampaignsPerHour ?? null,
      postingSchedule: channel.postingSchedule,
      // Pass the advertiser so a premium advertiser's `maxCampaignsPerHour`
      // entitlement can raise the per-hour cap when the publisher left their own
      // cap unset. Optional + backward compatible: a free advertiser (pct-free
      // entitlements resolve to 2) or an unknown advertiser changes nothing.
      advertiserId: campaign.advertiserId,
    });
    if (!channelFrequency.allowed) {
      return await reschedule(
        fresh,
        channelFrequency.retryAfterMs,
        channelFrequency.reason ?? 'channel frequency limit reached',
      );
    }

    // One advertiser must not dominate a single channel.
    const advertiserCooldown = await checkAdvertiserChannelCooldown(campaign.advertiserId, channel.id);
    if (!advertiserCooldown.allowed) {
      return await reschedule(
        fresh,
        advertiserCooldown.retryAfterMs,
        advertiserCooldown.reason ?? 'advertiser channel cooldown active',
      );
    }

    // ---- 5. Publisher manual approval (spec section 29) --------------
    if (!channel.autoApprovePosts && !fresh.publisherApprovedAt) {
      // A publisher request must not sit pending forever. When the deadline
      // passes the slot expires and the advertiser's reservation is released.
      const approvalTimeoutMs = (await businessRules.publisherApprovalTimeoutHours()) * 60 * 60 * 1000;

      await prisma.deliveryJob.update({
        where: { id: fresh.id },
        data: {
          status: 'AWAITING_APPROVAL',
          lockedAt: null,
          approvalExpiresAt: new Date(Date.now() + approvalTimeoutMs),
        },
      });

      await createNotification({
        userId: channel.ownerId,
        type: 'NEW_AD_REQUEST',
        title: 'New sponsored post request',
        body: `${campaign.advertiser.firstName ?? 'An advertiser'} wants to publish in “${channel.title}” for ${(priceCents / 100).toFixed(2)}. Approve or reject it in My Channels.`,
        data: { deliveryJobId: fresh.id, channelId: channel.id },
      });

      return { deliveryJobId, result: 'awaiting_publisher_approval' };
    }

    // ---- 6. Pick the creative (rotation) -----------------------------
    const creative = await pickCreative(fresh.campaignId, channel.id, fresh.adId);
    if (!creative) return await fail(fresh, 'UNKNOWN', 'Campaign has no active creative');

    // ---- 6b. Blocklist re-check (spec: a publisher can always refuse) --
    // The blocklist is applied when the campaign is created, but an entry added
    // afterwards (or a CAMPAIGN-scope entry, which creation cannot match because
    // the campaign id does not exist yet) must still be honoured at publish time.
    // Fail CLOSED when the check itself breaks.
    //
    // This used to `.catch()` into `{ blocked: false }`, i.e. publish the ad whenever the
    // lookup threw — which is precisely when the publisher's refusal could not be
    // evaluated. The blocklist is the only thing enforcing that refusal, so failing open
    // silently published an advertiser, category or domain the publisher had excluded.
    //
    // The two directions are not symmetric. Nothing has been published yet at this point,
    // so retrying is safe and cheap; and if the blocklist stays unreadable, the job runs
    // out of attempts and ends as a terminal failure, with the advertiser's reservation
    // released through the normal escrow path. A delivered post a publisher refused cannot
    // be taken back; a delayed one can.
    let blocked: { blocked: boolean; reason?: string };
    try {
      blocked = await isBlocked({
        channelId: channel.id,
        advertiserId: campaign.advertiserId,
        campaignId: fresh.campaignId,
        category: campaign.category ?? null,
        domain: creative.destinationUrl ?? null,
      });
    } catch (err) {
      logger.error(
        { err, deliveryJobId: fresh.id },
        'blocklist check failed — holding the delivery instead of publishing',
      );
      return await fail(
        fresh,
        'POLICY_CHECK_UNAVAILABLE',
        'The channel blocklist could not be read, so this post was not published.',
      );
    }
    if (blocked.blocked) {
      const reason = blocked.reason ?? 'Blocked by the channel owner';
      await recordDeliveryEvent(null, {
        deliveryJobId: fresh.id,
        type: 'FAILED',
        errorCode: 'PUBLISHER_REJECTED',
        message: reason,
        attempt: fresh.attempts,
      });
      return await fail(fresh, 'PUBLISHER_REJECTED', reason, { permanent: true });
    }

    // ---- 7. Publish ---------------------------------------------------
    const postText = buildSponsoredPostText({
      text: creative.text,
      disclosure: 'Paid promotion',
      hasImage: Boolean(creative.imageUrl),
    });

    let sendResult: { messageId: bigint; chatId: string };
    try {
      sendResult = await sendChannelPost({
        chatId: channel.telegramChannelId,
        text: postText,
        imageUrl: creative.imageUrl,
        buttonText: creative.buttonText,
        buttonUrl: buildTrackedUrl(creative.buttonUrl ?? creative.destinationUrl, creative.trackingSlug),
        disablePreview: Boolean(creative.buttonText),
      });
    } catch (err) {
      const code = describeTelegramError(err);
      const message = messageOf(err);

      if (!isRetryable(code)) {
        // The channel itself is broken — flag it so the publisher can fix it.
        await prisma.channel
          .update({
            where: { id: channel.id },
            data: {
              status: 'ATTENTION_REQUIRED',
              botIsAdmin: false,
              canPostMessages: false,
              lastPermissionCheck: new Date(),
            },
          })
          .catch(() => undefined);

        await createNotification({
          userId: channel.ownerId,
          type: 'CHANNEL_PERMISSION_PROBLEM',
          title: 'Channel needs attention',
          body: `BotFlow Bot could not post in “${channel.title}”. Please re-add the bot as an administrator with the "Post Messages" permission. Reason: ${message}`,
          data: { channelId: channel.id },
        });

          await recordDeliveryEvent(null, {
          deliveryJobId: fresh.id,
          type: 'FAILED',
          errorCode: code,
          message,
          attempt: fresh.attempts,
        });

        return await fail(fresh, code, message, { permanent: true });
      }

      if (code === 'RATE_LIMITED') {
        // Telegram tells us exactly how long to wait (`retry_after`, seconds).
        // Honour it instead of a fixed delay, both to stop hammering the API and
        // to publish as soon as the flood window closes.
        const waitMs = telegramRetryAfterMs(err);
        return await reschedule(fresh, waitMs, `telegram_rate_limited: ${message}`);
      }

      return await fail(fresh, code, message);
    }

    // ---- 8. Record the publish durably, then charge -------------------
    // The Telegram post is ALREADY LIVE at this point. Persist the messageId —
    // as the AdPost row, whose `deliveryJobId` is unique — in its own write
    // BEFORE any money moves. From then on the job is recognisable: a retry
    // finds this row (step 1b) and finishes the charge instead of re-sending.
    //
    // If even this write fails we have no way to recognise the post on a retry,
    // so re-running would publish, charge and pay out a second time. The job is
    // therefore made terminal with a NON-retryable code and an admin is paged.
    let adPostId: string;
    try {
      adPostId = await recordPublishedAdPost(fresh, channel, creative, priceCents, sendResult.messageId);
    } catch (err) {
      logger.error(
        { err, deliveryJobId: fresh.id, messageId: sendResult.messageId.toString() },
        'CRITICAL: post published on Telegram but recording it failed',
      );
      await alertAdmins(
        `Post published in @${channel.username ?? channel.title} but recording it failed. Job ${fresh.id}, Telegram message ${sendResult.messageId.toString()}. Manual check required — the job was stopped so it cannot be published (and charged) a second time.`,
      ).catch(() => undefined);
      await recordDeliveryEvent(null, {
        deliveryJobId: fresh.id,
        type: 'FAILED',
        errorCode: 'CHANNEL_UNAVAILABLE',
        message: `published (Telegram message ${sendResult.messageId.toString()}) but the AdPost record could not be written: ${messageOf(err)}`,
        attempt: fresh.attempts,
      });
      return await fail(
        fresh,
        'CHANNEL_UNAVAILABLE',
        `Post published in Telegram (message ${sendResult.messageId.toString()}) but recording it failed — stopped to prevent a duplicate publish`,
        { permanent: true },
      );
    }

    // The charge moves money, so it stays in its own transaction. If it fails,
    // the AdPost above is the durable marker: the retry reconciles it and only
    // repeats the charge — it never sends to Telegram again.
    try {
      await finalisePublished(fresh, channel, campaign, priceCents, adPostId);
    } catch (err) {
      logger.error(
        { err, deliveryJobId: fresh.id, adPostId },
        'post recorded but the charge transaction failed; retrying the charge only',
      );
      await alertAdmins(
        `Post for delivery job ${fresh.id} is live but charging it failed. It will be retried automatically, without re-publishing.`,
      ).catch(() => undefined);
      const escrowGuard = isEscrowGuardError(err);
      return await fail(
        fresh,
        escrowGuard ? 'BUDGET_EXHAUSTED' : 'UNKNOWN',
        escrowGuard
          ? 'Published, but the campaign budget no longer covers the charge. Top up the campaign.'
          : `charge failed after publish: ${messageOf(err)}`,
        escrowGuard ? undefined : { retryable: true },
      );
    }

    await recordDeliveryEvent(null, {
      deliveryJobId: fresh.id,
      type: 'PUBLISHED',
      message: `published to ${channel.title}`,
      attempt: fresh.attempts,
      metadata: { adPostId, priceCents, messageId: sendResult.messageId.toString() },
    });

    await recordDeliveryEvent(null, {
      deliveryJobId: fresh.id,
      type: 'CHARGED',
      message: `charged ${priceCents} cents`,
      metadata: { adPostId, priceCents, platformFeePercent: fresh.platformFeePercent },
    });

    logger.info(
      { deliveryJobId: fresh.id, adPostId, priceCents },
      'sponsored post published',
    );

    // ---- 9. Notifications (best effort, never blocking) ---------------
    // These MUST NOT be able to reach the outer catch: an error here would mark
    // an already-published, already-charged job as failed.
    await createNotification({
      userId: channel.ownerId,
      type: 'EARNINGS_ADDED',
      title: 'Sponsored post published',
      body: `A sponsored post went live in “${channel.title}”. You earned ${(priceCents / 100).toFixed(2)} (pending).`,
      data: { channelId: channel.id, adPostId },
    }).catch((err) => logger.warn({ err, deliveryJobId: fresh.id }, 'post-publish notification failed'));

    // Close the campaign if that was the last job.
    await maybeCompleteCampaign(fresh.campaignId).catch(() => undefined);

    return { deliveryJobId: fresh.id, result: 'published', messageId: sendResult.messageId.toString() };
  } catch (err) {
    // Unexpected failure. `UNKNOWN` is NON-retryable, so this can never send the
    // creative to Telegram again — the risky part of the publish has already
    // succeeded by the time most of this function runs. The slot's reservation
    // is released and an admin can reconcile from the delivery timeline.
    logger.error({ err, deliveryJobId }, 'delivery job threw unexpectedly — failing permanently to avoid a duplicate publish');
    return await fail(fresh, 'UNKNOWN', messageOf(err));
  }
}

/**
 * Write the published AdPost row — the durable record of the Telegram message —
 * in its own transaction, immediately after the send succeeds.
 *
 * Idempotent on `deliveryJobId` (unique), so a race with the reconciliation
 * path cannot create two rows for one delivery. Throws when the row genuinely
 * cannot be written; the caller must then stop the job (see the CRITICAL path
 * in `publishDeliveryJob`).
 */
async function recordPublishedAdPost(
  job: { id: string; campaignId: string; platformFeePercent: number },
  channel: { id: string; ownerId: string; pricingModel: string },
  creative: { id: string },
  priceCents: number,
  messageId: bigint,
): Promise<string> {
  const adPost = await prisma.adPost.upsert({
    where: { deliveryJobId: job.id },
    create: {
      campaignId: job.campaignId,
      adId: creative.id,
      channelId: channel.id,
      publisherId: channel.ownerId,
      deliveryJobId: job.id,
      telegramMessageId: messageId,
      status: 'PUBLISHED',
      publishedAt: new Date(),
      priceCents,
      // FIXED is exact. CPM/CPC are estimates — the Bot API gives us no
      // per-post view count, so the figure is derived from channel history and
      // is labelled as such everywhere it is displayed.
      billingMode:
        channel.pricingModel === 'FIXED'
          ? 'FIXED'
          : channel.pricingModel === 'CPM'
            ? 'CPM_ESTIMATED'
            : channel.pricingModel === 'CPC'
              ? 'CPC_ESTIMATED'
              : 'HYBRID_ESTIMATED',
    },
    // Never overwrite an existing record; a re-run only needs the id back.
    update: { telegramMessageId: messageId },
    select: { id: true },
  });
  return adPost.id;
}

/**
 * Charge a post that is already recorded as published, and mark its job
 * COMPLETED — all in one transaction. Safe to run more than once: the charge
 * reference is unique per AdPost and the delivery log is checked first, so a
 * reconciliation retry neither double-charges nor duplicates the log.
 */
async function finalisePublished(
  job: { id: string; campaignId: string; platformFeePercent: number },
  channel: { id: string; ownerId: string },
  campaign: { advertiserId: string; platformFeePercent: number },
  priceCents: number,
  adPostId: string,
): Promise<void> {
  await transaction(
    async (tx) => {
      const alreadyCharged = await tx.transaction.findUnique({
        where: { reference: ref.campaignCharge(adPostId) },
        select: { id: true },
      });

      if (!alreadyCharged) {
        await chargeDelivery(tx, {
          campaignId: job.campaignId,
          advertiserId: campaign.advertiserId,
          publisherId: channel.ownerId,
          channelId: channel.id,
          adPostId,
          priceCents,
          platformFeePercent: job.platformFeePercent || campaign.platformFeePercent,
        });
      }

      const logged = await tx.channelDeliveryLog.findFirst({
        where: { adPostId },
        select: { id: true },
      });
      if (!logged) {
        await tx.channelDeliveryLog.create({ data: { channelId: channel.id, adPostId } });
      }

      await tx.deliveryJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          processedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          lockedAt: null,
        },
      });
    },
    { timeout: 20_000, retries: 2 },
  );
}

/** Telegram `retry_after` (seconds) on a 429, clamped to a sane window. */
function telegramRetryAfterMs(err: unknown): number {
  const seconds = (err as { parameters?: { retry_after?: unknown } })?.parameters?.retry_after;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.max(seconds * 1000, 1_000), 10 * 60_000);
  }
  return 60_000;
}

/* ------------------------------------------------------------------
 *  Pre-flight helpers
 * ------------------------------------------------------------------ */

async function loadJob(deliveryJobId: string) {
  return prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    select: {
      id: true,
      campaignId: true,
      channelId: true,
      adId: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      publisherApprovedAt: true,
      priceCents: true,
      platformFeePercent: true,
      approvalExpiresAt: true,
      campaign: {
        select: {
           id: true,
           status: true,
           advertiserId: true,
           platformFeePercent: true,
           startAt: true,
           endAt: true,
           budgetReservedCents: true,
           budgetSpentCents: true,
           category: true,
           advertiser: { select: { firstName: true, username: true } },
        },
      },
      channel: {
        select: {
          id: true,
          ownerId: true,
          title: true,
          username: true,
          status: true,
          telegramChannelId: true,
          botIsAdmin: true,
          canPostMessages: true,
          adPriceCents: true,
          cpmRateCents: true,
          cpcRateCents: true,
          pricingModel: true,
          avgViews: true,
          autoApprovePosts: true,
          maxPostsPerDay: true,
          minHoursBetweenAds: true,
          maxCampaignsPerHour: true,
          postingSchedule: true,
        },
      },
    },
  });
}

/*
 * NOTE: pricing and per-channel spacing are deliberately NOT resolved here.
 *
 *   - The price is frozen onto each delivery job when the campaign is planned
 *     (`snapshotPriceCents` in campaign.service.ts) and read back as
 *     `fresh.priceCents`, so a publisher raising their price mid-campaign
 *     cannot overcharge an advertiser.
 *   - The frequency gate is `checkChannelFrequency` (frequency.service.ts).
 *
 * A local `resolvePriceCents` and a local `checkChannelSpacing` used to sit
 * here, both unreferenced. They were removed: a reader who "fixed" the dead
 * copy would have changed no behaviour at all.
 */

/**
 * Rotation: prefer a creative that has not been used in this channel recently,
 * weighted by `weight`. Falls back to the job's assigned creative.
 */
async function pickCreative(campaignId: string, channelId: string, assignedAdId: string | null) {
  const creatives = await prisma.ad.findMany({
    where: { campaignId, isActive: true },
    select: {
      id: true,
      text: true,
      imageUrl: true,
      buttonText: true,
      buttonUrl: true,
      destinationUrl: true,
      trackingSlug: true,
      weight: true,
    },
    orderBy: { weight: 'desc' },
  });

  if (!creatives.length) return null;
  if (creatives.length === 1) return creatives[0];

  const usedRecently = await prisma.adPost.findMany({
    where: { campaignId, channelId },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { adId: true },
  });
  const usedIds = new Set(usedRecently.map((p) => p.adId));

  const fresh = creatives.filter((c) => !usedIds.has(c.id));
  const pool = fresh.length ? fresh : creatives;

  // Weighted random pick from the surviving pool.
  const totalWeight = pool.reduce((sum, c) => sum + Math.max(1, c.weight ?? 1), 0);
  let roll = Math.random() * totalWeight;
  for (const c of pool) {
    roll -= Math.max(1, c.weight ?? 1);
    if (roll <= 0) return c;
  }

  return pool[0] ?? creatives.find((c) => c.id === assignedAdId) ?? creatives[0];
}

/** Wrap a destination URL in our click-tracking redirect. */
export function buildTrackedUrl(destination: string | null, slug: string): string | null {
  if (!destination) return null;
  const base = process.env.APP_URL ?? '';
  return base ? `${base.replace(/\/$/, '')}/c/${slug}` : null;
}

/* ------------------------------------------------------------------
 *  Outcome writers
 * ------------------------------------------------------------------ */

async function finish(
  job: { id: string; campaignId: string },
  result: 'skipped',
  reason: string,
): Promise<PublishOutcome> {
  await prisma.deliveryJob.update({
    where: { id: job.id },
    data: {
      status: 'CANCELLED',
      processedAt: new Date(),
      errorMessage: reason,
      lockedAt: null,
    },
  });
  logger.info({ deliveryJobId: job.id, reason }, 'delivery job skipped');
  return { deliveryJobId: job.id, result, reason };
}

async function reschedule(
  job: { id: string },
  delayMs: number,
  reason: string,
): Promise<PublishOutcome> {
  const scheduledAt = new Date(Date.now() + delayMs);

  await prisma.deliveryJob.update({
    where: { id: job.id },
    data: {
      status: 'SCHEDULED',
      scheduledAt,
      errorMessage: reason,
      lockedAt: null,
      queueJobId: null,
    },
  });

  const queueJobId = await enqueuePublishAd(job.id, { delayMs, jobIdSuffix: `r${Date.now()}` });
  if (queueJobId) {
    await prisma.deliveryJob.update({ where: { id: job.id }, data: { queueJobId } });
  }

  logger.info({ deliveryJobId: job.id, reason, retryInMs: delayMs }, 'delivery job rescheduled');
  return { deliveryJobId: job.id, result: 'rescheduled', reason, nextAttemptMs: delayMs };
}

async function fail(
  job: {
    id: string;
    attempts: number;
    maxAttempts: number;
    campaignId: string;
    channelId: string;
    priceCents: number;
  },
  errorCode: DeliveryErrorCode,
  errorMessage: string,
  opts: { permanent?: boolean; retryable?: boolean } = {},
): Promise<PublishOutcome> {
  // A job that already reached a terminal state must never be rewritten: doing
  // so could release escrow that was already consumed by a successful charge.
  const current = await prisma.deliveryJob.findUnique({
    where: { id: job.id },
    select: { status: true },
  });
  if (current && ['COMPLETED', 'CANCELLED'].includes(current.status)) {
    return { deliveryJobId: job.id, result: 'already_processed', reason: current.status };
  }

  // Terminal when the error is not retryable, when the caller says so, or when
  // we have simply run out of attempts. `retryable` lets a caller force a bounded
  // retry for a transient failure that uses an otherwise non-retryable code
  // (e.g. a ledger write failing right after a successful publish).
  const exhausted =
    opts.permanent ||
    (!opts.retryable && !isRetryable(errorCode)) ||
    job.attempts >= job.maxAttempts;

  if (!exhausted) {
    const backoffMs = backoffFor(job.attempts);

    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: {
        status: 'RETRYING',
        errorCode,
        errorMessage: truncateForTelegram(errorMessage, 500),
        lockedAt: null,
        queueJobId: null,
      },
    });

    const queueJobId = await enqueuePublishAd(job.id, {
      delayMs: backoffMs,
      jobIdSuffix: `a${job.attempts}`,
    });
    if (queueJobId) {
      await prisma.deliveryJob.update({ where: { id: job.id }, data: { queueJobId } });
    }

    await recordDeliveryEvent(null, {
      deliveryJobId: job.id,
      type: 'RETRIED',
      errorCode,
      message: errorMessage,
      attempt: job.attempts,
      metadata: { backoffMs },
    });

    logger.warn(
      { deliveryJobId: job.id, errorCode, attempt: job.attempts, backoffMs },
      'delivery failed, retrying',
    );
    return { deliveryJobId: job.id, result: 'retrying', errorCode, reason: errorMessage, nextAttemptMs: backoffMs };
  }

  // ---- Terminal failure -------------------------------------------------
  // Mark the job failed AND return this slot's reservation in ONE transaction,
  // so money can never be left stranded in escrow by a crash between the two.
  await transaction(async (tx) => {
    await tx.deliveryJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        errorCode,
        errorMessage: truncateForTelegram(errorMessage, 500),
        processedAt: new Date(),
        lockedAt: null,
      },
    });

    await releaseJobReservation(tx, {
      deliveryJobId: job.id,
      campaignId: job.campaignId,
      priceCents: job.priceCents,
    });
  });

  const campaign = await prisma.campaign.findUnique({
    where: { id: job.campaignId },
    select: { advertiserId: true, name: true, id: true },
  });

  if (campaign) {
    await createNotification({
      userId: campaign.advertiserId,
      type: 'DELIVERY_FAILED',
      title: 'A sponsored post could not be delivered',
      // Plain language, not a raw Telegram error code. The advertiser needs to
      // know what happens to their money, not which HTTP status came back.
      body: `Campaign “${campaign.name}” could not be published in one channel. ${userMessage(errorCode)}`,
      data: { campaignId: campaign.id, deliveryJobId: job.id, errorCode },
    });
  }

  logger.error({ deliveryJobId: job.id, errorCode, errorMessage }, 'delivery permanently failed');
  await maybeCompleteCampaign(job.campaignId).catch(() => undefined);

  return { deliveryJobId: job.id, result: 'failed', errorCode, reason: errorMessage };
}

/**
 * Expire publisher approval requests that were never answered, and release the
 * money reserved for them. Without this a campaign could sit forever waiting on
 * a publisher who has stopped responding.
 */
export async function expireStaleApprovals(limit = 200): Promise<number> {
  const stale = await prisma.deliveryJob.findMany({
    where: {
      status: 'AWAITING_APPROVAL',
      approvalExpiresAt: { lte: new Date() },
    },
    orderBy: { approvalExpiresAt: 'asc' },
    take: limit,
    select: { id: true, campaignId: true, channelId: true, priceCents: true },
  });

  let expired = 0;

  for (const job of stale) {
    // Claim AND release in ONE transaction. If the release fails the whole thing
    // rolls back, so the row stays AWAITING_APPROVAL and the next sweep retries
    // it — the advertiser's reservation can never be stranded by a crash between
    // "cancelled" and "released".
    const claimed = await transaction(async (tx) => {
      const res = await tx.deliveryJob.updateMany({
        where: { id: job.id, status: 'AWAITING_APPROVAL' },
        data: {
          status: 'CANCELLED',
          errorMessage: 'Publisher approval request expired',
          processedAt: new Date(),
          lockedAt: null,
        },
      });
      if (res.count === 0) return false;

      await releaseJobReservation(tx, {
        deliveryJobId: job.id,
        campaignId: job.campaignId,
        priceCents: job.priceCents,
      });
      return true;
    }).catch((err) => {
      logger.error({ err, deliveryJobId: job.id }, 'failed to expire stale approval — will retry on the next sweep');
      return false;
    });
    if (!claimed) continue;

    const campaign = await prisma.campaign.findUnique({
      where: { id: job.campaignId },
      select: { advertiserId: true, name: true },
    });

    if (campaign) {
      await createNotification({
        userId: campaign.advertiserId,
        type: 'DELIVERY_FAILED',
        title: 'Ad request expired',
        body: `A publisher did not respond to your sponsored post request for “${campaign.name}” in time, so it expired. Your reserved budget for that post has been returned to your available balance.`,
        data: { campaignId: job.campaignId, deliveryJobId: job.id },
      });
    }

    await maybeCompleteCampaign(job.campaignId).catch(() => undefined);
    expired += 1;
  }

  if (expired) logger.info({ expired }, 'expired stale publisher approval requests');
  return expired;
}

/* ------------------------------------------------------------------
 *  Publisher manual approval (spec section 29)
 * ------------------------------------------------------------------ */

export async function approveAdRequest(channelOwnerId: string, deliveryJobId: string) {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    select: {
      id: true,
      status: true,
      channel: { select: { ownerId: true, title: true } },
    },
  });

  if (!job) throw new Error('Ad request not found');
  if (job.channel.ownerId !== channelOwnerId) throw new Error('This request belongs to another account');
  if (job.status !== 'AWAITING_APPROVAL') {
    throw new Error(`This request is already ${job.status}`);
  }

  // Compare-and-set, not read-then-write: two concurrent taps (two devices, or
  // a double-tap before the keyboard clears) must not both enqueue the post.
  const approved = await prisma.deliveryJob.updateMany({
    where: { id: deliveryJobId, status: 'AWAITING_APPROVAL' },
    data: { status: 'PENDING', publisherApprovedAt: new Date(), lockedAt: null, queueJobId: null },
  });
  if (approved.count === 0) throw new Error('This request is no longer awaiting approval');

  await enqueuePublishAd(deliveryJobId, { jobIdSuffix: `ap${Date.now()}` });
  logger.info({ deliveryJobId }, 'publisher approved ad request');

  return { approved: true };
}

export async function rejectAdRequest(
  channelOwnerId: string,
  deliveryJobId: string,
  reason = 'Rejected by publisher',
) {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    select: {
      id: true,
      status: true,
      campaignId: true,
      channel: { select: { ownerId: true } },
      campaign: { select: { advertiserId: true, name: true } },
    },
  });

  if (!job) throw new Error('Ad request not found');
  if (job.channel.ownerId !== channelOwnerId) throw new Error('This request belongs to another account');
  if (job.status !== 'AWAITING_APPROVAL') throw new Error(`This request is already ${job.status}`);

  // Compare-and-set for the same reason as approval: a double-tap must not run
  // the cancel + notification twice.
  const rejected = await prisma.deliveryJob.updateMany({
    where: { id: deliveryJobId, status: 'AWAITING_APPROVAL' },
    data: {
      status: 'CANCELLED',
      errorCode: 'PUBLISHER_REJECTED',
      errorMessage: reason,
      processedAt: new Date(),
      lockedAt: null,
    },
  });
  if (rejected.count === 0) throw new Error('This request is no longer awaiting approval');

  await createNotification({
    userId: job.campaign.advertiserId,
    type: 'DELIVERY_FAILED',
    title: 'Post declined by publisher',
    body: `A channel owner declined your sponsored post for “${job.campaign.name}”. Your budget for that post was not charged.`,
    data: { campaignId: job.campaignId },
  });

  await maybeCompleteCampaign(job.campaignId).catch(() => undefined);

  return { rejected: true };
}

export async function listChannelAdRequests(channelId: string, p: { skip: number; take: number }) {
  const where: Prisma.DeliveryJobWhereInput = { channelId, status: 'AWAITING_APPROVAL' };

  const [total, items] = await Promise.all([
    prisma.deliveryJob.count({ where }),
    prisma.deliveryJob.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        createdAt: true,
        campaign: {
          select: {
            id: true,
            name: true,
            advertiser: { select: { firstName: true, username: true } },
            ads: { select: { text: true }, take: 1, orderBy: { weight: 'desc' } },
          },
        },
        channel: { select: { adPriceCents: true, title: true } },
      },
    }),
  ]);

  return {
    total,
    items: items.map((job) => ({
      id: job.id,
      campaignName: job.campaign.name,
      adText: job.campaign.ads[0]?.text ?? '',
      priceCents: job.channel.adPriceCents,
      advertiserName: job.campaign.advertiser.firstName ?? job.campaign.advertiser.username ?? 'Advertiser',
      createdAt: job.createdAt,
    })),
  };
}

/* ------------------------------------------------------------------
 *  Admin queue views
 * ------------------------------------------------------------------ */

export async function deliveryQueueStats() {
  const grouped = await prisma.deliveryJob.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const total = grouped.reduce((sum, g) => sum + g._count._all, 0);

  return {
    total,
    published: byStatus.COMPLETED ?? 0,
    pending: (byStatus.PENDING ?? 0) + (byStatus.SCHEDULED ?? 0) + (byStatus.PROCESSING ?? 0),
    failed: byStatus.FAILED ?? 0,
    awaitingApproval: byStatus.AWAITING_APPROVAL ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
  };
}

export async function retryDeliveryJob(deliveryJobId: string): Promise<void> {
  const job = await prisma.deliveryJob.findUnique({
    where: { id: deliveryJobId },
    select: { id: true, status: true },
  });
  if (!job) throw new Error('Delivery job not found');
  if (job.status === 'COMPLETED') throw new Error('This post was already published');

  // A FAILED job already had its slot reservation returned to the advertiser
  // (`escrow:release:job:<id>`). Re-publishing it would charge the campaign's
  // remaining reserved budget — money earmarked for OTHER slots. Until the slot
  // can be explicitly re-held (see the HAND-OFF note in the changelog), refuse
  // the retry rather than silently take another slot's escrow.
  const alreadyReleased = await prisma.transaction.findUnique({
    where: { reference: ref.jobRelease(deliveryJobId) },
    select: { id: true },
  });
  if (alreadyReleased) {
    throw new Error(
      'This post’s reserved budget was already returned, so it cannot be retried without re-reserving the slot. Please contact support.',
    );
  }

  await prisma.deliveryJob.update({
    where: { id: deliveryJobId },
    data: {
      status: 'PENDING',
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      queueJobId: null,
      lockedAt: null,
      scheduledAt: new Date(),
    },
  });

  await enqueuePublishAd(deliveryJobId, { jobIdSuffix: `manual${Date.now()}` });
}

/**
 * Reclaim delivery jobs left in PROCESSING by a worker that died between the
 * atomic claim and the publish/charge (OOM, deploy, SIGKILL).
 *
 * Without this a stuck row can never be claimed again (`CLAIMABLE` excludes
 * PROCESSING), never swept, and never expired — the campaign stays "in flight"
 * forever and its remaining escrow is never returned. Rows whose lock is older
 * than `STALE_PROCESSING_MS` are returned to PENDING and re-enqueued; the
 * publish path already reconciles a post that the dead attempt managed to send.
 */
export async function reclaimStaleDeliveryJobs(limit = 200): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

  const stale = await prisma.deliveryJob.findMany({
    where: {
      status: 'PROCESSING',
      OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }],
    },
    orderBy: { lockedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  let reclaimed = 0;
  for (const job of stale) {
    const res = await prisma.deliveryJob.updateMany({
      where: {
        id: job.id,
        status: 'PROCESSING',
        OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }],
      },
      data: {
        status: 'PENDING',
        lockedAt: null,
        queueJobId: null,
        errorMessage: 'reclaimed_after_stale_lock',
      },
    });
    if (res.count === 0) continue;

    const queueJobId = await enqueuePublishAd(job.id, { jobIdSuffix: `stale${Date.now()}` });
    if (queueJobId) {
      await prisma.deliveryJob.update({ where: { id: job.id }, data: { queueJobId, status: 'SCHEDULED' } });
    }
    reclaimed += 1;
  }

  if (reclaimed) logger.warn({ reclaimed }, 'reclaimed delivery jobs stuck in PROCESSING');
  return reclaimed;
}

/**
 * Safety net: re-enqueue any job whose scheduled time has passed but which has
 * no queue entry — e.g. because the queue entry was lost, or because an enqueue
 * failed after the row was already written as SCHEDULED/RETRYING.
 *
 * `retry`/`reschedule` write the DB row first and the queue second; when the
 * Redis enqueue fails they leave `queueJobId = null`. Rescuing only PENDING
 * would strand those rows forever (and a SCHEDULED row counts as in-flight, so
 * the campaign could never complete and its escrow would never be released).
 */
export async function sweepDueJobs(limit = 200): Promise<number> {
  const due = await prisma.deliveryJob.findMany({
    where: {
      status: { in: ['PENDING', 'SCHEDULED', 'RETRYING'] },
      scheduledAt: { lte: new Date() },
      queueJobId: null,
    },
    orderBy: { scheduledAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const job of due) {
    const queueJobId = await enqueuePublishAd(job.id, { jobIdSuffix: `sweep${Date.now()}` });
    if (queueJobId) {
      await prisma.deliveryJob.update({ where: { id: job.id }, data: { queueJobId, status: 'SCHEDULED' } });
    }
  }

  if (due.length) logger.info({ count: due.length }, 'swept due delivery jobs');
  return due.length;
}
