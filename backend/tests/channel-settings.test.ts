import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ForbiddenError, ValidationError } from '../src/utils/errors';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite.
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const { updateChannel, getChannel } = await import('../src/services/channel.service');
const { resetDatabase, createUser, createChannel, setTestSettings } = await import('./helpers/fixtures');

/**
 * PUBLISHER AD SETTINGS — the two switches a publisher owns.
 *
 * Both columns (`acceptAds`, `minAdPriceCents`) already existed in the database
 * and were already honoured by campaign targeting and the delivery gate, but
 * nothing in the API could ever set them: `updateChannelSchema` did not carry
 * the fields and `updateChannel` ignored them. A publisher therefore had no way
 * to pause sponsored ads or to raise their floor.
 *
 * These tests pin the contract now that it exists:
 *   - the values persist and come back on the channel payload
 *   - the floor is bounded by the platform maximum, so a channel cannot be
 *     parked permanently out of reach by a typo
 *   - changing the floor is audited, exactly like the ad price already was
 */

const PLATFORM_MAX_CENTS = 1_000_000;

describe('publisher ad settings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /* ---------------- acceptAds ---------------- */

  it('pauses sponsored ads when acceptAds is set to false, and resumes them', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { acceptAds: true });

    const paused = await updateChannel(publisher.id, channel.id, { acceptAds: false });
    expect(paused.acceptAds).toBe(false);

    // Persisted, not just echoed back.
    const reread = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(reread.acceptAds).toBe(false);

    // And exposed on the publisher-facing payload.
    const detail = await getChannel(publisher.id, channel.id);
    expect(detail.acceptAds).toBe(false);

    const resumed = await updateChannel(publisher.id, channel.id, { acceptAds: true });
    expect(resumed.acceptAds).toBe(true);
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).acceptAds).toBe(true);
  });

  it('leaves acceptAds untouched when the field is omitted', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { acceptAds: false });

    const updated = await updateChannel(publisher.id, channel.id, { maxPostsPerDay: 5 });
    expect(updated.acceptAds).toBe(false);
    expect(updated.maxPostsPerDay).toBe(5);
  });

  /* ---------------- minAdPriceCents ---------------- */

  it('stores a publisher floor and records an audit entry', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { minAdPriceCents: 0 });

    const updated = await updateChannel(publisher.id, channel.id, { minAdPriceCents: 2_500 });
    expect(updated.minAdPriceCents).toBe(2_500);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'CHANNEL_MIN_PRICE_CHANGED', targetId: channel.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.oldValue).toMatchObject({ minAdPriceCents: 0 });
    expect(audit?.newValue).toMatchObject({ minAdPriceCents: 2_500 });
  });

  it('allows a floor of zero, which means "no floor"', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { minAdPriceCents: 5_000 });

    const updated = await updateChannel(publisher.id, channel.id, { minAdPriceCents: 0 });
    expect(updated.minAdPriceCents).toBe(0);
  });

  it('refuses a floor above the platform maximum, because the channel could never be bought', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);

    await expect(
      updateChannel(publisher.id, channel.id, { minAdPriceCents: PLATFORM_MAX_CENTS + 1 }),
    ).rejects.toBeInstanceOf(ValidationError);

    // The row is untouched by the refused write.
    expect((await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } })).minAdPriceCents).toBe(0);
  });

  it('accepts a floor exactly at the platform maximum', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);

    const updated = await updateChannel(publisher.id, channel.id, { minAdPriceCents: PLATFORM_MAX_CENTS });
    expect(updated.minAdPriceCents).toBe(PLATFORM_MAX_CENTS);
  });

  it('refuses a negative or fractional floor', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);

    await expect(updateChannel(publisher.id, channel.id, { minAdPriceCents: -1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateChannel(publisher.id, channel.id, { minAdPriceCents: 12.5 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('honours a raised platform maximum', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id);
    await setTestSettings({ max_channel_post_price_cents: 50_000 });

    await expect(
      updateChannel(publisher.id, channel.id, { minAdPriceCents: 40_000 }),
    ).resolves.toMatchObject({ minAdPriceCents: 40_000 });

    await expect(
      updateChannel(publisher.id, channel.id, { minAdPriceCents: 60_000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  /* ---------------- guards that must also cover the new fields ---------------- */

  it('refuses another user, even for the new fields', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const channel = await createChannel(owner.id);

    await expect(
      updateChannel(stranger.id, channel.id, { acceptAds: false, minAdPriceCents: 9_999 }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const untouched = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(untouched.acceptAds).toBe(true);
    expect(untouched.minAdPriceCents).toBe(0);
  });

  it('refuses a suspended channel, even for the new fields', async () => {
    const publisher = await createUser();
    const channel = await createChannel(publisher.id, { status: 'SUSPENDED' });

    await expect(
      updateChannel(publisher.id, channel.id, { acceptAds: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
