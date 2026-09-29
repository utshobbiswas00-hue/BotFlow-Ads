import axios from 'axios';
import { CRYPTO_NETWORKS, isCryptoNetwork, type CryptoNetwork } from '@botflow/shared';
import { Prisma, type CryptoChainTransfer } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { SETTING_KEYS } from '../config/constants';
import { getNumberSetting, getStringSetting, setSetting } from './settings.service';
import { addressForNetwork } from './cryptoAddress.service';
import { createDeposit, verifyDeposit } from './deposit.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { isTronScanConfigured, scanTronNetwork } from './chainSources/tron';

const TRON_CURSOR_SETTING_KEY = 'crypto_scan_cursor:USDT_TRC20';

/**
 * Incoming crypto, turned into ad credit.
 *
 * ── WHERE THE MONEY CAN GO WRONG ───────────────────────────────────────────
 * Two things make on-chain crediting dangerous, and both are handled here
 * rather than in the scanner:
 *
 * 1. DECIMALS. A token amount is an integer in the asset's smallest unit. USDT
 *    is 6 decimals on TRON and Ethereum but 18 on BNB Chain. Read one as the
 *    other and a $10 deposit becomes $10,000,000 or $0.00001. So the decimals
 *    are taken FROM THE CHAIN where the chain reports them, and the pinned
 *    values below are only a fallback.
 *
 * 2. DOUBLE CREDITING. A rescan, an overlapping scan window or a reorg all
 *    re-present the same transfer. The unique key (network, txHash) on the row,
 *    the unique `depositId` linking it to what it became, and the ledger's own
 *    unique reference together mean the second sighting is a no-op.
 *
 * ── WHAT IS DELIBERATELY NOT DONE ──────────────────────────────────────────
 * A transfer whose price is unknown is HELD, not credited at a guess. USDT and
 * USDC are pegged, so those need no price feed at all; TON and BTC do, and
 * until one is configured their transfers sit as DETECTED for an operator to
 * settle. Crediting at an invented price is how a system quietly pays out the
 * wrong amount on every deposit.
 */

/** Pinned decimals, used only when the chain does not report them itself. */
const FALLBACK_DECIMALS: Record<CryptoNetwork, number> = {
  USDT_TON: 6,
  TON: 9, // nanotons
  USDT_BEP20: 18, // NOT 6 — BNB Chain's USDT is the classic trap
  USDT_TRC20: 6,
  USDT_ERC20: 6,
  USDC_TON: 6,
  USDC_TRC20: 6,
  USDC_ERC20: 6,
  BTC: 8, // satoshi
};

/** Assets we treat as $1.00 by definition, so no price feed is needed. */
const PEGGED_ASSETS = ['USDT', 'USDC'];

/** The chain's own assets, which need a price before they can be credited. */
const PRICED_ASSETS: Partial<Record<CryptoNetwork, string>> = { TON: 'TON', BTC: 'BTC' };

/** Which token contract to watch for a network that carries a token. */
const TOKEN_CONTRACTS: Partial<Record<CryptoNetwork, string>> = {
  USDT_TRC20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  USDT_ERC20: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  USDC_ERC20: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  // BNB Chain's USDT — the 18-decimal one.
  USDT_BEP20: '0x55d398326f99059fF775485246999027B3197955',
};

/* ------------------------------------------------------------------
 *  Converting a raw amount into money
 * ------------------------------------------------------------------ */

/**
 * The crypto deposit ceiling: a transfer worth $1,000,000 or more is refused.
 *
 * This is a DECIMAL-MISTAKE DETECTOR, not a business limit. Reading an
 * 18-decimal amount as a 6-decimal one multiplies it by 10^12 — $10 becomes
 * $10,000,000,000,000 — which stays comfortably inside a JS integer and would
 * otherwise be credited without complaint. A ceiling far above any real top-up
 * and far below that magnitude turns the whole class of scaling error into a
 * refusal.
 */
const MAX_DEPOSIT_CENTS = 100_000_000;

/**
 * `raw` is an integer in the asset's smallest unit; return USD cents.
 *
 * BigInt throughout, because an 18-decimal amount exceeds the range a float
 * represents exactly and a rounded balance is a wrong balance.
 */
export function rawToCents(raw: string, decimals: number, priceUsdCents: number): number {
  const value = BigInt(raw);
  if (value < 0n) throw new ValidationError('A transfer amount cannot be negative.');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new ValidationError(`Unusable decimals value: ${decimals}`);
  }

  const scale = 10n ** BigInt(decimals);
  // Multiply before dividing so the price is applied to the whole amount rather
  // than to a truncated fraction of it.
  const cents = (value * BigInt(priceUsdCents)) / scale;

  if (cents >= BigInt(MAX_DEPOSIT_CENTS)) {
    throw new ValidationError(
      'That amount is far larger than any real deposit — almost certainly the wrong decimals for this asset. Refusing to credit it.',
    );
  }
  return Number(cents);
}

/**
 * The USD price of one whole unit, in cents.
 *
 * Pegged stablecoins return 100 by definition. Anything else needs a price the
 * operator has set; `null` means "unknown", and the caller must hold the
 * transfer rather than credit it.
 */
export async function priceUsdCentsFor(network: string): Promise<number | null> {
  const asset = PRICED_ASSETS[network as CryptoNetwork];
  if (!asset) return 100; // a pegged unit

  const configured = await getNumberSetting(SETTING_KEYS.CRYPTO_PRICE_USD_CENTS, 0);
  if (configured > 0) return configured;

  logger.warn({ network }, 'no USD price configured for this asset — the transfer will be held');
  return null;
}

/** Decimals reported by the chain when available, otherwise the pinned value. */
export function decimalsFor(network: string, fromChain?: number | null): number {
  if (Number.isInteger(fromChain) && (fromChain as number) >= 0 && (fromChain as number) <= 36) {
    return fromChain as number;
  }
  if (!isCryptoNetwork(network)) throw new ValidationError(`Unknown network: ${network}`);
  return FALLBACK_DECIMALS[network];
}

/* ------------------------------------------------------------------
 *  Recording what the chain showed us
 * ------------------------------------------------------------------ */

export interface ObservedTransfer {
  network: string;
  txHash: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  /** Integer amount in the asset's smallest unit, as a string. */
  amountRaw: string;
  /** Decimals the observer read from the chain, when it could. */
  decimals?: number | null;
  blockNumber?: bigint | null;
  confirmations?: number;
  /** The asset symbol, when the observer knows it — decides the price source. */
  symbol?: string | null;
}

export interface RecordResult {
  transfer: CryptoChainTransfer;
  created: boolean;
}

/**
 * Store an observed transfer, or return the one already stored.
 *
 * Idempotent by (network, txHash). This is the function a scanner calls for
 * every transfer it sees on every pass, so it has to be safe to call
 * repeatedly with the same input.
 */
export async function recordObservedTransfer(input: ObservedTransfer): Promise<RecordResult> {
  if (!isCryptoNetwork(input.network)) {
    throw new ValidationError(`Unknown crypto network: ${input.network}`);
  }
  if (!input.txHash.trim()) throw new ValidationError('A transfer needs a transaction hash.');
  if (!input.amountRaw.trim()) throw new ValidationError('A transfer needs an amount.');
  if (!input.toAddress.trim()) throw new ValidationError('A transfer needs a destination.');

  const existing = await prisma.cryptoChainTransfer.findUnique({
    where: { network_txHash: { network: input.network, txHash: input.txHash } },
  });
  if (existing) return { transfer: existing, created: false };

  const decimals = decimalsFor(input.network, input.decimals ?? null);

  // The asset decides the price: a pegged symbol needs no feed, an unpriced one
  // is recorded WITHOUT an amount so it can be settled deliberately later.
  const priceUsdCents = input.symbol
    ? await priceUsdCentsForForSymbol(input.network, input.symbol)
    : await priceUsdCentsFor(input.network);

  const amountCents =
    priceUsdCents === null ? null : rawToCents(input.amountRaw, decimals, priceUsdCents);

  let created: CryptoChainTransfer;
  try {
    created = await prisma.cryptoChainTransfer.create({
      data: {
        network: input.network,
        txHash: input.txHash,
        asset: input.asset,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        amountRaw: input.amountRaw,
        priceUsdCents,
        amountCents,
        blockNumber: input.blockNumber ?? null,
        confirmations: input.confirmations ?? 0,
      },
    });
  } catch (err) {
    // A create can race another scanner and lose; the unique key means the loser
    // throws, so fall back to reading the winner's row rather than failing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.cryptoChainTransfer.findUnique({
        where: { network_txHash: { network: input.network, txHash: input.txHash } },
      });
      if (winner) return { transfer: winner, created: false };
    }
    throw err;
  }

  logger.info(
    { network: created.network, txHash: created.txHash, amountCents, priceUsdCents },
    amountCents === null
      ? 'observed an on-chain transfer with no price — held for an operator'
      : 'observed an on-chain transfer',
  );

  return { transfer: created, created: true };
}

/** Price lookup for a symbol the observer named, falling back to the network. */
async function priceUsdCentsForForSymbol(network: string, symbol: string): Promise<number | null> {
  const upper = symbol.toUpperCase();
  if (PEGGED_ASSETS.includes(upper)) return 100;
  return priceUsdCentsFor(network);
}

/* ------------------------------------------------------------------
 *  Crediting
 * ------------------------------------------------------------------ */

export interface CreditResult {
  transferId: string;
  depositId: string;
  creditedCents: number;
  alreadyCredited: boolean;
}

/**
 * Credit a transfer to a named account.
 *
 * The user is an explicit argument because the chain does not tell us who owns a
 * transfer — the operator does, by matching it against a support ticket or a
 * deposit intent. Making it explicit is what stops money landing in a guessed
 * wallet.
 *
 * `crypto` carries no fee, so what arrives is what is credited.
 */
export async function creditTransferTo(userId: string, transferId: string): Promise<CreditResult> {
  const transfer = await prisma.cryptoChainTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) throw new NotFoundError('Transfer');

  if (transfer.status === 'CREDITED' && transfer.depositId) {
    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: transfer.depositId } });
    return {
      transferId: transfer.id,
      depositId: deposit.id,
      creditedCents: deposit.amountCents - deposit.feeCents,
      alreadyCredited: true,
    };
  }
  if (transfer.status === 'IGNORED') throw new ValidationError('That transfer was marked ignored.');
  if (transfer.amountCents === null) {
    throw new ValidationError('No USD price is configured for this asset, so it cannot be valued.');
  }
  if (transfer.amountCents < 1) {
    throw new ValidationError('That transfer is worth less than one cent.');
  }

  // `gatewayRef` is unique and derived from the chain, so even a concurrent
  // caller cannot open a second deposit for the same transfer.
  const deposit = await createDeposit(userId, {
    amountCents: transfer.amountCents,
    method: 'crypto',
    gatewayRef: `chain:${transfer.network}:${transfer.txHash}`,
    senderInfo: transfer.fromAddress,
  });

  // The on-chain amount is authoritative. `gatewayRef` is derived from the
  // transfer, but a caller can pre-register a deposit carrying that same
  // reference, and `createDeposit`'s replay branch would then return THAT row
  // (with its caller-chosen amount) instead of the transfer's. Refuse rather
  // than credit a sum that no chain ever delivered.
  if (deposit.amountCents !== transfer.amountCents) {
    throw new ValidationError(
      'A deposit already exists for this transfer with a different amount — refusing to credit it.',
    );
  }

  const verified = await verifyDeposit(
    'crypto-watcher',
    deposit.id,
    `${transfer.amountRaw} ${transfer.asset} on ${transfer.network} (tx ${transfer.txHash})`,
    {
      gatewayTxnId: transfer.txHash,
      rawPayload: {
        source: 'chain',
        network: transfer.network,
        txHash: transfer.txHash,
        amountRaw: transfer.amountRaw,
        toAddress: transfer.toAddress,
      },
    },
  );

  await prisma.cryptoChainTransfer.update({
    where: { id: transfer.id },
    data: { status: 'CREDITED', depositId: verified.id, creditedAt: new Date() },
  });

  const creditedCents = verified.amountCents - verified.feeCents;
  logger.info(
    { transferId: transfer.id, depositId: verified.id, creditedCents },
    'credited an on-chain transfer',
  );

  return { transferId: transfer.id, depositId: verified.id, creditedCents, alreadyCredited: false };
}

/** Mark a transfer as not-a-deposit: dust, a test send, a mistake. */
export async function ignoreTransfer(
  adminId: string,
  transferId: string,
  reason: string,
): Promise<CryptoChainTransfer> {
  const transfer = await prisma.cryptoChainTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) throw new NotFoundError('Transfer');
  if (transfer.status === 'CREDITED') {
    throw new ValidationError('That transfer is already credited and cannot be ignored.');
  }
  if (!reason.trim()) throw new ValidationError('Give a reason for ignoring a transfer.');

  const updated = await prisma.cryptoChainTransfer.update({
    where: { id: transferId },
    data: { status: 'IGNORED', note: `${reason.trim()} (by ${adminId})` },
  });

  logger.warn({ transferId, adminId, reason }, 'on-chain transfer ignored');
  return updated;
}

/** The operator's queue: what has arrived and not yet been dealt with. */
export async function listPendingTransfers(): Promise<CryptoChainTransfer[]> {
  return prisma.cryptoChainTransfer.findMany({
    where: { status: 'DETECTED' },
    orderBy: { observedAt: 'asc' },
  });
}

/* ------------------------------------------------------------------
 *  Scanning
 * ------------------------------------------------------------------ */

/**
 * The standard ERC-20 / BEP-20 `Transfer(address,address,uint256)` topic.
 * A property of the token standard, not of any vendor, which is why it is safe
 * to hold here.
 */
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Which networks can currently be scanned.
 *
 * A chain is scannable only when an RPC endpoint has been configured for it.
 * Nothing here invents an endpoint: an unconfigured network is simply not
 * scanned, and the deposit address for it is still shown to customers, so the
 * gap is a DETECTED transfer an operator settles rather than a silent loss.
 */
/** EVM chains reachable over `eth_getLogs`, i.e. with an RPC URL configured for them. */
function scannableEvmNetworks(): CryptoNetwork[] {
  const rpcUrls = env.CRYPTO_RPC_URLS;
  return CRYPTO_NETWORKS.filter((n) => {
    // Only chains this scanner can actually read. TON and Bitcoin are not EVM
    // and are not spoken to by `eth_getLogs`; folding them in here would
    // silently scan nothing while looking like coverage.
    const isEvmToken = n.endsWith('_BEP20') || n.endsWith('_ERC20');
    return isEvmToken && Boolean(TOKEN_CONTRACTS[n]) && Boolean(rpcUrls[n]);
  });
}

/**
 * Every network this deposit scanner can currently read, for display (the
 * admin "what's being scanned" screen). TRON is read through TronGrid's REST
 * API, not `eth_getLogs`, so it is not one more entry in the RPC-URL map —
 * `runCryptoScan` below scans it through its own code path, not this list.
 */
export function scannableNetworks(): CryptoNetwork[] {
  const evm = scannableEvmNetworks();
  return isTronScanConfigured() ? [...evm, 'USDT_TRC20' as CryptoNetwork] : evm;
}

interface EvmLog {
  transactionHash: string;
  blockNumber: string;
  topics: string[];
  data: string;
}

/**
 * Per-network scan cursor, persisted through the settings table (an
 * arbitrary string key, not one of the fixed `SETTING_KEYS`).
 *
 * A previous version of this scanner always read `eth_getLogs` from block 0,
 * on every run, forever. Against a real RPC provider that either fails
 * outright (most providers cap the block range of a single `eth_getLogs`
 * call, commonly to a few thousand blocks) or, if it somehow succeeds,
 * re-downloads a chain's entire history on a schedule — the periodic
 * `SCAN_CRYPTO_DEPOSITS` job would error on every pass and no EVM deposit
 * would ever be recorded. The cursor is what makes each scan pick up where
 * the last one left off.
 */
const EVM_CURSOR_SETTING_PREFIX = 'crypto_scan_cursor:';
/** Re-read this many blocks behind the saved cursor, in case of a shallow reorg. */
const EVM_SCAN_OVERLAP_BLOCKS = 12n;
/** The very first scan for a network (no cursor yet) looks back this far rather than from block 0. */
const EVM_INITIAL_LOOKBACK_BLOCKS = 5_000n;

async function getEvmScanCursor(network: CryptoNetwork): Promise<bigint | null> {
  const raw = await getStringSetting(`${EVM_CURSOR_SETTING_PREFIX}${network}`, '');
  if (!raw) return null;
  try {
    const value = BigInt(raw);
    return value >= 0n ? value : null;
  } catch {
    logger.warn(
      { network, raw },
      'stored crypto scan cursor was unreadable; falling back to the initial lookback window',
    );
    return null;
  }
}

async function setEvmScanCursor(network: CryptoNetwork, block: bigint): Promise<void> {
  await setSetting(`${EVM_CURSOR_SETTING_PREFIX}${network}`, block.toString(), null, {
    group: 'crypto',
    description: `Internal — last scanned block for ${network}. Not shown in the admin UI.`,
  });
}

export interface EvmScanResult {
  transfers: ObservedTransfer[];
  /** The block this pass actually reached — the caller persists this as the next cursor. */
  scannedToBlock: bigint;
}

/**
 * Read incoming token transfers from an EVM-compatible chain over plain
 * JSON-RPC.
 *
 * `eth_getLogs` is the standard way to find token movements: filter on the
 * token contract, the Transfer topic, and the recipient padded to a topic.
 * Reading the decimals from the contract in the same pass is what keeps a
 * 6-decimal and an 18-decimal USDT from being confused for each other.
 *
 * The scan window is resumed from the last saved cursor (with a small
 * overlap for reorg safety) rather than re-reading from block 0 every time —
 * see the cursor notes above.
 */
export async function scanEvmNetwork(network: CryptoNetwork): Promise<EvmScanResult> {
  const rpcUrl = (env.CRYPTO_RPC_URLS ?? {})[network];
  const token = TOKEN_CONTRACTS[network];
  if (!rpcUrl || !token) return { transfers: [], scannedToBlock: 0n };

  const to = await addressForNetwork(network);
  const paddedTo = `0x${to.address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await axios.post(
      rpcUrl,
      { jsonrpc: '2.0', id: 1, method, params },
      { timeout: 20_000 },
    );
    const body = response.data as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method} failed: ${body.error.message ?? 'unknown'}`);
    return body.result;
  };

  const latestHex = (await call('eth_blockNumber', [])) as string;
  const latestBlock = BigInt(latestHex);

  const cursor = await getEvmScanCursor(network);
  const fromBlock =
    cursor !== null
      ? cursor > EVM_SCAN_OVERLAP_BLOCKS
        ? cursor - EVM_SCAN_OVERLAP_BLOCKS
        : 0n
      : latestBlock > EVM_INITIAL_LOOKBACK_BLOCKS
        ? latestBlock - EVM_INITIAL_LOOKBACK_BLOCKS
        : 0n;

  // The token's own decimals, so a misconfigured constant cannot misprice it.
  let decimals: number | null = null;
  try {
    const raw = (await call('eth_call', [{ to: token, data: '0x313ce567' }, 'latest'])) as string;
    if (typeof raw === 'string' && raw !== '0x') decimals = Number(BigInt(raw));
  } catch (err) {
    logger.warn({ err, network }, 'could not read token decimals; using the pinned value');
  }

  const logs = (await call('eth_getLogs', [
    {
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: 'latest',
      address: token,
      topics: [ERC20_TRANSFER_TOPIC, null, paddedTo],
    },
  ])) as EvmLog[];

  const transfers = (logs ?? []).map((log) => ({
    network,
    txHash: log.transactionHash,
    asset: token,
    fromAddress: `0x${(log.topics[1] ?? '').slice(-40)}`,
    toAddress: to.address,
    // uint256 value is the only non-indexed field, so it is the whole data.
    amountRaw: BigInt(log.data === '0x' ? '0x0' : log.data).toString(),
    decimals,
    blockNumber: BigInt(log.blockNumber),
    confirmations: 0,
    // Every network this scanner handles is a pegged stablecoin, so it needs no
    // price feed. Deriving the symbol from the network keeps that visible rather
    // than implied.
    symbol: network.startsWith('USDC') ? 'USDC' : 'USDT',
  }));

  return { transfers, scannedToBlock: latestBlock };
}

export interface ScanSummary {
  scanned: number;
  recorded: number;
  skipped: number;
}

/**
 * One scanning pass over every configured network.
 *
 * Recording is all this does — crediting is a separate, deliberate step, because
 * who a transfer belongs to is not something a chain can tell us.
 */
export async function runCryptoScan(): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, recorded: 0, skipped: 0 };

  for (const network of scannableEvmNetworks()) {
    summary.scanned += 1;
    try {
      const { transfers, scannedToBlock } = await scanEvmNetwork(network);
      for (const observed of transfers) {
        const { created } = await recordObservedTransfer(observed);
        if (created) summary.recorded += 1;
        else summary.skipped += 1;
      }
      // Only advance the cursor once every transfer from this pass is safely
      // recorded — a scan that throws midway leaves the cursor where it was,
      // so the next run re-reads from the same point rather than skipping it.
      await setEvmScanCursor(network, scannedToBlock);
    } catch (err) {
      logger.error({ err, network }, 'crypto scan failed for a network');
    }
  }

  if (isTronScanConfigured()) {
    summary.scanned += 1;
    try {
      const cursor = await getStringSetting(TRON_CURSOR_SETTING_KEY, '');
      const { transfers, nextCursor } = await scanTronNetwork(cursor || null);
      for (const observed of transfers) {
        const { created } = await recordObservedTransfer(observed);
        if (created) summary.recorded += 1;
        else summary.skipped += 1;
      }
      await setSetting(TRON_CURSOR_SETTING_KEY, nextCursor, null, {
        group: 'crypto',
        description: 'Internal — last scanned TronGrid cursor for USDT_TRC20. Not shown in the admin UI.',
      });
    } catch (err) {
      logger.error({ err, network: 'USDT_TRC20' }, 'crypto scan failed for a network');
    }
  }

  return summary;
}
