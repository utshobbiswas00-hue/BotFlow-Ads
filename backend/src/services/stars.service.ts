import { isPaymentMethod } from '@botflow/shared';
import type { Deposit } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { SETTING_KEYS } from '../config/constants';
import { BOT_TOKEN_CONFIGURED } from '../bot/bot';
import { getNumberSetting } from './settings.service';
import { feeBpsFor, quoteDeposit } from './paymentFee.service';
import { createDeposit, verifyDeposit } from './deposit.service';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * Telegram Stars (XTR) deposits.
 *
 * ── THE ONE DESIGN DECISION ────────────────────────────────────────────────
 * Stars arrive as whole Stars; our ledger, wallet, escrow and platform-fee
 * arithmetic are ALL in USD cents. So a Stars deposit is CONVERTED to cents at
 * the moment the invoice is created, and `Deposit.amountCents` holds cents like
 * every other rail. Storing Stars in `amountCents` would corrupt every
 * downstream calculation — the balance would suddenly be 80x what a campaign
 * budget could spend.
 *
 * The original Star count is kept separately on `starsAmount`, because
 * Telegram's statement and any refund are denominated in Stars and reconciling
 * the two needs the figure that was actually charged.
 *
 * ── WHY THE RATE IS A SETTING ──────────────────────────────────────────────
 * Telegram sets the Stars-to-USD price, not us, and it can change. A hardcoded
 * rate would quietly mis-value every deposit after a reprice, so it lives in
 * `stars_per_usd` (default 80, taken from the platform's own top-up pricing).
 *
 * ── NO BOTFATHER SETUP IS NEEDED ──────────────────────────────────────────
 * For digital goods, `provider_token` is deliberately empty and `currency` is
 * XTR. BotFather's Bot Settings -> Payments is for physical goods and fiat
 * providers only; there is no Stars toggle to enable.
 */

/** Telegram requires the payload to survive a round trip; our ids are cuids. */
const MAX_PAYLOAD_LENGTH = 128;

/** Telegram refuses a sub-1-Star price, so a Star count is whole and at least 1. */
const MIN_STARS = 1;

/**
 * The smallest Stars deposit the platform sells, stated as the credit that has
 * to reach the wallet rather than as a Star count.
 *
 * Telegram keeps 48% before anything is credited, so the Stars a minimum
 * deposit costs follow from the rate. Flooring the CREDIT (not the Star count)
 * means a rate change cannot quietly make a "minimum" deposit worth less: at
 * the default 80 Stars/USD it lands on 3078 Stars — gross 3847, Telegram's
 * 1847, and 2000 into the advertiser's balance.
 */
const MIN_STARS_CREDIT_CENTS = 2000;

/**
 * `Stars` is an integer by definition — a fractional Star is not a thing, and
 * accepting one would mean the two sides disagree about what was charged.
 */
function assertWholeStars(stars: number): void {
  if (!Number.isInteger(stars) || stars < MIN_STARS) {
    throw new ValidationError(`Stars must be a whole number of at least ${MIN_STARS}.`);
  }
}

/** How many Stars equal one USD. Telegram's price, overridable at runtime. */
export async function starsPerUsd(): Promise<number> {
  const rate = await getNumberSetting(SETTING_KEYS.STARS_PER_USD, 80);
  // A zero or negative rate would divide by zero or invert the conversion, so a
  // bad override is refused rather than trusted.
  if (!Number.isFinite(rate) || rate <= 0) {
    logger.error({ rate }, 'stars_per_usd is misconfigured; falling back to 80');
    return 80;
  }
  return rate;
}

export interface StarsQuote {
  stars: number;
  /** What the Stars are worth, in cents. */
  grossCents: number;
  feeBps: number;
  /** Telegram's 48%, in cents — kept by the platform. */
  feeCents: number;
  /** What actually reaches the advertiser's wallet. */
  creditedCents: number;
}

/** The conversion, with no fee applied. Split out so the minimum can be derived. */
function grossCentsFor(stars: number, rate: number): number {
  return Math.floor((stars * 100) / rate);
}

/**
 * The fewest Stars worth selling.
 *
 * Derived rather than hardcoded, because it depends on the rate: the rounding
 * has to be applied first (down on the conversion, up on the fee) before it is
 * clear what actually reaches the wallet. The credit is monotonic in `stars`,
 * so the first count that clears MIN_STARS_CREDIT_CENTS is the minimum. The
 * arithmetic is local — no settings read per iteration — and the ceiling means
 * a misconfigured rate throws instead of spinning.
 */
export async function minimumStarsForDeposit(): Promise<number> {
  const rate = await starsPerUsd();
  const feeBps = await feeBpsFor('telegram_stars');

  for (let stars = MIN_STARS; stars <= 1_000_000; stars += 1) {
    const grossCents = grossCentsFor(stars, rate);
    if (grossCents < 1) continue;
    const feeCents = Math.ceil((grossCents * feeBps) / 10_000);
    if (grossCents - feeCents >= MIN_STARS_CREDIT_CENTS) return stars;
  }

  throw new ValidationError('The Stars to USD rate is misconfigured — no deposit can be priced.');
}

/**
 * Price a Stars deposit in cents.
 *
 * The conversion rounds DOWN and the fee rounds UP, both deliberately: a
 * fraction of a cent is resolved toward the platform. Rounding the other way
 * would mean paying out more cents than the Stars were worth, on every single
 * deposit.
 */
export async function quoteStarsDeposit(stars: number): Promise<StarsQuote> {
  assertWholeStars(stars);

  const rate = await starsPerUsd();
  const grossCents = grossCentsFor(stars, rate);

  // The fee comes from the same table every other rail uses, so Telegram's 48%
  // cannot drift away from the one place it is declared.
  const fee = await quoteDeposit('telegram_stars', Math.max(grossCents, 1));
  const creditedCents = grossCents - fee.feeCents;

  // A deposit that does not clear the platform's minimum credit is refused:
  // selling it would take someone's Stars and hand back a balance too small to
  // do anything with.
  if (creditedCents < MIN_STARS_CREDIT_CENTS) {
    const minimum = await minimumStarsForDeposit();
    throw new ValidationError(
      `That is too few Stars: at ${rate} Stars per USD only ${creditedCents} would reach your balance, and the smallest deposit we sell credits ${MIN_STARS_CREDIT_CENTS}. Send at least ${minimum} Stars.`,
    );
  }

  return {
    stars,
    grossCents,
    feeBps: fee.feeBps,
    feeCents: fee.feeCents,
    creditedCents,
  };
}

/**
 * Create the PENDING deposit that an invoice will be paid against.
 *
 * The fee is frozen here (via `createDeposit`), so the rate the advertiser is
 * shown before paying is the rate they are charged — even if an operator edits
 * the rate while the invoice is open.
 */
export async function createStarsDeposit(
  userId: string,
  stars: number,
): Promise<{ deposit: Deposit; quote: StarsQuote }> {
  const quote = await quoteStarsDeposit(stars);

  const deposit = await createDeposit(userId, {
    amountCents: quote.grossCents,
    method: 'telegram_stars',
    // The payload Telegram echoes back on every later update. Using the deposit
    // id makes the reconciliation unambiguous: the callback carries the row it
    // belongs to rather than a value we have to search for.
    gatewayRef: null,
  });

  const linked = await prisma.deposit.update({
    where: { id: deposit.id },
    data: { starsAmount: stars, gatewayRef: deposit.id },
  });

  logger.info(
    { userId, depositId: linked.id, stars, grossCents: quote.grossCents, feeCents: quote.feeCents },
    'telegram stars deposit created',
  );

  return { deposit: linked, quote };
}

/**
 * Send the XTR invoice for a deposit.
 *
 * Imported dynamically so this module has no static dependency on the bot:
 * `bot.ts` imports the handlers, the handlers import this, and a static import
 * back would close that loop.
 */
export async function sendStarsInvoice(depositId: string): Promise<string> {
  if (!BOT_TOKEN_CONFIGURED) {
    throw new ValidationError(
      'The Telegram bot is not configured, so a Stars invoice cannot be sent.',
    );
  }

  const deposit = await prisma.deposit.findUnique({
    where: { id: depositId },
    include: { user: { select: { telegramId: true } } },
  });
  if (!deposit) throw new NotFoundError('Deposit');
  if (deposit.method !== 'telegram_stars' || deposit.starsAmount === null) {
    throw new ValidationError('That deposit is not a Stars deposit.');
  }
  if (deposit.status !== 'PENDING') {
    throw new ValidationError('That deposit has already been paid.');
  }

  const { bot } = await import('../bot/bot');

  const credited = deposit.amountCents - deposit.feeCents;
  await bot.api.sendInvoice(
    String(deposit.user.telegramId),
    'BotFlow Ads balance',
    // Say what lands, not just what is charged. The 48% is the single most
    // surprising thing about this rail, and the advertiser must see it before
    // paying rather than discover a smaller balance afterwards.
    `${deposit.starsAmount} Stars will become $${(credited / 100).toFixed(2)} of ad credit after Telegram's fee.`,
    deposit.id,
    'XTR',
    [{ label: 'BotFlow Ads balance', amount: deposit.starsAmount }],
    // provider_token intentionally omitted: digital goods do not use one.
    { need_name: false, need_email: false, need_phone_number: false },
  );

  return deposit.id;
}

/* ------------------------------------------------------------------
 *  Bot callbacks
 * ------------------------------------------------------------------ */

export interface PreCheckoutReview {
  ok: boolean;
  /** Shown to the buyer by Telegram when `ok` is false. Must be human-readable. */
  reason?: string;
  depositId?: string;
}

/**
 * Decide whether to approve a `pre_checkout_query`.
 *
 * Telegram cancels the order unless this is answered within 10 seconds, so the
 * work here stays to a single query. Anything unexpected is a REFUSAL: better a
 * payment that did not happen than Stars taken against a deposit we cannot
 * identify or that does not match what is being charged.
 */
export async function reviewPreCheckout(input: {
  payload: string;
  totalAmountStars: number;
}): Promise<PreCheckoutReview> {
  if (input.payload.length > MAX_PAYLOAD_LENGTH) {
    return { ok: false, reason: 'This invoice is no longer valid. Please start the top up again.' };
  }

  const deposit = await prisma.deposit.findUnique({ where: { id: input.payload } });

  if (!deposit || deposit.method !== 'telegram_stars' || deposit.starsAmount === null) {
    logger.warn({ payload: input.payload }, 'pre_checkout_query for an unknown deposit');
    return { ok: false, reason: 'We could not find this top up. Please start again.' };
  }

  if (deposit.status !== 'PENDING') {
    // Covers the double-tap: the invoice was already paid, so a second charge
    // must not be accepted.
    return { ok: false, reason: 'This top up has already been paid.' };
  }

  if (deposit.starsAmount !== input.totalAmountStars) {
    logger.error(
      { depositId: deposit.id, expected: deposit.starsAmount, got: input.totalAmountStars },
      'pre_checkout_query amount does not match the deposit',
    );
    return { ok: false, reason: 'The amount does not match this top up. Please start again.' };
  }

  return { ok: true, depositId: deposit.id };
}

export interface StarsPaymentResult {
  depositId: string;
  creditedCents: number;
  alreadyCredited: boolean;
}

/**
 * Credit a paid Stars invoice.
 *
 * Delegates the money movement to `verifyDeposit`, which is the one credit path
 * for every rail: its `PENDING -> VERIFIED` guard plus the unique ledger
 * reference `deposit:<id>` make a replayed `successful_payment` — and Telegram
 * does redeliver updates — a no-op rather than a second credit.
 *
 * `telegram_payment_charge_id` is stored because it is the ONLY handle
 * `refundStarPayment` accepts; without it a refund is impossible, and the id is
 * not recoverable later.
 */
export async function completeStarsPayment(input: {
  payload: string;
  totalAmountStars: number;
  chargeId: string;
}): Promise<StarsPaymentResult | null> {
  const deposit = await prisma.deposit.findUnique({ where: { id: input.payload } });

  if (!deposit || deposit.method !== 'telegram_stars' || deposit.starsAmount === null) {
    logger.error({ payload: input.payload }, 'successful_payment for an unknown deposit');
    return null;
  }

  // Telegram is the one that charged; a mismatch here means the invoice was
  // tampered with or we are looking at the wrong row. Refuse to credit.
  if (deposit.starsAmount !== input.totalAmountStars) {
    logger.error(
      { depositId: deposit.id, expected: deposit.starsAmount, got: input.totalAmountStars },
      'successful_payment amount does not match the deposit — refusing to credit',
    );
    return null;
  }

  const alreadyCredited = deposit.status !== 'PENDING';

  const verified = await verifyDeposit(
    'telegram-stars',
    deposit.id,
    `Paid with ${input.totalAmountStars} Telegram Stars`,
    {
      gatewayTxnId: input.chargeId,
      rawPayload: {
        source: 'telegram_stars',
        stars: input.totalAmountStars,
        telegramPaymentChargeId: input.chargeId,
      },
    },
  );

  // Re-read rather than trusting the stored feeBps arithmetic here: the ledger
  // is authoritative and this only reports what it did.
  const creditedCents = verified.amountCents - verified.feeCents;

  logger.info(
    { depositId: verified.id, stars: input.totalAmountStars, creditedCents, alreadyCredited },
    alreadyCredited ? 'stars payment replayed — no second credit' : 'stars payment credited',
  );

  return { depositId: verified.id, creditedCents, alreadyCredited };
}

/** True when `method` is a rail this module handles. Used by the route guard. */
export function isStarsMethod(method: string): boolean {
  return isPaymentMethod(method) && method === 'telegram_stars';
}
