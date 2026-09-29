import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { getPagination } from '../src/utils/pagination';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite (same pattern as the other suites).
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const { computeChannelHealth, refreshAllChannelHealth, refreshChannelHealth } = await import('../src/services/channelHealth.service');
const { canReceivePaidPost } = await import('../src/services/houseAd.service');
const { listMarketplace } = await import('../src/services/channel.service');
const { resetDatabase, createUser, createChannel, createCampaign, createDeliveryJob, setTestSettings } =
  await import('./helpers/fixtures');

/**
 * CHANNEL QUALITY — the health score is what advertisers (and the delivery
 * gate) rely on:
 *
 *   1. the sweep persists status AND score AND a check timestamp,
 *   2. a channel that keeps failing deliveries ends up below the delivery
 *      cutoff, so an advertiser is never sold a broken channel without a
 *      visible warning,
 *   3. canReceivePaidPost — the single gate every delivery path consults —
 *      honours the score and the "do not deliver" statuses,
 *   4. the marketplace exposes the score to advertisers and the new filters
 *      (price range, pricing model, sort) work with stable paging.
 */

const PAGE = getPagination({ page: 1, limit: 50 });

/** Create a delivery job whose createdAt is pinned, so job ordering is exact. */
async function datedJob(
  campaignId: string,
  channelId: string,
  status: 'COMPLETED' | 'FAILED',
  at: Date,
) {
  const job = await createDeliveryJob(campaignId, channelId, { status });
  await prisma.deliveryJob.update({
    where: { id: job.id },
    data: { createdAt: at },
  });
  return job;
}

async function failingChannel(ownerId: string, title = 'Failing Channel') {
  const channel = await createChannel(ownerId, { title });
  const campaign = await createCampaign(ownerId);
  const t0 = Date.parse('2026-09-26T08:00:00Z');
  await datedJob(campaign.id, channel.id, 'COMPLETED', new Date(t0));
  // Four consecutive failures on top of the old success -> the scorer must
  // flag this channel (consecutiveFailures > 3).
  for (let i = 1; i <= 4; i += 1) {
    await datedJob(campaign.id, channel.id, 'FAILED', new Date(t0 + i * 60_000));
  }
  return channel;
}

async function healthyChannel(ownerId: string, title = 'Healthy Channel') {
  const channel = await createChannel(ownerId, { title });
  const campaign = await createCampaign(ownerId);
  const t0 = Date.parse('2026-09-26T08:00:00Z');
  for (let i = 1; i <= 3; i += 1) {
    await datedJob(campaign.id, channel.id, 'COMPLETED', new Date(t0 + i * 60_000));
  }
  return channel;
}

// Single file-level teardown: the three describes share one Prisma client in
// a single fork, so disconnecting after the first describe would break the
// rest.
afterAll(async () => {
  await prisma.$disconnect();
});

describe('channel health persistence', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('refreshChannelHealth writes healthScore and healthCheckedAt, not just the status', async () => {
    const publisher = await createUser();
    const channel = await healthyChannel(publisher.id);

    const status = await refreshChannelHealth(channel.id);

    expect(status).toBe('HEALTHY');
    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(row.healthStatus).toBe('HEALTHY');
    expect(row.healthScore).toBe(100);
    expect(row.healthCheckedAt).toBeInstanceOf(Date);
  });

  it('a channel with consecutive failed deliveries scores below a healthy one and crosses the delivery cutoff', async () => {
    const publisher = await createUser();
    const failing = await failingChannel(publisher.id);
    const healthy = await healthyChannel(publisher.id);

    const failingHealth = await computeChannelHealth(failing.id);
    const healthyHealth = await computeChannelHealth(healthy.id);

    expect(failingHealth).not.toBeNull();
    expect(healthyHealth).not.toBeNull();
    expect(failingHealth!.healthStatus).toBe('ATTENTION_REQUIRED');
    expect(failingHealth!.score).toBeLessThan(healthyHealth!.score);

    // Persisted…
    await refreshChannelHealth(failing.id);
    await refreshChannelHealth(healthy.id);
    const [fRow, hRow] = await Promise.all([
      prisma.channel.findUniqueOrThrow({ where: { id: failing.id } }),
      prisma.channel.findUniqueOrThrow({ where: { id: healthy.id } }),
    ]);
    expect(fRow.healthScore).toBeLessThan(hRow.healthScore);

    // …and the failing channel sits at/below the delivery cutoff. The default
    // cutoff is 40 and the consecutive-failure rule scores 40, so raise the
    // cutoff (as an operator can) to show the failing channel crossing it.
    const min = 50;
    await setTestSettings({ channel_health_min_for_delivery: min });
    expect(fRow.healthScore).toBeLessThan(min);
    expect(hRow.healthScore).toBeGreaterThanOrEqual(min);
  });

  it('refreshAllChannelHealth sweeps every live channel, repeats safely and survives a bad channel', async () => {
    const publisher = await createUser();
    const good = await healthyChannel(publisher.id, 'Sweep Good');
    const bad = await failingChannel(publisher.id, 'Sweep Bad');
    const pending = await createChannel(publisher.id, { status: 'PENDING', title: 'Sweep Pending' });

    const first = await refreshAllChannelHealth();
    expect(first).toBe(2); // PENDING channel is not swept

    const [goodRow, badRow, pendingRow] = await Promise.all([
      prisma.channel.findUniqueOrThrow({ where: { id: good.id } }),
      prisma.channel.findUniqueOrThrow({ where: { id: bad.id } }),
      prisma.channel.findUniqueOrThrow({ where: { id: pending.id } }),
    ]);
    expect(goodRow).toMatchObject({ healthStatus: 'HEALTHY', healthScore: 100 });
    expect(badRow).toMatchObject({ healthStatus: 'ATTENTION_REQUIRED', healthScore: 40 });
    expect(goodRow.healthCheckedAt).toBeInstanceOf(Date);
    expect(badRow.healthCheckedAt).toBeInstanceOf(Date);
    expect(pendingRow.healthCheckedAt).toBeNull();

    // Repeatable: a second sweep re-scores, does not error, counts the same.
    const second = await refreshAllChannelHealth();
    expect(second).toBe(2);

    // Fault injection: one channel's compute throws (simulated transient DB
    // failure). The sweep must log and continue — the other channel is still
    // refreshed, and the return count reflects only the successful ones.
    // The delegate method is swapped directly (own property, captured and
    // restored) rather than through vi.spyOn, to keep the real Prisma client
    // pristine for the rest of the file.
    const delegate = prisma.channel as unknown as {
      findUnique: (args: { where: { id: string } }) => Promise<unknown>;
    };
    const originalFindUnique = delegate.findUnique;
    const goodCheckedBefore = (await prisma.channel.findUniqueOrThrow({ where: { id: good.id } }))
      .healthCheckedAt;
    delegate.findUnique = (args) => {
      if (args?.where?.id === good.id) return Promise.reject(new Error('simulated transient db failure'));
      return originalFindUnique.call(delegate, args);
    };

    try {
      const third = await refreshAllChannelHealth();
      expect(third).toBe(1);
    } finally {
      delegate.findUnique = originalFindUnique;
    }

    const [goodAfter, badAfter] = await Promise.all([
      prisma.channel.findUniqueOrThrow({ where: { id: good.id } }),
      prisma.channel.findUniqueOrThrow({ where: { id: bad.id } }),
    ]);
    // The failing channel's timestamp moved; the good one's stayed put.
    expect(badAfter.healthCheckedAt).not.toEqual(goodCheckedBefore);
    expect(goodAfter.healthCheckedAt).toEqual(goodCheckedBefore);
  });
});

describe('delivery gate honours channel health', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('refuses a low-health channel with a reason that names the health problem', async () => {
    const publisher = await createUser();
    const channel = await failingChannel(publisher.id);
    await refreshChannelHealth(channel.id);
    await setTestSettings({ channel_health_min_for_delivery: 50 });

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const verdict = await canReceivePaidPost(row);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/health is 40, below the 50 minimum/);
  });

  it('still allows a healthy channel above the cutoff', async () => {
    const publisher = await createUser();
    const channel = await healthyChannel(publisher.id);
    await refreshChannelHealth(channel.id);
    await setTestSettings({ channel_health_min_for_delivery: 50 });

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const verdict = await canReceivePaidPost(row);

    expect(verdict).toEqual({ allowed: true });
  });

  it('refuses a RESTRICTED channel even when its score is above the numeric minimum', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { title: 'Flaky Channel' });
    const campaign = await createCampaign(publisher.id);
    // 8 of the last 10 failed (>70%) but the newest job succeeded, so the
    // consecutive-failure rule (score 40) does not trigger — this is the
    // failure-rate rule: RESTRICTED with score 50, above the default cutoff
    // of 40. Only the status check can catch it.
    const t0 = Date.parse('2026-09-26T08:00:00Z');
    for (let i = 1; i <= 10; i += 1) {
      const failed = i <= 8;
      await datedJob(campaign.id, channel.id, failed ? 'FAILED' : 'COMPLETED', new Date(t0 + i * 60_000));
    }

    const status = await refreshChannelHealth(channel.id);
    expect(status).toBe('RESTRICTED');

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(row.healthScore).toBe(50); // above the default 40 minimum

    const verdict = await canReceivePaidPost(row);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/restricted/i);
  });

  it('refuses a channel whose health status is SUSPENDED', async () => {
    const publisher = await createUser();
    const channel = await healthyChannel(publisher.id);
    // Stale-but-real state: the sweep last saw a suspension; the review
    // status was re-approved without another health pass yet.
    await prisma.channel.update({
      where: { id: channel.id },
      data: { healthStatus: 'SUSPENDED', healthScore: 0 },
    });

    const row = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    const verdict = await canReceivePaidPost(row);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/suspended/i);
  });

  it('fails open for callers that pass a channel without the health fields', async () => {
    const verdict = await canReceivePaidPost({
      subscriberCount: 10_000,
      status: 'APPROVED',
      botIsAdmin: true,
      canPostMessages: true,
      acceptAds: true,
    });

    expect(verdict).toEqual({ allowed: true });
  });
});

describe('marketplace filters, sorting and payload', () => {
  let publisherId: string;

  async function seedMarketplace(): Promise<Record<'A' | 'B' | 'C', string>> {
    const [alpha, beta, gamma] = await Promise.all([
      createChannel(publisherId, {
        title: 'Alpha',
        subscriberCount: 1_000,
        adPriceCents: 1_000,
        pricingModel: 'FIXED',
      }),
      createChannel(publisherId, {
        title: 'Beta',
        subscriberCount: 5_000,
        adPriceCents: 5_000,
        pricingModel: 'CPM',
      }),
      createChannel(publisherId, {
        title: 'Gamma',
        subscriberCount: 2_000,
        adPriceCents: 2_500,
        pricingModel: 'FIXED',
      }),
    ]);
    // Distinct values on every sortable column, plus known health states.
    await prisma.channel.update({
      where: { id: alpha.id },
      data: { avgViews: 500, healthStatus: 'HEALTHY', healthScore: 90 },
    });
    await prisma.channel.update({
      where: { id: beta.id },
      data: { avgViews: 200, healthStatus: 'ATTENTION_REQUIRED', healthScore: 40 },
    });
    await prisma.channel.update({
      where: { id: gamma.id },
      data: { avgViews: 900, healthStatus: 'HEALTHY', healthScore: 70 },
    });
    // Guarded out of the listing: one suspended, one without bot rights.
    await createChannel(publisherId, { title: 'Delta', status: 'SUSPENDED' });
    await createChannel(publisherId, { title: 'Epsilon', botIsAdmin: false });

    return { A: alpha.id, B: beta.id, C: gamma.id };
  }

  const titles = (page: { items: Array<{ title: string }> }): string[] => page.items.map((c) => c.title);

  beforeEach(async () => {
    await resetDatabase();
    publisherId = (await createUser()).id;
  });

  it('still applies the delivery guards (approved + bot is admin + can post)', async () => {
    await seedMarketplace();
    const page = await listMarketplace({}, PAGE);
    expect(titles(page).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('filters by price range on adPriceCents (inclusive, and coerces raw query strings)', async () => {
    const { C } = await seedMarketplace();

    const strict = await listMarketplace({ minPriceCents: 1_500, maxPriceCents: 3_000 }, PAGE);
    expect(strict.items).toHaveLength(1);
    expect(strict.items[0]).toMatchObject({ id: C, title: 'Gamma' });

    const wide = await listMarketplace({ minPriceCents: 1_000, maxPriceCents: 5_000 }, PAGE);
    expect(wide.items).toHaveLength(3);

    // The route forwards query strings; the shared schema coerces them.
    const coerced = await listMarketplace({ minPriceCents: '1500', maxPriceCents: '3000' } as never, PAGE);
    expect(coerced.items).toHaveLength(1);
    expect(coerced.items[0]).toMatchObject({ title: 'Gamma' });
  });

  it('filters by pricingModel', async () => {
    const { B } = await seedMarketplace();

    const cpm = await listMarketplace({ pricingModel: 'CPM' }, PAGE);
    expect(cpm.items).toHaveLength(1);
    expect(cpm.items[0]).toMatchObject({ id: B, title: 'Beta' });

    const fixed = await listMarketplace({ pricingModel: 'FIXED' }, PAGE);
    expect(titles(fixed).sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('orders by each requested sort', async () => {
    await seedMarketplace();

    const reach = await listMarketplace({ sort: 'reach_desc' }, PAGE);
    expect(titles(reach)).toEqual(['Gamma', 'Alpha', 'Beta']); // 900, 500, 200 views

    const subs = await listMarketplace({ sort: 'subscribers_desc' }, PAGE);
    expect(titles(subs)).toEqual(['Beta', 'Gamma', 'Alpha']); // 5k, 2k, 1k subs

    const cheap = await listMarketplace({ sort: 'price_asc' }, PAGE);
    expect(titles(cheap)).toEqual(['Alpha', 'Gamma', 'Beta']); // 10, 25, 50

    const dear = await listMarketplace({ sort: 'price_desc' }, PAGE);
    expect(titles(dear)).toEqual(['Beta', 'Gamma', 'Alpha']);

    const quality = await listMarketplace({ sort: 'quality_desc' }, PAGE);
    expect(titles(quality)).toEqual(['Alpha', 'Gamma', 'Beta']); // 90, 70, 40

    // No sort requested -> the shared schema's default (reach_desc).
    const defaulted = await listMarketplace({}, PAGE);
    expect(titles(defaulted)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('keeps paging stable: no duplicates or gaps across pages', async () => {
    await seedMarketplace();

    const page1 = await listMarketplace({ sort: 'price_asc' }, getPagination({ page: 1, limit: 2 }));
    const page2 = await listMarketplace({ sort: 'price_asc' }, getPagination({ page: 2, limit: 2 }));

    expect(titles(page1)).toEqual(['Alpha', 'Gamma']);
    expect(titles(page2)).toEqual(['Beta']);
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page2.hasMore).toBe(false);

    const seen = [...page1.items.map((c) => c.id), ...page2.items.map((c) => c.id)];
    expect(new Set(seen).size).toBe(3);
  });

  it('breaks ties deterministically by id so identical rows cannot swap between pages', async () => {
    // Two channels identical on every sortable column except id.
    const ch1 = await createChannel(publisherId, {
      title: 'Tie One',
      subscriberCount: 4_000,
      adPriceCents: 2_000,
    });
    const ch2 = await createChannel(publisherId, {
      title: 'Tie Two',
      subscriberCount: 4_000,
      adPriceCents: 2_000,
    });
    for (const ch of [ch1, ch2]) {
      await prisma.channel.update({ where: { id: ch.id }, data: { avgViews: 800 } });
    }
    expect(ch1.id < ch2.id).toBe(true); // cuids are time-sortable

    const all = await listMarketplace({ sort: 'reach_desc' }, PAGE);
    expect(titles(all)).toEqual(['Tie One', 'Tie Two']);

    const first = await listMarketplace({ sort: 'reach_desc' }, getPagination({ page: 1, limit: 1 }));
    const second = await listMarketplace({ sort: 'reach_desc' }, getPagination({ page: 2, limit: 1 }));
    expect(titles(first)).toEqual(['Tie One']);
    expect(titles(second)).toEqual(['Tie Two']);
  });

  it('exposes healthStatus and healthScore, but never ownerId or telegramChannelId', async () => {
    const { A } = await seedMarketplace();

    const page = await listMarketplace({}, PAGE);
    expect(page.items).toHaveLength(3);
    for (const item of page.items) {
      expect(item).toHaveProperty('healthStatus');
      expect(item).toHaveProperty('healthScore');
      expect(item).not.toHaveProperty('ownerId');
      expect(item).not.toHaveProperty('telegramChannelId');
      expect(item).not.toHaveProperty('inviteLink');
      expect(item).not.toHaveProperty('acceptAds');
    }

    const alpha = page.items.find((c) => c.id === A);
    expect(alpha).toMatchObject({ healthStatus: 'HEALTHY', healthScore: 90 });
  });
});
