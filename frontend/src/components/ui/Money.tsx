import { cn } from '../../lib/cn';
import { formatMoney } from '../../lib/format';

export interface MoneyProps {
  /** Amount in cents (integer). */
  cents: number;
  currency?: string;
  /** Show a + / − sign for positive/negative amounts. */
  signed?: boolean;
  className?: string;
}

/**
 * Canonical money display — always converts cents -> currency.
 * Never render raw cents in the UI; use this component.
 *
 * Two deliberate details:
 *  - `num` applies tabular numerals, so figures do not reflow as they tick.
 *    A dashboard where "$1,111" is wider than "$999" looks broken.
 *  - `signed` pairs the colour with an explicit +/− glyph. Colour alone is
 *    never the only signal, so the meaning survives for colour-blind users.
 */
export function Money({ cents, currency, signed = false, className }: MoneyProps) {
  const text = signed
    ? `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatMoney(Math.abs(cents), currency)}`
    : formatMoney(cents, currency);

  return (
    <span
      className={cn(
        'num',
        signed && (cents > 0 ? 'money-pos' : cents < 0 ? 'money-neg' : undefined),
        className,
      )}
    >
      {text}
    </span>
  );
}
