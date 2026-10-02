import { Prisma, type TicketPriority, type TicketStatus } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { entitlementsFor } from './premium.service';
import { ticketNumber } from '../utils/crypto';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { displayName } from '../utils/format';
import { recordAudit } from './audit.service';
import { logger } from '../config/logger';

/**
 * In-app support tickets between users and the admin team.
 * A ticket is an ordered thread of TicketMessage rows; the ticket's
 * `lastMessageAt` drives the inbox ordering.
 */

export const TICKET_SELECT = {
  id: true,
  ticketNo: true,
  subject: true,
  category: true,
  status: true,
  priority: true,
  assignedToId: true,
  lastMessageAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupportTicketSelect;

type TicketPayload = Prisma.SupportTicketGetPayload<{ select: typeof TICKET_SELECT }>;

const MESSAGE_SELECT = {
  id: true,
  body: true,
  senderType: true,
  createdAt: true,
} satisfies Prisma.TicketMessageSelect;

/**
 * The admin thread selects the same message fields as `MESSAGE_SELECT` plus the
 * two the admin contract declares (`senderId`, `attachmentUrl`). The extra fields
 * are additive and only used by the admin read below — `MESSAGE_SELECT` and the
 * owner-facing `getTicket` are untouched.
 */
const ADMIN_MESSAGE_SELECT = {
  ...MESSAGE_SELECT,
  senderId: true,
  attachmentUrl: true,
} satisfies Prisma.TicketMessageSelect;

const CLOSED_LIKE: TicketStatus[] = ['CLOSED', 'RESOLVED'];

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Load a ticket and assert `userId` owns it. */
async function assertTicketOwner(ticketId: string, userId: string): Promise<{ id: string; userId: string; status: TicketStatus }> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, userId: true, status: true },
  });
  if (!ticket) throw new NotFoundError('Ticket');
  if (ticket.userId !== userId) throw new ForbiddenError('This ticket belongs to another account');
  return ticket;
}

/* ------------------------------------------------------------------
 *  User side
 * ------------------------------------------------------------------ */

export interface CreateTicketInput {
  subject: string;
  category: string;
  message: string;
}

/**
 * Open a support ticket: creates the SupportTicket row and its first
 * TicketMessage (senderType USER) atomically, stamping lastMessageAt.
 */
export async function createTicket(userId: string, input: CreateTicketInput): Promise<TicketPayload> {
  const subject = input.subject?.trim();
  const message = input.message?.trim();
  if (!subject) throw new ValidationError('A subject is required');
  if (!message) throw new ValidationError('A message is required');
  const category = input.category?.trim() || 'general';

  // PREMIUM priority support: a subscriber's ticket opens at HIGH so the admin
  // queue triages it ahead of the free queue. A user with no active subscription
  // gets the schema default (NORMAL) — the row is inserted exactly as before.
  const { prioritySupport } = await entitlementsFor(userId);

  // ticketNo is date + 5 random digits, so collisions are rare but possible.
  // Retry a couple of times on a P2002 unique violation.
  let ticket: TicketPayload | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      ticket = await transaction((tx) =>
        tx.supportTicket.create({
          data: {
            userId,
            ticketNo: ticketNumber(),
            subject,
            category,
            status: 'OPEN',
            ...(prioritySupport ? { priority: 'HIGH' as TicketPriority } : {}),
            lastMessageAt: new Date(),
            messages: {
              create: {
                senderId: userId,
                senderType: 'USER',
                body: message,
              },
            },
          },
          select: TICKET_SELECT,
        }),
      );
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (!isUniqueViolation(err)) throw err;
      logger.warn({ attempt: attempt + 1 }, 'createTicket: ticketNo collision — retrying with a new number');
    }
  }

  if (!ticket) {
    throw lastError instanceof Error ? lastError : new Error('Failed to create support ticket');
  }

  logger.info({ ticketId: ticket.id, ticketNo: ticket.ticketNo, userId }, 'support ticket created');
  return ticket;
}

export interface UserTicketRow {
  id: string;
  ticketNo: string;
  subject: string;
  status: TicketStatus;
  lastMessageAt: Date;
}

/** The user's own tickets, most recently active first. */
export async function listTickets(userId: string, p: Pagination) {
  const where: Prisma.SupportTicketWhereInput = { userId };

  const [total, items] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        ticketNo: true,
        subject: true,
        status: true,
        lastMessageAt: true,
      },
    }),
  ]);

  const rows: UserTicketRow[] = items;
  return buildPaginated(rows, total, p);
}

/**
 * Fetch a single ticket with its full message thread.
 * Throws ForbiddenError when the ticket belongs to another user.
 */
export async function getTicket(userId: string, ticketId: string) {
  await assertTicketOwner(ticketId, userId);

  const [ticket, messages] = await Promise.all([
    prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: TICKET_SELECT,
    }),
    prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      select: MESSAGE_SELECT,
    }),
  ]);

  // Re-fetched after the ownership check; the check already guaranteed existence.
  if (!ticket) throw new NotFoundError('Ticket');

  return { ticket, messages };
}

/**
 * Append the user's message to the thread, bump lastMessageAt, and reopen a
 * CLOSED/RESOLVED ticket so it comes back to the top of the admin queue.
 */
export async function addMessage(userId: string, ticketId: string, body: string) {
  const text = body?.trim();
  if (!text) throw new ValidationError('Message cannot be empty');

  const ticket = await assertTicketOwner(ticketId, userId);
  const reopened = CLOSED_LIKE.includes(ticket.status);

  // Message insert and the lastMessageAt bump must commit together: a thread
  // ordered by lastMessageAt must never contain a message that did not move it.
  const [message, updated] = await transaction(async (tx) => {
    const createdMessage = await tx.ticketMessage.create({
      data: { ticketId, senderId: userId, senderType: 'USER', body: text },
    });
    const updatedTicket = await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessageAt: new Date(),
        ...(reopened ? { status: 'OPEN' as TicketStatus, closedAt: null } : {}),
      },
      select: TICKET_SELECT,
    });
    return [createdMessage, updatedTicket] as const;
  });

  if (reopened) {
    logger.info({ ticketId, userId }, 'ticket reopened by user reply');
  }

  return { message, ticket: updated };
}

/* ------------------------------------------------------------------
 *  Admin side
 * ------------------------------------------------------------------ */

export interface ListTicketsAdminFilter {
  status?: TicketStatus;
}

/**
 * All tickets (any user). Higher-priority tickets (a premium user's, opened at
 * HIGH) surface first, then most recently active. For an all-free inbox every
 * ticket is NORMAL, so this is identical to the old `lastMessageAt desc` order.
 */
export async function listTicketsAdmin(filter: ListTicketsAdminFilter, p: Pagination) {
  const where: Prisma.SupportTicketWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { lastMessageAt: 'desc' }],
      skip: p.skip,
      take: p.take,
      select: {
        ...TICKET_SELECT,
        user: { select: { id: true, firstName: true, lastName: true, username: true, telegramId: true } },
      },
    }),
  ]);

  const rows = items.map((t) => ({ ...t, userName: displayName(t.user) }));
  return buildPaginated(rows, total, p);
}

/**
 * Admin-scoped thread read: the same query as `getTicket`, minus the ownership
 * assertion. `getTicket` calls `assertTicketOwner`, so an admin reading another
 * user's ticket would get a 404; here the authorisation is the route's
 * `tickets.view` permission instead of ownership. Messages are returned oldest
 * first, exactly as `getTicket` orders them.
 *
 * `getTicket`, `assertTicketOwner` and the owner path are untouched.
 */
export async function getTicketAdmin(ticketId: string) {
  const [ticket, messages] = await Promise.all([
    prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: TICKET_SELECT,
    }),
    prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
      select: ADMIN_MESSAGE_SELECT,
    }),
  ]);

  if (!ticket) throw new NotFoundError('Ticket');

  return { ticket, messages };
}

/**
 * Admin reply: appends a TicketMessage (senderType ADMIN), bumps
 * lastMessageAt, and reopens the ticket if it was CLOSED/RESOLVED.
 */
export async function adminReplyTicket(adminId: string, ticketId: string, body: string) {
  const text = body?.trim();
  if (!text) throw new ValidationError('Reply cannot be empty');

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, status: true },
  });
  if (!ticket) throw new NotFoundError('Ticket');

  const reopened = CLOSED_LIKE.includes(ticket.status);

  // Same atomicity requirement as the user-side reply.
  const [message, updated] = await transaction(async (tx) => {
    const createdMessage = await tx.ticketMessage.create({
      data: { ticketId, senderId: adminId, senderType: 'ADMIN', body: text },
    });
    const updatedTicket = await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessageAt: new Date(),
        ...(reopened ? { status: 'OPEN' as TicketStatus, closedAt: null } : {}),
      },
      select: TICKET_SELECT,
    });
    return [createdMessage, updatedTicket] as const;
  });

  logger.info({ ticketId, adminId, reopened }, 'admin replied to ticket');

  return { message, ticket: updated };
}

/**
 * Move a ticket between statuses. Closing/resolving stamps closedAt;
 * anything else clears it.
 */
export async function setTicketStatus(adminId: string, ticketId: string, status: TicketStatus): Promise<TicketPayload> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, status: true },
  });
  if (!ticket) throw new NotFoundError('Ticket');

  // No-op status change: return the full row without re-stamping closedAt.
  if (ticket.status === status) {
    const full = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: TICKET_SELECT,
    });
    if (!full) throw new NotFoundError('Ticket');
    return full;
  }

  const updated = await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      status,
      closedAt: CLOSED_LIKE.includes(status) ? new Date() : null,
    },
    select: TICKET_SELECT,
  });

  await recordAudit({
    actorId: adminId,
    actorType: 'ADMIN',
    action: 'TICKET_STATUS_CHANGED',
    targetType: 'SUPPORT_TICKET',
    targetId: ticketId,
    oldValue: { status: ticket.status },
    newValue: { status },
  });

  logger.info({ ticketId, adminId, from: ticket.status, to: status }, 'ticket status changed');
  return updated;
}
