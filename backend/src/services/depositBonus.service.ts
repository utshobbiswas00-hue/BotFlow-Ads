/**
 * TOP-UP VOLUME BONUS.
 *
 * The top-up screen advertises volume bonuses on the Stars packages —
 * "1250 USD / 100000 stars — Bonus +7%" and "625 USD / 50000 stars — Bonus
 * +5%" — and the bonus applies to ANY rail at those sizes, not only Stars.
 * This service makes the promise real: it prices the bonus, and it is the ONLY
 * code path that may grant one.
 *
 * ── DECISION 1: THE BONUS IS A PERCENTAGE OF GROSS, NOT OF THE NET ─────────
 * The promise is worded in what the CUSTOMER PAYS ("1250 USD … Bonus +7%"),
 * and gross is exactly that. On the 48% Stars rail a $1,250 gross nets only
 * $650; computing +7% on the net would pay $45.50 where $87.50 was advertised —
 * leaving the false promise alive on the very rail it is sold on. Gross is
 * also the only figure frozen on the deposit row at creation time, so the
 * bonus is a function of settled facts and is immune to later fee-rate
 * changes (same argument the fee model uses for `feeBps`/`feeCents`).
 *
 * The fee and the bonus COMPOSE, they do not fight:
 *
 *     fee    = ceil(gross × feeBps / 10000)      the DEPOSITOR pays (existing)
 *     bonus  = round(gross × bonusBps / 10000)   the PLATFORM pays (new)
 *     net    = gross − fee                       exact subtraction
 *     credited = net + bonus                     exact addition
 *
 *     ⟹  fee + net = gross  and  credited + fee − bonus = gross, ALWAYS,
 *        for every rail — including the 48% one. All four are integers;
 *        nothing fractional is ever stored or credited.
 *
 * Rounding is deliberately asymmetric and follows the codebase conventions:
 * the fee rounds UP (a half-cent of money the depositor agreed to give up is
 * resolved toward the platform — `paymentFee.service.quoteDeposit`), while
 * the bonus rounds HALF-UP (the `percentOf` convention for platform-paid
 * money: the platform never hands out a fraction of a cent, and a half-cent
 * in the customer's favour is the honest reading of "+7%").
 *
 * ── DECISION 2: GRANTED ONLY ON A SETTLED (VERIFIED) DEPOSIT ───────────────
 * Nothing here runs at intent time. `createDeposit` knows nothing about
 * bonuses; a PENDING or REJECTED deposit can never earn one. The bonus is
 * computed and ledgered inside `verifyDeposit`'s PENDING → VERIFIED
 * transition, in the SAME database transaction as the credit, via
 * `settleBonusFor` + `postDepositBonus` (see the wiring note at the bottom).
 *
 * One consequence, stated plainly: the tier table is read at SETTLEMENT time,
 * not frozen at intent time (the Deposit row has no bonus columns — adding
 * them is the schema change recommended in the ship report). Today the top-up
 * screen and the grant share one source of truth (the same setting), so what
 * was advertised is what is granted — unless an operator edits the tiers
 * between payment and verification. That window is minutes-to-hours, and it
 * is why the recommended follow-up is freezing `bonusBps`/`bonusCents` on the
 * row at creation, exactly like the fee.
 *
 * ── DECISION 3: TIERS ARE DATA, NOT CODE ───────────────────────────────────
 *     deposit_bonus_enabled   (bool, default true)
 *     deposit_bonus_tiers     (json, default: $1,250 → +7%, $625 → +5%)
 *
 * A tier is `{ minCents, bonusBps, methods? }`. The single HIGHEST qualifying
 * tier wins (`grossCents ≥ minCents`, and the rail is in `methods` when the
 * tier is scoped) — there is no stacking, matching the one "Bonus +X%" the
 * screen shows per package. An operator adds, removes, resizes or scopes
 * tiers, or switches the whole program off, from the settings table with no
 * deploy. (The keys must be added to `SETTING_KEYS`/`SETTING_DEFAULTS` — the
 * wiring note at the bottom has the exact block; this file references the
 * raw strings so it compiles before that wiring exists.)
 *
 * Malformed tier data FAILS CLOSED: a bad entry is skipped with a warning
 * (so a typo in a NEW tier cannot kill the advertised ones), a non-array
 * value disables the program, and a bonus above 100% of gross is refused —
 * the platform can never be configured to pay out more than the deposit it
 * verified. In every failure mode the deposit credit itself is unaffected:
 * the bonus degrades to zero, it never blocks money the customer really sent.
 *
 * ── DECISION 4: THE BONUS CANNOT BE FARMED ─────────────────────────────────
 * "Cannot be claimed twice on one deposit" is enforced twice, the same two
 * lines of defence the deposit credit itself uses:
 *
 *   1. STATE: the bonus is only ever posted inside the PENDING → VERIFIED
 *      transition of `verifyDeposit`, which re-reads the row inside its
 *      transaction and no-ops when the status is not PENDING. A replayed
 *      verify (second admin, duplicated webhook, retry loop) finds VERIFIED
 *      and moves nothing.
 *   2. UNIQUE LEDGER REFERENCE: the bonus posts its own ledger row,
 *      `deposit:bonus:<depositId>` — UNIQUE in the transactions table. Even
 *      if the transition logic were somehow re-entered, the duplicate insert
 *      collides and rolls back the ENTIRE transaction, bonus included.
 *
 * "Deposit → bonus → withdraw → repeat" is bounded by construction:
 *
 *   - The bonus is proportional to GROSS money that actually arrived and was
 *     verified against the gateway statement. It is not paid on balance
 *     movement, so minting a bonus requires repeatedly sending real funds
 *     through a real rail — each cycle the rail itself keeps 0–48% on the
 *     way IN.
 *   - The bonus money leaves through the same guarded withdrawal rails as
 *     any balance: minimum/maximum withdrawal, daily and monthly caps,
 *     manual review above the threshold (`payoutLimits.service`). Those
 *     caps are what rate-limit the cycle, and they already apply.
 *   - A tier's optional `methods` scope lets an operator confine the subsidy
 *     to the rails it actually wants to promote (e.g. crypto or Stars),
 *     which is the cheapest lever if a rail ever becomes a round-trip
 *     favourite.
 *
 * The honest arithmetic: a cycle that fronts $625 of the operator's own
 * money costs the platform 5–7% of it and returns the principal — that is
 * the intended price of a volume incentive, and it is a cost the product
 * explicitly advertises, not free money.
 *
 * ── WIRING (applied in `deposit.service.verifyDeposit`; exact snippet in the
 *    ship report) ───────────────────────────────────────────────────────────
 *   before the transaction:  `const bonusConfig = await loadBonusConfig();`
 *   inside, after the status guard and the `creditedCents` computation:
 *      `const bonus = settleBonusFor({ grossCents, feeCents, method, config })`
 *      `await postDepositBonus(tx, deposit, bonus)`
 *   i.e. the net credit keeps its existing row and reference
 *   (`deposit:<id>`), and the bonus is a SECOND row in the SAME transaction.
 */

import type { Prisma } from '@prisma/client';
import { isPaymentMethod, type PaymentMethod } from '@botflow/shared';
import { getBoolSetting, getSetting } from './settings.service';
import { feeBpsFor, methodLabel } from './paymentFee.service';
import { postLedger, type PostedLedger } from './transaction.service';
import { formatMoney } from '../utils/money';
import { ValidationError } from '../utils/errors';
import { logger } from '../config/logger';

/** Basis points: 100 bps = 1%. Same denominator the fee model uses. */
const BPS_DENOMINATOR = 10_000;

/**
 * The most the platform will ever pay out as a bonus on one deposit: 100% of
 * its gross. Anything configured beyond that is an operator error (a typo'd
 * 50000 instead of 5000) and is refused, not honoured.
 */
const MAX_BONUS_BPS = 10_000;

/**
 * The raw setting keys. They intentionally duplicate the values that
 * `SETTING_KEYS.DEPOSIT_BONUS_*` will carry once the constants.ts wiring is
 * applied (see report) — this file must compile BEFORE that wiring exists,
 * and the two must agree string-for-string or the admin panel would write
 * one key and this service would read another.
 */
export const DEPOSIT_BONUS_SETTING_KEYS = {
  enabled: 'deposit_bonus_enabled',
  tiers: 'deposit_bonus_tiers',
} as const;

/**
 * The advertised packages, as data:
 *   $1,250 gross (= 100,000 Stars at 80 Stars/USD)  →  +7%
 *   $625   gross (= 50,000 Stars)                   →  +5%
 * Highest first. This is the code-level fallback ONLY — the live value comes
 * from the settings table, where the operator edits it.
 */
export const DEFAULT_DEPOSIT_BONUS_TIERS: readonly DepositBonusTier[] = [
  { minCents: 125_000, bonusBps: 700 },
  { minCents: 62_500, bonusBps: 500 },
];

/* ------------------------------------------------------------------
 *  Types
 * ------------------------------------------------------------------ */

/** One configurable tier. `methods` is optional: absent = every rail. */
export interface DepositBonusTier {
  /** Gross, in cents, at which the tier starts applying (inclusive). */
  minCents: number;
  /** The bonus, in basis points of GROSS (700 = 7%). */
  bonusBps: number;
  /** Restrict the tier to these payment methods. Absent = all rails. */
  methods?: string[];
}

export interface BonusConfig {
  /** Master switch. Off = no bonus anywhere, full stop. */
  enabled: boolean;
  /** Validated tiers, sorted highest threshold first. */
  tiers: DepositBonusTier[];
  /** How many configured entries were skipped as malformed. */
  skipped: number;
}

/**
 * The pure price of a top-up: every figure the customer should be shown, and
 * the exact split the wallet will see when it settles.
 *
 * Reconciliation (all integers, no float anywhere):
 *   feeCents    = ceil(gross × feeBps / 10000)
 *   netCents    = gross − feeCents
 *   bonusCents  = round(gross × bonusBps / 10000)   [0 below every tier]
 *   creditedCents = netCents + bonusCents
 * so `feeCents + netCents === grossCents` and
 * `creditedCents + feeCents − bonusCents === grossCents` hold by construction.
 */
export interface TopUpQuote {
  method: PaymentMethod;
  /** What the depositor sends. */
  grossCents: number;
  /** The rail's rate, basis points (the depositor's cut). */
  feeBps: number;
  feeCents: number;
  /** gross − fee — the part of the deposit that is the customer's own. */
  netCents: number;
  /** The granted tier's rate, 0 when no tier qualifies. */
  bonusBps: number;
  bonusCents: number;
  /** net + bonus — the ONLY figure that may ever be credited. */
  creditedCents: number;
  /** The tier that qualified, or null. */
  tier: { minCents: number; bonusBps: number } | null;
}

/**
 * What a SETTLED deposit owes in bonus. `netCents`/`creditedCents` restate
 * the reconciliation so the caller (verifyDeposit) never re-derives money.
 */
export interface BonusSettlement {
  bonusBps: number;
  bonusCents: number;
  /** gross − fee, exactly as the fee model already splits it. */
  netCents: number;
  /** net + bonus — the wallet delta for the whole settled deposit. */
  creditedCents: number;
  /** The tier's minCents, null when no tier qualified. */
  tierMinCents: number | null;
}

/** The columns of a deposit row the grant needs — the full row satisfies it. */
export interface BonusDepositRow {
  id: string;
  userId: string;
  amountCents: number;
  feeBps: number;
  feeCents: number;
  method: string;
  currency: string;
}

/* ------------------------------------------------------------------
 *  Pure pricing — no I/O, fully unit-testable
 * ------------------------------------------------------------------ */

/**
 * Validate a raw tiers value from the settings table.
 *
 * Entry-by-entry, fail-closed: each bad entry is dropped (and counted) while
 * good ones survive, because the advertised tiers must not die because a NEW
 * tier the operator just added contains a typo. A bonus above 100% is refused
 * per entry — the configuration mistake it represents ("50000" meaning 500%)
 * must never become a live payout.
 */
export function parseBonusTiers(raw: unknown): { tiers: DepositBonusTier[]; skipped: number } {
  if (!Array.isArray(raw)) return { tiers: [], skipped: 0 };

  const tiers: DepositBonusTier[] = [];
  let skipped = 0;

  for (const entry of raw) {
    const t = entry as Partial<DepositBonusTier> | null;
    const minOk = typeof t?.minCents === 'number' && Number.isInteger(t.minCents) && t.minCents >= 0;
    const bpsOk = typeof t?.bonusBps === 'number' && Number.isInteger(t.bonusBps) && t.bonusBps >= 0 && t.bonusBps <= MAX_BONUS_BPS;
    const methodsOk =
      t?.methods === undefined ||
      (Array.isArray(t.methods) && t.methods.length > 0 && t.methods.every((m) => isPaymentMethod(m)));

    if (minOk && bpsOk && methodsOk) {
      tiers.push({
        minCents: t!.minCents!,
        bonusBps: t!.bonusBps!,
        ...(t!.methods !== undefined ? { methods: t!.methods } : {}),
      });
    } else {
      skipped += 1;
      logger.warn({ entry }, 'deposit bonus: skipping a malformed tier entry');
    }
  }

  // Highest threshold first so selection is "first match wins"; on a tie the
  // bigger bonus wins (an operator who configures the same threshold twice
  // gets the generous reading, not the stingy one).
  tiers.sort((a, b) => b.minCents - a.minCents || b.bonusBps - a.bonusBps);
  return { tiers, skipped };
}

/**
 * Pick the single qualifying tier: the highest `minCents` the gross reaches,
 * on a rail the tier permits. No stacking — the screen advertises one bonus
 * per package, and stacking would let the top tier quietly pay 12%.
 */
export function selectBonusTier(
  grossCents: number,
  method: string,
  tiers: readonly DepositBonusTier[],
): DepositBonusTier | null {
  for (const tier of tiers) {
    if (grossCents >= tier.minCents && (tier.methods === undefined || tier.methods.includes(method))) {
      return tier;
    }
  }
  return null;
}

/**
 * THE pure quote (requirement: gross, fee, bonus, credited for amount+method).
 *
 * Takes `feeBps` and `tiers` as parameters instead of looking them up, so the
 * arithmetic can be asserted for every rail without a database. The async
 * wrapper `quoteTopUpForDeposit` is the only production caller of the lookups.
 */
export function quoteTopUp(params: {
  grossCents: number;
  feeBps: number;
  method: string;
  tiers: readonly DepositBonusTier[];
}): TopUpQuote {
  const { grossCents, feeBps, method, tiers } = params;

  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    throw new ValidationError('Top-up amount must be a positive whole number of minor units.');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > BPS_DENOMINATOR) {
    throw new ValidationError(`Fee rate must be an integer number of basis points in 0..${BPS_DENOMINATOR}.`);
  }
  if (!isPaymentMethod(method)) {
    throw new ValidationError(`Unknown payment method "${method}".`);
  }

  // The fee keeps its existing semantics, untouched: ceil, depositor's cut.
  const feeCents = Math.ceil((grossCents * feeBps) / BPS_DENOMINATOR);
  const tier = selectBonusTier(grossCents, method, tiers);
  // The bonus is half-up, platform's cut — see the header for the rationale.
  const bonusCents = tier ? Math.round((grossCents * tier.bonusBps) / BPS_DENOMINATOR) : 0;
  const netCents = grossCents - feeCents;

  return {
    method,
    grossCents,
    feeBps,
    feeCents,
    netCents,
    bonusBps: tier?.bonusBps ?? 0,
    bonusCents,
    creditedCents: netCents + bonusCents,
    tier: tier ? { minCents: tier.minCents, bonusBps: tier.bonusBps } : null,
  };
}

/**
 * Settle the bonus for a deposit row that is ABOUT to be verified. Pure given
 * the row's frozen figures and the loaded config — `verifyDeposit` calls this
 * inside its transaction, right after it confirms the row is PENDING.
 *
 * A row whose fee exceeds its gross is corrupted data: refusing to grant
 * (ValidationError, which rolls the verification back for manual handling)
 * beats granting against numbers we cannot state.
 */
export function settleBonusFor(params: {
  grossCents: number;
  feeCents: number;
  method: string;
  config: BonusConfig;
}): BonusSettlement {
  const { grossCents, feeCents, method, config } = params;

  if (!Number.isInteger(grossCents) || grossCents <= 0) {
    throw new ValidationError('Settlement requires a positive whole gross.');
  }
  if (!Number.isInteger(feeCents) || feeCents < 0 || feeCents > grossCents) {
    throw new ValidationError(
      `Deposit row is corrupted: feeCents ${feeCents} is outside [0, ${grossCents}]. Refusing to settle.`,
    );
  }

  const tier = config.enabled ? selectBonusTier(grossCents, method, config.tiers) : null;
  const bonusBps = tier?.bonusBps ?? 0;
  const bonusCents = tier ? Math.round((grossCents * tier.bonusBps) / BPS_DENOMINATOR) : 0;
  const netCents = grossCents - feeCents;

  return {
    bonusBps,
    bonusCents,
    netCents,
    creditedCents: netCents + bonusCents,
    tierMinCents: tier?.minCents ?? null,
  };
}

/* ------------------------------------------------------------------
 *  Production entry points (settings lookups live here, not in the pure core)
 * ------------------------------------------------------------------ */

/**
 * Load and validate the live bonus configuration.
 *
 * Defaults reproduce the advertised packages when the operator has written
 * nothing. `enabled` defaults to TRUE: the bonus is already advertised to
 * paying customers, so shipping this code with the program off would leave
 * the false promise in place — the master switch exists to turn it off in an
 * emergency, not to be the quiet default.
 */
export async function loadBonusConfig(): Promise<BonusConfig> {
  const enabled = await getBoolSetting(DEPOSIT_BONUS_SETTING_KEYS.enabled, true);
  const raw = await getSetting<unknown>(DEPOSIT_BONUS_SETTING_KEYS.tiers);

  if (raw === undefined) {
    // No row in the settings table and no code default: use the advertised
    // packages. (SETTING_DEFAULTS is expected to carry the same value once
    // the constants.ts wiring is applied.)
    return { enabled, tiers: [...DEFAULT_DEPOSIT_BONUS_TIERS], skipped: 0 };
  }

  const { tiers, skipped } = parseBonusTiers(raw);
  if (skipped > 0) logger.warn({ skipped }, 'deposit bonus: some configured tiers were skipped as malformed');
  if (enabled && tiers.length === 0) {
    // Loud on purpose: the screen still advertises a bonus, and silently
    // paying none of it is the original bug.
    logger.error('deposit bonus is ENABLED but has no valid tiers — no bonus will be granted');
  }
  return { enabled, tiers, skipped };
}

/**
 * Settle-time bonus for a deposit row. This is the function the `verifyDeposit`
 * wiring feeds into `settleBonusFor`; it exists so the "what does THIS row owe"
 * answer is one call (and testable) instead of a copy of the wiring.
 */
export async function bonusForSettledDeposit(params: {
  amountCents: number;
  feeCents: number;
  method: string;
}): Promise<BonusSettlement> {
  const config = await loadBonusConfig();
  return settleBonusFor({
    grossCents: params.amountCents,
    feeCents: params.feeCents,
    method: params.method,
    config,
  });
}

/**
 * Price a top-up end-to-end, the way a UI should: the rail's live fee (with
 * its operator override, exactly as the deposit will be charged) composed
 * with the live tier table. Pure core + two lookups; no money moves.
 */
export async function quoteTopUpForDeposit(method: string, grossCents: number): Promise<TopUpQuote> {
  const feeBps = await feeBpsFor(method);
  const config = await loadBonusConfig();
  // The quote must say what the grant will actually do: a switched-off
  // program quotes no bonus. (Otherwise the top-up screen would advertise
  // something verifyDeposit is not about to pay — the original bug.)
  return quoteTopUp({ grossCents, feeBps, method, tiers: config.enabled ? config.tiers : [] });
}

/* ------------------------------------------------------------------
 *  The grant — the ONLY place a bonus may be posted to the ledger
 * ------------------------------------------------------------------ */

/**
 * The bonus's unique ledger reference. The convention is
 * `<type>:<entityId>:<suffix>` (see transaction.service `ref`); this lives
 * here rather than in `ref` because that object is in an existing file this
 * feature must not edit.
 */
export function depositBonusReference(depositId: string): string {
  return `deposit:bonus:${depositId}`;
}

/**
 * Post the settled bonus as its own ledger row, inside the verifyDeposit
 * transaction.
 *
 * Why its own row:
 *   - `reference` is UNIQUE, so the grant is impossible to double even if the
 *     transition were re-entered — the duplicate insert rolls back the whole
 *     transaction, bonus and all (second line of defence; the first is the
 *     PENDING-only status guard in verifyDeposit).
 *   - A self-contained, auditable movement: a support rep sees the bonus as
 *     its own line ("Top-up bonus +7% on $1,250.00") instead of a deposit
 *     row larger than the deposit, with the breakdown in `metadata`.
 *
 * Why the row is typed DEPOSIT: `TransactionType` is a closed enum and this
 * feature may not migrate. DEPOSIT is the honest category (money in, because
 * of a top-up), and the reference prefix + description + metadata identify it
 * in every report. (A future `DEPOSIT_BONUS` type is a one-value enum
 * migration if the team wants it; nothing here blocks on it.)
 *
 * Why the wallet delta touches ONLY `available`: the bonus is the platform's
 * gift, not the user's money in, so it never inflates `totalDepositedCents`.
 * (Conversely it DOES become withdrawable immediately, like any credited
 * deposit — the advertised bonus is real spendable money.)
 *
 * Returns null (and moves nothing) when the settlement carries no bonus:
 * sub-tier deposits must leave the ledger exactly as the fee model alone
 * would.
 */
export async function postDepositBonus(
  tx: Prisma.TransactionClient,
  deposit: BonusDepositRow,
  settlement: BonusSettlement,
): Promise<PostedLedger | null> {
  if (settlement.bonusCents <= 0) {
    logger.debug({ depositId: deposit.id }, 'deposit bonus: no tier reached — nothing to post');
    return null;
  }

  const posted = await postLedger(tx, {
    userId: deposit.userId,
    type: 'DEPOSIT',
    amountCents: settlement.bonusCents,
    reference: depositBonusReference(deposit.id),
    referenceType: 'DEPOSIT',
    currency: deposit.currency,
    walletDelta: { available: settlement.bonusCents },
    depositId: deposit.id,
    description: `Top-up bonus +${settlement.bonusBps / 100}% on ${formatMoney(deposit.amountCents, deposit.currency)} ${methodLabel(deposit.method)}`,
    metadata: {
      grossCents: deposit.amountCents,
      feeBps: deposit.feeBps,
      feeCents: deposit.feeCents,
      netCents: settlement.netCents,
      bonusBps: settlement.bonusBps,
      bonusCents: settlement.bonusCents,
      creditedCents: settlement.creditedCents,
      tierMinCents: settlement.tierMinCents,
    },
  });

  logger.info(
    { depositId: deposit.id, bonusCents: settlement.bonusCents, bonusBps: settlement.bonusBps, replayed: posted.replayed },
    'deposit bonus posted',
  );
  return posted;
}
