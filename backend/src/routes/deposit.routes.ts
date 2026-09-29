import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { createDepositSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { limiters } from '../middleware/rateLimit';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { createDeposit, listDeposits } from '../services/deposit.service';
import { listDepositNetworks } from '../services/cryptoAddress.service';
import { createStarsDeposit, sendStarsInvoice } from '../services/stars.service';

/**
 * Deposit (money IN) routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export const depositRouter = Router();

/** POST /api/deposits — declare a deposit for admin verification. */
depositRouter.post(
  '/deposits',
  limiters.deposit,
  validate({ body: createDepositSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      res.json({ ok: true, data: await createDeposit(user.id, req.body) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/deposits/crypto-networks — the networks the depositor may actually
 * use, each with the address to pay.
 *
 * Only networks an operator has configured and left active are returned. A
 * network with no address is deliberately ABSENT rather than present with an
 * empty string: an advertiser shown a blank address may still try to send to
 * it, and a transfer to the wrong chain cannot be recovered.
 *
 * Declared before `/deposits/:id`-style routes would be, so the literal path
 * can never be shadowed by a parameter.
 */
depositRouter.get('/deposits/crypto-networks', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await listDepositNetworks() });
  } catch (err) {
    next(err);
  }
});

const starsDepositBody = z.object({
  stars: z.number().int().min(3078).max(1_000_000),
});

/**
 * POST /api/deposits/stars — open a Telegram Stars invoice.
 *
 * Creates the PENDING deposit (which freezes the rate the advertiser is about to
 * be shown) and then sends the XTR invoice. The quote is returned so the Mini
 * App can state the exact credit BEFORE payment: at 48%, the gap between the
 * Stars sent and the credit added is the most surprising thing on this rail.
 */
depositRouter.post(
  '/deposits/stars',
  limiters.deposit,
  validate({ body: starsDepositBody }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { stars } = req.body as z.infer<typeof starsDepositBody>;

      const { deposit, quote } = await createStarsDeposit(user.id, stars);
      await sendStarsInvoice(deposit.id);

      res.json({ ok: true, data: { depositId: deposit.id, ...quote } });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/deposits — the user's deposit history. */
depositRouter.get('/deposits', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listDeposits(user.id, getPagination(req.query)) });
  } catch (err) {
    next(err);
  }
});
