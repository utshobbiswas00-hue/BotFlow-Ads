import { Router } from 'express';
import { DepositStatus, TransactionType, WithdrawalStatus } from '@prisma/client';
import type { Deposit, Prisma, Withdrawal } from '@prisma/client';
import { adminWithdrawalActionSchema, paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { prisma } from '../../db/prisma';
import { listDepositsAdmin, rejectDeposit, verifyDeposit } from '../../services/deposit.service';
import {
  approveWithdrawal,
  listWithdrawalsAdmin,
  markWithdrawalPaid,
  rejectWithdrawal,
} from '../../services/withdrawal.service';
import { ValidationError } from '../../utils/errors';
import { displayName } from '../../utils/format';
import { buildPaginated, getPagination } from '../../utils/pagination';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, respondOk } from './common';

export const financeRouter = Router();

const depositsQuery = paginationSchema.extend({
  status: z.nativeEnum(DepositStatus).optional(),
});

const withdrawalsQuery = paginationSchema.extend({
  status: z.nativeEnum(WithdrawalStatus).optional(),
});

const transactionsQuery = paginationSchema.extend({
  type: z.nativeEnum(TransactionType).optional(),
  userId: z.string().min(1).optional(),
});

const depositActionSchema = z.object({
  depositId: z.string().min(1),
  action: z.enum(['VERIFY', 'REJECT']),
  note: z.string().max(500).optional().nullable(),
});

/** All deposits, newest first, optionally filtered by status. */
financeRouter.get('/deposits', requirePermission('deposits.view'), validate({ query: depositsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof depositsQuery>;
    const data = await listDepositsAdmin({ status: query.status }, getPagination(query));
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
    const actor = adminId(req);
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

/** All withdrawals, newest first, optionally filtered by status. */
financeRouter.get('/withdrawals', requirePermission('withdrawals.view'), validate({ query: withdrawalsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof withdrawalsQuery>;
    const data = await listWithdrawalsAdmin({ status: query.status }, getPagination(query));
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
    const actor = adminId(req);
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
 * Ledger rows across ALL users, newest first, with the owning user's name.
 * Supports `type` and `userId` query filters.
 */
financeRouter.get('/transactions', requirePermission('deposits.view'), validate({ query: transactionsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof transactionsQuery>;
    const p = getPagination(query);

    const where: Prisma.TransactionWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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
