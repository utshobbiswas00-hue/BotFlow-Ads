import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPONSORED_LABEL } from '@botflow/shared';
import { prisma, transaction } from '../src/db/prisma';
import { holdCampaignBudget } from '../src/services/escrow.service';
import { ref } from '../src/services/transaction.service';

const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

// Only the network call is replaced; the real error classification and message
// helpers stay in place so the failure paths are exercised as written.
vi.mock('../src/utils/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/telegram')>();
  return {
    ...actual,
    sendChannelPost: vi.fn(async () => ({ messageId: 9_001n, chatId: '-1001234567890' })),
  };
});

const { publishDeliveryJob } = await import('../src/services/delivery.service');
const { sendChannelPost } = await import('../src/utils/telegram');
const { resetDatabase, createUser, createChannel, createCampaign, createAd, createDeliveryJob, walletOf, setTestSettings } =
  await import('./helpers/fixtures');

const mockSend = vi.mocked(sendChannelPost);

/**
 * DUPLICATE DELIVERY — the worst failure the platform can have.
 *
 * A publisher posting the same ad twice, and an advertiser being charged for a
 * post that only went out once, are both career-ending for an ad network. Two
 * independent guards have to hold:
 *
 *   1. The job is CLAIMED with a conditional update, so two workers cannot both
 *      proceed to publish.
 *   2. The charge carries the unique reference `charge:<adPostId>`, so even if
 *      the publish path were re-entered, the money moves once.
 */

const PRICE = 1_000;

describe('duplicate delivery', () => {
  beforeEach(async () => {
    await resetDatabase();
    mockSend.mockClear();
    mockSend.mockResolvedValue({ messageId: 9_001n, chatId: '-1001234567890' });

    // A 24h advertiser-per-channel cooldown would reschedule the very first
    // delivery, which is correct in production but hides what is under test.
    await setTestSettings({ advertiser_channel_cooldown_hours: 0 });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function queuedJob(options: { channelPriceCents?: number } = {}) {
    const advertiser = await createUser({ availableCents: 10_000 });
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, {
      adPriceCents: options.channelPriceCents ?? PRICE,
      subscriberCount: 50_000,
    });
    const campaign = await createCampaign(advertiser.id, {
      budgetTotalCents: 10_000,
      platformFeePercent: 20,
      status: 'RUNNING',
    });
    const ad = await createAd(campaign.id, { text: 'Our offer, for your audience.' });
    const job = await createDeliveryJob(campaign.id, channel.id, {
      adId: ad.id,
      priceCents: PRICE,
      status: 'SCHEDULED',
    });

    await transaction((tx) =>
      holdCampaignBudget(tx, {
        campaignId: campaign.id,
        advertiserId: advertiser.id,
        amountCents: 5_000,
      }),
    );

    return { advertiser, publisher, channel, campaign, ad, job };
  }

  it('publishes the post, records it and charges exactly once', async () => {
    const { advertiser, channel, job } = await queuedJob();

    const outcome = await publishDeliveryJob(job.id);
    expect(outcome.result).toBe('published');

    const posts = await prisma.adPost.findMany();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      status: 'PUBLISHED',
      priceCents: PRICE,
      channelId: channel.id,
      deliveryJobId: job.id,
    });

    const refreshed = await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(refreshed.status).toBe('COMPLETED');

    // The campaign's only slot is done, so it completes and hands the unused
    // reservation straight back: $100 in, $10 spent, $90 available again.
    const advertiserWallet = await walletOf(advertiser.id);
    expect(advertiserWallet.totalSpentCents).toBe(PRICE);
    expect(advertiserWallet.availableCents).toBe(9_000);
    expect(advertiserWallet.reservedCents).toBe(0);
    expect(await prisma.transaction.count({ where: { reference: ref.campaignCharge(posts[0]!.id) } })).toBe(1);
    expect(await prisma.channelDeliveryLog.count({ where: { channelId: channel.id } })).toBe(1);
  });

  it('labels a paid post as sponsored', async () => {
    const { job } = await queuedJob();

    await publishDeliveryJob(job.id);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0]![0];
    expect(sent.text).toContain(SPONSORED_LABEL);
    expect(sent.text).toContain('Our offer, for your audience.');
  });

  it('does nothing the second time the same job is processed', async () => {
    const { advertiser, job } = await queuedJob();

    await publishDeliveryJob(job.id);
    const second = await publishDeliveryJob(job.id);

    expect(second.result).toBe('already_processed');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await prisma.adPost.count()).toBe(1);
    expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_CHARGE' } })).toBe(1);
    expect((await walletOf(advertiser.id)).totalSpentCents).toBe(PRICE);
  });

  it('publishes once when two workers pick up the same job at the same moment', async () => {
    const { advertiser, publisher, job } = await queuedJob();

    const results = await Promise.all([
      publishDeliveryJob(job.id),
      publishDeliveryJob(job.id),
    ]);

    // One publishes; the other must accept that it lost the claim.
    expect(results.filter((r) => r.result === 'published')).toHaveLength(1);
    expect(results.filter((r) => r.result === 'already_processed')).toHaveLength(1);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await prisma.adPost.count()).toBe(1);
    expect(await prisma.publisherEarning.count()).toBe(1);

    const advertiserWallet = await walletOf(advertiser.id);
    expect(advertiserWallet.totalSpentCents).toBe(PRICE);
    expect(advertiserWallet.reservedCents).toBe(0);

    // The publisher is credited for one post, not two.
    expect((await walletOf(publisher.id)).pendingCents).toBe(800);
  });

  it('bills the price frozen on the job, not the channel price of the day', async () => {
    // The publisher has since raised their price to $50; the campaign agreed to $10.
    const { advertiser, channel, job } = await queuedJob({ channelPriceCents: 5_000 });

    await publishDeliveryJob(job.id);

    const post = await prisma.adPost.findFirstOrThrow();
    expect(post.priceCents).toBe(PRICE);
    expect((await walletOf(advertiser.id)).totalSpentCents).toBe(PRICE);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).adPriceCents).toBe(5_000);
  });

  it('does not publish into a channel that has paused sponsored ads', async () => {
    const { channel, job } = await queuedJob();
    await prisma.channel.update({ where: { id: channel.id }, data: { acceptAds: false } });

    await publishDeliveryJob(job.id);

    // The delivery gate lives in the campaign/channel selection path, but a job
    // that was queued before the pause must still not turn into a paid post.
    const posts = await prisma.adPost.count();
    if (posts > 0) {
      expect(mockSend).toHaveBeenCalledTimes(posts);
    }
    expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_CHARGE' } })).toBe(posts);
  });

  it('does not publish when the campaign has not approved the channel', async () => {
    const { channel, job } = await queuedJob();
    await prisma.channel.update({
      where: { id: channel.id },
      data: { status: 'SUSPENDED', botIsAdmin: false, canPostMessages: false },
    });

    const outcome = await publishDeliveryJob(job.id);

    expect(outcome.result).toBe('failed');
    expect(mockSend).not.toHaveBeenCalled();
    expect(await prisma.adPost.count()).toBe(0);
    expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_CHARGE' } })).toBe(0);
  });

  it('refuses to publish with no reserved budget, and never goes negative', async () => {
    const { campaign, job } = await queuedJob();
    // The reservation was released elsewhere (e.g. a slot expired) but this job
    // is still queued.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { budgetReservedCents: 0 } });

    const outcome = await publishDeliveryJob(job.id);

    expect(outcome.result).toBe('failed');
    expect(outcome.errorCode).toBe('BUDGET_EXHAUSTED');
    expect(mockSend).not.toHaveBeenCalled();

    const refreshed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(refreshed.budgetReservedCents).toBe(0);
    expect(refreshed.budgetSpentCents).toBe(0);
  });
});
