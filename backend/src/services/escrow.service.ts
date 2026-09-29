import type { Prisma } from '@prisma/client';
import { postLedger, ref } from './transaction.service';
import { assertCanSpend, lockWalletOrThrow } from './wallet.service';
import { entitlementsFor } from './premium.service';
import { splitRevenue } from '../utils/money';
import { logger } from '../config/logger';
import { BadRequestAppError } from '../utils/escrowErrors';
import { AppError, NotFoundError } from '../utils/errors';

/**
 * Thrown when a delivery charge is refused because the escrow it is drawn from
 * no longer exists: the campaign was cancelled/paused mid-flight, or a
 * concurrent charge already consumed the reservation.
 *
 * This is deliberately NOT retryable. The money is gone, so retrying would only
 * push `reserved_cents` negative and pay a publisher out of refunded escrow.
 *
 * `delivery.service` recognises this class by `err.code === 'ESCROW_INSUFFICIENT'`
 * (see `isEscrowGuardError`) and fails the job as the terminal `BUDGET_EXHAUSTED`
 * instead of retrying an operation that can never succeed — including on the
 * post-publish charge path, where the ad is already live and reloading the
 * budget is the only way forward.
 */
export class EscrowGuardError extends AppError {
  constructor(message = 'Campaign escrow no longer covers this delivery', details?: unknown) {
    super(message, 409, 'ESCROW_INSUFFICIENT', details);
  }
}

/**
 * Escrow: advertiser budget is moved out of `available` and into `reserved`
 * the moment a campaign is approved. Publishers are only paid out of money
 * that has already been reserved, so a campaign can never publish for free.
 *
 * Lifecycle
 *   hold      available -> reserved   (campaign approved)
 *   charge    reserved  -> publisher  (each post published)
 *   release   reserved  -> available  (unused budget returned on completion)
 */

export interface HoldResult {
  heldCents: number;
  alreadyHeld: boolean;
}

/**
 * Reserve `amountCents` of the advertiser's spendable balance for a campaign.
 * Idempotent per campaign — calling twice does not double-hold.
 *
 * The reservation is recorded in TWO places inside this one transaction, and
 * they must never be allowed to drift apart:
 *
 *   wallet.reservedCents          the user's money, held
 *   campaign.budgetReservedCents  this campaign's share of it
 *
 * The second one is what the delivery pre-flight compares against before
 * publishing, and what the release path refunds when a campaign closes. If only
 * the wallet moved, every delivery would fail with BUDGET_EXHAUSTED and the
 * unused budget could never be returned to the advertiser.
 */
export async function holdCampaignBudget(
  tx: Prisma.TransactionClient,
  params: { campaignId: string; advertiserId: string; amountCents: number },
): Promise<HoldResult> {
  const { campaignId, advertiserId, amountCents } = params;

  if (amountCents <= 0) return { heldCents: 0, alreadyHeld: false };

  const existing = await tx.transaction.findUnique({
    where: { reference: ref.campaignHold(campaignId) },
    select: { amountCents: true },
  });
  if (existing) {
    logger.debug({ campaignId }, 'escrow hold already exists, skipping');
    return { heldCents: Math.abs(existing.amountCents), alreadyHeld: true };
  }

  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { budgetTotalCents: true, budgetReservedCents: true },
  });
  if (!campaign) throw new NotFoundError('Campaign');
  if (campaign.budgetReservedCents + amountCents > campaign.budgetTotalCents) {
    throw new BadRequestAppError('Reserving this amount would exceed the campaign budget');
  }

  const wallet = await lockWalletOrThrow(tx, advertiserId);
  assertCanSpend(wallet, amountCents);

  await postLedger(tx, {
    userId: advertiserId,
    type: 'ESCROW_HOLD',
    amountCents: -amountCents,
    reference: ref.campaignHold(campaignId),
    referenceType: 'CAMPAIGN_HOLD',
    walletDelta: { available: -amountCents, reserved: amountCents },
    description: 'Campaign budget reserved',
    campaignId,
  });

  await tx.campaign.update({
    where: { id: campaignId },
    data: { budgetReservedCents: { increment: amountCents } },
  });

  return { heldCents: amountCents, alreadyHeld: false };
}

/**
 * Charge one delivered post and create the publisher's pending earning.
 * Called by the delivery worker inside a single DB transaction.
 */
export async function chargeDelivery(
  tx: Prisma.TransactionClient,
  params: {
    campaignId: string;
    advertiserId: string;
    publisherId: string;
    channelId: string;
    adPostId: string;
    priceCents: number;
    platformFeePercent: number;
  },
): Promise<{
  grossCents: number;
  platformFeeCents: number;
  publisherNetCents: number;
  earningId: string;
}> {
  const { campaignId, advertiserId, publisherId, channelId, adPostId, priceCents, platformFeePercent } =
    params;

  if (priceCents <= 0) throw new BadRequestAppError('Delivery price must be greater than zero');

  // Guard against double-charging the same post.
  const already = await tx.transaction.findUnique({
    where: { reference: ref.campaignCharge(adPostId) },
    select: { id: true },
  });
  if (already) throw new BadRequestAppError('This delivery has already been charged');

  // ---- Escrow guard --------------------------------------------------
  // The delivery pre-flight (delivery.service) read the campaign OUTSIDE this
  // transaction, so its budget check is a stale snapshot: between then and now
  // the advertiser may have cancelled the campaign (releasing the whole escrow)
  // or another worker may have consumed the remaining reservation. Serialize on
  // the campaign row and refuse the charge unless the escrow still covers it.
  await tx.$queryRaw`SELECT id FROM "campaigns" WHERE id = ${campaignId} FOR UPDATE`;

  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, budgetReservedCents: true },
  });
  if (!campaign) throw new EscrowGuardError('Campaign no longer exists', { campaignId });
  if (!['APPROVED', 'SCHEDULED', 'RUNNING'].includes(campaign.status)) {
    throw new EscrowGuardError(`Campaign is ${campaign.status}; this delivery cannot be charged`, {
      campaignId,
      status: campaign.status,
    });
  }

  // Guarded decrement: the WHERE clause itself carries `budget_reserved_cents
  // >= priceCents`, so the row can never go negative even if the read above is
  // stale — the affected-row count IS the assertion. The campaign counters move
  // here, atomically with the assertion, instead of in a later blind update.
  const charged = await tx.campaign.updateMany({
    where: { id: campaignId, budgetReservedCents: { gte: priceCents } },
    data: {
      budgetSpentCents: { increment: priceCents },
      budgetReservedCents: { decrement: priceCents },
    },
  });
  if (charged.count === 0) {
    throw new EscrowGuardError('Campaign reserved budget is exhausted', { campaignId, priceCents });
  }

  // The advertiser wallet is locked for the rest of this transaction, and the
  // shared `reserved` bucket is asserted to cover the charge before postLedger
  // decrements it — otherwise a charge for one campaign could drive another
  // campaign's refunds negative.
  const wallet = await lockWalletOrThrow(tx, advertiserId);
  if (wallet.reservedCents < priceCents) {
    throw new EscrowGuardError('Advertiser reserved balance no longer covers this delivery', {
      advertiserId,
      reservedCents: wallet.reservedCents,
      priceCents,
    });
  }

  const { platformFeeCents: baseFeeCents, netCents: baseNetCents } = splitRevenue(
    priceCents,
    platformFeePercent,
  );

  // ---- PREMIUM PUBLISHER EARNINGS BONUS ---------------------------------
  // A premium publisher keeps a larger share of the SAME delivery. The uplift is
  // carved OUT OF THE PLATFORM FEE — never added to the advertiser's price — so
  // the advertiser is charged exactly as before and the split still reconciles:
  //
  //     bonusCents = min(floor(net * pct / 100), platformFee)
  //     netCents        = net + bonus
  //     platformFeeCents = platformFee - bonus
  //     platformFeeCents + netCents === priceCents   (invariant preserved)
  //
  // The `min(..., platformFee)` cap guarantees the platform fee can never go
  // negative. With pct = 0 (FREE, no subscription) `bonusCents` is 0 and both
  // legs are byte-identical to the pre-premium code.
  const { publisherEarningBonusPct } = await entitlementsFor(publisherId);
  const bonusCents =
    publisherEarningBonusPct > 0
      ? Math.min(Math.floor((baseNetCents * publisherEarningBonusPct) / 100), baseFeeCents)
      : 0;
  const platformFeeCents = baseFeeCents - bonusCents;
  const netCents = baseNetCents + bonusCents;

  // 1. Advertiser's reserved budget is consumed. Money leaves escrow.
  await postLedger(tx, {
    userId: advertiserId,
    type: 'CAMPAIGN_CHARGE',
    amountCents: -priceCents,
    reference: ref.campaignCharge(adPostId),
    referenceType: 'DELIVERY_CHARGE',
    walletDelta: { reserved: -priceCents, totalSpent: priceCents },
    description: 'Sponsored post delivered',
    campaignId,
    channelId,
    adPostId,
  });

  // 2. Book the platform's cut for revenue reporting (no wallet movement —
  //    the fee is the difference between gross and net, not an extra charge).
  if (platformFeeCents > 0) {
    await postLedger(tx, {
      userId: advertiserId,
      type: 'PLATFORM_FEE',
      amountCents: -platformFeeCents,
      reference: ref.platformFee(adPostId),
      referenceType: 'PLATFORM_FEE',
      walletDelta: {},
      description: 'Platform fee on delivery',
      campaignId,
      channelId,
      adPostId,
    });
  }

  // 3. Publisher earning lands in `pending` — it is NOT withdrawable until the
  //    hold period passes and the payout job releases it.
  const earning = await tx.publisherEarning.create({
    data: {
      publisherId,
      adPostId,
      channelId,
      campaignId,
      grossCents: priceCents,
      platformFeeCents,
      netCents,
      status: 'PENDING',
    },
  });

  await postLedger(tx, {
    userId: publisherId,
    type: 'PUBLISHER_EARNING',
    amountCents: netCents,
    // Idempotency: unique per AdPost. When a premium bonus was paid the reference
    // ALSO encodes the bonus, so a replay of the same delivery at the same bonus
    // collides on the unique reference and can never double-pay the uplift. For a
    // FREE publisher (bonusCents 0) the reference is exactly `earning:<adPostId>`
    // as before.
    reference:
      bonusCents > 0
        ? `${ref.publisherEarning(adPostId)}:bonus:${bonusCents}`
        : ref.publisherEarning(adPostId),
    referenceType: 'PUBLISHER_EARNING',
    walletDelta: { pending: netCents, totalEarned: netCents },
    // The bonus is recorded so the earning is auditable after the fact. It is
    // also implicit in the row: platformFeeCents is the reduced fee and netCents
    // the uplifted share.
    description:
      bonusCents > 0
        ? `Earning from sponsored post (incl. ${bonusCents}-cent premium bonus)`
        : 'Earning from sponsored post',
    ...(bonusCents > 0
      ? { metadata: { premiumBonusCents: bonusCents, publisherEarningBonusPct } }
      : {}),
    campaignId,
    channelId,
    adPostId,
    earningId: earning.id,
  });

  // 4. Campaign counters were already moved by the guarded decrement above,
  //    atomically with the escrow assertion.

  await tx.channel.update({
    where: { id: channelId },
    data: {
      totalAdsPublished: { increment: 1 },
      totalEarnedCents: { increment: netCents },
    },
  });

  return { grossCents: priceCents, platformFeeCents, publisherNetCents: netCents, earningId: earning.id };
}

/**
 * Return unused reserved budget to the advertiser.
 * Called when a campaign completes, is cancelled, or is rejected after funds
 * were already held.
 */
export async function releaseCampaignBudget(
  tx: Prisma.TransactionClient,
  params: { campaignId: string; advertiserId: string; reason?: string; asRefund?: boolean },
): Promise<number> {
  const { campaignId, advertiserId, reason = 'campaign_closed', asRefund = false } = params;

  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { budgetReservedCents: true, budgetTotalCents: true, budgetSpentCents: true },
  });
  if (!campaign) return 0;

  // Never release more than the cap recorded at hold time.
  const held = campaign.budgetTotalCents - campaign.budgetSpentCents;
  const releasable = Math.max(0, Math.min(campaign.budgetReservedCents, held));

  if (releasable <= 0) {
    await tx.campaign.update({
      where: { id: campaignId },
      data: { budgetReservedCents: 0 },
    });
    return 0;
  }

  const reference = asRefund
    ? ref.campaignRefund(campaignId, reason)
    : ref.campaignRelease(campaignId);

  const existing = await tx.transaction.findUnique({ where: { reference }, select: { id: true } });
  if (existing) {
    logger.debug({ campaignId, reference }, 'escrow release already recorded');
    return 0;
  }

  await postLedger(tx, {
    userId: advertiserId,
    type: asRefund ? 'REFUND' : 'ESCROW_RELEASE',
    amountCents: releasable,
    reference,
    referenceType: asRefund ? 'CAMPAIGN_REFUND' : 'CAMPAIGN_RELEASE',
    walletDelta: {
      reserved: -releasable,
      available: releasable,
      ...(asRefund ? { totalRefunded: releasable } : {}),
    },
    description: asRefund ? `Campaign refund (${reason})` : `Unused campaign budget released (${reason})`,
    campaignId,
  });

  await tx.campaign.update({
    where: { id: campaignId },
    data: { budgetReservedCents: 0 },
  });

  return releasable;
}

/**
 * Move a matured publisher earning from `pending` to `available`.
 * Run by the payout worker once `availableAt` has passed.
 */
export async function releaseEarning(
  tx: Prisma.TransactionClient,
  earningId: string,
): Promise<{ released: boolean; netCents: number }> {
  const earning = await tx.publisherEarning.findUnique({
    where: { id: earningId },
    select: { id: true, publisherId: true, netCents: true, status: true, adPostId: true },
  });

  if (!earning) return { released: false, netCents: 0 };
  if (earning.status !== 'PENDING') return { released: false, netCents: earning.netCents };

  const reference = ref.earningRelease(earning.id);
  const existing = await tx.transaction.findUnique({ where: { reference }, select: { id: true } });
  if (existing) {
    // The release ledger row exists but the earning is still PENDING. Because
    // the ledger post and the status update share one transaction, this means
    // the status was reset out of band after the release committed. We cannot
    // prove whether the pending -> available movement is still reflected in the
    // wallet, so we must NOT silently flip the status: marking it AVAILABLE
    // without the movement would leave the earning looking matured forever while
    // the money stayed in `pending`. Surface it for manual reconciliation.
    logger.error(
      { earningId: earning.id, reference, publisherId: earning.publisherId, netCents: earning.netCents },
      'releaseEarning self-heal refused: release row exists but earning is still PENDING — manual reconciliation required',
    );
    return { released: false, netCents: earning.netCents };
  }

  await postLedger(tx, {
    userId: earning.publisherId,
    type: 'ESCROW_RELEASE',
    amountCents: earning.netCents,
    reference,
    referenceType: 'EARNING_RELEASE',
    walletDelta: { pending: -earning.netCents, available: earning.netCents },
    description: 'Earning matured and became withdrawable',
    adPostId: earning.adPostId,
    earningId: earning.id,
  });

  await tx.publisherEarning.update({
    where: { id: earning.id },
    data: { status: 'AVAILABLE', availableAt: new Date() },
  });

  return { released: true, netCents: earning.netCents };
}

/**
 * Release the reservation held for ONE delivery slot, leaving the rest of the
 * campaign's escrow untouched.
 *
 * Used when a post permanently fails, or when a publisher's approval request
 * expires. The advertiser must never have money parked in `reserved` for a post
 * that will never be published — that is the whole point of tracking escrow
 * per delivery rather than only per campaign.
 *
 * Idempotent per job: `escrow:release:job:<deliveryJobId>`.
 */
export async function releaseJobReservation(
  tx: Prisma.TransactionClient,
  params: { deliveryJobId: string; campaignId: string; priceCents: number },
): Promise<number> {
  const { deliveryJobId, campaignId, priceCents } = params;
  if (priceCents <= 0) return 0;

  const campaign = await tx.campaign.findUnique({
    where: { id: campaignId },
    select: { advertiserId: true, budgetReservedCents: true },
  });
  if (!campaign) return 0;

  // Never release more than the campaign actually still holds.
  const releasable = Math.min(priceCents, Math.max(0, campaign.budgetReservedCents));
  if (releasable <= 0) return 0;

  const reference = ref.jobRelease(deliveryJobId);
  const existing = await tx.transaction.findUnique({ where: { reference }, select: { id: true } });
  if (existing) return 0;

  await postLedger(tx, {
    userId: campaign.advertiserId,
    type: 'ESCROW_RELEASE',
    amountCents: releasable,
    reference,
    referenceType: 'DELIVERY_SLOT_RELEASE',
    walletDelta: { reserved: -releasable, available: releasable },
    description: 'Reserved budget returned — this delivery will not run',
    campaignId,
  });

  await tx.campaign.update({
    where: { id: campaignId },
    data: { budgetReservedCents: { decrement: releasable } },
  });

  logger.info({ deliveryJobId, campaignId, releasable }, 'delivery slot reservation released');
  return releasable;
}

/** How much budget a campaign still has available to spend. */
export function remainingBudgetCents(campaign: {
  budgetTotalCents: number;
  budgetSpentCents: number;
}): number {
  return Math.max(0, campaign.budgetTotalCents - campaign.budgetSpentCents);
}
