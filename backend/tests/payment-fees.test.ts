import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ValidationError } from '../src/utils/errors';
import { CRYPTO_NETWORKS, CRYPTO_NETWORK_LABELS, isCryptoNetwork } from '@botflow/shared';

// Verifying a deposit notifies the depositor, and the notification producers
// open a REAL Redis connection the moment they are imported. Redis is not what
// this file is testing, so the enqueue side is stubbed exactly as the other
// suites do (see alerts-email.test.ts) — without this the credit path blocks on
// a Redis connect and every test here times out.
const queue = vi.hoisted(() => ({
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookDelivery: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const { quoteDeposit, feeBpsFor, paymentFeeSummary, methodLabel } = await import(
  '../src/services/paymentFee.service'
);
const { createDeposit, verifyDeposit } = await import('../src/services/deposit.service');
const { resetDatabase, createUser, walletOf, setTestSettings } = await import('./helpers/fixtures');

/**
 * PAYMENT RAIL ECONOMICS.
 *
 * The operator's rates:
 *
 *   crypto (USDT / USDC / TON / BTC)   free — no processor sits in the middle
 *   Telegram Stars                     48%   (Telegram's own commission)
 *
 * THE DEPOSITOR PAYS. The fee comes out of what they sent, and only the
 * remainder reaches their wallet:
 *
 *     100 Stars  →  48 kept  →  52 credited
 *
 * That is the single guarantee this file exists to pin down. Crediting the full
 * amount would hand every depositor the platform's cut; deducting a rate the
 * depositor never saw would take money they did not agree to. Both directions
 * are asserted.
 */

const WIDE = { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2030-01-01T00:00:00Z') };

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the configured rates', () => {
  it('charges nothing for crypto — the only free rail', async () => {
    expect(await feeBpsFor('crypto')).toBe(0);
    const q = await quoteDeposit('crypto', 10_000);
    // A deposit through crypto is worth exactly what was sent.
    expect(q).toMatchObject({ grossCents: 10_000, feeBps: 0, feeCents: 0, creditedCents: 10_000 });
  });

  it('charges 48% for Telegram Stars', async () => {
    expect(await feeBpsFor('telegram_stars')).toBe(4800);
    const q = await quoteDeposit('telegram_stars', 10_000);
    expect(q).toMatchObject({ feeBps: 4800, feeCents: 4_800, creditedCents: 5_200 });
  });

  it("reproduces the operator's own Stars example: 100 in, 52 in the wallet", async () => {
    const q = await quoteDeposit('telegram_stars', 100);
    expect(q.feeCents).toBe(48);
    expect(q.creditedCents).toBe(52);
    // The two halves are exact, so they can never drift apart.
    expect(q.feeCents + q.creditedCents).toBe(q.grossCents);
  });

  it('rounds the fee UP, never giving away a fraction of a minor unit', async () => {
    // 48% of 1,005 is 482.4 — the depositor agreed to give up the fraction.
    const q = await quoteDeposit('telegram_stars', 1_005);
    expect(q.feeCents).toBe(483);
    expect(q.creditedCents).toBe(522);
  });

  it('refuses a method it has no rate for instead of booking it at zero', async () => {
    await expect(feeBpsFor('paypal')).rejects.toBeInstanceOf(ValidationError);
    await expect(quoteDeposit('paypal', 1_000)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a non-positive or fractional amount', async () => {
    await expect(quoteDeposit('crypto', 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(quoteDeposit('crypto', -5)).rejects.toBeInstanceOf(ValidationError);
    await expect(quoteDeposit('crypto', 10.5)).rejects.toBeInstanceOf(ValidationError);
  });

  it('lets an operator override a rate without a deploy', async () => {
    await setTestSettings({ payment_fee_bps_telegram_stars: 900 });
    expect(await feeBpsFor('telegram_stars')).toBe(900);
    expect((await quoteDeposit('telegram_stars', 10_000)).creditedCents).toBe(9_100);
    // One method's override must not move any other rail.
    expect(await feeBpsFor('crypto')).toBe(0);
  });

  it('ignores an override that is out of range rather than honouring a nonsense rate', async () => {
    await setTestSettings({ payment_fee_bps_telegram_stars: 99_999 });
    expect(await feeBpsFor('telegram_stars')).toBe(4800);

    await setTestSettings({ payment_fee_bps_telegram_stars: -100 });
    expect(await feeBpsFor('telegram_stars')).toBe(4800);
  });

  it('labels every method it accepts', () => {
    expect(methodLabel('telegram_stars')).toBe('Telegram Stars');
    expect(methodLabel('crypto')).toContain('Crypto');
    // A value stored before this model existed must not crash a report.
    expect(methodLabel('something_old')).toBe('something_old');
  });
});

describe('the crypto network list', () => {
  it('offers the (asset, chain) pairs the deposit screen shows', () => {
    // USDT on TON is a different address from USDT on BEP20 — the pair is what
    // the depositor picks, and sending to the wrong one is unrecoverable.
    expect(CRYPTO_NETWORKS).toContain('USDT_TON');
    expect(CRYPTO_NETWORKS).toContain('TON');
    expect(CRYPTO_NETWORKS).toContain('USDT_BEP20');
    expect(CRYPTO_NETWORKS).toContain('USDT_TRC20');
    expect(CRYPTO_NETWORKS).toContain('BTC');
    expect(CRYPTO_NETWORK_LABELS.USDT_TRC20).toEqual({ asset: 'USDT', chain: 'TRC20' });
    expect(CRYPTO_NETWORK_LABELS.BTC).toEqual({ asset: 'Bitcoin', chain: 'Bitcoin' });
  });

  it('rejects a network we cannot generate an address for', () => {
    expect(isCryptoNetwork('USDT_TON')).toBe(true);
    expect(isCryptoNetwork('USDT_SOLANA')).toBe(false);
    expect(isCryptoNetwork(null)).toBe(false);
  });
});

describe('a deposit records the rate it was taken at', () => {
  it('freezes feeBps and feeCents on the row at creation', async () => {
    const user = await createUser();

    const deposit = await createDeposit(user.id, { amountCents: 10_000, method: 'telegram_stars' });

    expect(deposit.feeBps).toBe(4800);
    expect(deposit.feeCents).toBe(4_800);
    expect(deposit.amountCents).toBe(10_000);
  });

  it('stamps a zero fee for a free rail, so a zero is measured rather than missing', async () => {
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 10_000, method: 'crypto' });
    expect(deposit.feeCents).toBe(0);
    expect(deposit.feeBps).toBe(0);
  });

  it('refuses an unknown method before anything is written', async () => {
    const user = await createUser();
    await expect(createDeposit(user.id, { amountCents: 5_000, method: 'paypal' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await prisma.deposit.count()).toBe(0);
  });

  it('does not rewrite the economics of an existing deposit when the rate later changes', async () => {
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 10_000, method: 'telegram_stars' });

    await setTestSettings({ payment_fee_bps_telegram_stars: 100 });
    const reloaded = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });

    // The advertiser is charged the rate they were shown at the time.
    expect(reloaded.feeBps).toBe(4800);
    expect(reloaded.feeCents).toBe(4_800);
  });
});

describe('the depositor pays the fee', () => {
  it('credits only what is left after the Stars fee', async () => {
    const admin = await createUser();
    const user = await createUser();
    const before = await walletOf(user.id);

    const deposit = await createDeposit(user.id, { amountCents: 10_000, method: 'telegram_stars' });
    await verifyDeposit(admin.id, deposit.id);

    const after = await walletOf(user.id);
    // 100 paid, 52 spendable — the 48 is the platform's.
    expect(after.availableCents - before.availableCents).toBe(5_200);

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.status).toBe('VERIFIED');
    expect(stored.amountCents).toBe(10_000);
    expect(stored.feeCents).toBe(4_800);
  });

  it('credits 52 of 100 Stars, exactly as the operator specified', async () => {
    const admin = await createUser();
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 100, method: 'telegram_stars' });

    await verifyDeposit(admin.id, deposit.id);

    expect((await walletOf(user.id)).availableCents).toBe(52);
    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.feeCents).toBe(48);
  });

  it('credits a crypto deposit in full, because that rail takes nothing', async () => {
    const admin = await createUser();
    const user = await createUser();
    const deposit = await createDeposit(user.id, { amountCents: 25_000, method: 'crypto' });

    await verifyDeposit(admin.id, deposit.id);

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.feeCents).toBe(0);
    expect((await walletOf(user.id)).availableCents).toBe(25_000);
  });

  it('never lets the credited amount exceed what was sent', async () => {
    const admin = await createUser();
    const user = await createUser();
    for (const method of ['telegram_stars', 'crypto'] as const) {
      const deposit = await createDeposit(user.id, { amountCents: 1_000, method });
      await verifyDeposit(admin.id, deposit.id);
      const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(stored.feeCents).toBeLessThanOrEqual(stored.amountCents);
      expect(stored.amountCents - stored.feeCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('per-rail reporting', () => {
  it('aggregates what was kept by method and computes the effective rate', async () => {
    const admin = await createUser();
    const user = await createUser();

    for (const [method, amount] of [
      ['crypto', 50_000],
      ['telegram_stars', 10_000],
      ['telegram_stars', 10_000],
    ] as const) {
      const deposit = await createDeposit(user.id, { amountCents: amount, method });
      await verifyDeposit(admin.id, deposit.id);
    }

    const summary = await paymentFeeSummary(WIDE);

    expect(summary.totals.deposits).toBe(3);
    expect(summary.totals.grossCents).toBe(70_000);
    // 0 (crypto) + 2 × 4,800 (Stars)
    expect(summary.totals.feeCents).toBe(9_600);
    expect(summary.totals.effectiveBps).toBe(1_371);

    // Most kept first — the rail to think hardest about sits at the top. Note
    // that Stars outranks crypto even though crypto brought in five times the
    // gross: 48% of 10,000 (4,800) beats 0% of 50,000. Sorting by RATE rather
    // than by amount kept would have hidden that.
    expect(summary.byMethod.map((m) => m.method)).toEqual(['telegram_stars', 'crypto']);
    const stars = summary.byMethod.find((m) => m.method === 'telegram_stars')!;
    expect(stars).toMatchObject({
      deposits: 2,
      grossCents: 20_000,
      feeCents: 9_600,
      effectiveBps: 4800,
      label: 'Telegram Stars',
    });
    const crypto = summary.byMethod.find((m) => m.method === 'crypto')!;
    expect(crypto).toMatchObject({ deposits: 1, grossCents: 50_000, feeCents: 0, effectiveBps: 0 });
  });

  it('excludes money that never arrived — pending and rejected deposits are not economic', async () => {
    const user = await createUser();
    await createDeposit(user.id, { amountCents: 10_000, method: 'telegram_stars' }); // left PENDING

    const summary = await paymentFeeSummary(WIDE);

    expect(summary.totals).toMatchObject({ deposits: 0, grossCents: 0, feeCents: 0, effectiveBps: 0 });
    expect(summary.byMethod).toEqual([]);
  });

  it('stays honest for a window with no deposits rather than dividing by zero', async () => {
    const summary = await paymentFeeSummary({ from: new Date('1999-01-01'), to: new Date('1999-02-01') });
    expect(summary.totals.effectiveBps).toBe(0);
    expect(summary.totals.netCents).toBe(0);
  });
});
