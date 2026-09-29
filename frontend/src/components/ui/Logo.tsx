import { cn } from '../../lib/cn';

/**
 * BotFlow brand assets.
 *
 * Both files live in /public and ship as PNGs:
 *  - logo-mark.png     the glyph on its own with the background removed, so it
 *                      sits correctly on both the Telegram light and dark theme
 *                      without a coloured plate behind it.
 *  - logo-lockup.png   the supplied artwork untouched — glyph on its own light
 *                      plate, safe only where a light plate is acceptable.
 *
 * logo-mark.png is 484x375, so the height is always derived from the width —
 * never hard-code both, or the logo will squash.
 */
const MARK_ASPECT = 375 / 484;

export interface LogoMarkProps {
  /** Rendered width in px. Height follows the intrinsic aspect ratio. */
  size?: number;
  className?: string;
  alt?: string;
}

export function LogoMark({ size = 26, className, alt = 'BotFlow Ads' }: LogoMarkProps) {
  return (
    <img
      src="/logo-mark.png"
      alt={alt}
      width={size}
      height={Math.round(size * MARK_ASPECT)}
      className={cn('shrink-0 select-none object-contain', className)}
      draggable={false}
      decoding="async"
    />
  );
}

export interface LogoLockupProps {
  width?: number;
  className?: string;
}

/** Full lockup on its own dark plate — use on dark surfaces only. */
export function LogoLockup({ width = 240, className }: LogoLockupProps) {
  return (
    <img
      src="/logo-lockup.png"
      alt="BotFlow Ads"
      width={width}
      className={cn('select-none rounded-2xl object-contain', className)}
      draggable={false}
      decoding="async"
    />
  );
}

/** Brand mark plus the product name, for headers and empty states. */
export function LogoWordmark({ size = 24, className }: LogoMarkProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark size={size} alt="" />
      <span className="font-extrabold tracking-tight">
        BotFlow
        <span className="text-[#0090F0]"> Ads</span>
      </span>
    </span>
  );
}
