import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, transaction } from '../src/db/prisma';
import {
  chargeDelivery,
  holdCampaignBudget,
  releaseCampaignBudget,
  releaseEarning,
  releaseJobReservation,
  remainingBudgetCents,
} from '../src/services/escrow.service';
import { ref } from '../src/services/transaction.service';
import { BadRequestAppError } from '../src/utils/escrowErrors';
import { InsufficientBalanceError } from '../src/utils/errors';
import {
  createAd,
  createCampaign,
  createChannel,
  createDeliveryJob,
  createUser,
  resetDatabase,
  walletOf,
} from './helpers/fixtures';

/**
 * ESCROW — an advertiser's budget is reserved before anything is published and
 * can only ever be spent on a post that actually went out.
 *
 * The invariant the whole model rests on:
 *   hold     available -> reserved
 *   charge   reserved  -> publisher (pending)
 *   release  reserved  -> available
 *
 * Money must never appear from nowhere, and it must never be charged twice.
 */

const PRICE = 1_000;
const FEE_PERCENT = 20;

describe('escrow', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup(availableCents = 10_000) {
    const advertiser = await createUser({ availableCents });
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);
    const campaign = await createCampaign(advertiser.id, {
      budgetTotalCents: 10_000,
      platformFeePercent: FEE_PERCENT,
    });
    const ad = await createAd(campaign.id);
    const job = await createDeliveryJob(campaign.id, channel.id, {
      adId: ad.id,
      priceCents: PRICE,
    });

    return { advertiser, publisher, channel, campaign, ad, job };
  }

  it('moves budget from available to reserved and is idempotent', async () => {
    const { advertiser, campaign } = await setup();

    const first = await transaction((tx) =>
      holdCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        amountCents: 5_000,
      }),
    );
    expect(first).toEqual({ heldCents: 5_000, alreadyHeld: false });

    // A worker retry (or a double-clicked approval) must not reserve twice.
    const second = await transaction((tx) =>
      holdCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        amountCents: 5_000,
      }),
    );
    expect(second.alreadyHeld).toBe(true);

    const wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(5_000);
    expect(wallet.reservedCents).toBe(5_000);
    expect(await prisma.transaction.count({ where: { reference: ref.campaignHold(campaign.id) } })).toBe(1);
  });

  it('refuses to reserve money the advertiser does not have, leaving no trace', async () => {
    const { advertiser, campaign } = await setup(1_000);

    await expect(
      transaction((tx) =>
        holdCampaignBudget(tx, {
          campaignId: campaign.id,
          advertiserId: advertiser.id,
          amountCents: 5_000,
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    const wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(1_000);
    expect(wallet.reservedCents).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('charges a delivered post out of the reservation and pays the publisher', async () => {
    const { advertiser, publisher, channel, campaign, job } = await setup();

    await transaction((tx) =>
      holdCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        amountCents: 5_000,
      }),
    );

    const adPost = await prisma.adPost.create({
      data: {
        campaignId: campaign.id,
        channelId: channel.id,
        publisherId: publisher.id,
        deliveryJobId: job.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceCents: PRICE,
      },
    });

    const result = await transaction((tx) =>
      chargeDelivery(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        publisherId: publisher.id,
        channelId: channel.id,
        adPostId: adPost.id,
        priceCents: PRICE,
        platformFeePercent: FEE_PERCENT,
      }),
    );

    // $10.00 post, 20% platform fee -> $8.00 to the publisher.
    expect(result.grossCents).toBe(1_000);
    expect(result.platformFeeCents).toBe(200);
    expect(result.publisherNetCents).toBe(800);

    const advertiserWallet = await walletOf(advertiser.id);
    expect(advertiserWallet.reservedCents).toBe(4_000);
    expect(advertiserWallet.availableCents).toBe(5_000);
    expect(advertiserWallet.totalSpentCents).toBe(1_000);
    // The charge does not leak back into spendable money.
    expect(advertiserWallet.availableCents).toBe(5_000);

    // Publisher money is PENDING — visible, but not yet withdrawable.
    const publisherWallet = await walletOf(publisher.id);
    expect(publisherWallet.pendingCents).toBe(800);
    expect(publisherWallet.availableCents).toBe(0);
    expect(publisherWallet.totalEarnedCents).toBe(800);

    const refreshed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(refreshed.budgetSpentCents).toBe(1_000);
    expect(refreshed.budgetReservedCents).toBe(4_000);
    expect(remainingBudgetCents(refreshed)).toBe(9_000);

    const earnings = await prisma.publisherEarning.findMany();
    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject({
      grossCents: 1_000,
      platformFeeCents: 200,
      netCents: 800,
      status: 'PENDING',
    });
  });

  it('conserves money across the whole hold -> charge cycle', async () => {
    const { advertiser, publisher, channel, campaign, job } = await setup();
    const budget = 5_000;

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: budget }),
    );

    const adPost = await prisma.adPost.create({
      data: {
        campaignId: campaign.id,
        channelId: channel.id,
        publisherId: publisher.id,
        deliveryJobId: job.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceCents: PRICE,
      },
    });

    await transaction((tx) =>
      chargeDelivery(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        publisherId: publisher.id,
        channelId: channel.id,
        adPostId: adPost.id,
        priceCents: PRICE,
        platformFeePercent: FEE_PERCENT,
      }),
    );

    const advertiserWallet = await walletOf(advertiser.id);
    const publisherWallet = await walletOf(publisher.id);

    // The reservation fell by exactly the price of the post...
    expect(budget - advertiserWallet.reservedCents).toBe(PRICE);
    // ...and that price is fully accounted for: publisher net + platform fee.
    expect(publisherWallet.pendingCents + 200).toBe(PRICE);
    // Nothing leaked back into the advertiser's spendable balance.
    expect(advertiserWallet.availableCents).toBe(10_000 - budget);
  });

  it('releases only the unused budget, and only once', async () => {
    const { advertiser, campaign } = await setup();

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 6_000 }),
    );

    const released = await transaction((tx) =>
      releaseCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id }),
    );
    expect(released).toBe(6_000);

    let wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(10_000);
    expect(wallet.reservedCents).toBe(0);

    // Running the completion job twice must not mint money.
    const again = await transaction((tx) =>
      releaseCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id }),
    );
    expect(again).toBe(0);

    wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(10_000);
  });

  it('releases a refund through its own reference, distinct from a plain release', async () => {
    const { advertiser, campaign } = await setup();

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 2_000 }),
    );

    const refunded = await transaction((tx) =>
      releaseCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        reason: 'admin_cancel',
        asRefund: true,
      }),
    );
    expect(refunded).toBe(2_000);

    const wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(10_000);
    expect(wallet.totalRefundedCents).toBe(2_000);

    const entry = await prisma.transaction.findUniqueOrThrow({
      where: { reference: ref.campaignRefund(campaign.id, 'admin_cancel') },
    });
    expect(entry.type).toBe('REFUND');
  });

  it('never releases more than the campaign still holds, even if asked twice', async () => {
    const { advertiser, campaign } = await setup();

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 3_000 }),
    );

    // Pretend the reservation was already released by another path.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetReservedCents: 0 } });

    const released = await transaction((tx) =>
      releaseCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id }),
    );
    expect(released).toBe(0);

    const wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(7_000);
  });

  it('releases a single delivery slot without disturbing the rest of the campaign', async () => {
    const { advertiser, campaign, job } = await setup();

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 5_000 }),
    );

    const released = await transaction((tx) =>
      releaseJobReservation(tx, {
        deliveryJobId: job.id,
        campaignId: campaign.id,
        priceCents: PRICE,
      }),
    );
    expect(released).toBe(PRICE);

    const refreshed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(refreshed.budgetReservedCents).toBe(4_000);

    const wallet = await walletOf(advertiser.id);
    expect(wallet.availableCents).toBe(6_000);

    // Retrying the failing job must not release the same slot twice.
    const again = await transaction((tx) =>
      releaseJobReservation(tx, {
        deliveryJobId: job.id,
        campaignId: campaign.id,
        priceCents: PRICE,
      }),
    );
    expect(again).toBe(0);
    expect((await walletOf(advertiser.id)).availableCents).toBe(6_000);
  });

  it('caps a slot release at what the campaign actually reserves', async () => {
    const { advertiser, campaign, job } = await setup();

    // A stale job claims a price, but the campaign only holds a fraction of it.
    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 300 }),
    );

    const released = await transaction((tx) =>
      releaseJobReservation(tx, { deliveryJobId: job.id, campaignId: campaign.id, priceCents: PRICE }),
    );
    expect(released).toBe(300);

    const refreshed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(refreshed.budgetReservedCents).toBe(0);
  });

  it('moves a matured earning into available exactly once', async () => {
    const { advertiser, publisher, channel, campaign, job } = await setup();

    const adPost = await prisma.adPost.create({
      data: {
        campaignId: campaign.id,
        channelId: channel.id,
        publisherId: publisher.id,
        deliveryJobId: job.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        priceCents: PRICE,
      },
    });

    await transaction((tx) =>
      holdCampaignBudget(tx, { campaignId: campaign.id, advertiserId: advertiser.id, amountCents: 2_000 }),
    );
    const charge = await transaction((tx) =>
      chargeDelivery(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        publisherId: publisher.id,
        channelId: channel.id,
        adPostId: adPost.id,
        priceCents: PRICE,
        platformFeePercent: FEE_PERCENT,
      }),
    );

    const first = await transaction((tx) => releaseEarning(tx, charge.earningId));
    expect(first).toEqual({ released: true, netCents: 800 });

    let wallet = await walletOf(publisher.id);
    expect(wallet.pendingCents).toBe(0);
    expect(wallet.availableCents).toBe(800);

    const second = await transaction((tx) => releaseEarning(tx, charge.earningId));
    expect(second.released).toBe(false);

    wallet = await walletOf(publisher.id);
    expect(wallet.pendingCents).toBe(0);
    expect(wallet.availableCents).toBe(800);

    const earning = await prisma.publisherEarning.findUniqueOrThrow({ where: { id: charge.earningId } });
    expect(earning.status).toBe('AVAILABLE');
    expect(earning.availableAt).not.toBeNull();
  });

  it('rejects a zero-price delivery outright', async () => {
    const { advertiser, publisher, channel, campaign } = await setup();

    await expect(
      transaction((tx) =>
        chargeDelivery(tx, {
          campaignId: campaign.id,
          advertiserId: advertiser.id,
          publisherId: publisher.id,
          channelId: channel.id,
          adPostId: 'nonexistent',
          priceCents: 0,
          platformFeePercent: FEE_PERCENT,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestAppError);
  });
});
