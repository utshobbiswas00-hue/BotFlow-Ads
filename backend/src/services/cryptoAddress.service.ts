import {
  CRYPTO_NETWORK_LABELS,
  CRYPTO_NETWORKS,
  isCryptoNetwork,
  type CryptoNetwork,
} from '@botflow/shared';
import type { CryptoDepositAddress } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { recordAudit } from './audit.service';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * The deposit addresses for the crypto rail, kept by an operator.
 *
 * ── WHY THIS IS DATA, NOT CONFIG ───────────────────────────────────────────
 * An address belongs to an (asset, chain) PAIR. USDT on TON and USDT on BEP20
 * are different wallets, and a transfer to the wrong chain is unrecoverable —
 * no support ticket gets it back. The pair is therefore the unit an operator
 * manages, and every row is validated against the closed CRYPTO_NETWORKS list
 * so a typo'd network can never be stored and later served to a depositor.
 *
 * ── THE RULE THAT MATTERS ──────────────────────────────────────────────────
 * `listDepositNetworks` returns ONLY networks that have an active address. A
 * network with no address must be absent from the deposit screen rather than
 * shown with an empty one: an empty address is an invitation to send money
 * nowhere. Adding an address is what puts a network on the screen, and
 * deactivating it takes the network back off — which is also how a compromised
 * wallet gets retired in one action.
 */

/** Rough shape check. Real chain validation belongs to the chain, not to us. */
const MAX_ADDRESS_LENGTH = 128;
const MAX_MEMO_LENGTH = 64;
const MAX_LABEL_LENGTH = 64;

export interface UpsertCryptoAddressInput {
  network: string;
  address: string;
  memo?: string | null;
  label?: string | null;
  isActive?: boolean;
}

/** A configured, currently-offered deposit network. Safe to show a depositor. */
export interface DepositNetworkView {
  network: CryptoNetwork;
  asset: string;
  chain: string;
  address: string;
  memo: string | null;
}

/** An admin-panel row: every known network, whether or not it is configured. */
export interface AdminCryptoAddressView {
  network: string;
  asset: string;
  chain: string;
  configured: boolean;
  address: string | null;
  memo: string | null;
  label: string | null;
  isActive: boolean;
}

function assertNetwork(network: string): asserts network is CryptoNetwork {
  if (!isCryptoNetwork(network)) {
    throw new ValidationError(
      `Unknown crypto network "${network}". Supported: ${CRYPTO_NETWORKS.join(', ')}.`,
    );
  }
}

function cleanAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) throw new ValidationError('A deposit address cannot be empty.');
  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    throw new ValidationError(`A deposit address cannot exceed ${MAX_ADDRESS_LENGTH} characters.`);
  }
  // Whitespace inside an address is always a paste accident, and a depositor
  // copying it would send to a different (or invalid) destination.
  if (/\s/.test(trimmed)) {
    throw new ValidationError('A deposit address cannot contain whitespace.');
  }
  return trimmed;
}

function cleanOptional(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`${field} cannot exceed ${max} characters.`);
  return trimmed;
}

/* ------------------------------------------------------------------
 *  Admin panel
 * ------------------------------------------------------------------ */

/**
 * Every network we know about, joined with its stored row.
 *
 * Returned in the canonical CRYPTO_NETWORKS order with unconfigured networks
 * included, so the admin panel can show what is still MISSING instead of
 * silently having no row to render.
 */
export async function listCryptoAddresses(): Promise<AdminCryptoAddressView[]> {
  const rows = await prisma.cryptoDepositAddress.findMany();
  const byNetwork = new Map(rows.map((r) => [r.network, r]));

  return CRYPTO_NETWORKS.map((network) => {
    const row = byNetwork.get(network);
    const { asset, chain } = CRYPTO_NETWORK_LABELS[network];
    return {
      network,
      asset,
      chain,
      configured: Boolean(row),
      address: row?.address ?? null,
      memo: row?.memo ?? null,
      label: row?.label ?? null,
      isActive: row?.isActive ?? false,
    };
  });
}

/**
 * Create or update the address for a network.
 *
 * Upsert rather than create: an operator replacing a wallet is the common case,
 * and a second row for the same network would make the served address
 * ambiguous — the exact failure this model exists to avoid.
 */
export async function upsertCryptoAddress(
  adminId: string,
  input: UpsertCryptoAddressInput,
): Promise<CryptoDepositAddress> {
  assertNetwork(input.network);

  const data = {
    address: cleanAddress(input.address),
    memo: cleanOptional(input.memo, MAX_MEMO_LENGTH, 'Memo'),
    label: cleanOptional(input.label, MAX_LABEL_LENGTH, 'Label'),
    isActive: input.isActive ?? true,
  };

  const before = await prisma.cryptoDepositAddress.findUnique({ where: { network: input.network } });

  const saved = await prisma.cryptoDepositAddress.upsert({
    where: { network: input.network },
    create: { network: input.network, ...data },
    update: data,
  });

  await recordAudit({
    actorId: adminId,
    action: before ? 'CRYPTO_ADDRESS_UPDATED' : 'CRYPTO_ADDRESS_CREATED',
    targetType: 'CRYPTO_ADDRESS',
    targetId: saved.id,
    oldValue: before
      ? { address: before.address, memo: before.memo, isActive: before.isActive }
      : null,
    newValue: { network: saved.network, address: saved.address, memo: saved.memo, isActive: saved.isActive },
  });

  logger.info(
    { adminId, network: saved.network, isActive: saved.isActive, replaced: Boolean(before) },
    'crypto deposit address saved',
  );

  return saved;
}

/**
 * Take a network off the deposit screen without deleting the address, or put it
 * back. This is the kill-switch for a wallet that is compromised or frozen.
 */
export async function setCryptoAddressActive(
  adminId: string,
  network: string,
  isActive: boolean,
): Promise<CryptoDepositAddress> {
  assertNetwork(network);

  const before = await prisma.cryptoDepositAddress.findUnique({ where: { network } });
  if (!before) {
    throw new NotFoundError(`Crypto deposit address for ${network}`);
  }

  const saved = await prisma.cryptoDepositAddress.update({
    where: { network },
    data: { isActive },
  });

  await recordAudit({
    actorId: adminId,
    action: isActive ? 'CRYPTO_ADDRESS_ENABLED' : 'CRYPTO_ADDRESS_DISABLED',
    targetType: 'CRYPTO_ADDRESS',
    targetId: saved.id,
    oldValue: { isActive: before.isActive },
    newValue: { isActive: saved.isActive },
  });

  logger.warn({ adminId, network, isActive }, 'crypto deposit address availability changed');

  return saved;
}

/**
 * Remove the row entirely.
 *
 * The network disappears from the deposit screen. Deposits already credited
 * against it are untouched — this only stops new money being sent there.
 */
export async function deleteCryptoAddress(adminId: string, network: string): Promise<void> {
  assertNetwork(network);

  const before = await prisma.cryptoDepositAddress.findUnique({ where: { network } });
  if (!before) throw new NotFoundError(`Crypto deposit address for ${network}`);

  await prisma.cryptoDepositAddress.delete({ where: { network } });

  await recordAudit({
    actorId: adminId,
    action: 'CRYPTO_ADDRESS_DELETED',
    targetType: 'CRYPTO_ADDRESS',
    targetId: before.id,
    oldValue: { network: before.network, address: before.address },
    newValue: null,
  });

  logger.warn({ adminId, network }, 'crypto deposit address deleted');
}

/* ------------------------------------------------------------------
 *  Deposit screen
 * ------------------------------------------------------------------ */

/**
 * The networks a depositor may actually use.
 *
 * Only active rows with a non-empty address. Anything else is omitted rather
 * than shown blank — see the note at the top of this file.
 */
export async function listDepositNetworks(): Promise<DepositNetworkView[]> {
  const rows = await prisma.cryptoDepositAddress.findMany({
    where: { isActive: true, address: { not: '' } },
  });
  const byNetwork = new Map(rows.map((r) => [r.network, r]));

  const view: DepositNetworkView[] = [];
  for (const network of CRYPTO_NETWORKS) {
    const row = byNetwork.get(network);
    // A row whose network is no longer in the closed list (an enum value was
    // retired) is skipped rather than served without a label.
    if (!row) continue;
    const { asset, chain } = CRYPTO_NETWORK_LABELS[network];
    view.push({ network, asset, chain, address: row.address, memo: row.memo });
  }
  return view;
}

/**
 * The address to pay for one network.
 *
 * Throws when the network is unknown, unconfigured or disabled — a caller that
 * gets a value back has an address that was being offered at that moment.
 */
export async function addressForNetwork(network: string): Promise<DepositNetworkView> {
  assertNetwork(network);

  const row = await prisma.cryptoDepositAddress.findUnique({ where: { network } });
  if (!row || !row.isActive || !row.address) {
    throw new NotFoundError(`A deposit address for ${network} is not available right now`);
  }

  const { asset, chain } = CRYPTO_NETWORK_LABELS[(network as CryptoNetwork)];
  return { network: network as CryptoNetwork, asset, chain, address: row.address, memo: row.memo };
}
