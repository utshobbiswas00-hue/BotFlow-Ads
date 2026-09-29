import { Link } from 'react-router-dom';
import type { CampaignSummary } from '@botflow/shared';
import { humanize } from '../../lib/format';
import { Money } from '../ui/Money';
import { StatusBadge } from '../ui/StatusBadge';
import { Icon } from '../ui/icons';

export interface CampaignCardProps {
  campaign: CampaignSummary;
  /** Optional advertiser / owner name (admin list). */
  ownerName?: string;
}

/** Campaign row for /campaigns and admin campaign lists. */
export function CampaignCard({ campaign, ownerName }: CampaignCardProps) {
  const spentPct =
    campaign.budgetTotalCents > 0
      ? Math.min(100, Math.round((campaign.budgetSpentCents / campaign.budgetTotalCents) * 100))
      : 0;
  const stats = campaign.stats;

  return (
    <Link to={`/campaigns/${campaign.id}`} className="block bg-surface border border-line rounded-2xl p-4 active:opacity-80">
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="font-semibold text-[15px] truncate">{campaign.name}</p>
        <StatusBadge status={campaign.status} />
      </div>
      <p className="text-xs text-mute mb-3">
        {humanize(campaign.promotionTarget)} · {humanize(campaign.pricingModel)}
        {campaign.isAutoTargeting ? ' · Auto-targeting' : ''}
        {ownerName ? ` · ${ownerName}` : ''}
      </p>

      {/* Budget bar */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-mute mb-1">
          <span>Budget used</span>
          <span>
            <Money cents={campaign.budgetSpentCents} /> / <Money cents={campaign.budgetTotalCents} />
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-line overflow-hidden">
          <div className="h-full rounded-full bg-accent" style={{ width: `${spentPct}%` }} />
        </div>
      </div>

      {stats && (
        <div className="flex items-center gap-4 text-xs text-mute pt-2 border-t border-line">
          <span className="inline-flex items-center gap-1">
            <Icon name="eye" size={13} /> {stats.views.toLocaleString()} views
          </span>
          <span className="inline-flex items-center gap-1">
            <Icon name="target" size={13} /> {stats.clicks.toLocaleString()} clicks
          </span>
          <span className="inline-flex items-center gap-1">
            <Icon name="check" size={13} /> {stats.published}/{stats.targetChannels} channels
          </span>
          <span className="ml-auto text-link font-semibold">{stats.ctr.toFixed(2)}%</span>
        </div>
      )}
    </Link>
  );
}
