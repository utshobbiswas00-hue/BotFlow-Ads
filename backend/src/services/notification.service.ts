import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { escapeHtml } from '../utils/format';
import { sendUserMessage, sendUserMessageDetailed, type UserMessageSendResult } from '../utils/telegram';
import { enqueueNotification } from '../queues/producers';
import { notificationEmailHtml } from '../utils/mailer';
import { withRetry } from '../utils/retry';
import { sendTransactionalEmail } from './email.service';
import { logger } from '../config/logger';

/**
 * Notifications are written to the DB first (so they always appear in the
 * in-app inbox) and then delivered to Telegram asynchronously. A Telegram
 * failure never rolls back the DB row — the user just sees it in the app.
 */

/**
 * Types that also get a transactional email, in addition to the in-app row.
 * Deliberately a short list: chat covers the rest, and email is for the
 * moments that would otherwise be silently missed (money spendable, an
 * account touched from a new device, an invoice issued).
 */
const EMAIL_FAN_OUT_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'EARNINGS_AVAILABLE',
  'SECURITY_ALERT',
  'INVOICE_READY',
]);

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  link?: string;
  /** Skip the Telegram push (e.g. the user is already looking at the screen). */
  silent?: boolean;
  /**
   * Broadcast delivery tracking (spec §52), optional and additive.
   *
   * When set, the queued `send-telegram-notification` job carries these ids and
   * the worker records this recipient's outcome into `BroadcastRecipient`. When
   * absent — every ordinary notification — the payload is byte-for-byte what it
   * always was and the tracking branch is never entered.
   */
  broadcastJobId?: string;
  broadcastRecipientId?: string;
}

export async function createNotification(input: NotifyInput): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: (input.data ?? null) as never,
        link: input.link ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, userId: input.userId, type: input.type }, 'failed to persist notification');
    return;
  }

  if (!input.silent) {
    await enqueueNotification({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data,
    });
  }

  // Email fan-out: a few notification types are not enough as an in-app
  // notice alone — the user may not be looking at the Mini App when money
  // becomes available, a sign-in comes from a new device, or an invoice is
  // issued. Those (and only those) also get a transactional email, mirroring
  // the notification's own title/body. Everything else stays chat-only.
  // Best-effort on all levels: sendTransactionalEmail never throws, and this
  // block is additionally isolated so no future change can let an email
  // failure touch the notification row or the caller.
  if (EMAIL_FAN_OUT_TYPES.has(input.type)) {
    try {
      await sendTransactionalEmail({
        userId: input.userId,
        subject: input.title,
        html: notificationEmailHtml(input.title, input.body),
        text: `${input.title}\n\n${input.body}`,
      });
    } catch (err) {
      logger.warn({ err, userId: input.userId, type: input.type }, 'email fan-out failed');
    }
  }
}

/** Fan out to the same notification for many users (e.g. all channel owners). */
export async function createBulkNotifications(inputs: NotifyInput[]): Promise<void> {
  if (!inputs.length) return;

  try {
    await prisma.notification.createMany({
      data: inputs.map((i) => ({
        userId: i.userId,
        type: i.type,
        title: i.title,
        body: i.body,
        data: (i.data ?? null) as never,
        link: i.link ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err, count: inputs.length }, 'failed to persist bulk notifications');
  }

  await Promise.all(
    inputs
      .filter((i) => !i.silent)
      .map((i) =>
        enqueueNotification({
          userId: i.userId,
          type: i.type,
          title: i.title,
          body: i.body,
          data: i.data,
          // Only broadcast fan-out carries these; every other caller leaves them
          // undefined so the queued payload is unchanged.
          ...(i.broadcastJobId && i.broadcastRecipientId
            ? { broadcastJobId: i.broadcastJobId, broadcastRecipientId: i.broadcastRecipientId }
            : {}),
        }),
      ),
  );
}

/**
 * Actually push to Telegram. Called by the notification worker so a slow
 * Telegram response cannot block an API request.
 */
export async function deliverToTelegram(payload: {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { telegramId: true },
  });

  if (!user) return false;

  const text = `<b>${escapeHtml(payload.title)}</b>\n\n${escapeHtml(payload.body)}`;

  // sendUserMessage swallows every Telegram error (including Grammy's 429
  // "Too Many Requests" with retry_after) and only returns a boolean, so a
  // bare `false` used to be logged by the worker and the job COMPLETED — the
  // notification was then dropped for good with no BullMQ retry. Give each
  // push a short, backed-off retry here, and if it still fails THROW so the
  // job is retried by BullMQ instead of being reported as delivered.
  let ok = false;
  try {
    ok = await withRetry(
      async () => {
        const sent = await sendUserMessage(user.telegramId, text);
        if (!sent) throw new Error('sendUserMessage returned false');
        return true;
      },
      { attempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 },
    );
  } catch {
    ok = false;
  }

  if (!ok) {
    throw new Error('telegram notification was not delivered after retries');
  }

  await prisma.notification
    .updateMany({
      // Match the exact notification this push mirrors (title + body), not
      // merely every undelivered row of the same type — a type-only filter
      // marked unrelated notifications of that type as delivered.
      where: {
        userId: payload.userId,
        type: payload.type as NotificationType,
        title: payload.title,
        body: payload.body,
        delivered: false,
      },
      data: { delivered: true, sentAt: new Date() },
    })
    .catch((err) => {
      logger.warn(
        { err, userId: payload.userId, type: payload.type },
        'could not mark notification as delivered',
      );
    });

  return true;
}

/* ------------------------------------------------------------------
 *  Broadcast delivery tracking (spec §52)
 * ------------------------------------------------------------------ */

/** The delivery outcome recorded on one `BroadcastRecipient` row. */
export interface BroadcastDeliveryResult {
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  telegramMessageId: bigint | null;
  error: string | null;
}

/** How many times one broadcast DM is attempted before it is reported failed. */
const BROADCAST_DELIVERY_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a single Telegram send result onto a recipient status.
 *
 * Pure : no database, no clock — the branch that decides SENT / FAILED /
 * SKIPPED is the one worth pinning in a test. A permanent refusal (blocked,
 * kicked, deactivated, gone) is SKIPPED, not FAILED: the platform did its job
 * and the report should not read as a delivery failure.
 */
export function classifyUserMessageResult(result: UserMessageSendResult): BroadcastDeliveryResult {
  if (result.ok) {
    return { status: 'SENT', telegramMessageId: result.messageId, error: null };
  }
  if (result.permanent) {
    return {
      status: 'SKIPPED',
      telegramMessageId: null,
      error: result.error ?? 'recipient is unreachable',
    };
  }
  return {
    status: 'FAILED',
    telegramMessageId: null,
    error: result.error ?? 'telegram notification was not delivered',
  };
}

/**
 * Deliver ONE broadcast DM and report its outcome richly (message id / error).
 *
 * This is the tracked twin of `deliverToTelegram`. It is only reached from the
 * worker when the job carries a broadcast recipient id, so the ordinary
 * notification path is completely untouched. Mirrors `deliverToTelegram`'s
 * three-attempt backoff and delivery stamp, but returns detail instead of a
 * bare boolean and never throws.
 */
export async function deliverBroadcastMessage(payload: {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<BroadcastDeliveryResult> {
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { telegramId: true },
  });

  // Gone before we could even try — nothing to retry, nothing to fail.
  if (!user) {
    return { status: 'SKIPPED', telegramMessageId: null, error: 'recipient no longer exists' };
  }

  const text = `<b>${escapeHtml(payload.title)}</b>\n\n${escapeHtml(payload.body)}`;

  let last: UserMessageSendResult = { ok: false, messageId: null, error: null, permanent: false };
  for (let attempt = 0; attempt < BROADCAST_DELIVERY_ATTEMPTS; attempt += 1) {
    last = await sendUserMessageDetailed(user.telegramId, text);
    if (last.ok || last.permanent) break;
    if (attempt < BROADCAST_DELIVERY_ATTEMPTS - 1) {
      await delay(500 * 2 ** attempt);
    }
  }

  const outcome = classifyUserMessageResult(last);

  if (outcome.status === 'SENT') {
    // Same delivery stamp the generic path applies (title + body match), and
    // equally best-effort: the Telegram message already went out.
    await prisma.notification
      .updateMany({
        where: {
          userId: payload.userId,
          type: payload.type as NotificationType,
          title: payload.title,
          body: payload.body,
          delivered: false,
        },
        data: { delivered: true, sentAt: new Date() },
      })
      .catch((err) => {
        logger.warn(
          { err, userId: payload.userId, type: payload.type },
          'could not mark broadcast notification as delivered',
        );
      });
  }

  return outcome;
}

export async function listNotifications(userId: string, p: Pagination, unreadOnly = false) {
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(unreadOnly ? { isRead: false } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        data: true,
        link: true,
        isRead: true,
        // Selected so the client always receives the full `{ isRead, readAt }`
        // pair from the user inbox.
        readAt: true,
        createdAt: true,
      },
    }),
  ]);

  return buildPaginated(items, total, p);
}

export async function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export async function markNotificationsRead(userId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}

export async function markAllRead(userId: string): Promise<number> {
  const res = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}

/* ------------------------------------------------------------------
 *  Admin inbox (AdminNotification — keyed to the admin ROLE)
 *
 *  Deliberately separate from the user-scoped functions above: an ops alert is
 *  addressed to the `AdminUser`, not the person, so it must not be written into
 *  (or read out of) the user's personal `Notification` inbox. The shape returned
 *  is identical, so one admin-panel contract serves both.
 * ------------------------------------------------------------------ */

export async function listAdminNotifications(
  adminId: string,
  p: Pagination,
  unreadOnly = false,
) {
  const where: Prisma.AdminNotificationWhereInput = {
    adminId,
    ...(unreadOnly ? { isRead: false } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.adminNotification.count({ where }),
    prisma.adminNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        data: true,
        link: true,
        isRead: true,
        readAt: true,
        createdAt: true,
      },
    }),
  ]);

  return buildPaginated(items, total, p);
}

export async function countUnreadAdminNotifications(adminId: string): Promise<number> {
  return prisma.adminNotification.count({ where: { adminId, isRead: false } });
}

export async function markAdminNotificationsRead(
  adminId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const res = await prisma.adminNotification.updateMany({
    where: { adminId, id: { in: ids }, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}

export async function markAllAdminNotificationsRead(adminId: string): Promise<number> {
  const res = await prisma.adminNotification.updateMany({
    where: { adminId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return res.count;
}

/* ------------------------------------------------------------------
 *  Admin alerts
 * ------------------------------------------------------------------ */

/**
 * The `NotificationType` persisted for an ops alert.
 *
 * `SYSTEM` is the existing general-purpose operational type and is NOT in
 * `EMAIL_FAN_OUT_TYPES`. `SECURITY_ALERT` was the other candidate but it means
 * "your account was touched from a new device" and fans out to email, neither of
 * which is true of a deposit/withdrawal/delivery page. No enum member is added —
 * the enum is already migrated, so a new member would demand a migration.
 */
const ADMIN_ALERT_NOTIFICATION_TYPE: NotificationType = 'SYSTEM';

/**
 * Persist an ops alert into every ACTIVE admin's admin inbox.
 *
 * The Telegram page is fire-and-forget chat: once read, the alert is gone. This
 * writes the durable copy to `AdminNotification`, keyed to the `AdminUser` (the
 * ROLE) rather than the person's `User` inbox, so ops history outlives any one
 * admin and the same human's personal inbox stays free of ops noise.
 *
 * Non-throwing by construction: `alertAdmins` is called from alert paths
 * (webhooks, workers, fraud scans), so a persistence failure must be logged and
 * swallowed rather than break the money-critical caller. The whole body is
 * wrapped, so both the lookup and the insert are failure-tolerant.
 *
 * No queued push is enqueued here: Telegram is already handled by
 * `alertAdmins`'s own retrying push, so a second notification job would deliver
 * a duplicate DM.
 */
async function persistAdminAlert(text: string): Promise<void> {
  try {
    const activeAdmins = await prisma.adminUser.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (!activeAdmins.length) return;

    await prisma.adminNotification.createMany({
      data: activeAdmins.map((admin) => ({
        adminId: admin.id,
        type: ADMIN_ALERT_NOTIFICATION_TYPE,
        title: 'Admin alert',
        body: text,
        data: { source: 'alertAdmins' },
      })),
    });
  } catch (err) {
    logger.error({ err }, 'failed to persist admin alert notifications');
  }
}

/**
 * Page the admin team over Telegram. Used for deposits/withdrawals awaiting
 * review, repeated delivery failures and fraud alerts.
 *
 * Also persists a DB row per active admin BEFORE the Telegram path, so the
 * alert survives being read in chat even when Telegram is unconfigured. That
 * persistence is best-effort and never affects the Telegram behaviour below.
 */
export async function alertAdmins(text: string): Promise<void> {
  await persistAdminAlert(text);

  const adminIds = env.TELEGRAM_ADMIN_IDS;
  if (!adminIds.length) {
    // No recipients configured is a DROPPED alert, not a no-op: without this
    // signal a deployment with an unset TELEGRAM_ADMIN_IDS silently reported
    // nothing while duplicate charges, blocked deposits and fraud went unseen.
    logger.error({ scope: 'alertAdmins' }, 'TELEGRAM_ADMIN_IDS is empty — admin alert was not delivered');
    return;
  }

  const telegramIds = adminIds
    .map((id) => {
      try {
        return BigInt(id);
      } catch {
        return null;
      }
    })
    .filter((v): v is bigint => v !== null);

  if (!telegramIds.length) {
    logger.error({ adminIds }, 'alertAdmins: no valid Telegram admin ids — admin alert was not delivered');
    return;
  }

  const admins = await prisma.user.findMany({
    where: { telegramId: { in: telegramIds } },
    select: { telegramId: true },
  });

  if (!admins.length) {
    logger.error(
      { configuredCount: adminIds.length },
      'alertAdmins: no admin accounts matched the configured ids — alert was not delivered',
    );
    return;
  }

  const message = `🚨 <b>Admin Alert</b>\n\n${escapeHtml(text)}`;

  // Retry each admin's push with backoff, and never let a failure resolve as
  // success. sendUserMessage reports a failure either by returning false or by
  // throwing; both are treated as retryable so a Telegram flood-wait cannot
  // silently swallow a money-critical page.
  const results = await Promise.all(
    admins.map(async (a) => {
      try {
        await withRetry(
          async () => {
            const sent = await sendUserMessage(a.telegramId, message);
            if (!sent) throw new Error('sendUserMessage returned false');
            return true;
          },
          { attempts: 3, baseDelayMs: 200, maxDelayMs: 1_500 },
        );
        return true;
      } catch (err) {
        logger.error(
          { err, telegramId: a.telegramId.toString() },
          'admin alert delivery failed after retries',
        );
        return false;
      }
    }),
  );

  if (!results.some(Boolean)) {
    logger.error(
      { adminCount: admins.length },
      'ADMIN ALERT NOT DELIVERED — every admin push failed',
    );
  }
}
