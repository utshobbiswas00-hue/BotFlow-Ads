import { Router } from 'express';
import { DepositStatus, TransactionType, WithdrawalStatus } from '@prisma/client';
import type { Deposit, Prisma, Withdrawal } from '@prisma/client';
import { adminWithdrawalActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { prisma } from '../../db/prisma';
import { DEPOSIT_SORT_KEYS, listDepositsAdmin, rejectDeposit, verifyDeposit } from '../../services/deposit.service';
import { issueAdminRefund } from '../../services/admin.service';
import {
  WITHDRAWAL_SORT_KEYS,
  approveWithdrawal,
  listWithdrawalsAdmin,
  markWithdrawalPaid,
  rejectWithdrawal,
} from '../../services/withdrawal.service';
import { AppError, ValidationError } from '../../utils/errors';
import { displayName } from '../../utils/format';
import { buildPaginated, getPagination } from '../../utils/pagination';
import { requirePermission } from '../../middleware/adminAuth';
import { adminUserId, respondOk } from './common';

export const financeRouter = Router();

/**
 * Whitelisted sort keys for the admin transactions list (§79). Kept as a const
 * so the route validates with `z.enum` and `transactionOrderBy` maps each key to
 * an explicit Prisma `orderBy` — a client string never reaches the query builder.
 */
export const TRANSACTION_SORT_KEYS = ['created_at', 'created_at_desc', 'amount', 'amount_desc'] as const;

export type TransactionSortKey = (typeof TRANSACTION_SORT_KEYS)[number];

/**
 * Map a validated sort key to an explicit Prisma `orderBy`. Exhaustive over the
 * union, so an unlisted value is a compile-time error rather than an injection.
 */
export function transactionOrderBy(sort: TransactionSortKey): Prisma.TransactionOrderByWithRelationInput {
  switch (sort) {
    case 'created_at':
      return { createdAt: 'asc' };
    case 'created_at_desc':
      return { createdAt: 'desc' };
    case 'amount':
      return { amountCents: 'asc' };
    case 'amount_desc':
      return { amountCents: 'desc' };
  }
}

/**
 * Optional date window shared by the finance lists (§79). `z.coerce.date()`
 * matches the audit-log query in settings.routes.ts.
 */
const dateRangeQuery = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/**
 * A backwards window (`from > to`) is a client mistake, so it returns the 400
 * the spec calls for (a malformed date string is still handled by zod → 422).
 */
function assertDateRange(q: { from?: Date; to?: Date }): void {
  if (q.from && q.to && q.from > q.to) {
    throw new AppError('`from` must be earlier than or equal to `to`', 400);
  }
}

const depositsQuery = paginationSchema.extend({
  status: z.nativeEnum(DepositStatus).optional(),
  ...dateRangeQuery,
  sort: z.enum(DEPOSIT_SORT_KEYS).optional(),
});

const withdrawalsQuery = paginationSchema.extend({
  status: z.nativeEnum(WithdrawalStatus).optional(),
  ...dateRangeQuery,
  sort: z.enum(WITHDRAWAL_SORT_KEYS).optional(),
});

const transactionsQuery = paginationSchema.extend({
  type: z.nativeEnum(TransactionType).optional(),
  userId: z.string().min(1).optional(),
  ...dateRangeQuery,
  sort: z.enum(TRANSACTION_SORT_KEYS).optional(),
});

const depositActionSchema = z.object({
  depositId: z.string().min(1),
  action: z.enum(['VERIFY', 'REJECT']),
  note: z.string().max(500).optional().nullable(),
});

/**
 * Admin-initiated refund (§38). The amount is a positive whole number of cents
 * and the reason is mandatory and substantive — an unexplained credit is
 * indistinguishable from a mistake when the ledger is reviewed later.
 */
const refundSchema = z.object({
  campaignId: z.string().min(1),
  amountCents: z
    .number()
    .int()
    .positive({ message: 'amountCents must be a positive whole number of cents' }),
  reason: z
    .string()
    .trim()
    .min(10, 'A refund reason of at least 10 characters is required')
    .max(500, 'The refund reason must be at most 500 characters'),
});

type RefundBody = z.infer<typeof refundSchema>;

/**
 * All deposits, newest first by default, optionally filtered by status and a
 * `from`/`to` window on `createdAt` (§79). `sort` reorders within the whitelist.
 */
financeRouter.get('/deposits', requirePermission('deposits.view'), validate({ query: depositsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof depositsQuery>;
    assertDateRange(query);
    const data = await listDepositsAdmin(
      { status: query.status, from: query.from, to: query.to, sort: query.sort },
      getPagination(query),
    );
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * VERIFY credits the wallet through the ledger (idempotent); REJECT marks
 * the PENDING deposit as rejected. A note is mandatory to reject.
 */
financeRouter.post('/deposits/action', requirePermission('deposits.manage'), validate({ body: depositActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof depositActionSchema>;
    const actor = adminUserId(req);
    let data: Deposit;
    switch (body.action) {
      case 'VERIFY': {
        data = await verifyDeposit(actor, body.depositId, body.note ?? undefined);
        break;
      }
      case 'REJECT': {
        const note = body.note?.trim();
        if (!note) throw new ValidationError('A note is required to reject a deposit');
        data = await rejectDeposit(actor, body.depositId, note);
        break;
      }
    }
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * All withdrawals, newest first by default, optionally filtered by status and a
 * `from`/`to` window on `createdAt` (§79). `sort` reorders within the whitelist.
 */
financeRouter.get('/withdrawals', requirePermission('withdrawals.view'), validate({ query: withdrawalsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof withdrawalsQuery>;
    assertDateRange(query);
    const data = await listWithdrawalsAdmin(
      { status: query.status, from: query.from, to: query.to, sort: query.sort },
      getPagination(query),
    );
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * APPROVE marks a PENDING withdrawal for payout; REJECT refunds the full
 * amount through the ledger (a reason note is required); MARK_PAID records
 * the external transfer (txRef required).
 */
financeRouter.post('/withdrawals/action', requirePermission('withdrawals.manage'), validate({ body: adminWithdrawalActionSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof adminWithdrawalActionSchema>;
    const actor = adminUserId(req);
    let data: Withdrawal;
    switch (body.action) {
      case 'APPROVE': {
        data = await approveWithdrawal(actor, body.withdrawalId, body.note ?? undefined);
        break;
      }
      case 'REJECT': {
        const reason = body.note?.trim();
        if (!reason) throw new ValidationError('A note is required to reject a withdrawal');
        data = await rejectWithdrawal(actor, body.withdrawalId, reason);
        break;
      }
      case 'MARK_PAID': {
        const txRef = body.txRef?.trim();
        if (!txRef) throw new ValidationError('txRef is required to mark a withdrawal as paid');
        data = await markWithdrawalPaid(actor, body.withdrawalId, txRef);
        break;
      }
    }
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * Ledger rows across ALL users, newest first by default, with the owning user's
 * name. Supports `type` and `userId` filters plus a `from`/`to` window on
 * `createdAt` and a whitelisted `sort` (§79).
 */
financeRouter.get('/transactions', requirePermission('deposits.view'), validate({ query: transactionsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof transactionsQuery>;
    assertDateRange(query);
    const p = getPagination(query);

    const where: Prisma.TransactionWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      // Date filter maps to Transaction.createdAt — the ledger's own timestamp
      // and the column this list orders by. NOTE: the schema only indexes
      // [userId, createdAt] and [type], so an admin-wide (no user) range scan
      // wants @@index([createdAt]) to stay fast; the amount sort has no index.
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        // Default preserved: newest ledger rows first when no `sort` is given.
        orderBy: query.sort ? transactionOrderBy(query.sort) : { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        select: {
          id: true,
          userId: true,
          type: true,
          status: true,
          amountCents: true,
          currency: true,
          balanceAfter: true,
          reference: true,
          referenceType: true,
          description: true,
          createdAt: true,
          user: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    const items = rows.map(({ user, ...tx }) => ({ ...tx, userName: displayName(user) }));
    respondOk(res, buildPaginated(items, total, p));
  } catch (err) {
    next(err);
  }
});

/**
 * Issue an admin refund against a campaign (§38). Credits the campaign's
 * advertiser through the ledger (a REFUND row, per-campaign reference) and
 * records the reason in the audit log. Gated on `deposits.manage` — this is
 * money IN to the advertiser, the same permission that moves deposits.
 */
financeRouter.post(
  '/refunds',
  requirePermission('deposits.manage'),
  validate({ body: refundSchema }),
  async (req, res, next) => {
    try {
      const body = req.body as RefundBody;
      const data = await issueAdminRefund(adminUserId(req), body);
      respondOk(res, data);
    } catch (err) {
      next(err);
    }
  },
);
