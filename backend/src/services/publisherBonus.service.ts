import { entitlementsFor } from './premium.service';

/**
 * SHARED PUBLISHER-EARNINGS BONUS RULE (premium `publisherEarningBonusPct`).
 *
 * A premium publisher keeps a larger share of the SAME delivery/charge. The
 * uplift is carved OUT OF THE PLATFORM FEE — never added to the advertiser's
 * price — so the advertiser is charged exactly as before and every split still
 * reconciles:
 *
 *     bonusCents       = pct > 0 ? min(floor(net * pct / 100), platformFee) : 0
 *     netCents         = net + bonusCents
 *     platformFeeCents = platformFee - bonusCents
 *     platformFeeCents + netCents === grossCents   (invariant preserved)
 *
 * The `min(..., platformFee)` cap guarantees the platform fee can never go
 * negative. With `pct = 0` (FREE — no active subscription) `bonusCents` is 0 and
 * the result is byte-identical to `splitRevenue`'s output, so a FREE user behaves
 * exactly as before premium existed.
 *
 * This is the SAME rule `escrow.service.chargeDelivery` applies inline for FIXED
 * deliveries. It lives in this shared module so the other revenue-split call
 * sites (e.g. `cpcBilling.service.settleCpcPost`) reuse one implementation
 * instead of growing a second, divergent copy.
 */
export interface PublisherEarningSplit {
  grossCents: number;
  platformFeeCents: number;
  netCents: number;
  /** The uplift carved out of the platform fee (0 for FREE). */
  bonusCents: number;
}

export function applyPublisherEarningBonus(
  base: { grossCents: number; platformFeeCents: number; netCents: number },
  publisherEarningBonusPct: number,
): PublisherEarningSplit {
  const bonusCents =
    publisherEarningBonusPct > 0
      ? Math.min(Math.floor((base.netCents * publisherEarningBonusPct) / 100), base.platformFeeCents)
      : 0;

  return {
    grossCents: base.grossCents,
    bonusCents,
    platformFeeCents: base.platformFeeCents - bonusCents,
    netCents: base.netCents + bonusCents,
  };
}

/** The publisher's `publisherEarningBonusPct` entitlement (0 for FREE). */
export async function publisherEarningBonusPct(userId: string): Promise<number> {
  const { publisherEarningBonusPct: pct } = await entitlementsFor(userId);
  return pct;
}
