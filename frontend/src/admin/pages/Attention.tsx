/**
 * "Needs attention" feed (spec §52, §65).
 *
 * This is a COMPUTED VIEW, not a notification inbox. `GET /api/admin/attention`
 * runs one count query per source on every request and returns whatever is
 * non-zero right now: nothing is stored, nothing persists, and there is no
 * read-state to change. So this page deliberately has NO "mark as read" control —
 * calling it an inbox would promise a persistence that does not exist. The
 * numbers are live counts that simply recompute on the next request.
 *
 * Items arrive already sorted most-urgent-first and pre-filtered (only sources
 * with a count > 0 survive), but this screen re-groups them by severity so the
 * ordering is visible and the eye can land on the top row.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { qk } from '../../lib/queryClient';
import { formatDateTime, groupNumber } from '../../lib/format';
import { Icon } from '../../components/ui/icons';
import { getAttentionFeed } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';
import type { AttentionItem, AttentionSeverity } from '../lib/types';

const SEVERITY_ORDER: AttentionSeverity[] = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'];

interface SeverityMeta {
  label: string;
  badge: string;
  accent: string;
}

const SEVERITY_META: Record<AttentionSeverity, SeverityMeta> = {
  CRITICAL: { label: 'Critical', badge: 'bg-danger/10 text-danger border-danger/40', accent: 'border-danger/40' },
  HIGH: { label: 'High', badge: 'bg-warn/10 text-warn border-warn/40', accent: 'border-warn/40' },
  NORMAL: { label: 'Normal', badge: 'bg-accent/10 text-link border-line', accent: 'border-line' },
  LOW: { label: 'Low', badge: 'bg-mute/10 text-mute border-line', accent: 'border-line' },
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const meta = SEVERITY_META[item.severity] ?? SEVERITY_META.NORMAL;
  return (
    <Link
      to={item.href}
      className={`flex items-center gap-3 bg-surface border ${meta.accent} rounded-2xl p-3 hover:bg-app/60 transition-colors`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{item.label}</span>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold tracking-wide border ${meta.badge}`}>
            {meta.label}
          </span>
        </div>
        <p className="text-xs text-mute mt-0.5">{item.detail}</p>
      </div>
      <span className="num text-xl font-bold shrink-0">{groupNumber(item.count)}</span>
      <Icon name="chevronRight" size={16} className="text-mute shrink-0" />
    </Link>
  );
}

export function AttentionPage() {
  const query = useQuery({
    queryKey: qk.adminAttention,
    queryFn: getAttentionFeed,
  });

  const items: AttentionItem[] = query.data?.items ?? [];
  const generatedAt = query.data?.generatedAt as string | undefined;

  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    meta: SEVERITY_META[severity],
    items: items.filter((item) => item.severity === severity),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <AdminPageHeader
        title="Needs attention"
        description="A live, computed snapshot of what an operator should look at right now — most urgent first. Nothing here is stored and nothing can be marked read; every number is recalculated on each request."
      />

      <div className="space-y-4">
        <div className="flex items-start gap-3 bg-surface border border-line rounded-2xl p-4">
          <span className="w-8 h-8 rounded-xl bg-app border border-line flex items-center justify-center shrink-0 text-mute">
            <Icon name="info" size={16} />
          </span>
          <p className="text-xs text-mute max-w-3xl">
            This is a computed view, not an inbox. It is assembled from live database counts and only
            lists sources whose count is greater than zero, so an item disappears on its own once the
            work is done — there is no read state to set and no &ldquo;mark as read&rdquo; action.
            {generatedAt ? <> Snapshot taken {formatDateTime(generatedAt)}.</> : null}
          </p>
        </div>

        <QueryState
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          isEmpty={!query.isPending && !query.isError && items.length === 0}
          emptyTitle="The platform is clear"
          emptyMessage="No source currently has a non-zero count. This feed only shows sources with a non-zero count, so an empty feed means nothing needs attention right now."
          onRetry={() => void query.refetch()}
          skeletonRows={4}
        >
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.severity} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold tracking-wide border ${group.meta.badge}`}
                  >
                    {group.meta.label}
                  </span>
                  <span className="text-xs text-mute">
                    {group.items.length} {group.items.length === 1 ? 'source' : 'sources'}
                  </span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => (
                    <AttentionRow key={item.kind} item={item} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </QueryState>
      </div>
    </>
  );
}
