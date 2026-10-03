import type { AdFormat, CampaignStatus, ChannelCategory, Prisma, PromotionTarget } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { holdCampaignBudget, releaseCampaignBudget } from './escrow.service';
import { validateDestinationUrl } from './urlSecurity.service';
import { evaluateCampaignCategory } from './categoryPolicy.service';
import { detectDuplicateCampaign } from './duplicate.service';
import { createCreativeVersions } from './creative.service';
import { blockedChannelIdsForCampaign } from './blocklist.service';
import { computeReachPlan } from './reachEstimator.service';
import { assertTransition, transitionCampaign } from './campaignStateMachine';
import { resolveTargets, snapshotPriceCents, type TargetingFilter } from './targeting.service';
import { businessRules } from './settings.service';
import { FREE_ENTITLEMENTS, checkQuota, entitlementsFor } from './premium.service';
import { recordAudit } from './audit.service';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { trackingSlug } from '../utils/crypto';
import { cancelDeliveryJob, enqueuePublishAd } from '../queues/producers';
import { logger } from '../config/logger';

/**
 * Campaign lifecycle
 *
 *   DRAFT -> PENDING_REVIEW -> APPROVED -> SCHEDULED/RUNNING -> COMPLETED
 *                          \-> REJECTED
 *   RUNNING <-> PAUSED,  RUNNING -> SUSPENDED, any -> CANCELLED
 *
 * Money rule: the budget is held in escrow the moment the campaign is
 * submitted. It is only spent as posts are actually published, and any
 * remainder is released back on completion, cancellation or rejection.
 */

export const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  status: true,
  promotionTarget: true,
  pricingModel: true,
  budgetTotalCents: true,
  budgetSpentCents: true,
  budgetReservedCents: true,
  platformFeePercent: true,
  frequencyPerChannel: true,
  isAutoTargeting: true,
  targeting: true,
  startAt: true,
  endAt: true,
  rejectReason: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CampaignSelect;

/* ------------------------------------------------------------------
 *  Create
 * ------------------------------------------------------------------ */

export interface CreativeInput {
  format?: AdFormat;
  text: string;
  imageUrl?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  destinationUrl?: string | null;
  weight?: number;
}

export interface CreateCampaignInput {
  name: string;
  /** The advertiser's language. A PAID post is published in this language. */
  language?: string | null;
  /** Drives the platform category policy and any publisher blocklist. */
  category?: ChannelCategory | null;
  promotionTarget?: PromotionTarget;
  pricingModel?: 'FIXED' | 'CPM' | 'CPC' | 'HYBRID';
  budgetCents: number;
  frequencyPerChannel?: number;
  isAutoTargeting?: boolean;
  targeting?: TargetingFilter;
  channelIds?: string[];
  startAt?: Date | null;
  endAt?: Date | null;
  creatives: CreativeInput[];
}

export interface CreateCampaignResult {
  campaignId: string;
  status: CampaignStatus;
  targetChannels: number;
  reservedCents: number;
  totalCostCents: number;
}

export async function createCampaign(
  advertiserId: string,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const minBudget = await businessRules.minCampaignBudgetCents();
  if (input.budgetCents < minBudget) {
    throw new ValidationError(`Minimum campaign budget is ${(minBudget / 100).toFixed(2)}`);
  }

  // ---- ENTITLEMENT GATES (premium) ---------------------------------------
  // Resolved from the advertiser's live entitlements. A user with no active
  // subscription resolves to the FREE baseline, so nothing below changes what a
  // free advertiser could already do.
  const entitlements = await entitlementsFor(advertiserId);

  // (1) Active-campaign quota. Checked here, BEFORE anything is reserved, so a
  //     blocked campaign never touches escrow. FREE = 2 concurrent campaigns.
  const campaignQuota = await checkQuota(advertiserId, 'activeCampaigns');
  if (!campaignQuota.allowed) {
    throw new ValidationError(
      campaignQuota.message ??
        `You can run ${campaignQuota.limit} active campaigns. Upgrade to Premium to run more.`,
    );
  }

  // (2) Maximum campaign budget for this advertiser. `-1` means unlimited.
  //     FREE = 100000 cents ($1,000.00), the value declared in FREE_ENTITLEMENTS.
  if (
    entitlements.maxCampaignBudgetCents >= 0 &&
    input.budgetCents > entitlements.maxCampaignBudgetCents
  ) {
    throw new ValidationError(
      `Your maximum campaign budget is $${(entitlements.maxCampaignBudgetCents / 100).toFixed(2)}. Upgrade to Premium to raise this limit.`,
    );
  }

  if (!input.creatives?.length) throw new ValidationError('At least one ad creative is required');

  const frequency = Math.min(Math.max(input.frequencyPerChannel ?? 1, 1), 3);

  // ---- PRE-FLIGHT POLICY CHECKS ------------------------------------------
  // These run BEFORE any money or database write: a campaign that cannot be
  // accepted should fail without reserving a single cent.
  let forceReview = false;

  // (a) Destination URL security. A hard block refuses the campaign outright;
  //     a softer signal routes it to review instead of rejecting it.
  for (const creative of input.creatives) {
    for (const candidate of [creative.destinationUrl, creative.buttonUrl]) {
      if (!candidate) continue;
      const verdict = await validateDestinationUrl(candidate);
      if (!verdict.ok || verdict.hardBlock) {
        throw new ValidationError(
          `This destination link cannot be used: ${verdict.reasons.join('; ') || 'invalid URL'}`,
        );
      }
      if (verdict.reasons.length > 0) forceReview = true;
    }
  }

  // (b) Platform category policy.
  const categoryVerdict = await evaluateCampaignCategory(input.category ?? null);
  if (categoryVerdict.blocked) {
    throw new ValidationError(categoryVerdict.message ?? 'This advertising category is not accepted.');
  }
  if (categoryVerdict.requiresReview) forceReview = true;

  // (c) Duplicate advertisement detection. Never blocks — flags and routes.
  const duplicate = await detectDuplicateCampaign({
    advertiserId,
    creatives: input.creatives.map((c) => ({ text: c.text, imageUrl: c.imageUrl ?? null })),
    destinationUrl: input.creatives.find((c) => c.destinationUrl)?.destinationUrl ?? null,
  });
  if (duplicate.severity === 'REVIEW') forceReview = true;

  // (d) What audience does this budget buy? Frozen onto the campaign so the
  //     figure the advertiser was shown can never drift.
  const reachPlan = await computeReachPlan(input.budgetCents);

  // 1. Resolve targets FIRST — we must know the real cost before touching money.
  const resolved = await resolveTargets({
    isAutoTargeting: Boolean(input.isAutoTargeting),
    channelIds: input.channelIds ?? [],
    filter: input.targeting ?? {},
    budgetCents: input.budgetCents,
    frequencyPerChannel: frequency,
  });

  if (resolved.targets.length === 0) {
    throw new ValidationError(
      'No eligible channels match this campaign. Widen your targeting or pick different channels.',
    );
  }

  // ---- CHANNEL-LEVEL POLICY FILTER --------------------------------------
  // A publisher can block this advertiser, this campaign, this category or a
  // domain; and a channel can set a minimum price. All of that is applied here,
  // after resolution, and the cost is RECOMPUTED from the survivors so the
  // advertiser is never charged for a channel that refused them.
  const excluded = await blockedChannelIdsForCampaign({
    advertiserId,
    category: input.category ?? null,
    domain: input.creatives.find((c) => c.destinationUrl)?.destinationUrl ?? null,
    channelIds: resolved.targets.map((t) => t.channelId),
  });
  const excludedSet = new Set(excluded);

  const channelRows = await prisma.channel.findMany({
    where: { id: { in: resolved.targets.map((t) => t.channelId) } },
    select: { id: true, acceptAds: true, minAdPriceCents: true, title: true },
  });
  const channelById = new Map(channelRows.map((c) => [c.id, c]));

  const targets = resolved.targets.filter((t) => {
    const channel = channelById.get(t.channelId);
    if (!channel) return false;
    if (excludedSet.has(t.channelId)) return false;
    if (!channel.acceptAds) return false;
    if (channel.minAdPriceCents > 0 && t.priceCents < channel.minAdPriceCents) return false;
    return true;
  });

  if (targets.length === 0) {
    throw new ValidationError(
      'No channel is currently accepting this campaign. Publishers may have paused ads, set a higher minimum price, or blocked this category.',
    );
  }

  const costCents = targets.reduce((sum, t) => sum + t.priceCents * frequency, 0);
  if (costCents > input.budgetCents) {
    throw new ValidationError(
      `Selected channels cost ${(costCents / 100).toFixed(2)}, which exceeds the budget of ${(input.budgetCents / 100).toFixed(2)}`,
    );
  }

  // ---- Platform fee + review gate from the advertiser's ENTITLEMENT ---------
  // The fee is snapshotted onto the campaign and its delivery jobs below, so a
  // lapsed subscriber keeps the fee the campaign was bought under.
  //
  // FREE handling: a premium fee can only come from a subscription benefit. The
  // resolved entitlement equals the free baseline (FREE_ENTITLEMENTS
  // .platformFeePercent, 20) for every non-subscriber, so in that case we fall
  // back to the live admin setting — an admin who tuned `platform_fee_percent`
  // keeps controlling free accounts exactly as before. A subscription that
  // overrides the fee gets its own (lower) number.
  const globalFeePercent = await businessRules.platformFeePercent();
  const platformFeePercent =
    entitlements.platformFeePercent === FREE_ENTITLEMENTS.platformFeePercent
      ? globalFeePercent
      : entitlements.platformFeePercent;

  // A premium advertiser may skip manual review — but only for an otherwise-clean
  // campaign. `forceReview` (URL, category or duplicate signal) still outranks
  // this below, and a hard policy block has already thrown before we get here.
  const autoApprove =
    (await businessRules.autoApproveCampaigns()) || entitlements.autoApproveCampaigns;

  // Everything below happens in ONE transaction: the campaign row, its
  // creatives, the explicit targets, the escrow hold and the delivery plan.
  // If any step fails the advertiser's money is never touched.
  return transaction(
    async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          advertiserId,
          name: input.name.slice(0, 120),
          promotionTarget: input.promotionTarget ?? 'CHANNEL',
          pricingModel: input.pricingModel ?? 'FIXED',
          budgetTotalCents: input.budgetCents,
          budgetReservedCents: 0,
          platformFeePercent,
          frequencyPerChannel: frequency,
          isAutoTargeting: Boolean(input.isAutoTargeting),
          targeting: (input.targeting ?? {}) as never,
          startAt: input.startAt ?? null,
          endAt: input.endAt ?? null,
          // The advertiser's language decides the language of a PAID post.
          language: (input.language ?? 'en').slice(0, 8),
          category: input.category ?? null,
          // The reach band the advertiser was actually shown, frozen here.
          estimatedReachMin: reachPlan.reachMin,
          estimatedReachMax: reachPlan.reachMax,
          reachBasis: reachPlan.reachBasis,
          planSnapshot: {
            advertiserCpmCents: reachPlan.advertiserCpmCents,
            reachTarget: reachPlan.reachTarget,
            channels: targets.length,
            posts: targets.length * frequency,
            costCents,
            duplicateSeverity: duplicate.severity,
            forcedReview: forceReview,
          } as never,
          // A flagged URL, category or duplicate forces review even when
          // auto-approval is on — a policy signal outranks convenience.
          status: autoApprove && !forceReview ? 'APPROVED' : 'PENDING_REVIEW',
          ...(autoApprove && !forceReview ? { reviewedAt: new Date() } : {}),
        },
        select: { id: true, status: true },
      });

      // Creatives — each gets its own click-tracking slug.
      await tx.ad.createMany({
        data: input.creatives.map((c) => ({
          campaignId: campaign.id,
          format: c.format ?? 'TEXT',
          text: c.text.slice(0, 2000),
          imageUrl: c.imageUrl ?? null,
          buttonText: c.buttonText ?? null,
          buttonUrl: c.buttonUrl ?? null,
          destinationUrl: c.destinationUrl ?? null,
          trackingSlug: trackingSlug(),
          weight: Math.min(Math.max(c.weight ?? 1, 1), 10),
        })),
      });

      // Explicit targets, so the marketplace can show what was bought.
      await tx.campaignTarget.createMany({
        data: targets.map((t) => ({
          campaignId: campaign.id,
          channelId: t.channelId,
          priceCents: t.priceCents,
        })),
        skipDuplicates: true,
      });

      // Creative history + content fingerprints. Version 1 is recorded so a
      // later edit appends version 2 rather than overwriting this one.
      const adRows = await tx.ad.findMany({
        where: { campaignId: campaign.id },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const ad of adRows) {
        await createCreativeVersions(tx, {
          adId: ad.id,
          creatives: input.creatives.map((c) => ({
            format: c.format ?? 'TEXT',
            text: c.text,
            imageUrl: c.imageUrl ?? null,
            buttonText: c.buttonText ?? null,
            buttonUrl: c.buttonUrl ?? null,
            destinationUrl: c.destinationUrl ?? null,
          })),
          actorId: advertiserId,
        });
      }

      // Reserve the money now, against the real campaign id.
      await holdCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId,
        amountCents: costCents,
      });

      const jobs = await planDeliveryJobs(tx, {
        campaignId: campaign.id,
        targets: targets.map((t) => ({ channelId: t.channelId, priceCents: t.priceCents })),
        frequency,
        startAt: input.startAt ?? null,
        platformFeePercent,
      });

      return {
        campaignId: campaign.id,
        status: campaign.status as CampaignStatus,
        targetChannels: targets.length,
        reservedCents: costCents,
        totalCostCents: costCents,
        jobCount: jobs.length,
      };
    },
    { timeout: 30_000, retries: 2 },
  );
}

/* ------------------------------------------------------------------
 *  Delivery planning
 * ------------------------------------------------------------------ */

interface PlanParams {
  campaignId: string;
  targets: Array<{ channelId: string; priceCents: number }>;
  frequency: number;
  startAt: Date | null;
  platformFeePercent: number;
}

/**
 * Price resolved ONCE, at planning time, and then frozen onto every delivery
 * job. A publisher raising `adPriceCents` after a campaign exists must never
 * change what that campaign pays.
 *
 * The SAME `snapshotPriceCents` helper (imported from targeting.service) is
 * what `resolveTargets` prices the reservation with, so the estimate the
 * advertiser was shown, the escrow hold and the frozen job price always agree.
 *
 * Create one DeliveryJob per (channel × frequency) using the lightest-weight
 * creative for now — rotation is applied at publish time.
 */
async function planDeliveryJobs(
  tx: Prisma.TransactionClient,
  params: PlanParams,
): Promise<Array<{ id: string; channelId: string; scheduledAt: Date }>> {
  const { campaignId, targets, frequency, startAt, platformFeePercent } = params;

  const creatives = await tx.ad.findMany({
    where: { campaignId, isActive: true },
    orderBy: { weight: 'desc' },
    select: { id: true },
  });
  if (!creatives.length) throw new ValidationError('Campaign has no active creatives');

  const baseTime = startAt && startAt.getTime() > Date.now() ? startAt.getTime() : Date.now();
  const MIN_SPACING_MS = 30 * 60 * 1000; // never fan out the same ad instantly

  const rows: Prisma.DeliveryJobCreateManyInput[] = [];

  for (const target of targets) {
    for (let i = 0; i < frequency; i += 1) {
      rows.push({
        campaignId,
        channelId: target.channelId,
        adId: creatives[i % creatives.length]?.id,
        // 0-based repetition index within this target. Part of the uniqueness
        // key (@@unique([campaignId, channelId, adId, seq])), so a campaign
        // with a single creative and frequency > 1 still produces `frequency`
        // distinct jobs instead of being collapsed by skipDuplicates.
        seq: i,
        status: 'PENDING',
        scheduledAt: new Date(baseTime + i * MIN_SPACING_MS),
        // PRICING SNAPSHOT + FEE SNAPSHOT — both frozen for the life of the job.
        //
        // `target.priceCents` IS the frozen snapshot: it is the price `resolveTargets`
        // used to compute `costCents`, which is what `holdCampaignBudget` reserved a few
        // lines earlier in this same transaction. The job used to re-read the channel row
        // here and prefer that instead, which agreed only because the read happened in
        // the same transaction — the ledger and the job would have diverged the moment
        // anything moved this call. The two must be the same number by construction, not
        // by timing, so the reserved price is what is written.
        priceCents: target.priceCents,
        platformFeePercent,
      });
    }
  }

  await tx.deliveryJob.createMany({ data: rows, skipDuplicates: true });

  return tx.deliveryJob.findMany({
    where: { campaignId },
    select: { id: true, channelId: true, scheduledAt: true },
  });
}

/**
 * Push a campaign's pending jobs onto the queue.
 * Called on approval and on resume. Uses delayed jobs rather than an
 * in-process timer, because Render web services sleep.
 */
export async function enqueueCampaignJobs(campaignId: string): Promise<number> {
  const jobs = await prisma.deliveryJob.findMany({
    where: { campaignId, status: { in: ['PENDING', 'SCHEDULED'] } },
    select: { id: true, scheduledAt: true, queueJobId: true },
  });

  let queued = 0;
  for (const job of jobs) {
    if (job.queueJobId) continue;
    const delayMs = Math.max(0, job.scheduledAt.getTime() - Date.now());
    const queueJobId = await enqueuePublishAd(job.id, { delayMs });
    if (queueJobId) {
      await prisma.deliveryJob.update({
        where: { id: job.id },
        data: { queueJobId, status: 'SCHEDULED' },
      });
      queued += 1;
    }
  }

  logger.info({ campaignId, queued }, 'campaign delivery jobs enqueued');
  return queued;
}

/**
 * Remove the queued (delayed/waiting) BullMQ entry of every not-yet-run job of a
 * campaign and clear its `queueJobId`.
 *
 * Called when a campaign is paused. Left in place, a delayed queue job fires
 * while the campaign is PAUSED; the delivery worker then sees the paused status,
 * `finish()`es the job as CANCELLED and the slot is lost forever (resume only
 * re-enqueues PENDING/SCHEDULED rows). Clearing `queueJobId` lets `resume` put
 * the slot back on the queue.
 */
async function cancelScheduledQueueJobs(campaignId: string): Promise<number> {
  const jobs = await prisma.deliveryJob.findMany({
    where: { campaignId, queueJobId: { not: null }, status: { in: ['PENDING', 'SCHEDULED'] } },
    select: { id: true, queueJobId: true },
  });

  let cancelled = 0;
  for (const job of jobs) {
    if (!job.queueJobId) continue;
    await cancelDeliveryJob(job.queueJobId);
    await prisma.deliveryJob.update({ where: { id: job.id }, data: { queueJobId: null } });
    cancelled += 1;
  }

  return cancelled;
}

/* ------------------------------------------------------------------
 *  Admin transitions
 * ------------------------------------------------------------------ */

export async function approveCampaign(
  adminId: string,
  campaignId: string,
  note?: string,
): Promise<{ enqueued: number }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, startAt: true, endAt: true },
  });
  if (!campaign) throw new NotFoundError('Campaign');
  const from = campaign.status;
  // assertTransition produces the precise "allowed from X" message, so the rule
  // lives in exactly one place instead of being duplicated here.
  if (from !== 'PENDING_REVIEW' && from !== 'PAUSED') assertTransition(from, 'APPROVED');

  const startsInFuture = campaign.startAt ? campaign.startAt.getTime() > Date.now() : false;
  const runningState: CampaignStatus = startsInFuture ? 'SCHEDULED' : 'RUNNING';

  await transaction(async (tx) => {
    await transitionCampaign(tx, {
      campaignId,
      from,
      to: 'APPROVED',
      actorType: 'ADMIN',
      actorId: adminId,
      reason: note,
      extraData: {
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
        rejectReason: null,
      },
    });

    // Approval and going live are two DISTINCT transitions in the lifecycle.
    // `runningState` is always SCHEDULED or RUNNING, so this is unconditional.
    await transitionCampaign(tx, {
      campaignId,
      from: 'APPROVED',
      to: runningState,
      actorType: 'ADMIN',
      actorId: adminId,
      reason: 'approved',
    });
  });

  const enqueued = await enqueueCampaignJobs(campaignId);
  return { enqueued };
}

export async function rejectCampaign(
  adminId: string,
  campaignId: string,
  reason: string,
): Promise<void> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, advertiserId: true },
  });
  if (!campaign) throw new NotFoundError('Campaign');

  await transaction(async (tx) => {
    await tx.campaign.update({
      where: { id: campaignId },
      data: {},
    });

    await transitionCampaign(tx, {
      campaignId,
      from: campaign.status,
      to: 'REJECTED',
      actorType: 'ADMIN',
      actorId: adminId,
      reason,
      extraData: { rejectReason: reason, reviewedById: adminId, reviewedAt: new Date() },
    });

    // Give the advertiser their money back immediately.
    await releaseCampaignBudget(tx, {
      campaignId,
      advertiserId: campaign.advertiserId,
      reason: 'rejected',
      asRefund: true,
    });

    await tx.deliveryJob.updateMany({
      where: { campaignId, status: { in: ['PENDING', 'SCHEDULED', 'AWAITING_APPROVAL'] } },
      data: { status: 'CANCELLED' },
    });
  });

  await recordAudit({
    actorId: adminId,
    action: 'CAMPAIGN_REJECTED',
    targetType: 'CAMPAIGN',
    targetId: campaignId,
    oldValue: { status: campaign.status },
    newValue: { status: 'REJECTED', reason },
  });
}

/* ------------------------------------------------------------------
 *  Owner transitions
 * ------------------------------------------------------------------ */

export async function setCampaignStatus(
  advertiserId: string,
  campaignId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<{ status: CampaignStatus }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, advertiserId: true },
  });
  if (!campaign) throw new NotFoundError('Campaign');
  if (campaign.advertiserId !== advertiserId) throw new ForbiddenError('This campaign belongs to another account');

  switch (action) {
    case 'pause': {
      if (!['RUNNING', 'SCHEDULED', 'APPROVED'].includes(campaign.status)) {
        throw new ConflictError(`Cannot pause a campaign in status ${campaign.status}`);
      }
      // Stop the delayed queue entries BEFORE flipping the status. A delayed
      // BullMQ job that fires while the campaign is PAUSED is finished as
      // CANCELLED and never re-queued on resume.
      await cancelScheduledQueueJobs(campaignId);
      await transaction(async (tx) => {
        await transitionCampaign(tx, {
          campaignId,
          from: campaign.status,
          to: 'PAUSED',
          actorType: 'USER',
          actorId: advertiserId,
          reason: 'paused by advertiser',
        });
        await tx.deliveryJob.updateMany({
          where: { campaignId, status: { in: ['PENDING', 'SCHEDULED'] } },
          data: { status: 'PENDING' },
        });
      });
      return { status: 'PAUSED' };
    }

    case 'resume': {
      if (campaign.status !== 'PAUSED') {
        throw new ConflictError('Only a paused campaign can be resumed');
      }
      const startsInFuture = false; // paused campaigns resume immediately
      const next: CampaignStatus = startsInFuture ? 'SCHEDULED' : 'RUNNING';
      await transaction(async (tx) => {
        await transitionCampaign(tx, {
          campaignId,
          from: 'PAUSED',
          to: next,
          actorType: 'USER',
          actorId: advertiserId,
          reason: 'resumed by advertiser',
        });
      });
      // A job that was already in flight when the pause happened is finished as
      // CANCELLED by the delivery worker (campaign_status_PAUSED). It never
      // published an ad, so put the slot back for re-queueing.
      await prisma.deliveryJob.updateMany({
        where: {
          campaignId,
          status: 'CANCELLED',
          errorMessage: 'campaign_status_PAUSED',
          adPost: { is: null },
        },
        data: { status: 'PENDING', queueJobId: null, processedAt: null, errorMessage: null },
      });
      await enqueueCampaignJobs(campaignId);
      return { status: next };
    }

    case 'cancel': {
      if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(campaign.status)) {
        throw new ConflictError(`Campaign is already ${campaign.status}`);
      }
      await transaction(async (tx) => {
        await transitionCampaign(tx, {
          campaignId,
          from: campaign.status,
          to: 'CANCELLED',
          actorType: 'USER',
          actorId: advertiserId,
          reason: 'cancelled by advertiser',
        });
        await tx.deliveryJob.updateMany({
          where: { campaignId, status: { in: ['PENDING', 'SCHEDULED', 'AWAITING_APPROVAL'] } },
          data: { status: 'CANCELLED' },
        });
        await releaseCampaignBudget(tx, {
          campaignId,
          advertiserId,
          reason: 'cancelled',
        });
      });
      return { status: 'CANCELLED' };
    }

    default:
      throw new ValidationError('Unknown action');
  }
}

/* ------------------------------------------------------------------
 *  Read
 * ------------------------------------------------------------------ */

export async function listCampaigns(
  advertiserId: string,
  filter: { status?: CampaignStatus },
  p: Pagination,
) {
  const where: Prisma.CampaignWhereInput = {
    advertiserId,
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: CAMPAIGN_SELECT,
    }),
  ]);

  return buildPaginated(items, total, p);
}

export async function getCampaignDetail(advertiserId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      ...CAMPAIGN_SELECT,
      advertiserId: true,
      ads: {
        select: {
          id: true,
          format: true,
          text: true,
          imageUrl: true,
          buttonText: true,
          buttonUrl: true,
          destinationUrl: true,
          trackingSlug: true,
          weight: true,
          isActive: true,
        },
      },
      targets: {
        select: {
          priceCents: true,
          channel: {
            select: { id: true, title: true, username: true, subscriberCount: true, avgViews: true },
          },
        },
      },
    },
  });

  if (!campaign) throw new NotFoundError('Campaign');
  if (campaign.advertiserId !== advertiserId) throw new ForbiddenError('This campaign belongs to another account');

  const stats = await campaignDeliveryStats(campaignId);

  return { ...campaign, stats };
}

/** Delivery breakdown used by both the advertiser UI and the admin queue. */
export async function campaignDeliveryStats(campaignId: string) {
  const grouped = await prisma.deliveryJob.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });

  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const postAgg = await prisma.adPost.aggregate({
    where: { campaignId },
    _sum: { views: true, clicks: true },
    _count: { _all: true },
  });

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { budgetTotalCents: true, budgetSpentCents: true, budgetReservedCents: true },
  });

  const views = postAgg._sum.views ?? 0;
  const clicks = postAgg._sum.clicks ?? 0;

  return {
    targetChannels: Object.values(byStatus).reduce((a, b) => a + b, 0),
    published: byStatus.PUBLISHED ?? 0,
    pending: (byStatus.PENDING ?? 0) + (byStatus.SCHEDULED ?? 0) + (byStatus.PROCESSING ?? 0),
    failed: byStatus.FAILED ?? 0,
    awaitingApproval: byStatus.AWAITING_APPROVAL ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
    posts: postAgg._count._all,
    views,
    clicks,
    ctr: views > 0 ? Math.round((clicks / views) * 10000) / 100 : 0,
    remainingBudgetCents: campaign
      ? Math.max(0, campaign.budgetTotalCents - campaign.budgetSpentCents)
      : 0,
  };
}

/**
 * Auto-complete a campaign once every job is terminal.
 * Called by the scheduler sweep — completing early would strand budget
 * in escrow, so we only do it when nothing is left in flight.
 */
export async function maybeCompleteCampaign(campaignId: string): Promise<boolean> {
  const inFlight = await prisma.deliveryJob.count({
    where: {
      campaignId,
      status: { in: ['PENDING', 'SCHEDULED', 'PROCESSING', 'LOCKED', 'AWAITING_APPROVAL'] },
    },
  });
  if (inFlight > 0) return false;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, advertiserId: true },
  });
  // EXPIRED is terminal too. Without it here, a job finishing just after the campaign
  // expired would flip EXPIRED back to COMPLETED — the delivery worker calls this after
  // every terminal job.
  if (!campaign || ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(campaign.status)) {
    return false;
  }

  await transaction(async (tx) => {
    await transitionCampaign(tx, {
      campaignId,
      from: campaign.status,
      to: 'COMPLETED',
      actorType: 'SYSTEM',
      actorId: null,
      reason: 'every delivery reached a terminal state',
    });
    await releaseCampaignBudget(tx, {
      campaignId,
      advertiserId: campaign.advertiserId,
      reason: 'completed',
    });
  });

  logger.info({ campaignId }, 'campaign completed and escrow released');
  return true;
}

/**
 * Close out a campaign whose `endAt` has passed.
 *
 * The expiry sweep used to cancel the campaign's queued jobs and then hand it to
 * `maybeCompleteCampaign`, which moves to COMPLETED. `EXPIRED` — a state the enum
 * declares and every status filter, report and API response understands — was
 * therefore never written once: a campaign the deadline had cut short was reported as
 * having completed, everywhere.
 *
 * Which of the two it is, is decided from what the campaign delivered rather than from
 * what this sweep happened to do, because a previous sweep may already have cancelled
 * the jobs:
 *
 *   every slot delivered, none cancelled   → COMPLETED (the end time arrived with the
 *                                             work done; nothing was lost)
 *   at least one slot cancelled            → EXPIRED   (the deadline ended it early)
 *
 * Returns false — leaving the campaign for the next sweep — while anything is still in
 * flight, the same rule `maybeCompleteCampaign` applies.
 */
export async function finaliseExpiredCampaign(campaignId: string): Promise<boolean> {
  const inFlight = await prisma.deliveryJob.count({
    where: {
      campaignId,
      status: { in: ['PENDING', 'SCHEDULED', 'PROCESSING', 'LOCKED', 'AWAITING_APPROVAL'] },
    },
  });
  if (inFlight > 0) return false;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true, advertiserId: true },
  });
  if (!campaign) return false;
  if (!['APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'].includes(campaign.status)) return false;

  const cancelledJobs = await prisma.deliveryJob.count({
    where: { campaignId, status: 'CANCELLED' },
  });
  const to = cancelledJobs > 0 ? 'EXPIRED' : 'COMPLETED';

  await transaction(async (tx) => {
    await transitionCampaign(tx, {
      campaignId,
      from: campaign.status as CampaignStatus,
      to,
      actorType: 'SYSTEM',
      actorId: null,
      reason:
        to === 'EXPIRED'
          ? `the campaign end time passed with ${cancelledJobs} slot(s) cancelled`
          : 'every delivery reached a terminal state before the end time',
    });
    await releaseCampaignBudget(tx, {
      campaignId,
      advertiserId: campaign.advertiserId,
      reason: to === 'EXPIRED' ? 'expired' : 'completed',
    });
  });

  logger.info({ campaignId, status: to, cancelledJobs }, 'campaign closed after its end time');
  return true;
}
