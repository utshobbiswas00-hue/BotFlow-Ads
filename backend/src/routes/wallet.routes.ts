import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { validate } from '../middleware/validate';
import { buildPaginated, getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { getWallet, withdrawableCents, netWorthCents } from '../services/wallet.service';
import { listEarnings } from '../services/earnings.service';

/**
 * Wallet & ledger routes. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 * Money values are integer cents.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const TRANSACTION_TYPES = [
  'DEPOSIT',
  'CAMPAIGN_CHARGE',
  'PUBLISHER_EARNING',
  'WITHDRAWAL',
  'REFUND',
  'PLATFORM_FEE',
  'REFERRAL_REWARD',
  'MANUAL_ADJUSTMENT',
  'ESCROW_HOLD',
  'ESCROW_RELEASE',
] as const;

const transactionsQuery = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const walletRouter = Router();

/** GET /api/wallet — balances plus derived withdrawable / net worth / pending. */
walletRouter.get('/wallet', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [wallet, pending] = await Promise.all([
      getWallet(user.id),
      prisma.publisherEarning.aggregate({
        where: { publisherId: user.id, status: 'PENDING' },
        _sum: { netCents: true },
      }),
    ]);
    res.json({
      ok: true,
      data: {
        wallet,
        withdrawableCents: withdrawableCents(wallet),
        netWorthCents: netWorthCents(wallet),
        pendingEarningsCents: pending._sum.netCents ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/transactions — the user's ledger, newest first, optional type filter. */
walletRouter.get('/transactions', validate({ query: transactionsQuery }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const q = req.validated?.query as z.infer<typeof transactionsQuery>;
    const p = getPagination(q);

    const where: Prisma.TransactionWhereInput = {
      userId: user.id,
      ...(q.type ? { type: q.type } : {}),
    };

    const [total, items] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
        select: {
          id: true,
          type: true,
          status: true,
          amountCents: true,
          currency: true,
          balanceAfter: true,
          reference: true,
          referenceType: true,
          description: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({ ok: true, data: buildPaginated(items, total, p) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/earnings — the publisher's earnings history. */
walletRouter.get('/earnings', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listEarnings(user.id, getPagination(req.query)) });
  } catch (err) {
    next(err);
  }
});
