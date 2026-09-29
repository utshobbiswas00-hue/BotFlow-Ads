import {
  PAYMENT_METHOD_FEE_BPS,
  PAYMENT_METHOD_LABELS,
  isPaymentMethod,
  type PaymentMethod,
} from '@botflow/shared';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { getNumberSetting } from './settings.service';
import { ValidationError } from '../utils/errors';

/**
 * What each payment rail costs the platform, and the arithmetic that keeps that
 * cost visible.
 *
 * ── WHO PAYS ───────────────────────────────────────────────────────────────
 * THE DEPOSITOR PAYS. The fee is deducted from what they send, and only the
 * remainder is credited:
 *
 *     100 sent  →  fee 48  →  52 credited to their wallet, 48 kept
 *
 * So `creditedCents` is the number that reaches the wallet, and it is NOT
 * `grossCents`. Every caller that credits money must use `creditedCents`;
 * crediting `grossCents` would hand the depositor the platform's cut.
 *
 * ── WHY THE RATE IS FROZEN ON THE ROW ──────────────────────────────────────
 * Rates change (Telegram's especially). `feeBps`/`feeCents` are written when the
 * deposit is created, so a rate change never rewrites a deposit that already
 * happened — and the advertiser is charged the rate they were shown.
 *
 * ── THE NUMBER WORTH STARING AT ────────────────────────────────────────────
 * Telegram Stars keeps 48%. An advertiser topping up 100 by Stars can only ever
 * spend 52 on ads, while the same 100 by crypto buys 100. That is a very strong
 * incentive for advertiser money to leave the Stars rail, which is a product
 * fact to plan around rather than a bug — `paymentFeeSummary` reports the kept
 * amount per rail so the mix is visible.
 */

/** Settings are stored as basis points: 1500 bps = 15%. */
const BPS_DENOMINATOR = 10_000;

/** Runtime override key for one method, e.g. `payment_fee_bps_card`. */
export function feeSettingKey(method: PaymentMethod): string {
  return `payment_fee_bps_${method}`;
}

/** Human label for a method, tolerant of a legacy/unknown stored value. */
export function methodLabel(method: string): string {
  return isPaymentMethod(method) ? PAYMENT_METHOD_LABELS[method] : method;
}

/**
 * The rate for a method, in basis points.
 *
 * Settings win over the code default so an operator can respond to a processor
 * price change without a deploy. An unknown method is refused rather than
 * booked at zero: a silent 0% would understate cost on every report built from
 * this row.
 */
export async function feeBpsFor(method: string): Promise<number> {
  if (!isPaymentMethod(method)) {
    throw new ValidationError(
      `Unknown payment method "${method}". Supported methods: ${Object.keys(PAYMENT_METHOD_FEE_BPS).join(', ')}.`,
    );
  }
  const fallback = PAYMENT_METHOD_FEE_BPS[method];
  const override = await getNumberSetting(feeSettingKey(method), fallback);
  if (!Number.isFinite(override) || override < 0 || override > BPS_DENOMINATOR) {
    logger.warn({ method, override, fallback }, 'ignoring an out-of-range fee override');
    return fallback;
  }
  return override;
}

export interface DepositQuote {
  method: PaymentMethod;
  /** What the depositor sends. */
  grossCents: number;
  /** Basis points deducted from it. */
  feeBps: number;
  /** What the platform keeps, in money. */
  feeCents: number;
  /** What reaches the depositor's wallet — the ONLY figure a credit may use. */
  creditedCents: number;
}

/**
 * Price a deposit on a given rail.
 *
 * Rounding is UP, and it is deliberately in the platform's favour: the fee is
 * money the depositor agreed to give up, so a half-cent is resolved toward the
 * platform rather than handed back. Rounding down would also mean the platform
 * silently subsidised every sub-unit deposit.
 *
 * The remainder is exact (`gross - fee`), so `fee + credited === gross` always
 * holds — the two halves can never drift apart.
 */
export async function quoteDeposit(method: string, grossCents: number): Promise<DepositQuote> {
  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    throw new ValidationError('Deposit amount must be a positive whole number of minor units.');
  }
  const feeBps = await feeBpsFor(method);
  const feeCents = Math.ceil((grossCents * feeBps) / BPS_DENOMINATOR);
  return {
    method: method as PaymentMethod,
    grossCents,
    feeBps,
    feeCents,
    creditedCents: grossCents - feeCents,
  };
}

/** The fee columns to persist on a new deposit row. */
export async function feeColumnsForDeposit(
  method: string,
  grossCents: number,
): Promise<{ feeBps: number; feeCents: number }> {
  const quote = await quoteDeposit(method, grossCents);
  return { feeBps: quote.feeBps, feeCents: quote.feeCents };
}

export interface MethodEconomics {
  method: string;
  label: string;
  deposits: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
  /** Effective rate actually paid across the period, in basis points. */
  effectiveBps: number;
}

export interface PaymentFeeSummary {
  from: Date;
  to: Date;
  /** Imported money only: VERIFIED deposits. A rejected deposit is not economic. */
  totals: { deposits: number; grossCents: number; feeCents: number; netCents: number; effectiveBps: number };
  byMethod: MethodEconomics[];
}

/**
 * Per-rail economics for a period — the report that answers "what are the
 * payment rails costing me, and on which one?".
 *
 * Reads only VERIFIED deposits: a PENDING one has not been reconciled and a
 * REJECTED one never brought money in, so neither belongs in a margin figure.
 */
export async function paymentFeeSummary(range: { from: Date; to: Date }): Promise<PaymentFeeSummary> {
  const rows = await prisma.deposit.findMany({
    where: { status: 'VERIFIED', createdAt: { gte: range.from, lte: range.to } },
    select: { method: true, amountCents: true, feeCents: true },
  });

  const byMethod = new Map<string, MethodEconomics>();
  for (const row of rows) {
    const current = byMethod.get(row.method) ?? {
      method: row.method,
      label: methodLabel(row.method),
      deposits: 0,
      grossCents: 0,
      feeCents: 0,
      netCents: 0,
      effectiveBps: 0,
    };
    current.deposits += 1;
    current.grossCents += row.amountCents;
    current.feeCents += row.feeCents;
    current.netCents = current.grossCents - current.feeCents;
    byMethod.set(row.method, current);
  }

  const methods = [...byMethod.values()]
    .map((m) => ({
      ...m,
      effectiveBps: m.grossCents > 0 ? Math.round((m.feeCents / m.grossCents) * BPS_DENOMINATOR) : 0,
    }))
    // Costliest rail first: the one to fix is the one at the top.
    .sort((a, b) => b.feeCents - a.feeCents);

  const grossCents = methods.reduce((sum, m) => sum + m.grossCents, 0);
  const feeCents = methods.reduce((sum, m) => sum + m.feeCents, 0);

  return {
    from: range.from,
    to: range.to,
    totals: {
      deposits: methods.reduce((sum, m) => sum + m.deposits, 0),
      grossCents,
      feeCents,
      netCents: grossCents - feeCents,
      effectiveBps: grossCents > 0 ? Math.round((feeCents / grossCents) * BPS_DENOMINATOR) : 0,
    },
    byMethod: methods,
  };
}
