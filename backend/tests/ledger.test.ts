import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, transaction } from '../src/db/prisma';
import { postLedger } from '../src/services/transaction.service';
import { createUser, resetDatabase, walletOf } from './helpers/fixtures';

/**
 * The ledger is the only code path allowed to move money, so its guarantees
 * are the foundation everything else stands on:
 *
 *   - a reference is UNIQUE, therefore a replayed call cannot double-credit
 *   - balances move with SQL arithmetic, therefore concurrent calls cannot
 *     lose an update
 *   - every row records both balances, therefore a single entry is auditable
 *     on its own
 */

describe('ledger (transaction.service)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('credits the wallet and writes a self-contained ledger row', async () => {
    const user = await createUser();

    await transaction((tx) =>
      postLedger(tx, {
        userId: user.id,
        type: 'DEPOSIT',
        amountCents: 5_000,
        reference: 'deposit:test-1',
        referenceType: 'DEPOSIT',
        walletDelta: { available: 5_000, totalDeposited: 5_000 },
        description: 'Test deposit',
      }),
    );

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(5_000);
    expect(wallet.totalDepositedCents).toBe(5_000);

    const entry = await prisma.transaction.findUniqueOrThrow({
      where: { reference: 'deposit:test-1' },
    });
    expect(entry.amountCents).toBe(5_000);
    expect(entry.status).toBe('COMPLETED');
    // Both sides of the movement are captured, so the row can be audited alone.
    expect(entry.balanceBefore).toBe(0);
    expect(entry.balanceAfter).toBe(5_000);
  });

  it('does not double-credit when the same reference is posted again', async () => {
    const user = await createUser();

    const post = () =>
      transaction((tx) =>
        postLedger(tx, {
          userId: user.id,
          type: 'DEPOSIT',
          amountCents: 2_500,
          reference: 'deposit:replayed',
          walletDelta: { available: 2_500 },
        }),
      );

    await post();
    const second = await post();

    expect(second.replayed).toBe(true);

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(2_500);
    expect(await prisma.transaction.count({ where: { reference: 'deposit:replayed' } })).toBe(1);
  });

  it('credits exactly once when several identical payments arrive at the same moment', async () => {
    const user = await createUser();

    // Five concurrent webhook deliveries for one payment. All five must not
    // succeed: the unique reference makes the losers roll back, and with them
    // the wallet increment they were about to apply.
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        transaction((tx) =>
          postLedger(tx, {
            userId: user.id,
            type: 'DEPOSIT',
            amountCents: 10_000,
            reference: 'deposit:concurrent',
            walletDelta: { available: 10_000 },
          }),
        ),
      ),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(10_000);
    expect(await prisma.transaction.count({ where: { reference: 'deposit:concurrent' } })).toBe(1);
  });

  it('never loses an update when many different credits land together', async () => {
    const user = await createUser();
    const amounts = [100, 250, 999, 4_321, 777, 50, 12_000];
    const expected = amounts.reduce((a, b) => a + b, 0);

    await Promise.all(
      amounts.map((amount, i) =>
        transaction((tx) =>
          postLedger(tx, {
            userId: user.id,
            type: 'REFERRAL_REWARD',
            amountCents: amount,
            reference: `referral:concurrent-${i}`,
            walletDelta: { available: amount },
          }),
        ),
      ),
    );

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(expected);
    expect(await prisma.transaction.count()).toBe(amounts.length);
  });

  it('runs every wallet delta in one statement, so totals cannot drift apart', async () => {
    const user = await createUser();

    await transaction((tx) =>
      postLedger(tx, {
        userId: user.id,
        type: 'ESCROW_HOLD',
        amountCents: -3_000,
        reference: 'escrow:hold:mixed',
        walletDelta: {
          available: -3_000,
          reserved: 3_000,
        },
      }),
    );

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(-3_000);
    expect(wallet.reservedCents).toBe(3_000);
    // Exactly one version bump for one logical movement.
    expect(wallet.version).toBe(1);
  });
});
