import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';

// The withdrawal flow notifies the user and audits the admin action, both of
// which enqueue BullMQ jobs. Redis is not part of these guarantees, so the
// producers are stubbed rather than stood up.
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const {
  createWithdrawal,
  rejectWithdrawal,
  approveWithdrawal,
} = await import('../src/services/withdrawal.service');
const { resetDatabase, createUser, setTestSettings, walletOf } = await import('./helpers/fixtures');

/**
 * WITHDRAWALS — money OUT, and the flow most worth attacking.
 *
 * The design decision under test: the wallet is debited the MOMENT the request
 * is created, inside the same transaction that inserts the row. There is no
 * window in which a user can request the same money twice, and a rejection
 * refunds through a unique ledger reference so it can never pay out a refund
 * twice either.
 */

const AMOUNT = 1_000; // $10.00

// NOTE: the free monthly cap (FREE_ENTITLEMENTS.monthlyWithdrawLimitCents =
// 50,000) is comfortably above every amount asserted here, so it never binds.

async function withdrawalOptions() {
  // Generous defaults, so each test can make exactly ONE constraint bind.
  await setTestSettings({
    min_withdrawal_cents: 500,
    max_withdrawal_cents: 100_000,
    withdrawal_fee_cents: 0,
    // The rolling 24h cap is an ENTITLEMENT value, not an admin setting: the
    // free baseline lives in `premium_free_daily_withdraw_limit_cents` and a
    // plan can raise it. `daily_withdrawal_limit_cents` is no longer read.
    premium_free_daily_withdraw_limit_cents: 20_000,
    max_pending_withdrawals: 10,
    manual_review_threshold_cents: 10_000,
    allowed_withdrawal_methods: ['crypto'],
  });
}

function request(userId: string, amountCents = AMOUNT) {
  return createWithdrawal(userId, {
    amountCents,
    method: 'crypto',
    accountDetails: { address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', network: 'USDT_TRC20' },
  });
}

describe('double withdrawal', () => {
  beforeEach(async () => {
    await resetDatabase();
    await withdrawalOptions();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('debits the wallet the moment the request is made', async () => {
    const user = await createUser({ availableCents: 5_000 });

    const withdrawal = await request(user.id);

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(4_000);
    expect(wallet.totalWithdrawnCents).toBe(AMOUNT);
    expect(withdrawal.status).toBe('PENDING');
    // Never stored in the clear.
    expect(withdrawal.accountMasked).not.toContain('01700000000');

    const entry = await prisma.transaction.findUniqueOrThrow({
      where: { reference: `withdrawal:${withdrawal.id}` },
    });
    expect(entry.amountCents).toBe(-AMOUNT);
  });

  it('refuses the request when the balance will not cover it', async () => {
    const user = await createUser({ availableCents: 900 });

    await expect(request(user.id)).rejects.toThrow();

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(900);
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it('never pays out more than the balance, however many requests arrive at once', async () => {
    // $20.00 available, five simultaneous $10.00 requests: at most two may win.
    const user = await createUser({ availableCents: 2_000 });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => request(user.id)));

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(0);
    expect(wallet.totalWithdrawnCents).toBe(2_000);

    // Two withdrawal rows, two debits — and never a third.
    expect(await prisma.withdrawal.count()).toBe(2);
    expect(await prisma.transaction.count({ where: { type: 'WITHDRAWAL' } })).toBe(2);
    // No balance may be driven negative by the race.
    expect(wallet.availableCents).toBeGreaterThanOrEqual(0);
  });

  it('holds the request inside the pending cap', async () => {
    await setTestSettings({ max_pending_withdrawals: 2 });
    const user = await createUser({ availableCents: 100_000 });

    await request(user.id);
    await request(user.id);

    await expect(request(user.id)).rejects.toThrow(/pending/i);

    expect(await prisma.withdrawal.count()).toBe(2);
    expect((await walletOf(user.id)).availableCents).toBe(98_000);
  });

  it('holds the request inside the rolling 24h limit', async () => {
    await setTestSettings({ premium_free_daily_withdraw_limit_cents: 2_500 });
    const user = await createUser({ availableCents: 100_000 });

    await request(user.id, 2_000);
    await expect(request(user.id, 2_000)).rejects.toThrow(/24 hours/i);

    expect((await walletOf(user.id)).availableCents).toBe(98_000);
  });

  it('flags a large request for manual review without blocking it', async () => {
    // The 24h cap has to sit ABOVE the review threshold, or the limit check
    // would block the request before review ever gets a say.
    await setTestSettings({
      manual_review_threshold_cents: 5_000,
      premium_free_daily_withdraw_limit_cents: 100_000,
    });
    const user = await createUser({ availableCents: 100_000 });

    const withdrawal = await request(user.id, 6_000);

    expect(withdrawal.requiresReview).toBe(true);
    expect(withdrawal.status).toBe('PENDING');
  });

  it('refunds a rejected withdrawal exactly once, even if rejected twice', async () => {
    const user = await createUser({ availableCents: 5_000 });
    const withdrawal = await request(user.id);
    expect((await walletOf(user.id)).availableCents).toBe(4_000);

    await rejectWithdrawal('admin-1', withdrawal.id, 'invalid account details');

    let wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(5_000);
    expect(wallet.totalWithdrawnCents).toBe(0);

    // The row is no longer PENDING, so a repeated rejection is refused outright.
    await expect(rejectWithdrawal('admin-1', withdrawal.id, 'again')).rejects.toThrow();

    wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(5_000);
    expect(await prisma.transaction.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('refunds only once when two rejections race', async () => {
    const user = await createUser({ availableCents: 5_000 });
    const withdrawal = await request(user.id);

    const results = await Promise.allSettled([
      rejectWithdrawal('admin-1', withdrawal.id, 'duplicate attempt'),
      rejectWithdrawal('admin-2', withdrawal.id, 'duplicate attempt'),
    ]);

    // Exactly one rejection may win.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const wallet = await walletOf(user.id);
    expect(wallet.availableCents).toBe(5_000);
    expect(await prisma.transaction.count({ where: { type: 'REFUND' } })).toBe(1);
  });

  it('does not move money again when an approved withdrawal is paid', async () => {
    const user = await createUser({ availableCents: 5_000 });
    const withdrawal = await request(user.id);

    await approveWithdrawal('admin-1', withdrawal.id, 'checked');
    const wallet = await walletOf(user.id);

    // Approval is a state change only: the debit already happened at request time.
    expect(wallet.availableCents).toBe(4_000);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe('APPROVED');
  });
});
