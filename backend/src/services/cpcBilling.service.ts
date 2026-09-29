import type { Prisma } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { logger } from '../config/logger';
import { postLedger } from './transaction.service';
import { cpcCost, splitRevenue } from '../utils/money';
import { applyPublisherEarningBonus, publisherEarningBonusPct } from './publisherBonus.service';

/**
 * Real click-based CPC billing — and the reconciliation that makes it honest.
 *
 * CPC/HYBRID campaigns must be billed on ACTUAL valid tracked clicks, never on
 * an estimate. A VALID CLICK is exactly `Click { isFraud: false }` — duplicate /
 * self / automated traffic is already flagged by the fraud layer, so
 * `isFraud: false` is the whole definition. No extra filters.
 *
 * ── Reconciliation contract ────────────────────────────────────────────────
 * A CPC/HYBRID post is NOT charged $0 at publish: `delivery.service`
 * `resolvePriceCents` charges an up-front estimate (`max(adPriceCents,
 * cpcRateCents × 2% of avgViews)`), because the publisher has to be paid for a
 * delivered post. That up-front estimate is therefore the FLOOR, playing
 * exactly the role `adPriceCents` plays for a FIXED channel.
 *
 * Settlement then bills the DELTA between the real click bill and EVERYTHING
 * already charged for that post — the up-front estimate included. Counting only
 * the earlier `cpc:` rows (which is what this file used to do) charged the
 * advertiser the estimate AND the whole click bill for the same clicks: a
 * straight double-charge. `totalChargedCents` is the single source of what has
 * already been billed, and it reads the ledger rather than trusting a counter.
 *
 * Idempotency: the advertiser charge reference is `cpc:<adPostId>:<chargedAfter>`,
 * where `chargedAfter` is the CUMULATIVE amount billed for the post after this
 * settlement. Re-running at the same billed total produces the same reference,
 * so the unique index (and the postLedger replay check) makes it a no-op; a
 * larger delta — more clicks, or a top-up that lifts an earlier escrow cap —
 * produces a distinct reference and a genuine extra charge. Keying on the
 * billed total rather than on `owed` is what keeps a capped remainder billable
 * later instead of colliding with its own earlier capped run. Nothing is ever
 * un-billed — a click later flagged fraudulent simply stops the count from
 * growing, it never claws money back, and the publisher's floor is never
 * clawed back either.
 */

const isCpcBilledModel = (model: string): boolean => model === 'CPC' || model === 'HYBRID';

/** Count the valid (non-fraud) tracked clicks for one post. */
export async function validClickCount(adPostId: string): Promise<number> {
  return prisma.click.count({ where: { adPostId, isFraud: false } });
}

/**
 * What the advertiser currently OWES for a post:
 * validClicks × Channel.cpcRateCents.
 * 0 when the channel is not billed on clicks (CPC / HYBRID only).
 */
export async function accrueClickCharge(
  adPostId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const [clicks, post] = await Promise.all([
    db.click.count({ where: { adPostId, isFraud: false } }),
    db.adPost.findUnique({ where: { id: adPostId }, select: { channelId: true } }),
  ]);
  if (clicks <= 0 || !post) return 0;

  const channel = await db.channel.findUnique({
    where: { id: post.channelId },
    select: { pricingModel: true, cpcRateCents: true },
  });
  if (!channel || !isCpcBilledModel(channel.pricingModel)) return 0;

  return cpcCost(clicks, channel.cpcRateCents);
}

/**
 * Everything already charged to the advertiser for this post.
 *
 * Both charge kinds count, because both are money the advertiser has paid for
 * this post:
 *   - `charge:<adPostId>`  — the up-front charge at publish (the floor),
 *   - `cpc:<adPostId>:<n>` — any earlier click settlement.
 *
 * Summing only the second kind is what produced the double-charge this
 * function exists to prevent, so it deliberately filters on nothing but the
 * post id and the charge type.
 */
export async function totalChargedCents(
  adPostId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const rows = await db.transaction.findMany({
    where: { adPostId, type: 'CAMPAIGN_CHARGE', status: 'COMPLETED' },
    select: { amountCents: true },
  });
  return rows.reduce((sum, row) => sum + Math.abs(row.amountCents), 0);
}

/** Just the up-front (publish-time) charge for this post — the publisher's floor. */
export async function upfrontChargeCents(adPostId: string): Promise<number> {
  const row = await prisma.transaction.findUnique({
    where: { reference: `charge:${adPostId}` },
    select: { amountCents: true, type: true, status: true },
  });
  if (!row || row.type !== 'CAMPAIGN_CHARGE' || row.status !== 'COMPLETED') return 0;
  return Math.abs(row.amountCents);
}

/**
 * Advertiser-facing breakdown of one post's reconciliation, so the figure the
 * UI shows is provable line by line rather than an opaque total.
 *
 *   upfrontCents   what was charged at publish (the floor)
 *   owesCents      valid clicks × the channel's CPC rate
 *   chargedCents   everything charged so far
 *   deltaCents     what the next settlement would still charge (never negative)
 */
export async function cpcReconciliation(adPostId: string): Promise<{
  validClicks: number;
  cpcRateCents: number;
  upfrontCents: number;
  owesCents: number;
  chargedCents: number;
  deltaCents: number;
}> {
  const post = await prisma.adPost.findUnique({ where: { id: adPostId }, select: { channelId: true } });
  const channel = post
    ? await prisma.channel.findUnique({
        where: { id: post.channelId },
        select: { cpcRateCents: true, pricingModel: true },
      })
    : null;

  const [clicks, upfront, charged] = await Promise.all([
    validClickCount(adPostId),
    upfrontChargeCents(adPostId),
    totalChargedCents(adPostId),
  ]);

  const rate = channel && isCpcBilledModel(channel.pricingModel) ? channel.cpcRateCents : 0;
  const owes = cpcCost(clicks, rate);

  return {
    validClicks: clicks,
    cpcRateCents: rate,
    upfrontCents: upfront,
    owesCents: owes,
    chargedCents: charged,
    deltaCents: Math.max(0, owes - charged),
  };
}

/**
 * Settle one PUBLISHED post: bill the DELTA between what is owed for valid
 * clicks and what has already been billed, capped at the campaign's reserved
 * escrow. Returns how many cents this call actually settled.
 */
export async function settleCpcPost(
  adPostId: string,
): Promise<{ settledCents: number; cappedByReserved: boolean }> {
  return transaction(async (tx) => {
    // 1. Load everything the decision depends on.
    const post = await tx.adPost.findUnique({
      where: { id: adPostId },
      select: {
        id: true,
        status: true,
        campaignId: true,
        channelId: true,
        publisherId: true,
      },
    });
    if (!post) throw new Error(`settleCpcPost: adPost ${adPostId} not found`);
    if (post.status !== 'PUBLISHED') return { settledCents: 0, cappedByReserved: false };
    if (!post.campaignId) {
      logger.warn({ adPostId }, 'CPC settlement skipped: post has no campaign (house post?)');
      return { settledCents: 0, cappedByReserved: false };
    }

    // Serialize settlements against the same escrow so two concurrent posts
    // of one campaign cannot both read the same reserved amount and overdraw it.
    await tx.$queryRaw`SELECT id FROM "campaigns" WHERE id = ${post.campaignId} FOR UPDATE`;

    const campaign = await tx.campaign.findUnique({
      where: { id: post.campaignId },
      select: {
        id: true,
        advertiserId: true,
        budgetReservedCents: true,
        platformFeePercent: true,
        status: true,
      },
    });
    if (!campaign) {
      throw new Error(`settleCpcPost: campaign ${post.campaignId} not found for adPost ${adPostId}`);
    }

    const channel = await tx.channel.findUnique({
      where: { id: post.channelId },
      select: { pricingModel: true, cpcRateCents: true },
    });
    if (!channel || !isCpcBilledModel(channel.pricingModel)) {
      return { settledCents: 0, cappedByReserved: false };
    }

    // 2. owed − everything already charged (the up-front floor included).
    //    Never negative — a click later marked fraudulent must never claw money
    //    back, and the publisher's floor is never clawed back either.
    //    Both reads go through `tx`: they must see the same snapshot as the
    //    campaign FOR UPDATE above, not a different connection's committed state.
    const owed = await accrueClickCharge(adPostId, tx);
    const charged = await totalChargedCents(adPostId, tx);
    const delta = owed - charged;
    if (delta <= 0) return { settledCents: 0, cappedByReserved: false };

    // 3. Never charge beyond what is held in escrow.
    const chargeable = Math.min(delta, campaign.budgetReservedCents);
    let cappedByReserved = false;
    if (chargeable < delta) {
      cappedByReserved = true;
      logger.warn(
        {
          adPostId,
          campaignId: campaign.id,
          owed,
          charged,
          delta,
          chargeable,
          reserved: campaign.budgetReservedCents,
        },
        'CPC SETTLEMENT CAPPED by campaign reserved budget — the remainder is unbilled until the advertiser tops up (or clicks grow)',
      );
    }
    if (chargeable <= 0) return { settledCents: 0, cappedByReserved: false };

    // 4. Advertiser side. The reference embeds the CUMULATIVE billed amount
    //    (`charged + chargeable`), not the full `owed`. Embedding `owed` made a
    //    run that was capped by escrow reuse the same reference as the earlier
    //    capped run — so the remainder stayed permanently unbillable even after
    //    a top-up. Keying on the running total means: re-running at the same
    //    billed state is a no-op, while a genuinely larger delta (a top-up, or
    //    more clicks) produces a distinct reference and a real extra charge.
    const chargedAfter = charged + chargeable;
    const posted = await postLedger(tx, {
      userId: campaign.advertiserId,
      type: 'CAMPAIGN_CHARGE',
      amountCents: -chargeable,
      reference: `cpc:${adPostId}:${chargedAfter}`,
      referenceType: 'CPC_SETTLEMENT',
      walletDelta: { reserved: -chargeable, totalSpent: chargeable },
      description: 'CPC clicks settled',
      campaignId: campaign.id,
      channelId: post.channelId,
      adPostId,
    });
    if (posted.replayed) {
      // Same billed total as an already-committed settlement. No money moved in
      // this call — do NOT re-apply the publisher split or the counters.
      logger.info(
        { adPostId, reference: posted.transaction.reference },
        'CPC settlement replay — nothing new posted',
      );
      return { settledCents: 0, cappedByReserved: false };
    }

    // 5. Publisher side: split the chargeable amount, upsert the earning by
    //    DELTA, then post the publisher's share to their wallet (pending).
    //    A premium publisher's `publisherEarningBonusPct` uplifts the SAME
    //    chargeable amount, carved out of the platform fee: the advertiser pays
    //    the same (`chargeable`), and `platformFeeCents + netCents === chargeable`
    //    still holds. With pct = 0 (FREE) the split is byte-identical to
    //    `splitRevenue`'s output — nothing changes for a free publisher.
    const bonusPct = await publisherEarningBonusPct(post.publisherId);
    const split = applyPublisherEarningBonus(
      splitRevenue(chargeable, campaign.platformFeePercent),
      bonusPct,
    );
    const existing = await tx.publisherEarning.findUnique({ where: { adPostId } });
    const earning = existing
      ? await tx.publisherEarning.update({
          where: { adPostId },
          data: {
            grossCents: { increment: split.grossCents },
            platformFeeCents: { increment: split.platformFeeCents },
            netCents: { increment: split.netCents },
          },
        })
      : await tx.publisherEarning.create({
          data: {
            publisherId: post.publisherId,
            adPostId,
            channelId: post.channelId,
            campaignId: post.campaignId,
            grossCents: split.grossCents,
            platformFeeCents: split.platformFeeCents,
            netCents: split.netCents,
            status: 'PENDING',
          },
        });

    await postLedger(tx, {
      userId: post.publisherId,
      type: 'PUBLISHER_EARNING',
      amountCents: split.netCents,
      // Idempotency: unique per (post, billed total). When a premium bonus was
      // paid the reference ALSO encodes the bonus, so a replay at the same billed
      // total can never double-pay the uplift (a different bonus produces a
      // different, still-unique reference). For a FREE publisher (bonusCents 0)
      // the reference is exactly `cpc:earning:<adPostId>:<chargedAfter>` as before.
      reference:
        split.bonusCents > 0
          ? `cpc:earning:${adPostId}:${chargedAfter}:bonus:${split.bonusCents}`
          : `cpc:earning:${adPostId}:${chargedAfter}`,
      referenceType: 'CPC_SETTLEMENT',
      walletDelta: { pending: split.netCents, totalEarned: split.netCents },
      // The bonus is recorded so the earning is auditable after the fact (it is
      // also implicit in the row: platformFeeCents is the reduced fee and
      // netCents the uplifted share).
      description:
        split.bonusCents > 0
          ? `CPC clicks settled — publisher share (incl. ${split.bonusCents}-cent premium bonus)`
          : 'CPC clicks settled — publisher share',
      ...(split.bonusCents > 0
        ? { metadata: { premiumBonusCents: split.bonusCents, publisherEarningBonusPct: bonusPct } }
        : {}),
      campaignId: campaign.id,
      channelId: post.channelId,
      adPostId,
      earningId: earning.id,
    });

    // 6. Keep the denormalized counters in line with the escrow convention:
    //    reserved -= chargeable, spent += chargeable.
    await tx.adPost.update({
      where: { id: adPostId },
      data: {
        platformFeeCents: { increment: split.platformFeeCents },
        publisherEarningCents: { increment: split.netCents },
      },
    });
    await tx.campaign.update({
      where: { id: campaign.id },
      data: {
        budgetSpentCents: { increment: chargeable },
        budgetReservedCents: { decrement: chargeable },
      },
    });

    // 7.
    return { settledCents: chargeable, cappedByReserved };
  });
}

/**
 * Settle every PUBLISHED post on a CPC/HYBRID channel, oldest `updatedAt`
 * first. Each post runs in its own transaction; one bad post is logged and
 * skipped so it cannot abort the batch. Returns the number of posts that
 * actually settled money.
 */
export async function settleAllCpcPosts(limit?: number): Promise<number> {
  const posts = await prisma.adPost.findMany({
    where: {
      status: 'PUBLISHED',
      channel: { pricingModel: { in: ['CPC', 'HYBRID'] } },
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  let settled = 0;
  for (const post of posts) {
    try {
      const result = await settleCpcPost(post.id);
      if (result.settledCents > 0) settled += 1;
    } catch (err) {
      logger.error(
        { err, adPostId: post.id },
        'CPC settlement failed for one post — continuing with the rest of the batch',
      );
    }
  }
  return settled;
}

/**
 * Advertiser-facing view of click-based billing: how many CPC/HYBRID posts
 * are live, how many valid clicks they have accumulated, how much has been
 * charged, and how much is still owed against the current click counts.
 *
 * `billedCents` counts the up-front floor as well as click settlements — it is
 * what the advertiser has actually been charged, not merely the click portion,
 * so `billedCents + pendingSettlementCents` is the honest total.
 */
export async function cpcBillingSummary(
  advertiserId: string,
): Promise<{ posts: number; validClicks: number; billedCents: number; pendingSettlementCents: number }> {
  const posts = await prisma.adPost.findMany({
    where: {
      status: 'PUBLISHED',
      campaign: { advertiserId },
      channel: { pricingModel: { in: ['CPC', 'HYBRID'] } },
    },
    select: { id: true, channelId: true },
  });
  if (posts.length === 0) {
    return { posts: 0, validClicks: 0, billedCents: 0, pendingSettlementCents: 0 };
  }

  const postIds = posts.map((p) => p.id);

  const [channels, clickRows, txns] = await Promise.all([
    prisma.channel.findMany({
      where: { id: { in: posts.map((p) => p.channelId) } },
      select: { id: true, cpcRateCents: true },
    }),
    prisma.click.groupBy({
      by: ['adPostId'],
      where: { adPostId: { in: postIds }, isFraud: false },
      _count: { _all: true },
    }),
    // Every advertiser charge for these posts — the up-front floor AND any
    // click settlements. `pendingSettlementCents` is only meaningful against
    // the true total, otherwise it reports a debit that would never be taken.
    prisma.transaction.findMany({
      where: {
        adPostId: { in: postIds },
        type: 'CAMPAIGN_CHARGE',
        status: 'COMPLETED',
      },
      select: { adPostId: true, amountCents: true },
    }),
  ]);

  const rateByChannel = new Map(channels.map((c) => [c.id, c.cpcRateCents]));
  const clicksByPost = new Map<string, number>(clickRows.map((r) => [r.adPostId ?? '', r._count._all]));
  const billedByPost = new Map<string, number>();
  for (const t of txns) {
    if (t.adPostId === null) continue;
    billedByPost.set(t.adPostId, (billedByPost.get(t.adPostId) ?? 0) + Math.abs(t.amountCents));
  }

  let validClicks = 0;
  let billedCents = 0;
  let pendingSettlementCents = 0;
  for (const p of posts) {
    const clicks = clicksByPost.get(p.id) ?? 0;
    const charged = billedByPost.get(p.id) ?? 0;
    const owed = cpcCost(clicks, rateByChannel.get(p.channelId) ?? 0);
    validClicks += clicks;
    billedCents += charged;
    pendingSettlementCents += Math.max(0, owed - charged);
  }

  return { posts: posts.length, validClicks, billedCents, pendingSettlementCents };
}
