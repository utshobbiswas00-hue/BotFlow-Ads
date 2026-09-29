import { Router } from 'express';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { adjustUserBalance, getUserAdminDetail, listUsersAdmin } from '../../services/admin.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const usersRouter = Router();

const usersQuery = paginationSchema.extend({
  search: z.string().max(100).trim().optional(),
});

type UsersQuery = z.infer<typeof usersQuery>;

const adjustBalanceSchema = z.object({
  userId: z.string().min(1),
  /** Positive credits, negative debits. Integer cents, non-zero. */
  amountCents: z.number().int().refine((v) => v !== 0, { message: 'amountCents must be a non-zero integer' }),
  reason: z
    .string()
    .max(500)
    .trim()
    .refine((v) => v.length > 0, { message: 'A reason is required' }),
});

type AdjustBalanceBody = z.infer<typeof adjustBalanceSchema>;

/** Search users by name / username / telegramId, newest registrations first. */
usersRouter.get('/', requirePermission('users.view'), validate({ query: usersQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as UsersQuery;
    const data = await listUsersAdmin(query.search, getPagination(query));
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Full dossier: profile, channels, campaigns, recent finance, earnings. */
usersRouter.get('/:id', requirePermission('users.view'), validate({ params: idParams }), async (req, res, next) => {
  try {
    const data = await getUserAdminDetail(req.params.id);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/**
 * Manual credit (positive) or debit (negative) of a user's available
 * balance. Runs through the ledger and is audited.
 */
usersRouter.post('/adjust-balance', requirePermission('users.balance.adjust'), validate({ body: adjustBalanceSchema }), async (req, res, next) => {
  try {
    const body = req.body as AdjustBalanceBody;
    const data = await adjustUserBalance(adminId(req), body.userId, body.amountCents, body.reason);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});
