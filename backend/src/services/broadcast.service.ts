/**
 * Broadcast delivery tracking (spec §52) — persistence and reporting.
 *
 * WHY THIS EXISTS
 * A broadcast used to leave no record of itself: the route enqueued one queue
 * job and the notification worker fanned it out, so there was no way to answer
 * "who did we message, and did it arrive?". `BroadcastJob` is the broadcast and
 * `BroadcastRecipient` is one delivery attempt to one user. This service is the
 * only writer of those two tables.
 *
 * THE IMPORTANT DISTINCTION
 * `Notification.delivered` answers "is it in the user's inbox?" — a recipient
 * clearing their inbox must not erase delivery history. These rows answer "what
 * did the broadcast do?", including Telegram's own message id and error text.
 *
 * COUNTERS ARE RECOMPUTED, NEVER INCREMENTED
 * `BroadcastJob.sentCount` / `failedCount` / `status` are recomputed from a
 * `groupBy` over the recipient rows after every outcome. Retries re-run the same
 * recipient; an incrementing counter would double-count, whereas a recompute is
 * idempotent and self-heals. The denormalised columns stay accurate even if a
 * worker attempt is repeated.
 *
 * TRACKING IS BEST-EFFORT
 * Recording an outcome must never fail the user's notification. Every write
 * here that runs after a send is wrapped so a database hiccup is logged and
 * swallowed — the Telegram message already went out and is more important than
 * the report.
 */
import {
  BroadcastJobStatus,
  BroadcastRecipientStatus,
  type BroadcastAudience,
  type BroadcastJob,
  type Prisma,
} from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { NotFoundError } from '../utils/errors';
import { buildPaginated, type PaginatedResult, type Pagination } from '../utils/pagination';

/** The aggregate the detail endpoint reports, always derived from the rows. */
export interface BroadcastJobCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

/** A recipient row plus the user's DISPLAY NAME — never a Telegram id or email. */
export interface BroadcastRecipientView {
  id: string;
  userId: string;
  status: string;
  telegramMessageId: bigint | null;
  error: string | null;
  sentAt: Date | null;
  createdAt: Date;
  userName: string;
}

/** The job fields the history list and detail view expose. */
const BROADCAST_JOB_LIST_SELECT = {
  id: true,
  status: true,
  audience: true,
  title: true,
  totalRecipients: true,
  sentCount: true,
  failedCount: true,
  createdById: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.BroadcastJobSelect;

function recipientName(u: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}): string {
  const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim();
  if (name) return name;
  if (u.username) return `@${u.username.replace(/^@/, '')}`;
  return 'User';
}

/**
 * Fold a `groupBy(status)` result into one counts object.
 *
 * Exported and pure so the per-status aggregation is testable without a
 * database, and so the endpoint's counts and the job's own recompute use the
 * exact same arithmetic.
 */
export function countsFromGroupBy(
  rows: { status: string; _count: { _all: number } }[],
): BroadcastJobCounts {
  const counts: BroadcastJobCounts = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const n = row._count._all;
    counts.total += n;
    switch (row.status) {
      case 'PENDING':
        counts.pending += n;
        break;
      case 'SENT':
        counts.sent += n;
        break;
      case 'FAILED':
        counts.failed += n;
        break;
      case 'SKIPPED':
        counts.skipped += n;
        break;
      default:
        break;
    }
  }
  return counts;
}

export interface CreatedBroadcastJob {
  jobId: string;
  recipients: { userId: string; recipientId: string }[];
}

/**
 * Create the `BroadcastJob` and one PENDING `BroadcastRecipient` row per user,
 * atomically. The recipient ids are returned so the queue job can attribute
 * each later send back to its row.
 *
 * The whole thing is one transaction: a job with no recipient rows (or rows
 * with no job) would make the report lie about what is in flight.
 */
export async function createBroadcastJob(input: {
  title: string;
  body: string;
  audience: BroadcastAudience;
  createdById: string | null;
  userIds: string[];
}): Promise<CreatedBroadcastJob> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.broadcastJob.create({
      data: {
        title: input.title,
        body: input.body,
        audience: input.audience,
        createdById: input.createdById,
        totalRecipients: input.userIds.length,
        status: BroadcastJobStatus.QUEUED,
      },
      select: { id: true },
    });

    const recipients: { userId: string; recipientId: string }[] = [];
    for (const userId of input.userIds) {
      const row = await tx.broadcastRecipient.create({
        data: { jobId: job.id, userId, status: BroadcastRecipientStatus.PENDING },
        select: { id: true, userId: true },
      });
      recipients.push({ userId: row.userId, recipientId: row.id });
    }

    return { jobId: job.id, recipients };
  });
}

/** QUEUED → RUNNING once the worker picks the fan-out up. Idempotent. */
export async function markBroadcastRunning(jobId: string): Promise<void> {
  await prisma.broadcastJob.updateMany({
    where: { id: jobId, status: BroadcastJobStatus.QUEUED },
    data: { status: BroadcastJobStatus.RUNNING },
  });
}

/** The queue rejected the fan-out — the job can never run, so fail it loudly. */
export async function markBroadcastEnqueueFailed(jobId: string): Promise<void> {
  await prisma.broadcastJob.updateMany({
    where: { id: jobId },
    data: { status: BroadcastJobStatus.FAILED, completedAt: new Date() },
  });
}

/**
 * Recompute the job's counters and status from its recipient rows.
 *
 * Status is RUNNING while any recipient is still PENDING, then COMPLETED when
 * none failed, or FAILED when at least one did. Returns the counts it wrote so
 * callers (and tests) see what was recorded.
 */
export async function recomputeBroadcastJob(jobId: string): Promise<BroadcastJobCounts> {
  const grouped = await prisma.broadcastRecipient.groupBy({
    by: ['status'],
    where: { jobId },
    _count: { _all: true },
  });
  const counts = countsFromGroupBy(grouped);

  const data: Prisma.BroadcastJobUpdateInput = {
    sentCount: counts.sent,
    failedCount: counts.failed,
  };

  if (counts.pending === 0) {
    data.status = counts.failed > 0 ? BroadcastJobStatus.FAILED : BroadcastJobStatus.COMPLETED;
    data.completedAt = new Date();
  } else {
    data.status = BroadcastJobStatus.RUNNING;
    data.completedAt = null;
  }

  await prisma.broadcastJob.update({ where: { id: jobId }, data });
  return counts;
}

/**
 * Record one recipient's outcome and refresh the job's counters.
 *
 * NEVER throws: the user's Telegram message is already sent, and a tracking
 * write must not turn a delivered notification into a failed BullMQ job.
 */
export async function recordBroadcastOutcome(input: {
  jobId: string;
  recipientId: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  telegramMessageId?: bigint | null;
  error?: string | null;
}): Promise<void> {
  try {
    await prisma.broadcastRecipient.update({
      where: { id: input.recipientId },
      data: {
        status: input.status as BroadcastRecipientStatus,
        telegramMessageId: input.status === 'SENT' ? (input.telegramMessageId ?? null) : null,
        error:
          input.status === 'SENT' ? null : (input.error ?? null),
        sentAt: input.status === 'SENT' ? new Date() : null,
      },
    });
    await recomputeBroadcastJob(input.jobId);
  } catch (err) {
    logger.warn(
      { err, jobId: input.jobId, recipientId: input.recipientId, status: input.status },
      'broadcast delivery tracking write failed',
    );
  }
}

/** Paginated broadcast history, newest first. */
export async function listBroadcastHistory(
  p: Pagination,
): Promise<PaginatedResult<Prisma.BroadcastJobGetPayload<{ select: typeof BROADCAST_JOB_LIST_SELECT }>>> {
  const [total, items] = await Promise.all([
    prisma.broadcastJob.count(),
    prisma.broadcastJob.findMany({
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: BROADCAST_JOB_LIST_SELECT,
    }),
  ]);

  return buildPaginated(items, total, p);
}

/**
 * One job with BOTH the denormalised counters on the row AND a live `groupBy`
 * count. They are returned side by side on purpose: if the two ever disagree, an
 * operator (and a test) can see the drift instead of it being hidden.
 */
export async function getBroadcastJob(id: string): Promise<{
  job: BroadcastJob;
  counts: BroadcastJobCounts;
}> {
  const job = await prisma.broadcastJob.findUnique({ where: { id } });
  if (!job) throw new NotFoundError('Broadcast');

  const grouped = await prisma.broadcastRecipient.groupBy({
    by: ['status'],
    where: { jobId: id },
    _count: { _all: true },
  });

  return { job, counts: countsFromGroupBy(grouped) };
}

/**
 * Paginated recipient rows for one job, newest-last (creation order), with an
 * optional status filter. Joins `users` for a display name only — Telegram ids
 * and emails are never selected, so they cannot leak into the response.
 */
export async function listBroadcastRecipients(
  id: string,
  p: Pagination,
  status?: BroadcastRecipientStatus,
): Promise<PaginatedResult<BroadcastRecipientView>> {
  const job = await prisma.broadcastJob.findUnique({ where: { id }, select: { id: true } });
  if (!job) throw new NotFoundError('Broadcast');

  const where: Prisma.BroadcastRecipientWhereInput = {
    jobId: id,
    ...(status ? { status } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.broadcastRecipient.count({ where }),
    prisma.broadcastRecipient.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        userId: true,
        status: true,
        telegramMessageId: true,
        error: true,
        sentAt: true,
        createdAt: true,
        user: { select: { firstName: true, lastName: true, username: true } },
      },
    }),
  ]);

  const items: BroadcastRecipientView[] = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    status: r.status,
    telegramMessageId: r.telegramMessageId,
    error: r.error,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    userName: recipientName(r.user),
  }));

  return buildPaginated(items, total, p);
}
