import { SPONSORED_LABEL } from '@botflow/shared';
import { cn } from '../../lib/cn';

export interface AdPreviewProps {
  /** Channel / sender display name shown in the bubble header. */
  channelName?: string;
  channelPhoto?: string | null;
  text: string;
  imageUrl?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  /** Compact mode: hide the outer chat chrome. */
  compact?: boolean;
  className?: string;
}

/**
 * Realistic Telegram post bubble: "📢 Sponsored" label at top, ad text,
 * optional image, and the inline-keyboard button as a rounded blue pill.
 */
export function AdPreview({
  channelName = 'Your Channel',
  channelPhoto,
  text,
  imageUrl,
  buttonText,
  buttonUrl,
  compact = false,
  className,
}: AdPreviewProps) {
  const hasButton = !!(buttonText || buttonUrl);
  return (
    <div className={cn('w-full', compact ? '' : 'bg-app/60 rounded-2xl p-3', className)}>
      <div className="bg-surface rounded-2xl rounded-tl-md shadow-sm overflow-hidden max-w-full">
        {/* Bubble header */}
        <div className="flex items-center gap-2 px-3 pt-3">
          {channelPhoto ? (
            <img
              src={channelPhoto}
              alt=""
              className="w-7 h-7 rounded-full object-cover shrink-0"
              loading="lazy"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-accent/15 text-accent flex items-center justify-center text-[11px] font-bold shrink-0">
              {channelName.charAt(0).toUpperCase() || 'M'}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[13px] font-semibold truncate leading-tight">{channelName}</p>
          </div>
        </div>

        {/* Sponsored label */}
        <div className="px-3 mt-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-link bg-accent/10 rounded-md px-1.5 py-0.5">
            {SPONSORED_LABEL}
          </span>
        </div>

        {/* Text */}
        {text ? (
          <p className="px-3 pt-1.5 pb-3 text-[14px] leading-snug whitespace-pre-wrap break-words">{text}</p>
        ) : (
          !imageUrl && <div className="h-3 px-3 pb-3" />
        )}

        {/* Image */}
        {imageUrl && (
          <img
            src={imageUrl}
            alt="Ad creative"
            className="w-full max-h-64 object-cover"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        )}

        {/* Inline keyboard button (rounded blue pill) */}
        {hasButton && (
          <div className="px-3 pb-3 pt-1">
            <div className="w-full text-center bg-accent text-accentink text-[14px] font-medium rounded-full py-2.5 pointer-events-none">
              {buttonText || buttonUrl || 'Learn more'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
