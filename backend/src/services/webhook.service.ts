import crypto from 'node:crypto';
import axios from 'axios';
import { Prisma, type WebhookDelivery, type WebhookEndpoint } from '@prisma/client';
import {
  WEBHOOK_EVENT_LIST,
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
} from '@botflow/shared';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { SETTING_KEYS } from '../config/constants';
import { getBoolSetting, getNumberSetting } from './settings.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import {
  isPrivateOrInternalHost,
  pinnedLookup,
  resolveHostAddresses,
} from './urlSecurity.service';
import { recordAudit } from './audit.service';
import { enqueueWebhookDelivery } from '../queues/producers';

/**
 * Advertiser webhooks — the outbound half of programmatic access.
 *
 * The contract an integrator depends on:
 *   - a row is written to `WebhookDelivery` BEFORE any HTTP is attempted, so a
 *     crash between "event happened" and "request sent" loses nothing — the
 *     sweeper picks the row up;
 *   - every request carries `X-BotFlow-Signature: sha256=<hmac>` computed over
 *     `${timestamp}.${rawBody}`, so a replay of an old body with a fresh
 *     timestamp cannot validate;
 *   - a non-2xx response is retried on a widening backoff, and an endpoint that
 *     keeps failing is disabled rather than hammered forever.
 *
 * Nothing here is allowed to throw into a business operation. Callers use
 * `emitWebhookEvent` (queues/producers.ts), which swallows every failure.
 */

/** Secret format: `whsec_<43 base64url chars>`. */
const SECRET_PREFIX = 'whsec_';
/** Widening backoff between delivery attempts, in seconds. */
const RETRY_DELAYS_SECONDS = [30, 120, 600, 3_600, 21_600];
/** Per-request timeout. A subscriber that takes longer than this is failing. */
const DELIVERY_TIMEOUT_MS = 10_000;
/** Never let one sweep monopolise the worker. */
const DISPATCH_BATCH_SIZE = 200;
/** An undelivered row older than this is not worth re-attempting. */
const DISPATCH_MAX_AGE_MS = 48 * 3_600_000;

/* ------------------------------------------------------------------
 *  Views — what the Mini App and the API are allowed to see
 * ------------------------------------------------------------------ */

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  failureCount: number;
  disabledAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryView {
  id: string;
  endpointId: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

/**
 * Serialize an endpoint WITHOUT its signing secret.
 *
 * The secret is returned exactly once — from `createWebhookEndpoint` — and is
 * never readable afterwards. A secret that can be re-read is a secret that
 * leaks through a support screenshot.
 */
function toEndpointView(row: WebhookEndpoint): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events as unknown as string[],
    isActive: row.isActive,
    failureCount: row.failureCount,
    disabledAt: row.disabledAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDeliveryView(row: WebhookDelivery): WebhookDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    event: row.event as unknown as string,
    status: row.status as unknown as string,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    error: row.error,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------
 *  Endpoint management (Mini App, behind telegramAuth)
 * ------------------------------------------------------------------ */

/** Only our closed event list is subscribable — see shared/src/enums.ts. */
function assertKnownEvents(events: string[]): void {
  const unknown = events.filter((e) => !WEBHOOK_EVENT_LIST.includes(e));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown webhook event(s): ${unknown.join(', ')}`);
  }
}

/**
 * Reject a webhook target that points inside the network (SSRF guard).
 * HTTPS-only is enforced by the schema; this closes the internal-address hole.
 */
function assertPublicWebhookUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ValidationError('Webhook url is not a valid URL');
  }
  if (isPrivateOrInternalHost(host)) {
    throw new ValidationError(
      'Webhook url must not point at a private, loopback, link-local or internal address',
    );
  }
}

/**
 * Register a new endpoint.
 *
 * Returns the signing secret ONCE — there is no code path that reads it back,
 * so a subscriber who loses it must rotate (delete and recreate).
 */
export async function createWebhookEndpoint(
  userId: string,
  input: unknown,
): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  const parsed = createWebhookEndpointSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Invalid webhook endpoint', parsed.error.issues);
  }
  const { url, description, events } = parsed.data;
  assertKnownEvents(events);
  assertPublicWebhookUrl(url);

  const secret = `${SECRET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;

  const row = await prisma.webhookEndpoint.create({
    data: {
      userId,
      url,
      description: description ?? null,
      secret,
      events: events as never,
    },
  });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'WEBHOOK_ENDPOINT_CREATED',
    targetType: 'WEBHOOK_ENDPOINT',
    targetId: row.id,
    newValue: { url, events },
    // Deliberately no secret material.
  });

  return { endpoint: toEndpointView(row), secret };
}

export async function listWebhookEndpoints(userId: string): Promise<WebhookEndpointView[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toEndpointView);
}

/**
 * Update an endpoint. Returns 404 for someone else's id, so an account cannot
 * probe which endpoint ids exist.
 */
export async function updateWebhookEndpoint(
  userId: string,
  id: string,
  input: unknown,
): Promise<WebhookEndpointView> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw new NotFoundError('Webhook endpoint');

  const parsed = updateWebhookEndpointSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('Invalid webhook endpoint', parsed.error.issues);
  }
  const { url, description, events, isActive } = parsed.data;
  if (events) assertKnownEvents(events);
  if (url !== undefined) assertPublicWebhookUrl(url);

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: {
      ...(url !== undefined ? { url } : {}),
      ...(description !== undefined ? { description: description ?? null } : {}),
      ...(events !== undefined ? { events: events as never } : {}),
      // Re-activating clears the failure streak: the owner has presumably fixed
      // whatever was broken, and carrying the old count forward would disable
      // them again on the very next failure.
      ...(isActive !== undefined
        ? { isActive, ...(isActive ? { failureCount: 0, disabledAt: null } : {}) }
        : {}),
    },
  });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'WEBHOOK_ENDPOINT_UPDATED',
    targetType: 'WEBHOOK_ENDPOINT',
    targetId: id,
    oldValue: { url: existing.url, events: existing.events, isActive: existing.isActive },
    newValue: { url: updated.url, events: updated.events, isActive: updated.isActive },
  });

  return toEndpointView(updated);
}

/**
 * Remove an endpoint. Its delivery history goes with it (`onDelete: Cascade`),
 * which is what a subscriber expects when they tear an integration down.
 */
export async function deleteWebhookEndpoint(userId: string, id: string): Promise<{ deleted: true }> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw new NotFoundError('Webhook endpoint');

  await prisma.webhookEndpoint.delete({ where: { id } });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'WEBHOOK_ENDPOINT_DELETED',
    targetType: 'WEBHOOK_ENDPOINT',
    targetId: id,
    oldValue: { url: existing.url, events: existing.events },
  });

  return { deleted: true };
}

/**
 * A subscriber's own delivery log — the first thing they need when they say
 * "we never received it". Scoped to their endpoints only.
 */
export async function listWebhookDeliveries(
  userId: string,
  q: { endpointId?: string; limit?: number } = {},
): Promise<WebhookDeliveryView[]> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      endpoint: { userId },
      ...(q.endpointId ? { endpointId: q.endpointId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map(toDeliveryView);
}

/**
 * Queue a `TEST` delivery so the owner can prove the endpoint is reachable and
 * the signature validates before real money events depend on it.
 */
export async function testWebhookEndpoint(
  userId: string,
  id: string,
): Promise<{ delivery: WebhookDeliveryView }> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!existing || existing.userId !== userId) throw new NotFoundError('Webhook endpoint');

  const delivery = await createDelivery(id, 'TEST', {
    message: 'This is a test event from BotFlow Ads.',
    endpointId: id,
  });

  return { delivery: toDeliveryView(delivery) };
}

/* ------------------------------------------------------------------
 *  Fan-out (platform -> every subscribed endpoint)
 * ------------------------------------------------------------------ */

async function createDelivery(
  endpointId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<WebhookDelivery> {
  const row = await prisma.webhookDelivery.create({
    data: {
      endpointId,
      event: event as never,
      payload: payload as Prisma.InputJsonValue,
      status: 'PENDING',
    },
  });

  // Row first, then queue. If the enqueue fails the row still exists and the
  // sweeper will find it — the reverse order would lose the event entirely.
  await enqueueWebhookDelivery(row.id);
  return row;
}

/**
 * Fan one event out to every active endpoint of this user that subscribes to it.
 *
 * Returns how many deliveries were queued. An endpoint subscribed to nothing
 * (empty `events`) receives nothing — subscribing is explicit, never implied.
 */
export async function queueWebhookEvent(
  userId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  if (!WEBHOOK_EVENT_LIST.includes(event)) {
    logger.warn({ userId, event }, 'refusing to queue an unknown webhook event');
    return 0;
  }

  // Operator kill-switch, checked here rather than in the callers so every
  // producer of an event is covered by one setting.
  if (!(await getBoolSetting(SETTING_KEYS.WEBHOOKS_ENABLED, true))) return 0;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { userId, isActive: true, events: { has: event as never } },
    select: { id: true },
  });

  let queued = 0;
  for (const endpoint of endpoints) {
    try {
      await createDelivery(endpoint.id, event, payload);
      queued += 1;
    } catch (err) {
      // One bad endpoint must not stop the others.
      logger.error({ err, endpointId: endpoint.id, event }, 'failed to queue webhook delivery');
    }
  }

  if (queued > 0) logger.info({ userId, event, queued }, 'webhook event queued');
  return queued;
}

/* ------------------------------------------------------------------
 *  Delivery
 * ------------------------------------------------------------------ */

/**
 * `sha256=<hmac>` over `${timestamp}.${rawBody}`.
 *
 * Binding the timestamp into the signed bytes is what makes replay detectable:
 * a captured body cannot be re-sent later with a new timestamp.
 */
function sign(secret: string, timestamp: number, rawBody: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `sha256=${mac}`;
}

function nextDelaySeconds(attempt: number): number {
  const idx = Math.min(attempt, RETRY_DELAYS_SECONDS.length - 1);
  return RETRY_DELAYS_SECONDS[idx] as number;
}

export interface DeliveryOutcome {
  status: 'DELIVERED' | 'RETRY' | 'EXHAUSTED' | 'SKIPPED';
  responseStatus?: number;
  error?: string;
  attempts: number;
}

/**
 * Attempt one delivery of one `WebhookDelivery` row.
 *
 * Never throws: every outcome is recorded on the row and, when a retry is due,
 * a fresh job is queued with an attempt-scoped job id (a re-add under the SAME
 * id would be swallowed by BullMQ's dedupe while the previous job is still in
 * the completed set — the retry would silently never happen).
 */
export async function deliverWebhook(deliveryId: string): Promise<DeliveryOutcome> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery) {
    logger.warn({ deliveryId }, 'webhook delivery row no longer exists');
    return { status: 'SKIPPED', attempts: 0 };
  }
  if (delivery.status === 'DELIVERED') {
    return { status: 'SKIPPED', attempts: delivery.attempts };
  }

  const endpoint = delivery.endpoint;
  if (!endpoint.isActive) {
    // The subscription was switched off (or auto-disabled) after the event was
    // raised. Record why, so the subscriber's log is not a silent gap.
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'FAILED', error: 'Endpoint is not active', nextAttemptAt: null },
    });
    return { status: 'SKIPPED', error: 'Endpoint is not active', attempts: delivery.attempts };
  }

  const maxAttempts = await getNumberSetting(SETTING_KEYS.WEBHOOK_MAX_ATTEMPTS, 5);
  const attempt = delivery.attempts + 1;

  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    createdAt: delivery.createdAt.toISOString(),
    data: delivery.payload,
  });

  let responseStatus: number | undefined;
  let failure: string | undefined;

  try {
    // Defence in depth: re-check at delivery time so an endpoint stored before
    // this guard existed (or via a direct DB write) can never be dialled.
    assertPublicWebhookUrl(endpoint.url);

    // The check above only judges the hostname, and it was made when the endpoint was
    // registered — DNS is free to have changed since. This is the request that actually
    // reaches the network, so this is where the resolved addresses have to be vetted,
    // and where the vetted answers get pinned to it.
    const resolution = await resolveHostAddresses(new URL(endpoint.url).hostname);
    if (!resolution.ok) {
      throw new Error(
        resolution.reason === 'internal'
          ? 'Webhook host resolves to a private, loopback, link-local or internal address'
          : 'Webhook host could not be resolved',
      );
    }

    const response = await axios.post(endpoint.url, rawBody, {
      timeout: DELIVERY_TIMEOUT_MS,
      maxRedirects: 0,
      lookup: pinnedLookup(resolution.addresses) as NonNullable<
        Parameters<typeof axios.post>[2]
      >['lookup'],
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BotFlow-Webhooks/1.0',
        'X-BotFlow-Event': String(delivery.event),
        'X-BotFlow-Delivery': delivery.id,
        'X-BotFlow-Timestamp': String(timestamp),
        'X-BotFlow-Signature': sign(endpoint.secret, timestamp, rawBody),
      },
      // Non-2xx must be inspected, not thrown — axios would otherwise turn a
      // 500 from the subscriber into an indistinguishable transport error.
      validateStatus: () => true,
      // We must see the subscriber's real status, not a followed redirect's.
      transformResponse: [(data: unknown) => data],
    });
    responseStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      failure = `Endpoint responded ${response.status}`;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : 'Delivery failed';
  }

  /* ---- Success ---- */
  if (!failure) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DELIVERED',
        attempts: attempt,
        responseStatus: responseStatus ?? null,
        error: null,
        deliveredAt: new Date(),
        nextAttemptAt: null,
      },
    });
    // A single success clears the streak: this endpoint is alive.
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { failureCount: 0, lastSuccessAt: new Date() },
    });
    return { status: 'DELIVERED', responseStatus, attempts: attempt };
  }

  /* ---- Failure: retry, or give up and disable ---- */
  const exhausted = attempt >= maxAttempts;

  if (exhausted) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'EXHAUSTED',
        attempts: attempt,
        responseStatus: responseStatus ?? null,
        error: failure,
        nextAttemptAt: null,
      },
    });
  } else {
    const delayMs = nextDelaySeconds(attempt - 1) * 1_000;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'PENDING',
        attempts: attempt,
        responseStatus: responseStatus ?? null,
        error: failure,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
  }

  const disableAfter = await getNumberSetting(SETTING_KEYS.WEBHOOK_DISABLE_AFTER_FAILURES, 20);
  const failedEndpoint = await prisma.webhookEndpoint.update({
    where: { id: endpoint.id },
    data: { failureCount: { increment: 1 }, lastFailureAt: new Date() },
    select: { failureCount: true },
  });

  // Only retire an endpoint that has run out of retries too — a single
  // transient failure on an otherwise-healthy endpoint must not disable it.
  if (exhausted && failedEndpoint.failureCount >= disableAfter) {
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { isActive: false, disabledAt: new Date() },
    });
    logger.error(
      { endpointId: endpoint.id, failureCount: failedEndpoint.failureCount },
      'webhook endpoint disabled after repeated failures',
    );
  }

  if (!exhausted) {
    // Distinct job id per attempt — see the note on this function.
    await enqueueWebhookDelivery(deliveryId, nextDelaySeconds(attempt - 1) * 1_000, attempt);
  }

  logger.warn({ deliveryId, attempt, responseStatus, failure }, 'webhook delivery failed');
  return { status: exhausted ? 'EXHAUSTED' : 'RETRY', responseStatus, error: failure, attempts: attempt };
}

/**
 * Safety net for the delivery queue.
 *
 * A pending row whose job was lost (deploy mid-flight, Redis eviction) would
 * otherwise sit forever. This re-queues anything due, so delivery is
 * at-least-once even when the queue loses a message.
 */
export async function dispatchPendingWebhookDeliveries(): Promise<number> {
  const now = new Date();
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      createdAt: { gte: new Date(now.getTime() - DISPATCH_MAX_AGE_MS) },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      endpoint: { isActive: true },
    },
    orderBy: { createdAt: 'asc' },
    take: DISPATCH_BATCH_SIZE,
    select: { id: true, attempts: true },
  });

  for (const row of rows) {
    await enqueueWebhookDelivery(row.id, 0, row.attempts);
  }

  if (rows.length > 0) logger.info({ count: rows.length }, 're-dispatched pending webhook deliveries');
  return rows.length;
}

/**
 * Retention. A subscriber's log is a debugging aid, not an archive; keeping
 * every attempt forever would grow the table without bound.
 *
 * Skipped entirely when the operator has switched webhooks off.
 */
export async function purgeWebhookDeliveries(): Promise<{ delivered: number; failed: number }> {
  const enabled = await getBoolSetting(SETTING_KEYS.WEBHOOKS_ENABLED, true);
  if (!enabled) return { delivered: 0, failed: 0 };

  const delivered = await prisma.webhookDelivery.deleteMany({
    where: { status: 'DELIVERED', createdAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
  });
  const failed = await prisma.webhookDelivery.deleteMany({
    where: {
      status: { in: ['FAILED', 'EXHAUSTED'] },
      createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) },
    },
  });

  return { delivered: delivered.count, failed: failed.count };
}
