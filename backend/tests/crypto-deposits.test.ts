import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { NotFoundError, ValidationError } from '../src/utils/errors';
import { ref } from '../src/services/transaction.service';

// The notification producers open a real Redis connection on import, and the
// crypto rail's whole point is that it is credited in the same transaction as
// every other rail — so the enqueue side is stubbed, as in the other suites.
const queue = vi.hoisted(() => ({
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookDelivery: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const {
  rawToCents,
  decimalsFor,
  priceUsdCentsFor,
  recordObservedTransfer,
  creditTransferTo,
  ignoreTransfer,
  listPendingTransfers,
  scannableNetworks,
} = await import('../src/services/cryptoDeposit.service');
const { resetDatabase, createUser, walletOf, setTestSettings } = await import('./helpers/fixtures');

/**
 * CRYPTO DEPOSITS.
 *
 * Two failure modes make on-chain crediting dangerous, and this file pins both:
 *
 * 1. DECIMALS. A token amount is an integer in the asset's smallest unit. USDT
 *    is 6 decimals on TRON and Ethereum but 18 on BNB Chain. Read one as the
 *    other and a $10 deposit becomes $10,000,000 — or $0. These tests show the
 *    magnitudes rather than asserting a number is "right", because the point is
 *    how catastrophically wrong the wrong read is.
 *
 * 2. DOUBLE CREDITING. A rescan or a reorg re-presents the same transfer. The
 *    unique (network, txHash) row, the unique `depositId` link and the ledger's
 *    own unique reference all have to hold, so this is asserted directly.
 */

const USDT_TRC20_DECIMALS = 6;
const USDT_BEP20_DECIMALS = 18;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('converting a raw chain amount', () => {
  it('reads 6-decimal USDT correctly: 10 USDT is $10.00', () => {
    // 10 USDT on TRON is 10_000_000 of the smallest unit.
    expect(rawToCents('10000000', USDT_TRC20_DECIMALS, 100)).toBe(1_000);
  });

  it('reads 18-decimal USDT correctly: 10 USDT is ALSO $10.00', () => {
    // The same 10 USDT on BNB Chain is 10_000_000_000_000_000_000 units. Same
    // money, a completely different string.
    expect(rawToCents('10000000000000000000', USDT_BEP20_DECIMALS, 100)).toBe(1_000);
  });

  it('shows what reading the wrong decimals would do — this is the whole risk', () => {
    // A 6-decimal amount read as 18-decimal: the money silently vanishes.
    expect(rawToCents('10000000', USDT_BEP20_DECIMALS, 100)).toBe(0);

    // The other direction is far worse. $10 read as a 6-decimal amount when it
    // is really an 18-decimal one comes out as $10,000,000,000,000 — a number
    // that fits in a JS integer perfectly happily, so an integer-range check
    // does NOT catch it. What catches it is a ceiling no real top-up reaches.
    expect(() => rawToCents('10000000000000000000', USDT_TRC20_DECIMALS, 100)).toThrow(
      /wrong decimals/i,
    );
  });

  it('still accepts a large but plausible deposit', () => {
    // $50,000 must not be caught by the ceiling meant for scaling mistakes.
    expect(rawToCents('50000000000', USDT_TRC20_DECIMALS, 100)).toBe(5_000_000);
  });

  it('applies the price to the whole amount, not to a truncated fraction', () => {
    // 1.5 USDT at $1.00.
    expect(rawToCents('1500000', USDT_TRC20_DECIMALS, 100)).toBe(150);
  });

  it('refuses a negative amount and an absurd decimals value', () => {
    expect(() => rawToCents('-1', 6, 100)).toThrow(ValidationError);
    expect(() => rawToCents('1000000', 99, 100)).toThrow(ValidationError);
  });

  it('prefers the decimals the chain reported over the pinned value', () => {
    // A chain that says 8 must win over the compiled-in 6, or a token upgrade
    // would be silently mispriced until someone redeployed.
    expect(decimalsFor('USDT_TRC20', 8)).toBe(8);
    expect(decimalsFor('USDT_TRC20', null)).toBe(USDT_TRC20_DECIMALS);
    // BNB Chain's USDT is the one that catches people out.
    expect(decimalsFor('USDT_BEP20')).toBe(USDT_BEP20_DECIMALS);
    expect(() => decimalsFor('NOT_A_CHAIN')).toThrow(ValidationError);
  });
});

describe('pricing', () => {
  it('treats USDT and USDC as a dollar, so they need no price feed', async () => {
    expect(await priceUsdCentsFor('USDT_TRC20')).toBe(100);
    expect(await priceUsdCentsFor('USDC_ERC20')).toBe(100);
  });

  it('returns NO price for an asset it has not been given one for', async () => {
    // The honest answer is "unknown" rather than a guess.
    expect(await priceUsdCentsFor('TON')).toBeNull();
    expect(await priceUsdCentsFor('BTC')).toBeNull();
  });

  it('uses a configured price when there is one', async () => {
    await setTestSettings({ crypto_price_usd_cents: 350 });
    expect(await priceUsdCentsFor('TON')).toBe(350);
    // A pegged asset is unaffected by an operator setting a price.
    expect(await priceUsdCentsFor('USDT_TRC20')).toBe(100);
  });
});

describe('recording what the chain showed', () => {
  const base = {
    network: 'USDT_TRC20',
    txHash: 'a'.repeat(64),
    asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    fromAddress: 'TSender',
    toAddress: 'TC4utPWPZWB35Sx4WFmAxKUKP6QtZMqDqk',
    amountRaw: '10000000',
    symbol: 'USDT',
  };

  it('values the transfer in cents at observation time', async () => {
    const { transfer, created } = await recordObservedTransfer(base);

    expect(created).toBe(true);
    expect(transfer.amountCents).toBe(1_000);
    expect(transfer.priceUsdCents).toBe(100);
    expect(transfer.status).toBe('DETECTED');
  });

  it('records the SAME transfer only once, however many times it is seen', async () => {
    await recordObservedTransfer(base);
    const second = await recordObservedTransfer(base);
    const third = await recordObservedTransfer(base);

    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(await prisma.cryptoChainTransfer.count()).toBe(1);
  });

  it('holds a transfer it cannot price instead of inventing one', async () => {
    const { transfer } = await recordObservedTransfer({
      ...base,
      network: 'TON',
      asset: 'TON',
      symbol: 'TON',
      amountRaw: '1000000000', // 1 TON
    });

    // Recorded, visible to an operator, and deliberately NOT valued.
    expect(transfer.amountCents).toBeNull();
    expect(transfer.priceUsdCents).toBeNull();
    expect(await listPendingTransfers()).toHaveLength(1);
  });

  it('refuses an unknown chain and an incomplete transfer', async () => {
    await expect(recordObservedTransfer({ ...base, network: 'SOLANA' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(recordObservedTransfer({ ...base, txHash: '  ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(recordObservedTransfer({ ...base, amountRaw: '' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await prisma.cryptoChainTransfer.count()).toBe(0);
  });
});

describe('crediting a transfer', () => {
  async function pendingTransfer(amountRaw = '10000000') {
    const { transfer } = await recordObservedTransfer({
      network: 'USDT_TRC20',
      txHash: 'b'.repeat(64),
      asset: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      fromAddress: 'TSender',
      toAddress: 'TC4utPWPZWB35Sx4WFmAxKUKP6QtZMqDqk',
      amountRaw,
      symbol: 'USDT',
    });
    return transfer;
  }

  it('credits the full amount — crypto takes no fee', async () => {
    const user = await createUser();
    const transfer = await pendingTransfer();

    const result = await creditTransferTo(user.id, transfer.id);

    expect(result.creditedCents).toBe(1_000);
    expect(result.alreadyCredited).toBe(false);
    // $10.00 in, $10.00 spendable — this is why crypto is the rail to push.
    expect((await walletOf(user.id)).availableCents).toBe(1_000);

    const stored = await prisma.cryptoChainTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
    expect(stored.status).toBe('CREDITED');
    expect(stored.depositId).toBe(result.depositId);
    expect(stored.creditedAt).not.toBeNull();
  });

  it('credits ONCE, however many times it is asked', async () => {
    const user = await createUser();
    const transfer = await pendingTransfer();

    const first = await creditTransferTo(user.id, transfer.id);
    const second = await creditTransferTo(user.id, transfer.id);
    const third = await creditTransferTo(user.id, transfer.id);

    expect(second.alreadyCredited).toBe(true);
    expect(third.alreadyCredited).toBe(true);
    expect(second.depositId).toBe(first.depositId);

    expect((await walletOf(user.id)).availableCents).toBe(1_000);
    expect(await prisma.deposit.count()).toBe(1);
    expect(await prisma.transaction.count({ where: { type: 'DEPOSIT' } })).toBe(1);
    expect(await prisma.transaction.count({ where: { reference: ref.deposit(first.depositId) } })).toBe(1);
  });

  it('refuses to credit a transfer with no price', async () => {
    const user = await createUser();
    const { transfer } = await recordObservedTransfer({
      network: 'TON',
      txHash: 'c'.repeat(64),
      asset: 'TON',
      symbol: 'TON',
      fromAddress: 'TONsender',
      toAddress: 'UQAe-vo66AhqzOc9lvioLpltXLIeZ9IdBttTCMFBWHvXrXKw',
      amountRaw: '1000000000',
    });

    await expect(creditTransferTo(user.id, transfer.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('refuses dust rather than crediting zero', async () => {
    const user = await createUser();
    // 1 unit of a 6-decimal token is $0.000001 — worth less than nothing.
    const transfer = await pendingTransfer('1');

    await expect(creditTransferTo(user.id, transfer.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('refuses a transfer that was explicitly ignored', async () => {
    const user = await createUser();
    const transfer = await pendingTransfer();
    await ignoreTransfer('admin-1', transfer.id, 'test send');

    await expect(creditTransferTo(user.id, transfer.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('reports an unknown transfer rather than creating one', async () => {
    const user = await createUser();
    await expect(creditTransferTo(user.id, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('the operator queue', () => {
  it('lists only what has not been dealt with', async () => {
    const user = await createUser();

    const first = await recordObservedTransfer({
      network: 'USDT_TRC20',
      txHash: 'd'.repeat(64),
      asset: 'USDT',
      symbol: 'USDT',
      fromAddress: 'A',
      toAddress: 'B',
      amountRaw: '10000000',
    });
    await recordObservedTransfer({
      network: 'USDT_TRC20',
      txHash: 'e'.repeat(64),
      asset: 'USDT',
      symbol: 'USDT',
      fromAddress: 'A',
      toAddress: 'B',
      amountRaw: '20000000',
    });

    await creditTransferTo(user.id, first.transfer.id);

    const pending = await listPendingTransfers();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.txHash).toBe('e'.repeat(64));
  });

  it('will not ignore a transfer that is already credited', async () => {
    const user = await createUser();
    const { transfer } = await recordObservedTransfer({
      network: 'USDT_TRC20',
      txHash: 'f'.repeat(64),
      asset: 'USDT',
      symbol: 'USDT',
      fromAddress: 'A',
      toAddress: 'B',
      amountRaw: '10000000',
    });
    await creditTransferTo(user.id, transfer.id);

    await expect(ignoreTransfer('admin-1', transfer.id, 'oops')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('requires a reason for ignoring anything', async () => {
    const { transfer } = await recordObservedTransfer({
      network: 'USDT_TRC20',
      txHash: '0'.repeat(64),
      asset: 'USDT',
      symbol: 'USDT',
      fromAddress: 'A',
      toAddress: 'B',
      amountRaw: '10000000',
    });

    await expect(ignoreTransfer('admin-1', transfer.id, '   ')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('what can actually be scanned', () => {
  it('reports NO chains when no RPC endpoint has been configured', async () => {
    // Nothing is invented: with no endpoint the scanner simply has nothing to
    // read, and that is visible here rather than looking like coverage.
    expect(scannableNetworks()).toEqual([]);
  });
});
