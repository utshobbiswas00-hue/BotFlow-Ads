import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Conversion attribution and reporting.
 *
 * Two bugs are pinned here:
 *
 * 1. The slug fallback looked for "the most recent click by this user" filtered on
 *    `userId: ctx.advertiserId`. `Click.userId` is the Telegram user who tapped the ad;
 *    `ctx.advertiserId` is the API key's owner. They are different people, so the lookup
 *    returned null on every real conversion and the post and channel were dropped from the
 *    row while the code appeared to have found them.
 *
 * 2. The metrics summed `valueCents` across every currency. `cents` of USD, EUR and BDT are
 *    not additive, so the reported total was a number of nothing.
 *
 * No database is touched.
 */
const mocks = vi.hoisted(() => ({
  adFindUnique: vi.fn(),
  clickFindUnique: vi.fn(),
  clickFindFirst: vi.fn(),
  conversionCreate: vi.fn(),
  conversionFindUniqueOrThrow: vi.fn(),
  conversionGroupBy: vi.fn(),
  campaignFindMany: vi.fn(),
  createNotification: vi.fn(async () => undefined),
  emitWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock('../../db/prisma', () => ({
  prisma: {
    ad: { findUnique: mocks.adFindUnique },
    click: { findUnique: mocks.clickFindUnique, findFirst: mocks.clickFindFirst },
    conversionEvent: {
      create: mocks.conversionCreate,
      findUniqueOrThrow: mocks.conversionFindUniqueOrThrow,
      groupBy: mocks.conversionGroupBy,
    },
    campaign: { findMany: mocks.campaignFindMany },
  },
}));

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../notification.service', () => ({ createNotification: mocks.createNotification }));

vi.mock('../../queues/producers', () => ({ emitWebhookEvent: mocks.emitWebhookEvent }));

import { getConversionStats, recordConversion } from '../conversion.service';

const CTX = { apiKeyId: 'key_1', advertiserId: 'adv_1' };

beforeEach(() => {
  vi.clearAllMocks();
  // `recordConversion` notifies the campaign owner, which reads the campaign row.
  mocks.campaignFindMany.mockResolvedValue([]);
});

describe('slug attribution', () => {
  it('attributes the ad and campaign, and never guesses the clicker', async () => {
    mocks.adFindUnique.mockResolvedValue({
      id: 'ad_1',
      campaignId: 'cmp_1',
      campaign: { advertiserId: 'adv_1' },
    });
    mocks.conversionCreate.mockImplementation(async ({ data }: never) => ({
      id: 'conv_1',
      ...(data as object),
    }));

    const { event } = await recordConversion(
      { trackingSlug: 'slug-abc', eventName: 'purchase', valueCents: 1200 },
      CTX,
    );

    // The lookup that could not succeed is gone.
    expect(mocks.clickFindFirst).not.toHaveBeenCalled();

    // What the slug proves is recorded...
    expect(event).toMatchObject({
      adId: 'ad_1',
      campaignId: 'cmp_1',
      advertiserId: 'adv_1',
    });
    // ...and what it cannot prove is null rather than invented.
    expect(event).toMatchObject({ clickId: null, adPostId: null, channelId: null });
  });

  it('still refuses a slug that belongs to another advertiser', async () => {
    mocks.adFindUnique.mockResolvedValue({
      id: 'ad_1',
      campaignId: 'cmp_1',
      campaign: { advertiserId: 'someone-else' },
    });

    await expect(
      recordConversion({ trackingSlug: 'slug-abc', eventName: 'purchase' }, CTX),
    ).rejects.toThrow(/does not belong/i);
    expect(mocks.conversionCreate).not.toHaveBeenCalled();
  });

  it('keeps full attribution when the caller sends the clickId', async () => {
    mocks.clickFindUnique.mockResolvedValue({
      id: 'click_1',
      adId: 'ad_1',
      adPostId: 'post_1',
      campaignId: 'cmp_1',
      channelId: 'chan_1',
      ad: { campaign: { advertiserId: 'adv_1' } },
    });
    mocks.conversionCreate.mockImplementation(async ({ data }: never) => ({
      id: 'conv_1',
      ...(data as object),
    }));

    const { event } = await recordConversion({ clickId: 'click_1', eventName: 'purchase' }, CTX);

    expect(event).toMatchObject({
      clickId: 'click_1',
      adPostId: 'post_1',
      channelId: 'chan_1',
    });
  });
});

describe('currency-aware totals', () => {
  it('sums a single-currency account', async () => {
    mocks.conversionGroupBy.mockResolvedValue([
      { campaignId: 'cmp_1', currency: 'USD', _count: { _all: 3 }, _sum: { valueCents: 900 } },
    ]);
    mocks.campaignFindMany.mockResolvedValue([{ id: 'cmp_1', name: 'Spring' }]);

    const stats = await getConversionStats('adv_1');

    expect(stats.conversions).toBe(3);
    expect(stats.totalValueCents).toBe(900);
    expect(stats.currency).toBe('USD');
    expect(stats.byCurrency).toEqual([{ currency: 'USD', conversions: 3, valueCents: 900 }]);
    expect(stats.byCampaign[0]).toMatchObject({
      campaignId: 'cmp_1',
      campaignName: 'Spring',
      conversions: 3,
      valueCents: 900,
      currency: 'USD',
    });
  });

  it('refuses to add different currencies together', async () => {
    // $100 + €100 + ৳100 is not 300 of anything. The old code reported exactly that.
    mocks.conversionGroupBy.mockResolvedValue([
      { campaignId: 'cmp_1', currency: 'USD', _count: { _all: 1 }, _sum: { valueCents: 10000 } },
      { campaignId: 'cmp_1', currency: 'EUR', _count: { _all: 1 }, _sum: { valueCents: 10000 } },
      { campaignId: 'cmp_2', currency: 'BDT', _count: { _all: 1 }, _sum: { valueCents: 10000 } },
    ]);
    mocks.campaignFindMany.mockResolvedValue([
      { id: 'cmp_1', name: 'Spring' },
      { id: 'cmp_2', name: 'Summer' },
    ]);

    const stats = await getConversionStats('adv_1');

    expect(stats.conversions).toBe(3);
    // No single figure is claimed...
    expect(stats.totalValueCents).toBeNull();
    expect(stats.currency).toBeNull();
    // ...and the figures that ARE additive are reported per currency.
    expect(stats.byCurrency).toEqual([
      { currency: 'BDT', conversions: 1, valueCents: 10000 },
      { currency: 'EUR', conversions: 1, valueCents: 10000 },
      { currency: 'USD', conversions: 1, valueCents: 10000 },
    ]);
  });

  it('reports a campaign that mixes currencies without a total', async () => {
    mocks.conversionGroupBy.mockResolvedValue([
      { campaignId: 'cmp_1', currency: 'USD', _count: { _all: 2 }, _sum: { valueCents: 500 } },
      { campaignId: 'cmp_1', currency: 'EUR', _count: { _all: 1 }, _sum: { valueCents: 700 } },
    ]);
    mocks.campaignFindMany.mockResolvedValue([{ id: 'cmp_1', name: 'Spring' }]);

    const stats = await getConversionStats('adv_1');

    expect(stats.byCampaign).toHaveLength(1);
    expect(stats.byCampaign[0]).toMatchObject({
      campaignId: 'cmp_1',
      conversions: 3,
      valueCents: null,
      currency: null,
    });
    expect(stats.byCampaign[0]!.byCurrency).toHaveLength(2);
  });

  it('reports zeroes rather than inventing a total when nothing happened', async () => {
    mocks.conversionGroupBy.mockResolvedValue([]);
    mocks.campaignFindMany.mockResolvedValue([]);

    const stats = await getConversionStats('adv_1');

    expect(stats).toMatchObject({
      conversions: 0,
      totalValueCents: null,
      currency: null,
      byCurrency: [],
      byCampaign: [],
    });
  });
});
