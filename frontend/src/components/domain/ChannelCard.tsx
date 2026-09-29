import { Link } from 'react-router-dom';
import type { ChannelSummary } from '@botflow/shared';
import type { ChannelQuality, MarketplaceChannelRow } from '../../lib/contracts';
import { channelQualityOf } from '../../lib/contracts';
import { cn } from '../../lib/cn';
import { categoryLabel, compactNumber, formatMoney, pricingLabel } from '../../lib/format';
import { StatusBadge } from '../ui/StatusBadge';
import { Icon } from '../ui/icons';

export interface ChannelCardProps {
  channel: ChannelSummary;
  /** Show publisher-only status + earnings (my-channels list). */
  showStatus?: boolean;
  /** Show selection checkbox (marketplace picker). */
  selected?: boolean;
  onToggle?: () => void;
}

/** Channel row for /channels and admin channel lists. */
export function ChannelCard({ channel, showStatus = false, selected, onToggle }: ChannelCardProps) {
  const name = channel.title || channel.username || 'Channel';
  const username = channel.username ? `@${channel.username.replace(/^@/, '')}` : '';
  const inner = (
    <>
      <div className="w-11 h-11 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-sm shrink-0 overflow-hidden">
        {channel.photoUrl ? (
          <img src={channel.photoUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold text-[15px] truncate">{name}</p>
          {showStatus && <StatusBadge status={channel.status} />}
        </div>
        <p className="text-xs text-mute truncate mt-0.5">
          {username && <span className="text-link">{username} · </span>}
          {categoryLabel(channel.category)}
          {channel.country ? ` · ${channel.country.toUpperCase()}` : ''}
        </p>
        <p className="text-xs text-mute mt-0.5">
          {compactNumber(channel.subscriberCount)} subs · {compactNumber(channel.avgViews)} avg views
        </p>
      </div>
      <div className="text-right shrink-0 pl-2">
        <p className="text-sm font-bold whitespace-nowrap">{pricingLabel(channel.pricingModel, channel.adPriceCents)}</p>
        {showStatus && (
          <p className="text-xs text-mute mt-0.5 whitespace-nowrap">
            {channel.totalAdsPublished} ads · {formatMoney(channel.totalEarnedCents)}
          </p>
        )}
      </div>
    </>
  );

  const cls = cn('bg-surface border border-line rounded-2xl p-3 flex items-center gap-3 w-full text-left',
    selected ? 'border-accent ring-1 ring-accent' : 'border-line');

  if (onToggle) {
    return (
      <button type="button" onClick={onToggle} className={cn(cls, 'active:opacity-80')}>
        {inner}
        <span
          className={cn(
            'w-6 h-6 rounded-full border flex items-center justify-center shrink-0',
            selected ? 'bg-accent border-accent text-accentink' : 'border-line text-transparent',
          )}
        >
          <Icon name="check" size={14} />
        </span>
      </button>
    );
  }

  return (
    <Link to={`/channels/${channel.id}`} className={cn(cls, 'active:opacity-80 block')}>
      {inner}
    </Link>
  );
}

/** Category moderation state shown on marketplace rows (muted badge + note). */
export interface MarketplaceChannelPolicy {
  state: 'REVIEW_REQUIRED' | 'BLOCKED';
  note?: string;
}

const QUALITY_TONE_CLS: Record<ChannelQuality['tone'], string> = {
  green: 'bg-ok/10 text-ok',
  amber: 'bg-warn/10 text-warn',
  red: 'bg-danger/10 text-danger',
  gray: 'bg-mute/10 text-mute',
};
const QUALITY_DOT_CLS: Record<ChannelQuality['tone'], string> = {
  green: 'bg-ok',
  amber: 'bg-warn',
  red: 'bg-danger',
  gray: 'bg-mute',
};

/** Marketplace row — same visual, but no internal navigation. */
export function MarketplaceChannelCard({
  channel,
  policy,
}: {
  /** `featured` is added by the backend for premium publishers (optional here). */
  channel: MarketplaceChannelRow & { featured?: boolean };
  policy?: MarketplaceChannelPolicy | null;
}) {
  const name = channel.title || channel.username || 'Channel';
  // Advertiser-facing delivery quality. A dot alone would not say what is
  // wrong, so the chip carries a short label plus a tooltip with the reason.
  const quality = channelQualityOf(channel);
  return (
    <div className="bg-surface border border-line rounded-2xl p-3 flex items-center gap-3">
      <div className="w-11 h-11 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-sm shrink-0 overflow-hidden">
        {channel.photoUrl ? (
          <img src={channel.photoUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          name.charAt(0).toUpperCase()
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="font-semibold text-[15px] truncate">{name}</p>
          <span
            title={quality.description}
            className={cn(
              'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold tracking-wide whitespace-nowrap shrink-0',
              QUALITY_TONE_CLS[quality.tone],
            )}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', QUALITY_DOT_CLS[quality.tone])} aria-hidden="true" />
            {quality.label}
          </span>
          {policy && (
            <span
              title={policy.note}
              className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-mute/10 text-mute text-[10px] font-semibold tracking-wide uppercase shrink-0"
            >
              {policy.state === 'BLOCKED' ? 'Restricted' : 'Extra review'}
            </span>
          )}
          {channel.featured && (
            <span
              title="Featured publisher — promoted in the marketplace"
              className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-accent/10 text-accent text-[10px] font-semibold tracking-wide uppercase shrink-0"
            >
              Featured
            </span>
          )}
        </div>
        <p className="text-xs text-mute truncate mt-0.5">
          {categoryLabel(channel.category)}
          {channel.country ? ` · ${channel.country.toUpperCase()}` : ''}
          {channel.language ? ` · ${channel.language.toUpperCase()}` : ''}
        </p>
        <p className="text-xs text-mute mt-0.5">
          {compactNumber(channel.subscriberCount)} subs · {compactNumber(channel.avgViews)} avg views
        </p>
        {policy?.note && (
          <p className="text-[11px] text-mute leading-snug mt-1">{policy.note}</p>
        )}
      </div>
      <p className="text-sm font-bold whitespace-nowrap shrink-0">
        {pricingLabel(channel.pricingModel, channel.adPriceCents)}
      </p>
    </div>
  );
}

