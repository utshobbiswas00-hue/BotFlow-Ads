import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '../src/db/prisma';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../src/utils/errors';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite.
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
  emitWebhookEvent: vi.fn(async () => 0 as number),
}));
vi.mock('../src/queues/producers', () => queue);

const { createApiKey, listApiKeys, revokeApiKey, resolveApiKey } = await import('../src/services/apiKey.service');
const { recordConversion, getConversionStats } = await import('../src/services/conversion.service');
const { apiKeyAuth, requireScope } = await import('../src/middleware/apiKeyAuth');
const { resetDatabase, createUser, createChannel, createCampaign, createAd } = await import('./helpers/fixtures');

/**
 * ADVERTISER PROGRAMMATIC API — keys + conversion tracking.
 *
 * The guarantees under test:
 *   - a key is shown exactly once (at creation) and only its SHA-256 hash is
 *     ever stored, so a database dump cannot hand anyone a working credential
 *   - revoked, expired and wrong-secret keys are all rejected — with distinct,
 *     plain-language messages — and keys are revoked, never deleted
 *   - conversion postbacks are idempotent: a retried event creates exactly one
 *     row, and an event that cannot be attributed to the key owner's ads is
 *     rejected rather than stored
 *   - the metrics an advertiser sees are the stored, attributed conversions —
 *     zeros until one actually exists
 */

const sha256 = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

describe('advertiser API keys', () => {
  beforeEach(async () => {
    await resetDatabase();
    queue.emitWebhookEvent.mockClear();
    queue.enqueueNotification.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the plaintext key once and stores only its SHA-256 hash', async () => {
    const user = await createUser();

    const { key, record } = await createApiKey(user.id, {
      label: 'CI key',
      scopes: ['READ', 'WRITE'],
    });

    // Shape: bfa_live_ + 43 base64url characters (32 random bytes).
    expect(key).toMatch(/^bfa_live_[A-Za-z0-9_-]{43}$/);
    // The display prefix is the first 12 chars of the RANDOM part.
    expect(record.prefix).toBe(key.slice(9, 21));
    expect(record.revoked).toBe(false);
    expect(record.expired).toBe(false);

    // What the database actually holds: the hash of the full key, and nothing
    // from which the key could be recovered.
    const row = await prisma.advertiserApiKey.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.keyHash).toBe(sha256(key));
    expect(row.keyHash).not.toBe(key);
    expect(row.keyHash).toMatch(/^[a-f0-9]{64}$/);

    // The list endpoint never returns the hash, and the plaintext cannot be
    // reconstructed from it.
    const views = await listApiKeys(user.id);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(record.id);
    expect(views[0]).not.toHaveProperty('keyHash');
    expect(JSON.stringify(views)).not.toContain(key);
  });

  it('rejects invalid input (createApiKeySchema) without writing a row', async () => {
    const user = await createUser();

    await expect(createApiKey(user.id, { label: '', scopes: ['READ'] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createApiKey(user.id, { label: 'x', scopes: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createApiKey(user.id, { label: 'x', scopes: ['READ'], expiresInDays: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.advertiserApiKey.count()).toBe(0);
  });

  it('resolves a valid key and stamps lastUsedAt / lastUsedIp', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ'] });

    const before = await prisma.advertiserApiKey.findUniqueOrThrow({ where: { id: record.id } });
    expect(before.lastUsedAt).toBeNull();
    expect(before.lastUsedIp).toBeNull();

    const resolved = await resolveApiKey(key, '203.0.113.7');
    expect(resolved.id).toBe(record.id);
    expect(resolved.userId).toBe(user.id);

    const after = await prisma.advertiserApiKey.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.lastUsedAt).toBeInstanceOf(Date);
    expect(after.lastUsedIp).toBe('203.0.113.7');
  });

  it('rejects a revoked key with a distinct message, keeps the row, and is idempotent', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { key, record } = await createApiKey(owner.id, { label: 'CI key', scopes: ['READ'] });

    const revoked = await revokeApiKey(owner.id, record.id);
    expect(revoked.revoked).toBe(true);
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    await expect(resolveApiKey(key)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(resolveApiKey(key)).rejects.toThrow(/revoked/i);

    // Revoked, not deleted — the row (and anything it reported) stays.
    const row = await prisma.advertiserApiKey.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.revokedAt).toBeInstanceOf(Date);

    // Idempotent: revoking twice is a no-op, not an error.
    const again = await revokeApiKey(owner.id, record.id);
    expect(again.revokedAt).toEqual(row.revokedAt);

    // Someone else's key → 404, so accounts cannot probe each other's ids.
    await expect(revokeApiKey(stranger.id, record.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokeApiKey(owner.id, 'no-such-key')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects an expired key with a distinct message', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ'] });

    // A fresh key works...
    await expect(resolveApiKey(key)).resolves.toMatchObject({ id: record.id });

    // ...but once its expiry is in the past it is refused (distinct wording).
    await prisma.advertiserApiKey.update({
      where: { id: record.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(resolveApiKey(key)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(resolveApiKey(key)).rejects.toThrow(/expired/i);
    await expect(resolveApiKey(key)).rejects.not.toThrow(/revoked/i);

    const views = await listApiKeys(user.id);
    expect(views[0].expired).toBe(true);
    expect(views[0].revoked).toBe(false);
  });

  it('rejects a wrong secret presented under a valid prefix', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ'] });

    // Same 12-char prefix, garbage secret.
    const wrongSecret = `${key.slice(0, 21)}${'x'.repeat(31)}`;
    expect(wrongSecret.slice(9, 21)).toBe(record.prefix);
    await expect(resolveApiKey(wrongSecret)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(resolveApiKey(wrongSecret)).rejects.toThrow(/invalid api key/i);

    // Malformed / missing keys are refused the same way.
    await expect(resolveApiKey('not-a-key-at-all')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(resolveApiKey(`bfa_live_${'y'.repeat(43)}`)).rejects.toBeInstanceOf(UnauthorizedError);

    // A refused guess must not have stamped the key as used.
    const row = await prisma.advertiserApiKey.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.lastUsedAt).toBeNull();
  });

  it('writes audit entries for create and revoke, never containing the key', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'Audited key', scopes: ['WRITE'] });
    await revokeApiKey(user.id, record.id);

    const created = await prisma.auditLog.findFirst({
      where: { action: 'API_KEY_CREATED', targetId: record.id },
    });
    expect(created).not.toBeNull();
    expect(created?.actorId).toBe(user.id);
    expect(created?.actorType).toBe('USER');
    expect(created?.targetType).toBe('ADVERTISER_API_KEY');
    expect(JSON.stringify(created?.newValue ?? {})).not.toContain(key);

    const revoked = await prisma.auditLog.findFirst({
      where: { action: 'API_KEY_REVOKED', targetId: record.id },
    });
    expect(revoked).not.toBeNull();
    expect(JSON.stringify(revoked?.newValue ?? {})).not.toContain(key);
  });
});

describe('apiKeyAuth middleware', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function invokeScope(req: Record<string, unknown>, scope: 'READ' | 'WRITE') {
    let nextArg: unknown;
    requireScope(scope)(req as never, {} as never, (err?: unknown) => {
      nextArg = err;
    });
    return nextArg;
  }

  it('authenticates from the Authorization header and sets req.apiKey', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ', 'WRITE'] });

    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${key}` } };
    const result = await invokeAuthAsync(req);

    expect(result.nextArg).toBeUndefined();
    expect(req.apiKey).toMatchObject({ id: record.id, userId: user.id });
    expect((req.apiKey as { scopes: string[] }).scopes).toEqual(expect.arrayContaining(['READ', 'WRITE']));
  });

  it('authenticates from the X-API-Key header', async () => {
    const user = await createUser();
    const { key } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ'] });

    const req: Record<string, unknown> = { headers: { 'x-api-key': key } };
    const result = await invokeAuthAsync(req);
    expect(result.nextArg).toBeUndefined();
    expect(req.apiKey).toBeDefined();
  });

  it('answers 401 when no key is present', async () => {
    const req: Record<string, unknown> = { headers: {} };
    const result = await invokeAuthAsync(req);
    expect(result.nextArg).toBeInstanceOf(UnauthorizedError);
    expect((result.nextArg as UnauthorizedError).statusCode).toBe(401);
    expect(req.apiKey).toBeUndefined();
  });

  it('answers 401 for a revoked key, never reusing the request identity', async () => {
    const user = await createUser();
    const { key, record } = await createApiKey(user.id, { label: 'CI key', scopes: ['READ'] });
    await revokeApiKey(user.id, record.id);

    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${key}` } };
    const result = await invokeAuthAsync(req);
    expect(result.nextArg).toBeInstanceOf(UnauthorizedError);
    expect(req.apiKey).toBeUndefined();
  });

  it('requireScope answers 403 for a READ-only key on a WRITE route, 401 with no key', async () => {
    const user = await createUser();
    const readKey = await createApiKey(user.id, { label: 'read only', scopes: ['READ'] });
    const writeKey = await createApiKey(user.id, { label: 'read write', scopes: ['READ', 'WRITE'] });

    const readRow = await resolveApiKey(readKey.key);
    const writeRow = await resolveApiKey(writeKey.key);

    // The READ-only key gets the 403 service guard, exactly as conversion
    // ingest applies it.
    const readReq = { apiKey: { id: readRow.id, userId: readRow.userId, scopes: readRow.scopes } };
    const forbidden = invokeScope(readReq, 'WRITE');
    expect(forbidden).toBeInstanceOf(ForbiddenError);
    expect((forbidden as ForbiddenError).statusCode).toBe(403);

    // The full-scope key passes the same guard.
    const writeReq = { apiKey: { id: writeRow.id, userId: writeRow.userId, scopes: writeRow.scopes } };
    expect(invokeScope(writeReq, 'WRITE')).toBeUndefined();
    expect(invokeScope(writeReq, 'READ')).toBeUndefined();

    // No key at all → 401, not 403 (the key has to exist before scope matters).
    expect(invokeScope({}, 'WRITE')).toBeInstanceOf(UnauthorizedError);
  });
});

// The two invokeAuth helpers below share the middleware call — kept as async
// because apiKeyAuth is an async function.
async function invokeAuthAsync(req: Record<string, unknown>) {
  let nextArg: unknown;
  await apiKeyAuth(req as never, {} as never, (err?: unknown) => {
    nextArg = err;
  });
  return { nextArg, req };
}

interface Scenario {
  advertiserId: string;
  publisherId: string;
  channelId: string;
  campaignId: string;
  ad: { id: string; trackingSlug: string };
  adPostId: string;
  clickId: string;
  key: string;
  keyId: string;
  ctx: { apiKeyId: string; advertiserId: string; source: string };
}

async function buildScenario(): Promise<Scenario> {
  const advertiser = await createUser({ firstName: 'Advertiser' });
  const publisher = await createUser({ firstName: 'Publisher' });
  const channel = await createChannel(publisher.id);
  const campaign = await createCampaign(advertiser.id, { name: 'Launch campaign' });
  const ad = await createAd(campaign.id);

  const adPost = await prisma.adPost.create({
    data: {
      adId: ad.id,
      campaignId: campaign.id,
      channelId: channel.id,
      publisherId: publisher.id,
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  const click = await prisma.click.create({
    data: {
      adId: ad.id,
      adPostId: adPost.id,
      campaignId: campaign.id,
      channelId: channel.id,
      userId: advertiser.id,
    },
  });

  const created = await createApiKey(advertiser.id, { label: 'CI key', scopes: ['READ', 'WRITE'] });

  return {
    advertiserId: advertiser.id,
    publisherId: publisher.id,
    channelId: channel.id,
    campaignId: campaign.id,
    ad: { id: ad.id, trackingSlug: ad.trackingSlug },
    adPostId: adPost.id,
    clickId: click.id,
    key: created.key,
    keyId: created.record.id,
    ctx: { apiKeyId: created.record.id, advertiserId: advertiser.id, source: 'postback' },
  };
}

describe('conversion ingest', () => {
  beforeEach(async () => {
    await resetDatabase();
    queue.emitWebhookEvent.mockClear();
    queue.enqueueNotification.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores exactly one row when the same conversion is posted twice, and flags the retry', async () => {
    const s = await buildScenario();

    const input = {
      clickId: s.clickId,
      eventName: 'purchase',
      valueCents: 1500,
      currency: 'USD',
      dedupeKey: 'order-1001',
    };

    const first = await recordConversion(input, s.ctx);
    expect(first.duplicate).toBe(false);

    const second = await recordConversion(input, s.ctx);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);

    const count = await prisma.conversionEvent.count();
    expect(count).toBe(1);
    const stored = await prisma.conversionEvent.findUniqueOrThrow({ where: { dedupeKey: 'order-1001' } });
    expect(stored.id).toBe(first.event.id);
    expect(stored.valueCents).toBe(1500);

    // The retry must not re-notify or re-webhook.
    const notifications = await prisma.notification.count({
      where: { userId: s.advertiserId, type: 'CONVERSION_RECORDED' },
    });
    expect(notifications).toBe(1);
    expect(queue.emitWebhookEvent).toHaveBeenCalledTimes(1);
    expect(queue.emitWebhookEvent).toHaveBeenCalledWith(
      s.advertiserId,
      'CONVERSION_RECORDED',
      expect.objectContaining({ conversionId: first.event.id, campaignId: s.campaignId }),
    );
  });

  it('derives a stable dedupe key so a same-minute retry is a no-op even without one supplied', async () => {
    const s = await buildScenario();

    // Fixed occurredAt keeps the derived key identical even if the wall clock
    // crosses a minute boundary between the two calls.
    const input = {
      clickId: s.clickId,
      eventName: 'signup',
      currency: 'USD',
      occurredAt: new Date('2026-09-20T10:30:00.000Z'),
    };

    const first = await recordConversion(input, s.ctx);
    const second = await recordConversion(input, s.ctx);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(await prisma.conversionEvent.count()).toBe(1);

    // A different event (different name) in the same minute is NOT a duplicate.
    const other = await recordConversion(
      { ...input, eventName: 'purchase', occurredAt: new Date('2026-09-20T10:30:30.000Z') },
      s.ctx,
    );
    expect(other.duplicate).toBe(false);
    expect(await prisma.conversionEvent.count()).toBe(2);
  });

  it('attributes the event to the real click: campaign, ad, channel, post and advertiser', async () => {
    const s = await buildScenario();

    const { event } = await recordConversion(
      { clickId: s.clickId, eventName: 'purchase', valueCents: 2500, currency: 'USD' },
      s.ctx,
    );

    expect(event.clickId).toBe(s.clickId);
    expect(event.campaignId).toBe(s.campaignId);
    expect(event.adId).toBe(s.ad.id);
    expect(event.channelId).toBe(s.channelId);
    expect(event.adPostId).toBe(s.adPostId);
    expect(event.advertiserId).toBe(s.advertiserId);
    expect(event.apiKeyId).toBe(s.keyId);
    expect(event.source).toBe('postback');
    expect(event.eventName).toBe('purchase');
  });

  it('resolves a tracking slug and enriches from the most recent click on that ad+user', async () => {
    const s = await buildScenario();

    // Remove the scenario's click so only the two explicitly dated clicks below
    // are candidates for "most recent".
    await prisma.click.delete({ where: { id: s.clickId } });

    // A NEWER click on the same ad — different post and channel.
    const publisher2 = await createUser({ firstName: 'Publisher 2' });
    const channel2 = await createChannel(publisher2.id);
    const post2 = await prisma.adPost.create({
      data: {
        adId: s.ad.id,
        campaignId: s.campaignId,
        channelId: channel2.id,
        publisherId: publisher2.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
    const olderClick = await prisma.click.create({
      data: {
        adId: s.ad.id,
        campaignId: s.campaignId,
        userId: s.advertiserId,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    const newestClick = await prisma.click.create({
      data: {
        adId: s.ad.id,
        adPostId: post2.id,
        campaignId: s.campaignId,
        channelId: channel2.id,
        userId: s.advertiserId,
        createdAt: new Date('2026-09-15T00:00:00.000Z'),
      },
    });

    const { event } = await recordConversion(
      { trackingSlug: s.ad.trackingSlug, eventName: 'lead', valueCents: 400 },
      s.ctx,
    );

    expect(event.adId).toBe(s.ad.id);
    expect(event.campaignId).toBe(s.campaignId);
    expect(event.advertiserId).toBe(s.advertiserId);
    // Enriched from the NEWEST click, not the older one.
    expect(event.clickId).toBe(newestClick.id);
    expect(event.adPostId).toBe(post2.id);
    expect(event.channelId).toBe(channel2.id);
    expect(olderClick.id).not.toBe(event.clickId);
  });

  it('rejects an unattributable conversion and stores nothing', async () => {
    const s = await buildScenario();

    await expect(
      recordConversion({ clickId: 'click-that-never-existed', eventName: 'purchase' }, s.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordConversion({ trackingSlug: 'no-such-slug', eventName: 'purchase' }, s.ctx),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.conversionEvent.count()).toBe(0);
  });

  it('refuses to attribute another advertiser’s click to this account', async () => {
    const s = await buildScenario();
    const other = await createUser({ firstName: 'Other advertiser' });
    const otherKey = await createApiKey(other.id, { label: 'their key', scopes: ['WRITE'] });
    const otherCtx = { apiKeyId: otherKey.record.id, advertiserId: other.id, source: 'postback' };

    // A real, valid click — but it belongs to the scenario's campaign, not to
    // `other`. It must be rejected, and nothing may be stored for `other`.
    await expect(
      recordConversion({ clickId: s.clickId, eventName: 'purchase' }, otherCtx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordConversion({ trackingSlug: s.ad.trackingSlug, eventName: 'purchase' }, otherCtx),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.conversionEvent.count({ where: { advertiserId: other.id } })).toBe(0);
    expect(await prisma.conversionEvent.count()).toBe(0);
  });
});

describe('conversion stats (honest advertiser metrics)', () => {
  beforeEach(async () => {
    await resetDatabase();
    queue.emitWebhookEvent.mockClear();
    queue.enqueueNotification.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns zero before any conversion and the exact totals after', async () => {
    const s = await buildScenario();

    // Nothing stored, nothing invented.
    const empty = await getConversionStats(s.advertiserId);
    expect(empty).toEqual({ conversions: 0, totalValueCents: 0, byCampaign: [] });

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const a = await recordConversion(
      { clickId: s.clickId, eventName: 'purchase', valueCents: 1500, dedupeKey: 'stat-a' },
      s.ctx,
    );
    const b = await recordConversion(
      { clickId: s.clickId, eventName: 'purchase', valueCents: 2500, dedupeKey: 'stat-b', occurredAt: threeDaysAgo },
      s.ctx,
    );
    // A retry of `a` must not move the numbers.
    const retry = await recordConversion(
      { clickId: s.clickId, eventName: 'purchase', valueCents: 1500, dedupeKey: 'stat-a' },
      s.ctx,
    );
    expect(retry.duplicate).toBe(true);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);

    const stats = await getConversionStats(s.advertiserId);
    expect(stats.conversions).toBe(2);
    expect(stats.totalValueCents).toBe(4000);
    expect(stats.byCampaign).toEqual([
      {
        campaignId: s.campaignId,
        campaignName: 'Launch campaign',
        conversions: 2,
        valueCents: 4000,
      },
    ]);

    // Range filtering: only the recent event inside the last day.
    const recent = await getConversionStats(s.advertiserId, { from: new Date(Date.now() - 86_400_000) });
    expect(recent.conversions).toBe(1);
    expect(recent.totalValueCents).toBe(1500);

    // Another advertiser's stats are unaffected.
    const stranger = await createUser();
    expect(await getConversionStats(stranger.id)).toEqual({ conversions: 0, totalValueCents: 0, byCampaign: [] });
  });
});
