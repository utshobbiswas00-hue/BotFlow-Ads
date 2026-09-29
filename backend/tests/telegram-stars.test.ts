import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ValidationError } from '../src/utils/errors';
import { ref } from '../src/services/transaction.service';

// The notification producers open a real Redis connection on import, and the
// bot module builds a grammY instance — neither is what this file tests. The
// bot is stubbed so the invoice contract can be asserted instead of the call
// being attempted.
const queue = vi.hoisted(() => ({
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookDelivery: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

const botMock = vi.hoisted(() => ({
  // Loosely typed on purpose: the assertions below index into the call to show
  // the argument POSITIONS carrying the XTR contract.
  sendInvoice: vi.fn(async (..._args: unknown[]) => ({ message_id: 1 })),
}));
vi.mock('../src/bot/bot', () => ({
  BOT_TOKEN_CONFIGURED: true,
  bot: { api: { sendInvoice: botMock.sendInvoice } },
}));

const {
  quoteStarsDeposit,
  createStarsDeposit,
  sendStarsInvoice,
  reviewPreCheckout,
  completeStarsPayment,
  starsPerUsd,
  minimumStarsForDeposit,
} = await import('../src/services/stars.service');
const { resetDatabase, createUser, walletOf, setTestSettings } = await import('./helpers/fixtures');

/**
 * TELEGRAM STARS DEPOSITS.
 *
 * Two things this file exists to protect:
 *
 * 1. THE LEDGER IS IN CENTS. Stars arrive as whole Stars, but every balance,
 *    escrow and platform-fee calculation is in USD cents, so a deposit is
 *    converted at invoice time. Storing Stars in `amountCents` would make a
 *    balance 80x what a campaign budget could spend.
 *
 * 2. THE DEPOSITOR PAYS TELEGRAM'S 48%. The smallest deposit sold is the Star
 *    count that still credits 20.00 after that cut: at the default 80
 *    Stars/USD it is 3078 Stars — gross 3847, Telegram keeps 1847, and 2000
 *    reaches the wallet.
 */

const WIDE_RATE = 80; // Stars per USD

/** The smallest deposit sold at WIDE_RATE, and the money it moves. */
const MINIMUM = 3_078;
const MINIMUM_GROSS = 3_847;
const MINIMUM_FEE = 1_847;
const MINIMUM_CREDIT = 2_000;

/** The fixture has no Telegram id, so it is stamped on afterwards. */
async function userWithTelegramId(telegramId: string) {
  const user = await createUser();
  return prisma.user.update({ where: { id: user.id }, data: { telegramId: BigInt(telegramId) } });
}

beforeEach(async () => {
  await resetDatabase();
  botMock.sendInvoice.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('converting Stars to cents', () => {
  it('uses the configured rate and applies the 48% before crediting', async () => {
    expect(await starsPerUsd()).toBe(WIDE_RATE);

    const quote = await quoteStarsDeposit(MINIMUM);

    // 3078 Stars / 80 = $38.475 = 3847 cents, floored.
    expect(quote.grossCents).toBe(MINIMUM_GROSS);
    expect(quote.feeBps).toBe(4800);
    expect(quote.feeCents).toBe(MINIMUM_FEE);
    expect(quote.creditedCents).toBe(MINIMUM_CREDIT);
  });

  it('keeps the two halves exact, so they can never drift', async () => {
    for (const stars of [MINIMUM, 25_000, 100_000]) {
      const quote = await quoteStarsDeposit(stars);
      expect(quote.feeCents + quote.creditedCents).toBe(quote.grossCents);
    }
  });

  it('honours a rate change without a deploy, because Telegram reprices', async () => {
    // At 100 Stars/USD the same 20.00 floor needs 3847 Stars.
    await setTestSettings({ stars_per_usd: 100 });

    const quote = await quoteStarsDeposit(3_847);
    expect(quote.grossCents).toBe(3_847);
    expect(quote.feeCents).toBe(MINIMUM_FEE);
    expect(quote.creditedCents).toBe(MINIMUM_CREDIT);
  });

  it('falls back to 80 rather than trusting a rate that would break the maths', async () => {
    await setTestSettings({ stars_per_usd: 0 });
    expect(await starsPerUsd()).toBe(80);

    await setTestSettings({ stars_per_usd: -5 });
    expect(await starsPerUsd()).toBe(80);
  });

  it('refuses a fractional or zero Star count — a part-Star is not a thing', async () => {
    await expect(quoteStarsDeposit(10.5)).rejects.toBeInstanceOf(ValidationError);
    await expect(quoteStarsDeposit(0)).rejects.toBeInstanceOf(ValidationError);
    await expect(quoteStarsDeposit(-3)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses an amount whose credit would not clear the platform minimum', async () => {
    // 100 Stars is real money — 125 cents gross, 65 net — but it is still below
    // the smallest deposit the platform sells, so it is refused rather than
    // credited with an amount too small to spend.
    await expect(quoteStarsDeposit(100)).rejects.toBeInstanceOf(ValidationError);

    const minimum = await minimumStarsForDeposit();
    expect(minimum).toBe(MINIMUM);
    await expect(quoteStarsDeposit(minimum)).resolves.toMatchObject({
      stars: minimum,
      grossCents: MINIMUM_GROSS,
      feeCents: MINIMUM_FEE,
      creditedCents: MINIMUM_CREDIT,
    });
  });

  it('refuses a below-minimum deposit and stores nothing', async () => {
    const user = await createUser();
    await expect(createStarsDeposit(user.id, 100)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.deposit.count()).toBe(0);
  });
});

describe('creating the deposit the invoice will be paid against', () => {
  it('freezes the rate, the fee and the Star count on the row', async () => {
    const user = await createUser();

    const { deposit, quote } = await createStarsDeposit(user.id, MINIMUM);

    expect(deposit.method).toBe('telegram_stars');
    expect(deposit.status).toBe('PENDING');
    expect(deposit.amountCents).toBe(MINIMUM_GROSS);
    expect(deposit.feeBps).toBe(4800);
    expect(deposit.feeCents).toBe(MINIMUM_FEE);
    expect(deposit.starsAmount).toBe(MINIMUM);
    expect(deposit.currency).toBe('USD');
    expect(quote.creditedCents).toBe(MINIMUM_CREDIT);
    // The payload Telegram will echo back is the deposit's own id.
    expect(deposit.gatewayRef).toBe(deposit.id);
  });

  it('does not let a later rate change rewrite an open invoice', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    await setTestSettings({ stars_per_usd: 200 });

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.amountCents).toBe(MINIMUM_GROSS);
    expect(stored.feeCents).toBe(MINIMUM_FEE);
  });
});

describe('the invoice sent to Telegram', () => {
  it('is an XTR invoice for the exact Star count, with no provider token', async () => {
    const user = await userWithTelegramId('900000001');
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    await sendStarsInvoice(deposit.id);

    expect(botMock.sendInvoice).toHaveBeenCalledTimes(1);
    const call = botMock.sendInvoice.mock.calls[0] as unknown[];
    const chatId = call[0];
    const description = call[2];
    const payload = call[3];
    const currency = call[4];
    const prices = call[5];
    const options = call[6] as Record<string, unknown>;

    expect(String(chatId)).toBe('900000001');
    expect(currency).toBe('XTR');
    expect(payload).toBe(deposit.id);
    expect(prices).toEqual([{ label: 'BotFlow Ads balance', amount: MINIMUM }]);
    // The advertiser must see the actual credit before paying, not discover a
    // smaller balance afterwards. At 80 Stars/USD, 3078 Stars becomes $20.00.
    expect(String(description)).toContain('20.00');
    expect(String(description)).toContain(`${MINIMUM} Stars`);
    // Digital goods take no provider token; passing one would break Stars.
    expect(options).not.toHaveProperty('provider_token');
  });

  it('refuses to invoice a deposit that is not a Stars deposit', async () => {
    const user = await userWithTelegramId('900000002');
    const { createDeposit } = await import('../src/services/deposit.service');
    const crypto = await createDeposit(user.id, { amountCents: 5_000, method: 'crypto' });

    await expect(sendStarsInvoice(crypto.id)).rejects.toBeInstanceOf(ValidationError);
    expect(botMock.sendInvoice).not.toHaveBeenCalled();
  });
});

describe('pre-checkout review', () => {
  it('approves a matching pending invoice', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    const review = await reviewPreCheckout({ payload: deposit.id, totalAmountStars: MINIMUM });

    expect(review.ok).toBe(true);
    expect(review.depositId).toBe(deposit.id);
  });

  it('refuses a payload that is not one of our deposits', async () => {
    const review = await reviewPreCheckout({ payload: 'not-a-deposit-id', totalAmountStars: MINIMUM });

    expect(review.ok).toBe(false);
    expect(review.reason).toBeTruthy();
  });

  it('refuses when the amount differs from the deposit', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    const review = await reviewPreCheckout({ payload: deposit.id, totalAmountStars: 5_000 });

    expect(review.ok).toBe(false);
  });

  it('refuses a second attempt on an invoice that was already paid', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);
    await completeStarsPayment({ payload: deposit.id, totalAmountStars: MINIMUM, chargeId: 'ch_1' });

    const review = await reviewPreCheckout({ payload: deposit.id, totalAmountStars: MINIMUM });

    expect(review.ok).toBe(false);
  });
});

describe('crediting a paid invoice', () => {
  it('credits the net amount and stores the charge id a refund needs', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    const result = await completeStarsPayment({
      payload: deposit.id,
      totalAmountStars: MINIMUM,
      chargeId: 'charge-refund-handle',
    });

    expect(result).not.toBeNull();
    expect(result!.creditedCents).toBe(MINIMUM_CREDIT);
    expect(result!.alreadyCredited).toBe(false);

    // 2000 cents, not 3847 — Telegram's 48% never reaches the wallet.
    expect((await walletOf(user.id)).availableCents).toBe(MINIMUM_CREDIT);

    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.status).toBe('VERIFIED');
    expect(stored.gatewayTxnId).toBe('charge-refund-handle');
  });

  it('does NOT credit twice when Telegram redelivers the update', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    await completeStarsPayment({ payload: deposit.id, totalAmountStars: MINIMUM, chargeId: 'ch_1' });
    const replay = await completeStarsPayment({
      payload: deposit.id,
      totalAmountStars: MINIMUM,
      chargeId: 'ch_1',
    });

    expect(replay!.alreadyCredited).toBe(true);
    expect((await walletOf(user.id)).availableCents).toBe(MINIMUM_CREDIT);
    expect(await prisma.transaction.count({ where: { reference: ref.deposit(deposit.id) } })).toBe(1);
    expect(await prisma.transaction.count({ where: { type: 'DEPOSIT' } })).toBe(1);
  });

  it('refuses to credit when the Stars charged do not match the deposit', async () => {
    const user = await createUser();
    const { deposit } = await createStarsDeposit(user.id, MINIMUM);

    const result = await completeStarsPayment({
      payload: deposit.id,
      totalAmountStars: 999,
      chargeId: 'ch_bad',
    });

    expect(result).toBeNull();
    expect((await walletOf(user.id)).availableCents).toBe(0);
    const stored = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(stored.status).toBe('PENDING');
  });

  it('returns null for an unknown payload instead of inventing a credit', async () => {
    const result = await completeStarsPayment({
      payload: 'not-a-deposit',
      totalAmountStars: MINIMUM,
      chargeId: 'ch_x',
    });

    expect(result).toBeNull();
    expect(await prisma.deposit.count()).toBe(0);
  });
});
