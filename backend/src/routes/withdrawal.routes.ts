import { Router } from 'express';
import type { Request } from 'express';
import { createWithdrawalSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { limiters } from '../middleware/rateLimit';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { createWithdrawal, listWithdrawals } from '../services/withdrawal.service';

/**
 * Withdrawal (money OUT) routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 * The wallet is debited the moment a withdrawal is requested — see the
 * service for the double-spend guarantees.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const withdrawalRouter = Router();

/** POST /api/withdrawals — request a payout (wallet debited immediately). */
withdrawalRouter.post(
  '/withdrawals',
  limiters.withdrawal,
  validate({ body: createWithdrawalSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      res.json({ ok: true, data: await createWithdrawal(user.id, req.body) });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/withdrawals — the user's withdrawal history. */
withdrawalRouter.get('/withdrawals', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listWithdrawals(user.id, getPagination(req.query)) });
  } catch (err) {
    next(err);
  }
});
