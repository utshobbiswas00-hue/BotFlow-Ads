import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, transaction } from '../src/db/prisma';
import { chargeDelivery, holdCampaignBudget } from '../src/services/escrow.service';
import { ref } from '../src/services/transaction.service';
import { BadRequestAppError } from '../src/utils/escrowErrors';

const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const { createDeposit, verifyDeposit } = await import('../src/services/deposit.service');
const { resetDatabase, createUser, createChannel, createCampaign, createAd, createDeliveryJob, walletOf } =
  await import('./helpers/fixtures');

/**
 * DOUBLE PAYMENT — the same money moved twice.
 *
 * Two shapes of the same failure:
 *   1. an advertiser charged twice for one delivered post
 *   2. a deposit credited twice because the verification was replayed
 *
 * Both are stopped by the same mechanism: every movement carries a UNIQUE
 * ledger reference, and the reference is written in the same transaction as
 * the balance change. A replay collides and rolls the whole thing back.
 */

const PRICE = 1_000;
const FEE_PERCENT = 20;

describe('double payment', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function deliveredPost() {
    const advertiser = await createUser({ availableCents: 10_000 });
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);
    const campaign = await createCampaign(advertiser.id, {
      budgetTotalCents: 10_000,
      platformFeePercent: FEE_PERCENT,
    });
    const ad = await createAd(campaign.id);
    const job = await createDeliveryJob(campaign.id, channel.id, { adId: ad.id, priceCents: PRICE });

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

    const charge = (adPostId: string) =>
      transaction((tx) =>
        chargeDelivery(tx, {
          campaignId: campaign.id,
          advertiserId: advertiser.id,
          publisherId: publisher.id,
          channelId: channel.id,
          adPostId,
          priceCents: PRICE,
          platformFeePercent: FEE_PERCENT,
        }),
      );

    return { advertiser, publisher, channel, campaign, adPost, charge };
  }

  it('refuses to charge the same post twice', async () => {
    const { advertiser, publisher, campaign, adPost, charge } = await deliveredPost();

    await charge(adPost.id);
    await expect(charge(adPost.id)).rejects.toBeInstanceOf(BadRequestAppError);

    const advertiserWallet = await walletOf(advertiser.id);
    expect(advertiserWallet.reservedCents).toBe(4_000);
    expect(advertiserWallet.totalSpentCents).toBe(PRICE);

    expect((await walletOf(publisher.id)).pendingCents).toBe(800);

    const refreshed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(refreshed.budgetSpentCents).toBe(PRICE);
    expect(refreshed.budgetReservedCents).toBe(4_000);

    // One charge, one fee, one earning — no phantom duplicates.
    expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_CHARGE' } })).toBe(1);
    expect(await prisma.transaction.count({ where: { type: 'PLATFORM_FEE' } })).toBe(1);
    expect(await prisma.publisherEarning.count()).toBe(1);
  });

  it('charges exactly once when two workers settle the same post simultaneously', async () => {
    const { advertiser, publisher, campaign, adPost, charge } = await deliveredPost();

    const results = await Promise.allSettled([charge(adPost.id), charge(adPost.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const advertiserWallet = await walletOf(advertiser.id);
    expect(advertiserWallet.reservedCents).toBe(4_000);
    expect(advertiserWallet.totalSpentCents).toBe(PRICE);
    expect((await walletOf(publisher.id)).pendingCents).toBe(800);

    expect(await prisma.transaction.count({ where: { reference: ref.campaignCharge(adPost.id) } })).toBe(1);
    expect(await prisma.publisherEarning.count()).toBe(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).budgetSpentCents).toBe(PRICE);
  });

  it('never lets the publisher earn twice for one post', async () => {
    const { publisher, adPost, charge } = await deliveredPost();

    await charge(adPost.id);
    await charge(adPost.id).catch(() => undefined);

    const earnings = await prisma.publisherEarning.findMany({ where: { publisherId: publisher.id } });
    expect(earnings).toHaveLength(1);
    expect(earnings[0]!.netCents).toBe(800);

    const wallet = await walletOf(publisher.id);
    expect(wallet.pendingCents).toBe(800);
    expect(wallet.totalEarnedCents).toBe(800);
  });

  it('credits a deposit once, however many times it is verified', async () => {
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 7_500, method: 'telegram_stars' });

    await verifyDeposit('admin-1', deposit.id, 'checked against the statement');
    const again = await verifyDeposit('admin-2', deposit.id, 'duplicate attempt');

    expect(again.status).toBe('VERIFIED');

    const wallet = await walletOf(user.id);
    // Stars keeps 48%, and the depositor pays it: 7,500 sent, 3,900
    // spendable. The number is asserted exactly — if a rate moves, this test
    // should fail rather than quietly accept a different credit.
    expect(deposit.feeBps).toBe(4800);
    expect(wallet.availableCents).toBe(3_900);
    expect(wallet.totalDepositedCents).toBe(3_900);
    expect(await prisma.transaction.count({ where: { reference: ref.deposit(deposit.id) } })).toBe(1);
  });

  it('credits a deposit once when two admins verify it at the same moment', async () => {
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 4_000, method: 'telegram_stars' });

    await Promise.allSettled([
      verifyDeposit('admin-1', deposit.id),
      verifyDeposit('admin-2', deposit.id),
    ]);

    const wallet = await walletOf(user.id);
    // 4,000 sent, 2,080 spendable after the 48% Stars fee — credited exactly
    // ONCE, which is what this test is really about.
    expect(wallet.availableCents).toBe(2_080);
    expect(await prisma.transaction.count({ where: { type: 'DEPOSIT' } })).toBe(1);
  });

  it('treats a repeated gateway reference as the same deposit', async () => {
    const user = await createUser();

    const first = await createDeposit(user.id, {
      amountCents: 2_000,
      method: 'crypto',
      gatewayRef: 'trx_test_123',
    });
    const replay = await createDeposit(user.id, {
      amountCents: 2_000,
      method: 'crypto',
      gatewayRef: 'trx_test_123',
    });

    expect(replay.id).toBe(first.id);
    expect(await prisma.deposit.count()).toBe(1);
  });
});
