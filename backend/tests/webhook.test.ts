import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '../src/db/prisma';
import { NotFoundError, ValidationError } from '../src/utils/errors';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite (same pattern as the other suites).
const queue = vi.hoisted(() => ({
  enqueueWebhookDelivery: vi.fn(async () => undefined),
  enqueueNotification: vi.fn(async () => undefined),
  emitWebhookEvent: vi.fn(async () => 0 as number),
}));
vi.mock('../src/queues/producers', () => queue);

// No subscriber is reachable from a test run, and the point of these tests is
// what we SEND, not what the far end answers — so the HTTP call is captured.
const axiosMock = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock }));

const {
  createWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  testWebhookEndpoint,
  queueWebhookEvent,
  deliverWebhook,
  dispatchPendingWebhookDeliveries,
  purgeWebhookDeliveries,
} = await import('../src/services/webhook.service');
const { resetDatabase, createUser, setTestSettings } = await import('./helpers/fixtures');

/**
 * ADVERTISER WEBHOOKS — the outbound contract an integrator builds against.
 *
 * The guarantees under test, in order of how much money they protect:
 *
 *   1. THE SIGNATURE. Every request is signed over `${timestamp}.${rawBody}`, so
 *      a captured body cannot be replayed with a fresh timestamp. The test
 *      recomputes the HMAC itself, and also proves a tampered body does NOT
 *      verify — otherwise the assertion would pass even with no signing at all.
 *   2. NO DOUBLE-CHARGE OF ATTENTION: an event reaches exactly the active
 *      endpoints that subscribed to it, and nothing else.
 *   3. A FAILING ENDPOINT IS RETRIED, THEN RETIRED — never retried forever,
 *      and never disabled for a single transient failure.
 *   4. THE SECRET EXISTS ONCE. It is returned at creation and is not in any
 *      read model afterwards.
 *   5. ONE ADVERTISER CANNOT TOUCH ANOTHER'S ENDPOINTS.
 */

const URL_A = 'https://subscriber.example.com/hooks/botflow';
const URL_B = 'https://other.example.com/hooks/botflow';

/** Register an endpoint and keep the one-time secret beside it. */
async function makeEndpoint(userId: string, events: string[], url = URL_A) {
  const { endpoint, secret } = await createWebhookEndpoint(userId, { url, events });
  return { endpoint, secret, url };
}

/** A delivery row created through the real fan-out path, so payloads are real. */
async function makeDelivery(
  endpointId: string,
  event = 'POST_PUBLISHED',
  payload: Record<string, unknown> = { a: 1 },
) {
  await queueWebhookEvent(
    (await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } })).userId,
    event,
    payload,
  );
  const row = await prisma.webhookDelivery.findFirstOrThrow({
    where: { endpointId },
    orderBy: { createdAt: 'desc' },
  });
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  axiosMock.post.mockReset();
  queue.enqueueWebhookDelivery.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('webhook fan-out', () => {
  it('creates exactly one delivery per active endpoint subscribed to that event', async () => {
    const user = await createUser();
    await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await makeEndpoint(user.id, ['POST_PUBLISHED', 'CAMPAIGN_COMPLETED'], URL_B);
    // Subscribed to something else entirely — must not receive this event.
    await makeEndpoint(user.id, ['INVOICE_ISSUED'], 'https://third.example.com/h');

    const queued = await queueWebhookEvent(user.id, 'POST_PUBLISHED', { postId: 'p1' });

    expect(queued).toBe(2);
    const rows = await prisma.webhookDelivery.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    expect(rows.every((r) => r.event === 'POST_PUBLISHED')).toBe(true);
    expect(queue.enqueueWebhookDelivery).toHaveBeenCalledTimes(2);
  });

  it('never fans out to an endpoint that has been switched off', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await updateWebhookEndpoint(user.id, endpoint.id, { isActive: false });

    const queued = await queueWebhookEvent(user.id, 'POST_PUBLISHED', {});

    expect(queued).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('never fans out to another advertiser', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await makeEndpoint(owner.id, ['POST_PUBLISHED']);
    await makeEndpoint(stranger.id, ['POST_PUBLISHED'], 'https://stranger.example.com/h');

    const queued = await queueWebhookEvent(owner.id, 'POST_PUBLISHED', {});

    expect(queued).toBe(1);
    const rows = await prisma.webhookDelivery.findMany({ include: { endpoint: true } });
    expect(rows.map((r) => r.endpoint.userId)).toEqual([owner.id]);
  });

  it('refuses an event that is not in the closed list rather than queueing a silent no-show', async () => {
    const user = await createUser();
    await makeEndpoint(user.id, ['POST_PUBLISHED']);

    const queued = await queueWebhookEvent(user.id, 'NOT_A_REAL_EVENT', {});

    expect(queued).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('stops fanning out entirely when the operator kill-switch is off', async () => {
    const user = await createUser();
    await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await setTestSettings({ webhooks_enabled: false });

    const queued = await queueWebhookEvent(user.id, 'POST_PUBLISHED', {});

    expect(queued).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
    expect(queue.enqueueWebhookDelivery).not.toHaveBeenCalled();
  });
});

describe('endpoint management', () => {
  it('returns the signing secret at creation and never again', async () => {
    const user = await createUser();
    const { endpoint, secret } = await makeEndpoint(user.id, ['POST_PUBLISHED']);

    expect(secret).toMatch(/^whsec_[\w-]{20,}$/);
    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(stored.secret).toBe(secret);

    // The read models must not carry it, or a support screenshot leaks it.
    const [listed] = await listWebhookEndpoints(user.id);
    expect(listed).not.toHaveProperty('secret');
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(Object.keys(JSON.stringify(endpoint))).not.toContain(secret);
  });

  it('rejects an unknown event at creation instead of storing a never-firing subscription', async () => {
    const user = await createUser();
    // The closed list is enforced at the request boundary (zod) and again in
    // the service, so an endpoint that can never fire cannot be stored.
    await expect(
      createWebhookEndpoint(user.id, { url: URL_A, events: ['NOPE'] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
  });

  it('clears the failure streak when an endpoint is re-enabled', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { failureCount: 9, disabledAt: new Date(), isActive: false },
    });

    const reenabled = await updateWebhookEndpoint(user.id, endpoint.id, { isActive: true });

    expect(reenabled.isActive).toBe(true);
    expect(reenabled.failureCount).toBe(0);
    expect(reenabled.disabledAt).toBeNull();
  });

  it('treats another advertiser\'s endpoint as not found, so ids cannot be probed', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { endpoint } = await makeEndpoint(owner.id, ['POST_PUBLISHED']);

    await expect(updateWebhookEndpoint(stranger.id, endpoint.id, { isActive: false })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteWebhookEndpoint(stranger.id, endpoint.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(testWebhookEndpoint(stranger.id, endpoint.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.webhookEndpoint.count()).toBe(1);
  });

  it('takes the delivery history with a deleted endpoint', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await queueWebhookEvent(user.id, 'POST_PUBLISHED', {});
    expect(await prisma.webhookDelivery.count()).toBe(1);

    await deleteWebhookEndpoint(user.id, endpoint.id);

    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('queues a TEST delivery for the owner so the signature can be verified', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);

    const { delivery } = await testWebhookEndpoint(user.id, endpoint.id);

    expect(delivery.event).toBe('TEST');
    expect(delivery.status).toBe('PENDING');
    // Queued on the row id; the producer's own parameter defaults supply the
    // delay and attempt number.
    expect(queue.enqueueWebhookDelivery).toHaveBeenCalledWith(delivery.id);
  });

  it('shows the owner their own delivery log and nobody else\'s', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const mine = await makeEndpoint(owner.id, ['POST_PUBLISHED']);
    const theirs = await makeEndpoint(stranger.id, ['POST_PUBLISHED'], 'https://stranger.example.com/h');
    await queueWebhookEvent(owner.id, 'POST_PUBLISHED', {});
    await queueWebhookEvent(stranger.id, 'POST_PUBLISHED', {});

    const log = await listWebhookDeliveries(owner.id);

    expect(log).toHaveLength(1);
    expect(log[0]!.endpointId).toBe(mine.endpoint.id);
    expect(log.some((d) => d.endpointId === theirs.endpoint.id)).toBe(false);
  });
});

describe('delivery', () => {
  it('signs the exact bytes it sends, and a tampered body does not verify', async () => {
    const user = await createUser();
    const { endpoint, secret, url } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id, 'POST_PUBLISHED', { postId: 'p1' });
    axiosMock.post.mockResolvedValue({ status: 200, data: 'ok' });

    await deliverWebhook(row.id);

    const [calledUrl, rawBody, config] = axiosMock.post.mock.calls[0] as unknown as [
      string,
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toBe(url);

    const timestamp = config.headers['X-BotFlow-Timestamp']!;
    expect(Number(timestamp)).toBeGreaterThan(0);
    expect(config.headers['X-BotFlow-Event']).toBe('POST_PUBLISHED');
    expect(config.headers['X-BotFlow-Delivery']).toBe(row.id);

    const sign = (body: string) =>
      `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;

    expect(config.headers['X-BotFlow-Signature']).toBe(sign(rawBody));

    // Negative control: the assertion above must be able to fail. Rebinding a
    // different body to the same signature must NOT verify.
    expect(config.headers['X-BotFlow-Signature']).not.toBe(sign(`${rawBody} `));

    const envelope = JSON.parse(rawBody) as { id: string; event: string; data: unknown };
    expect(envelope.id).toBe(row.id);
    expect(envelope.event).toBe('POST_PUBLISHED');
    expect(envelope.data).toEqual({ postId: 'p1' });
  });

  it('marks a 2xx as delivered and clears the failure streak', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { failureCount: 3 } });
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockResolvedValue({ status: 204, data: '' });

    const outcome = await deliverWebhook(row.id);

    expect(outcome).toMatchObject({ status: 'DELIVERED', responseStatus: 204, attempts: 1 });
    const [delivery, ep] = await Promise.all([
      prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } }),
      prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }),
    ]);
    expect(delivery.status).toBe('DELIVERED');
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
    expect(delivery.nextAttemptAt).toBeNull();
    expect(ep.failureCount).toBe(0);
    expect(ep.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('schedules a retry on a non-2xx, keeping the row pending rather than losing it', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockResolvedValue({ status: 500, data: 'boom' });

    const outcome = await deliverWebhook(row.id);

    expect(outcome).toMatchObject({ status: 'RETRY', responseStatus: 500, attempts: 1 });
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(delivery.status).toBe('PENDING');
    expect(delivery.attempts).toBe(1);
    expect(delivery.error).toContain('500');
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // 30s is the first backoff step, and the retry carries the NEXT attempt
    // number so BullMQ does not dedupe it away against the first job id.
    expect(queue.enqueueWebhookDelivery).toHaveBeenLastCalledWith(row.id, 30_000, 1);
  });

  it('treats a transport failure the same as a bad status', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockRejectedValue(new Error('ECONNREFUSED'));

    const outcome = await deliverWebhook(row.id);

    expect(outcome.status).toBe('RETRY');
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(delivery.error).toContain('ECONNREFUSED');
  });

  it('retires an endpoint only once retries are exhausted AND it keeps failing', async () => {
    const user = await createUser();
    await setTestSettings({ webhook_max_attempts: 1, webhook_disable_after_failures: 1 });
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    // The fan-out already queued the first attempt; only what the delivery path
    // queues from here on is what this test is about.
    queue.enqueueWebhookDelivery.mockClear();
    axiosMock.post.mockRejectedValue(new Error('dead host'));

    const outcome = await deliverWebhook(row.id);

    expect(outcome.status).toBe('EXHAUSTED');
    const [delivery, ep] = await Promise.all([
      prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } }),
      prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }),
    ]);
    expect(delivery.status).toBe('EXHAUSTED');
    expect(delivery.nextAttemptAt).toBeNull();
    expect(ep.isActive).toBe(false);
    expect(ep.disabledAt).toBeInstanceOf(Date);
    // Nothing further may be queued for a retired endpoint.
    expect(queue.enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it('does not disable an endpoint after a single failure while retries remain', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockRejectedValue(new Error('blip'));

    await deliverWebhook(row.id);

    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(ep.isActive).toBe(true);
    expect(ep.disabledAt).toBeNull();
    expect(ep.failureCount).toBe(1);
  });

  it('stops retrying once retries are exhausted, even before the disable threshold', async () => {
    const user = await createUser();
    await setTestSettings({ webhook_max_attempts: 2, webhook_disable_after_failures: 50 });
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockResolvedValue({ status: 503, data: 'nope' });

    await deliverWebhook(row.id);
    const second = await deliverWebhook(row.id);

    expect(second.status).toBe('EXHAUSTED');
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(ep.isActive).toBe(true); // below the disable threshold
    expect(ep.failureCount).toBe(2);
  });

  it('makes no HTTP call for an endpoint that was switched off after the event was raised', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    await updateWebhookEndpoint(user.id, endpoint.id, { isActive: false });

    const outcome = await deliverWebhook(row.id);

    expect(outcome.status).toBe('SKIPPED');
    expect(axiosMock.post).not.toHaveBeenCalled();
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(delivery.status).toBe('FAILED');
    expect(delivery.error).toContain('not active');
  });

  it('re-delivering an already-delivered row moves no data and sends no second request', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const row = await makeDelivery(endpoint.id);
    axiosMock.post.mockResolvedValue({ status: 200, data: 'ok' });
    await deliverWebhook(row.id);
    const firstDeliveredAt = (
      await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })
    ).deliveredAt;

    const again = await deliverWebhook(row.id);

    expect(again.status).toBe('SKIPPED');
    expect(axiosMock.post).toHaveBeenCalledTimes(1);
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(delivery.deliveredAt).toEqual(firstDeliveredAt);
  });
});

describe('dispatch safety net and retention', () => {
  it('re-queues a pending delivery that is due, and leaves a future one alone', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const due = await makeDelivery(endpoint.id);
    const later = await makeDelivery(endpoint.id);
    await prisma.webhookDelivery.update({
      where: { id: later.id },
      data: { nextAttemptAt: new Date(Date.now() + 3_600_000) },
    });
    queue.enqueueWebhookDelivery.mockClear();

    const requeued = await dispatchPendingWebhookDeliveries();

    expect(requeued).toBe(1);
    expect(queue.enqueueWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(queue.enqueueWebhookDelivery).toHaveBeenCalledWith(due.id, 0, 0);
  });

  it('does not resurrect a delivery whose endpoint was retired', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    await makeDelivery(endpoint.id);
    await updateWebhookEndpoint(user.id, endpoint.id, { isActive: false });
    queue.enqueueWebhookDelivery.mockClear();

    expect(await dispatchPendingWebhookDeliveries()).toBe(0);
    expect(queue.enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  it('purges old delivered rows but keeps recent ones and the failure history', async () => {
    const user = await createUser();
    const { endpoint } = await makeEndpoint(user.id, ['POST_PUBLISHED']);
    const old = await makeDelivery(endpoint.id);
    await makeDelivery(endpoint.id);
    // Retention keys off `createdAt` (when the event happened), so that is the
    // field that has to age for the row to become eligible.
    await prisma.webhookDelivery.update({
      where: { id: old.id },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(Date.now() - 30 * 86_400_000),
        createdAt: new Date(Date.now() - 30 * 86_400_000),
      },
    });

    const purged = await purgeWebhookDeliveries();

    expect(purged.delivered).toBe(1);
    const remaining = await prisma.webhookDelivery.findMany();
    expect(remaining.map((r) => r.id)).not.toContain(old.id);
    expect(remaining).toHaveLength(1);
  });
});
