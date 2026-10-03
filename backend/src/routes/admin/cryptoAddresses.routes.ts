import { Router } from 'express';
import { z } from 'zod';
import { CRYPTO_NETWORKS } from '@botflow/shared';
import { validate } from '../../middleware/validate';
import {
  deleteCryptoAddress,
  listCryptoAddresses,
  setCryptoAddressActive,
  upsertCryptoAddress,
} from '../../services/cryptoAddress.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminUserId, respondOk } from './common';

/**
 * Crypto deposit addresses — the admin panel's side.
 *
 * The network is a path parameter validated against the closed CRYPTO_NETWORKS
 * list, so an address for a chain we do not support cannot be created by hand.
 * Saving an address is what puts that network on the deposit screen; disabling
 * or deleting it takes the network back off.
 */
export const cryptoAddressesRouter = Router();

// Saving an address redirects where real deposits land — a settings action.
cryptoAddressesRouter.use(requirePermission('settings.manage'));

const networkParams = z.object({ network: z.enum(CRYPTO_NETWORKS) });

const upsertBody = z.object({
  address: z.string().trim().min(1).max(128),
  memo: z.string().trim().max(64).nullable().optional(),
  label: z.string().trim().max(64).nullable().optional(),
  isActive: z.boolean().optional(),
});

type NetworkParams = z.infer<typeof networkParams>;
type UpsertBody = z.infer<typeof upsertBody>;

/** Every known network, including the ones still missing an address. */
cryptoAddressesRouter.get('/', async (_req, res, next) => {
  try {
    respondOk(res, await listCryptoAddresses());
  } catch (err) {
    next(err);
  }
});

/** Create or replace a network's address. Replacing is the normal case. */
cryptoAddressesRouter.put(
  '/:network',
  validate({ params: networkParams, body: upsertBody }),
  async (req, res, next) => {
    try {
      const { network } = req.params as unknown as NetworkParams;
      const body = req.body as UpsertBody;
      const saved = await upsertCryptoAddress(adminUserId(req), { network, ...body });
      respondOk(res, saved);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Turn a network on or off without losing the address.
 *
 * This is the action to reach for when a wallet is compromised: it stops new
 * deposits immediately and leaves the address on file for reconciliation.
 */
cryptoAddressesRouter.patch(
  '/:network/active',
  validate({ params: networkParams, body: z.object({ isActive: z.boolean() }) }),
  async (req, res, next) => {
    try {
      const { network } = req.params as unknown as NetworkParams;
      const { isActive } = req.body as { isActive: boolean };
      respondOk(res, await setCryptoAddressActive(adminUserId(req), network, isActive));
    } catch (err) {
      next(err);
    }
  },
);

/** Remove the address, taking the network off the deposit screen. */
cryptoAddressesRouter.delete(
  '/:network',
  validate({ params: networkParams }),
  async (req, res, next) => {
    try {
      const { network } = req.params as unknown as NetworkParams;
      await deleteCryptoAddress(adminUserId(req), network);
      respondOk(res, { deleted: true, network });
    } catch (err) {
      next(err);
    }
  },
);
