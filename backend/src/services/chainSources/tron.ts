import axios from 'axios';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ValidationError } from '../../utils/errors';
import { addressForNetwork } from '../cryptoAddress.service';
import type { ObservedTransfer } from '../cryptoDeposit.service';

/**
 * TRON source: incoming TRC-20 USDT transfers, read from TronGrid.
 *
 * ENDPOINT — verified from the official TronGrid OpenAPI on
 * developers.tron.network ("Get TRC20 Transaction Info by account address",
 * trongrid-v1-api). The path, query parameters, response shape and the
 * `TRON-PRO-API-KEY` header are all documented there:
 *
 *   GET {TRON_TRONGRID_API_URL}/v1/accounts/{address}/transactions/trc20
 *       ?contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
 *       &only_to={address}&only_confirmed=true
 *       &order_by=block_timestamp,asc&limit=100
 *       &min_timestamp={ms}&max_timestamp={ms}[&fingerprint={token}]
 *
 * The documented mainnet server is `https://api.trongrid.io`. We do NOT bake
 * that into the code as a default: `TRON_TRONGRID_API_URL` is a REQUIRED env
 * value (see env.ts — it defaults to `''`, which reports this source as
 * unconfigured), and a source without it refuses to scan — an invented
 * endpoint is how a scanner silently reads the wrong network.
 *
 * SCAN WINDOW (how a window cannot silently skip a transfer):
 *   - The cursor is the block timestamp (ms) of the newest transfer seen on
 *     the previous scan, persisted by the caller (`cryptoDeposit.service`'s
 *     `runCryptoScan`) through the settings table. Each scan reads
 *     [cursor - OVERLAP_MS, now] oldest first, page after page, following the
 *     provider's `fingerprint` token (the docs require every other parameter
 *     to stay identical across pages; the same params object is kept for the
 *     whole walk).
 *   - The FIRST scan (no cursor) reads the address's full history: a deposit
 *     address has no meaningful history before we started watching it, and
 *     anything that exists is by definition money sent to us.
 *   - OVERLAP_MS (10 min) is far larger than TRON's finality delay (3 s
 *     blocks; a transfer is classified confirmed only once its block is
 *     solidified), so a transfer that confirms between two scans is always
 *     re-read. Recording is idempotent by (network, txHash), so the overlap
 *     costs nothing.
 *   - MAX_PAGES × PAGE_SIZE is a safety valve, not a window: if a single scan
 *     burst is larger than the cap, the cursor stops at the newest transfer
 *     actually read and the next scan covers the remainder. Nothing is
 *     skipped.
 *
 * CONFIRMATIONS: the only confirmation signal this endpoint gives is the
 * confirmed/unconfirmed classification, and we read with
 * `only_confirmed=true` — a transfer is in a solidified block by the time it
 * can be returned. That is the threshold this source applies before handing
 * anything to the recorder; the per-transfer `confirmations` count is not
 * exposed by this endpoint and is left unset.
 *
 * DECIMALS: read from each item's `token_info.decimals` — the chain's own
 * number. If the provider omits it or returns a value outside 0..36 we pass
 * `null` and the recorder falls back to the pinned 6 for USDT_TRC20.
 */

/** Tether USD on TRON mainnet — the same constant pinned in cryptoDeposit.service. */
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

/** How far behind the cursor each scan re-reads; see the window notes above. */
const OVERLAP_MS = 10 * 60 * 1000;
/** The endpoint allows up to 200 per page; 100 keeps requests comfortably sized. */
const PAGE_SIZE = 100;
/** Safety valve for one scan burst — see the window notes above. */
const MAX_PAGES = 50;
const HTTP_TIMEOUT_MS = 20_000;

interface TronGridTokenInfo {
  symbol?: string;
  address?: string;
  decimals?: number;
  name?: string;
}

/** One TRC-20 event as TronGrid returns it (only the fields this source reads). */
interface TronGridTrc20Item {
  transaction_id?: string;
  token_info?: TronGridTokenInfo;
  /** Block time in epoch MILLISECONDS. */
  block_timestamp?: number;
  from?: string;
  to?: string;
  /** 'Transfer' for token movements; other event types must not be treated as deposits. */
  type?: string;
  /** Integer string in the token's smallest unit. */
  value?: string;
}

interface TronGridPage {
  success?: boolean;
  message?: string;
  data?: TronGridTrc20Item[];
  meta?: {
    at?: number;
    page_size?: number;
    fingerprint?: string | null;
    links?: { next?: string | null } | null;
  };
}

function readBaseUrl(): string | null {
  const value = env.TRON_TRONGRID_API_URL.trim();
  return value ? value : null;
}

function readApiKey(): string | null {
  const value = env.TRON_TRONGRID_API_KEY.trim();
  return value ? value : null;
}

/** Whether this source has what it needs to scan at all. */
export function isTronScanConfigured(): boolean {
  return readBaseUrl() !== null;
}

/**
 * The cursor is an epoch-ms string. A corrupted cursor degrades to a full
 * history re-read (idempotent recording absorbs it) rather than throwing on
 * every scan forever.
 */
function parseCursor(cursor: string | null): number | null {
  if (!cursor) return null;
  const n = Number.parseInt(cursor, 10);
  if (Number.isInteger(n) && n > 0) return n;
  logger.warn({ cursor }, 'TRON scan cursor was unreadable; re-reading from the beginning');
  return null;
}

export interface TronScanResult {
  transfers: ObservedTransfer[];
  /** Opaque cursor for the next call — the caller persists this. */
  nextCursor: string;
}

/**
 * Read incoming, CONFIRMED USDT transfers to the configured deposit address
 * and return them in the shared ObservedTransfer shape plus the cursor for
 * the next scan.
 */
export async function scanTronNetwork(cursor: string | null): Promise<TronScanResult> {
  const baseUrl = readBaseUrl();
  if (!baseUrl) {
    throw new ValidationError(
      'TRON source is not configured: set TRON_TRONGRID_API_URL to the TronGrid base URL ' +
        '(the documented mainnet server is https://api.trongrid.io). Refusing to scan against an endpoint that was not given.',
    );
  }
  const apiKey = readApiKey();

  const view = await addressForNetwork('USDT_TRC20');
  const address = view.address;

  const now = Date.now();
  const start = parseCursor(cursor);
  const minTimestamp = start === null ? 0 : Math.max(0, start - OVERLAP_MS);
  const maxTimestamp = now;

  // One params object for the whole walk: the docs require it to stay
  // identical when `fingerprint` is added for the next page.
  const baseParams: Record<string, string> = {
    contract_address: USDT_TRC20_CONTRACT,
    only_to: address,
    only_confirmed: 'true',
    order_by: 'block_timestamp,asc',
    limit: String(PAGE_SIZE),
    min_timestamp: String(minTimestamp),
    max_timestamp: String(maxTimestamp),
  };

  const headers: Record<string, string> = {};
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`;

  const transfers: ObservedTransfer[] = [];
  let latestSeen = 0; // newest block_timestamp among ALL items seen, mapped or not
  let fingerprint: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await axios.get(url, {
      headers,
      params: fingerprint ? { ...baseParams, fingerprint } : { ...baseParams },
      timeout: HTTP_TIMEOUT_MS,
    });

    const body = response.data as TronGridPage;
    if (!body || body.success === false) {
      throw new Error(`TronGrid returned success=false: ${body?.message ?? 'no message'}`);
    }
    const items = Array.isArray(body.data) ? body.data : [];
    if (items.length === 0) break;

    for (const item of items) {
      const blockTimestamp =
        typeof item.block_timestamp === 'number' && Number.isFinite(item.block_timestamp)
          ? Math.floor(item.block_timestamp)
          : null;
      if (blockTimestamp !== null) latestSeen = Math.max(latestSeen, blockTimestamp);

      const txHash = typeof item.transaction_id === 'string' ? item.transaction_id.trim() : '';
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      if (!txHash || !/^\d+$/.test(value)) {
        logger.warn({ item }, 'TRON trc20 item lacked a usable transaction_id or value; skipped');
        continue;
      }
      // Defensive: the request already filters with only_to, but a transfer
      // we did not receive must never reach the recorder.
      if (item.to !== undefined && item.to !== address) continue;
      // Approval-style events share this endpoint; only token transfers are deposits.
      if (item.type !== undefined && item.type.toLowerCase() !== 'transfer') continue;
      const contract = typeof item.token_info?.address === 'string' ? item.token_info.address : '';
      if (contract && contract.toUpperCase() !== USDT_TRC20_CONTRACT.toUpperCase()) {
        logger.warn({ contract }, 'TRON trc20 item was not the USDT contract; skipped');
        continue;
      }

      const reported = item.token_info?.decimals;
      const decimals =
        typeof reported === 'number' && Number.isInteger(reported) && reported >= 0 && reported <= 36
          ? reported
          : null;

      transfers.push({
        network: 'USDT_TRC20',
        txHash,
        asset: USDT_TRC20_CONTRACT,
        fromAddress: typeof item.from === 'string' ? item.from : '',
        toAddress: address,
        amountRaw: value,
        decimals,
        blockNumber: null, // this endpoint reports block time, not block number
        symbol:
          typeof item.token_info?.symbol === 'string' && item.token_info.symbol
            ? item.token_info.symbol
            : 'USDT',
      });
    }

    fingerprint =
      typeof body.meta?.fingerprint === 'string' && body.meta.fingerprint !== ''
        ? body.meta.fingerprint
        : null;
    if (!fingerprint) break;
    if (page === MAX_PAGES - 1) {
      // The burst was larger than the cap. The cursor stops at the newest
      // transfer read; the next scan covers the remainder — nothing skipped.
      logger.warn(
        { network: 'USDT_TRC20', pages: MAX_PAGES },
        'TRON scan hit the page cap before the window ended; the cursor advances to the newest transfer read',
      );
    }
  }

  return {
    transfers,
    // No items at all: advance to `now` so the next window is [now-OVERLAP, now'].
    // Items seen: the newest of them (the overlap re-reads the boundary safely).
    nextCursor: latestSeen > 0 ? String(latestSeen) : String(maxTimestamp),
  };
}
