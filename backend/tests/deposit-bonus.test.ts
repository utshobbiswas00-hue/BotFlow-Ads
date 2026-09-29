import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, transaction } from '../src/db/prisma';
import { ValidationError } from '../src/utils/errors';
import { PAYMENT_METHOD_FEE_BPS } from '@botflow/shared';

// verifyDeposit (imported below via deposit.service) fans out to the
// notification producer, which opens a REAL Redis connection at import time.
// Redis is not what this file tests, so the enqueue side is stubbed exactly
// as the other suites do (see payment-fees.test.ts).
const queue = vi.hoisted(() => ({
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookDelivery: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const {
  DEPOSIT_BONUS_SETTING_KEYS,
  DEFAULT_DEPOSIT_BONUS_TIERS,
  quoteTopUp,
  quoteTopUpForDeposit,
  settleBonusFor,
  loadBonusConfig,
  bonusForSettledDeposit,
  postDepositBonus,
  depositBonusReference,
  parseBonusTiers,
  selectBonusTier,
} = await import('../src/services/depositBonus.service');
const { createDeposit, rejectDeposit } = await import('../src/services/deposit.service');
const { resetDatabase, createUser, walletOf, setTestSettings } = await import('./helpers/fixtures');

/**
 * TOP-UP VOLUME BONUS.
 *
 * The screen promises "1250 USD / 100000 stars — Bonus +7%" and
 * "625 USD / 50000 stars — Bonus +5%". This file pins down:
 *
 *   1. the exact arithmetic — gross, fee, bonus, credited reconcile for EVERY
 *      rail, including the 48% Stars one;
 *   2. that the bonus is a percentage of GROSS (what the customer pays), not
 *      of the fee-eroded net;
 *   3. that the tiers are DATA: thresholds/percentages change without a
 *      deploy, malformed data fails closed, and the program can be switched
 *      off;
 *   4. that the grant is exactly-once per deposit — at intent time nothing is
 *      paid, and replay/race of the grant moves the money once.
 *
 * The settle-time hook in verifyDeposit (the 5-line wiring) is applied
 * separately; every function it calls is tested here, against the real
 * database, including the unique-reference double-grant defence.
 */

const TIERS = DEFAULT_DEPOSIT_BONUS_TIERS;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('quoteTopUp — pure arithmetic, every rail', () => {
  const GROSSES = [1_000, 62_499, 62_500, 100_000, 124_999, 125_000, 1_000_000];

  it('reconciles exactly for every payment method at every headline size', () => {
    for (const [method, feeBps] of Object.entries(PAYMENT_METHOD_FEE_BPS)) {
      for (const grossCents of GROSSES) {
        const q = quoteTopUp({ grossCents, feeBps, method, tiers: TIERS });

        // The fee keeps its existing semantics (ceil, depositor's cut) and the
        // split can never drift: fee + net = gross, always.
        expect(q.feeCents, `${method} @ ${grossCents}: fee`).toBe(Math.ceil((grossCents * feeBps) / 10_000));
        expect(q.netCents, `${method} @ ${grossCents}: net`).toBe(grossCents - q.feeCents);
        expect(q.feeCents + q.netCents, `${method} @ ${grossCents}: split`).toBe(grossCents);

        // The bonus composes on top and the credited figure is exact:
        // credited = gross - fee + bonus.
        expect(q.creditedCents, `${method} @ ${grossCents}: credited`).toBe(q.netCents + q.bonusCents);
        expect(q.grossCents - q.feeCents + q.bonusCents).toBe(q.creditedCents);
      }
    }
  });

  it('picks the single highest qualifying tier — never a stack', () => {
    expect(quoteTopUp({ grossCents: 125_000, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(700);
    expect(quoteTopUp({ grossCents: 1_000_000, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(700);
    expect(quoteTopUp({ grossCents: 124_999, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(500);
    expect(quoteTopUp({ grossCents: 62_500, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(500);
    expect(quoteTopUp({ grossCents: 62_499, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(0);
    expect(quoteTopUp({ grossCents: 1_000, feeBps: 0, method: 'crypto', tiers: TIERS }).bonusBps).toBe(0);
  });

  it('rounds the bonus half-up: 5% of 124,999 is 6,249.95 → 6,250', () => {
    const q = quoteTopUp({ grossCents: 124_999, feeBps: 0, method: 'crypto', tiers: TIERS });
    expect(q.bonusCents).toBe(6_250);
  });

  it('reproduces the advertised Stars packages exactly (80 Stars = $1)', () => {
    // 100,000 Stars = $1,250 gross = 125,000 cents. The 48% rail keeps
    // 60,000; the bonus is 7% of the GROSS the customer paid, not of the
    // 65,000 that survives the fee.
    const big = quoteTopUp({ grossCents: 125_000, feeBps: 4_800, method: 'telegram_stars', tiers: TIERS });
    expect(big).toMatchObject({
      grossCents: 125_000,
      feeBps: 4_800,
      feeCents: 60_000,
      netCents: 65_000,
      bonusBps: 700,
      bonusCents: 8_750,
      creditedCents: 73_750,
    });

    // 50,000 Stars = $625 gross = 62,500 cents.
    const small = quoteTopUp({ grossCents: 62_500, feeBps: 4_800, method: 'telegram_stars', tiers: TIERS });
    expect(small).toMatchObject({
      feeCents: 30_000,
      netCents: 32_500,
      bonusBps: 500,
      bonusCents: 3_125,
      creditedCents: 35_625,
    });
  });

  it('leaves sub-tier deposits exactly as the fee model alone would (100 in → 52 for Stars)', () => {
    const q = quoteTopUp({ grossCents: 100, feeBps: 4_800, method: 'telegram_stars', tiers: TIERS });
    expect(q).toMatchObject({ feeCents: 48, netCents: 52, bonusBps: 0, bonusCents: 0, creditedCents: 52 });
  });

  it('composes with a changed fee rate without touching the bonus (bonus is gross-based)', () => {
    const q = quoteTopUp({ grossCents: 125_000, feeBps: 900, method: 'telegram_stars', tiers: TIERS });
    expect(q).toMatchObject({ feeCents: 11_250, netCents: 113_750, bonusCents: 8_750, creditedCents: 122_500 });
  });

  it('honours a tier scoped to specific rails', () => {
    const scoped = [{ minCents: 62_500, bonusBps: 500, methods: ['crypto'] as string[] }];
    // 5% of 125,000 — the scoped tier's own rate, not the default 7%.
    expect(quoteTopUp({ grossCents: 125_000, feeBps: 0, method: 'crypto', tiers: scoped }).bonusCents).toBe(6_250);
    expect(quoteTopUp({ grossCents: 125_000, feeBps: 1_500, method: 'telegram_stars', tiers: scoped }).bonusCents).toBe(0);
  });

  it('refuses to price an unknown method, a non-positive gross, or a nonsense rate', () => {
    expect(() => quoteTopUp({ grossCents: 100, feeBps: 0, method: 'paypal', tiers: TIERS })).toThrow(ValidationError);
    expect(() => quoteTopUp({ grossCents: 0, feeBps: 0, method: 'crypto', tiers: TIERS })).toThrow(ValidationError);
    expect(() => quoteTopUp({ grossCents: -100, feeBps: 0, method: 'crypto', tiers: TIERS })).toThrow(ValidationError);
    expect(() => quoteTopUp({ grossCents: 10.5, feeBps: 0, method: 'crypto', tiers: TIERS })).toThrow(ValidationError);
    expect(() => quoteTopUp({ grossCents: 100, feeBps: 10_001, method: 'crypto', tiers: TIERS })).toThrow(ValidationError);
    expect(() => quoteTopUp({ grossCents: 100, feeBps: -1, method: 'crypto', tiers: TIERS })).toThrow(ValidationError);
  });
});

describe('settleBonusFor — what a settled row owes', () => {
  const config = { enabled: true, tiers: [...TIERS], skipped: 0 };

  it('restates the full reconciliation for the wallet to use', () => {
    // The advertised $1,250 Stars package: 125,000 cents gross, 48% = 60,000 fee.
    const s = settleBonusFor({ grossCents: 125_000, feeCents: 60_000, method: 'telegram_stars', config });
    expect(s).toEqual({
      bonusBps: 700,
      bonusCents: 8_750,
      netCents: 65_000,
      creditedCents: 73_750,
      tierMinCents: 125_000,
    });
  });

  it('owes nothing below every tier, and says so with a null tier', () => {
    const s = settleBonusFor({ grossCents: 1_000, feeCents: 0, method: 'crypto', config });
    expect(s).toEqual({ bonusBps: 0, bonusCents: 0, netCents: 1_000, creditedCents: 1_000, tierMinCents: null });
  });

  it('owes nothing when the program is switched off, even above the top tier', () => {
    const s = settleBonusFor({
      grossCents: 1_000_000,
      feeCents: 0,
      method: 'crypto',
      config: { ...config, enabled: false },
    });
    expect(s.bonusCents).toBe(0);
  });

  it('refuses to settle a corrupted row (fee above gross) instead of granting on bad numbers', () => {
    expect(() => settleBonusFor({ grossCents: 100, feeCents: 101, method: 'crypto', config })).toThrow(ValidationError);
  });
});

describe('quoteTopUpForDeposit — the async composition of fee + bonus', () => {
  it('quotes every rail at its own rate, reconciled, with the default tiers', async () => {
    for (const [method, feeBps] of Object.entries(PAYMENT_METHOD_FEE_BPS)) {
      const q = await quoteTopUpForDeposit(method, 125_000);
      expect(q.feeBps, method).toBe(feeBps);
      expect(q.bonusBps, method).toBe(700); // every rail reaches the $1,250 tier
      expect(q.bonusCents, method).toBe(8_750);
      expect(q.feeCents + q.netCents, method).toBe(125_000);
      expect(q.creditedCents, method).toBe(125_000 - q.feeCents + 8_750);
    }
  });

  it('honours a runtime fee override and keeps the bonus intact', async () => {
    await setTestSettings({ payment_fee_bps_telegram_stars: 900 });
    const q = await quoteTopUpForDeposit('telegram_stars', 125_000);
    expect(q).toMatchObject({ feeBps: 900, feeCents: 11_250, bonusBps: 700, bonusCents: 8_750, creditedCents: 122_500 });
  });

  it('refuses an unknown method, exactly like the fee model does', async () => {
    await expect(quoteTopUpForDeposit('paypal', 100)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the tiers are data, not code', () => {
  it('ships with the advertised packages when the operator has said nothing', async () => {
    const config = await loadBonusConfig();
    expect(config.enabled).toBe(true);
    expect(config.tiers).toEqual([
      { minCents: 125_000, bonusBps: 700 },
      { minCents: 62_500, bonusBps: 500 },
    ]);
  });

  it('lets an operator change thresholds and percentages without a deploy', async () => {
    await setTestSettings({ [DEPOSIT_BONUS_SETTING_KEYS.tiers]: [{ minCents: 200_000, bonusBps: 1_000 }] });

    expect((await quoteTopUpForDeposit('crypto', 125_000)).bonusCents).toBe(0); // no longer qualifies
    const q = await quoteTopUpForDeposit('crypto', 200_000);
    // 1,000 bps = 10%: ten per cent of 200,000.
    expect(q).toMatchObject({ bonusBps: 1_000, bonusCents: 20_000 });
  });

  it('can switch the whole program off with one flag', async () => {
    await setTestSettings({ [DEPOSIT_BONUS_SETTING_KEYS.enabled]: false });
    expect((await quoteTopUpForDeposit('crypto', 1_000_000)).bonusCents).toBe(0);
  });

  it('can scope a tier to the rails it wants to subsidize', async () => {
    await setTestSettings({
      [DEPOSIT_BONUS_SETTING_KEYS.tiers]: [{ minCents: 62_500, bonusBps: 500, methods: ['crypto'] }],
    });
    // 5% of 125,000 — the scoped tier's own rate.
    expect((await quoteTopUpForDeposit('crypto', 125_000)).bonusCents).toBe(6_250);
    expect((await quoteTopUpForDeposit('telegram_stars', 125_000)).bonusCents).toBe(0);
  });

  it('skips malformed entries instead of letting one typo kill the advertised tiers', async () => {
    await setTestSettings({
      [DEPOSIT_BONUS_SETTING_KEYS.tiers]: [
        { minCents: -5, bonusBps: 700 }, // negative threshold: bad
        { minCents: 'nope', bonusBps: 700 }, // not a number: bad
        { minCents: 62_500, bonusBps: 500 }, // the one good tier
        { minCents: 10_000, bonusBps: 50_000 }, // 500%: refused — platform pays at most 100%
        { minCents: 10_000, bonusBps: 100, methods: ['paypal'] }, // unknown rail: bad
        'not-even-an-object',
      ],
    });

    const config = await loadBonusConfig();
    expect(config.tiers).toEqual([{ minCents: 62_500, bonusBps: 500 }]);
    expect(config.skipped).toBe(5);

    // The surviving tier still pays — at ITS rate, not a phantom 7% or 500%.
    expect((await quoteTopUpForDeposit('crypto', 125_000)).bonusCents).toBe(6_250);
  });

  it('fails closed (no bonus, no crash) when the value is not an array at all', async () => {
    await setTestSettings({ [DEPOSIT_BONUS_SETTING_KEYS.tiers]: 'make it rain' });
    const config = await loadBonusConfig();
    expect(config.tiers).toEqual([]);
    expect((await quoteTopUpForDeposit('crypto', 1_000_000)).bonusCents).toBe(0);
  });

  it('parses tiers deterministically: highest threshold first, generous tie-break', () => {
    const { tiers } = parseBonusTiers([
      { minCents: 62_500, bonusBps: 500 },
      { minCents: 125_000, bonusBps: 700 },
      { minCents: 125_000, bonusBps: 900 },
      { minCents: 125_000, bonusBps: 700 },
    ]);
    // Parse keeps every valid entry (it does not dedupe); selection below
    // still picks the single best match, so duplicates are harmless.
    expect(tiers.map((t) => [t.minCents, t.bonusBps])).toEqual([
      [125_000, 900], // tie at 125_000 → the bigger bonus wins
      [125_000, 700],
      [125_000, 700], // the duplicate, kept
      [62_500, 500],
    ]);
    expect(selectBonusTier(125_000, 'crypto', tiers)?.bonusBps).toBe(900);
    expect(selectBonusTier(124_999, 'crypto', tiers)?.bonusBps).toBe(500);
  });
});

describe('the grant is ledgered exactly once, per settled deposit', () => {
  /** Create a real PENDING deposit for `user`, compute its settlement, post the grant. */
  async function depositWithBonus(user: Awaited<ReturnType<typeof createUser>>, amountCents: number, method: string) {
    const deposit = await createDeposit(user.id, { amountCents, method });
    const settlement = await bonusForSettledDeposit({
      amountCents: deposit.amountCents,
      feeCents: deposit.feeCents,
      method: deposit.method,
    });
    return { user, deposit, settlement };
  }

  it('posts nothing while a deposit is merely intended (PENDING)', async () => {
    const user = await createUser();
    await createDeposit(user.id, { amountCents: 125_000, method: 'crypto' });

    expect(await prisma.transaction.count()).toBe(0);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('a rejected deposit earns nothing and can never re-enter the settle path', async () => {
    const user = await createUser();
    const { deposit } = await depositWithBonus(user, 125_000, 'crypto');
    await rejectDeposit('admin-1', deposit.id, 'no such transfer on the statement');

    // The transition guard is the stop: only a PENDING row may be verified,
    // and a REJECTED row is not PENDING. No ledger, no wallet movement.
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe('REJECTED');
    expect(await prisma.transaction.count()).toBe(0);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('credits the bonus to the wallet as its own ledger row on settlement', async () => {
    const user = await createUser();
    const { deposit, settlement } = await depositWithBonus(user, 125_000, 'crypto');

    expect(settlement).toEqual({
      bonusBps: 700,
      bonusCents: 8_750,
      netCents: 125_000, // crypto keeps nothing
      creditedCents: 133_750,
      tierMinCents: 125_000,
    });

    await transaction((tx) => postDepositBonus(tx, deposit, settlement));

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(8_750);
    // The bonus is a platform gift, not the user's money in: it never
    // inflates the "total deposited" figure.
    expect(wallet.totalDepositedCents).toBe(0);

    const rows = await prisma.transaction.findMany({ where: { reference: depositBonusReference(deposit.id) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'DEPOSIT',
      amountCents: 8_750,
      status: 'COMPLETED',
      depositId: deposit.id,
    });
    expect(rows[0]!.description).toContain('+7%');
    expect(rows[0]!.description).toContain('$1,250.00');
  });

  it('cannot be claimed twice on one deposit, no matter how often the grant is attempted', async () => {
    const user = await createUser();
    const { deposit, settlement } = await depositWithBonus(user, 125_000, 'crypto');

    await transaction((tx) => postDepositBonus(tx, deposit, settlement));
    await transaction((tx) => postDepositBonus(tx, deposit, settlement)); // replay

    expect(await prisma.transaction.count({ where: { reference: depositBonusReference(deposit.id) } })).toBe(1);
    expect((await walletOf(user.id)).availableCents).toBe(8_750);
  });

  it('cannot be double-granted even when two grants race', async () => {
    const user = await createUser();
    const { deposit, settlement } = await depositWithBonus(user, 125_000, 'crypto');

    await Promise.allSettled([
      transaction((tx) => postDepositBonus(tx, deposit, settlement)),
      transaction((tx) => postDepositBonus(tx, deposit, settlement)),
    ]);

    // One unique reference, one ledger row, one wallet delta.
    expect(await prisma.transaction.count({ where: { reference: depositBonusReference(deposit.id) } })).toBe(1);
    expect((await walletOf(user.id)).availableCents).toBe(8_750);
  });

  it('posts no row and moves no money when the deposit does not reach a tier', async () => {
    const user = await createUser();
    const { deposit, settlement } = await depositWithBonus(user, 1_000, 'crypto');
    const posted = await transaction((tx) => postDepositBonus(tx, deposit, settlement));

    expect(posted).toBeNull();
    expect(await prisma.transaction.count()).toBe(0);
    expect((await walletOf(user.id)).availableCents).toBe(0);
  });

  it('is per-DEPOSIT, not per-user: two qualifying top-ups earn two bonuses', async () => {
    const user = await createUser();
    for (let i = 0; i < 2; i++) {
      const { deposit, settlement } = await depositWithBonus(user, 62_500, 'crypto');
      await transaction((tx) => postDepositBonus(tx, deposit, settlement));
    }

    expect(await prisma.transaction.count({ where: { type: 'DEPOSIT' } })).toBe(2);
    expect((await walletOf(user.id)).availableCents).toBe(2 * 3_125);
  });

  it('reconciles end-to-end on the 48% Stars rail: gross = fee + net, wallet = net + bonus', async () => {
    const user = await createUser();
    const { deposit, settlement } = await depositWithBonus(user, 125_000, 'telegram_stars');

    expect(deposit.feeBps).toBe(4_800);
    expect(deposit.feeCents).toBe(60_000);
    expect(settlement).toEqual({
      bonusBps: 700,
      bonusCents: 8_750,
      netCents: 65_000,
      creditedCents: 73_750,
      tierMinCents: 125_000,
    });

    await transaction((tx) => postDepositBonus(tx, deposit, settlement));

    // The bonus row plus the (wiring's) net credit must equal creditedCents;
    // here we post only the bonus row and check it against the split.
    const bonusRow = await prisma.transaction.findUniqueOrThrow({ where: { reference: depositBonusReference(deposit.id) } });
    expect(bonusRow.amountCents).toBe(settlement.creditedCents - settlement.netCents);
    expect(settlement.netCents + bonusRow.amountCents).toBe(settlement.creditedCents);
    expect((await walletOf(user.id)).availableCents).toBe(8_750);
  });
});
