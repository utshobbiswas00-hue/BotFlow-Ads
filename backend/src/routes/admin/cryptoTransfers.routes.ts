import { Router } from 'express';
import { z } from 'zod';
import { CRYPTO_NETWORKS } from '@botflow/shared';
import { validate } from '../../middleware/validate';
import {
  creditTransferTo,
  ignoreTransfer,
  listPendingTransfers,
  recordObservedTransfer,
  runCryptoScan,
  scannableNetworks,
} from '../../services/cryptoDeposit.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminUserId, respondOk } from './common';

/**
 * The crypto deposit queue.
 *
 * A chain cannot tell us WHO a transfer belongs to, so detection and crediting
 * are separate steps and a human stands between them. That is not a limitation
 * to be engineered away later — it is the control that stops an incoming
 * transfer being credited into a guessed wallet.
 *
 * `POST /crypto-transfers` is also the manual door: an operator who can see a
 * transfer on a block explorer but whose chain is not scanned yet can record it
 * by hand and credit it, with the same conversion and the same idempotency as
 * anything the scanner would have found.
 */
export const cryptoTransfersRouter = Router();

// Recording and crediting on-chain transfers moves money — deposits.manage.
cryptoTransfersRouter.use(requirePermission('deposits.manage'));

const recordBody = z.object({
  network: z.enum(CRYPTO_NETWORKS),
  txHash: z.string().trim().min(1).max(128),
  /** Token contract address, or the native symbol where there is none. */
  asset: z.string().trim().min(1).max(128),
  fromAddress: z.string().trim().min(1).max(128),
  toAddress: z.string().trim().min(1).max(128),
  /** Integer amount in the asset's smallest unit. A string, never a float. */
  amountRaw: z.string().trim().regex(/^\d+$/, 'amountRaw must be a plain integer string'),
  /** Read from the chain when the operator has it; the pinned value otherwise. */
  decimals: z.number().int().min(0).max(36).nullable().optional(),
  symbol: z.string().trim().max(16).nullable().optional(),
  blockNumber: z.number().int().nonnegative().nullable().optional(),
});

/** The queue: everything seen and not yet dealt with. */
cryptoTransfersRouter.get('/', async (_req, res, next) => {
  try {
    respondOk(res, await listPendingTransfers());
  } catch (err) {
    next(err);
  }
});

/** Which chains this deployment can actually see, so the gap is visible. */
cryptoTransfersRouter.get('/scannable', async (_req, res, next) => {
  try {
    respondOk(res, { networks: scannableNetworks() });
  } catch (err) {
    next(err);
  }
});

/** Record a transfer seen elsewhere (block explorer, support ticket). */
cryptoTransfersRouter.post(
  '/',
  validate({ body: recordBody }),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof recordBody>;
      const result = await recordObservedTransfer({
        ...body,
        decimals: body.decimals ?? null,
        symbol: body.symbol ?? null,
        blockNumber: body.blockNumber === null || body.blockNumber === undefined ? null : BigInt(body.blockNumber),
      });
      respondOk(res, result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Credit a recorded transfer to an account.
 *
 * The user is named explicitly because nothing on the chain says who owns the
 * transfer. Idempotent: crediting the same transfer twice returns the original
 * deposit rather than opening a second one.
 */
cryptoTransfersRouter.post(
  '/:id/credit',
  validate({ params: z.object({ id: z.string().min(1) }), body: z.object({ userId: z.string().min(1) }) }),
  async (req, res, next) => {
    try {
      const { id } = req.params as unknown as { id: string };
      const { userId } = req.body as { userId: string };
      respondOk(res, await creditTransferTo(userId, id));
    } catch (err) {
      next(err);
    }
  },
);

/** Not a deposit: dust, a test send, a mistake. Reason required. */
cryptoTransfersRouter.post(
  '/:id/ignore',
  validate({ params: z.object({ id: z.string().min(1) }), body: z.object({ reason: z.string().trim().min(1).max(255) }) }),
  async (req, res, next) => {
    try {
      const { id } = req.params as unknown as { id: string };
      const { reason } = req.body as { reason: string };
      respondOk(res, await ignoreTransfer(adminUserId(req), id, reason));
    } catch (err) {
      next(err);
    }
  },
);

/** Run a pass now instead of waiting for the schedule. */
cryptoTransfersRouter.post('/scan', async (_req, res, next) => {
  try {
    respondOk(res, await runCryptoScan());
  } catch (err) {
    next(err);
  }
});
