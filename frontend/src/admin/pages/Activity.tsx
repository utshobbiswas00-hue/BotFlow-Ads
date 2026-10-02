/**
 * Cross-entity activity feed (spec §65).
 *
 * A COMPUTED VIEW, not a stored event log. `GET /api/admin/activity?limit=`
 * merges the most recent rows from several tables into one newest-first stream
 * and returns `{ items, generatedAt }`; nothing is written by rendering this
 * screen and there is no read-state to change. The page says so in words, and
 * shows `generatedAt` so a reader knows exactly how fresh the snapshot is.
 *
 * The API already orders items newest-first, so this screen only GROUPS them by
 * calendar day — it never re-sorts, which would risk disagreeing with the server
 * about what "recent" means.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDate, formatDateTime, fromNow } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Icon } from '../../components/ui/icons';
import { Select } from '../../components/ui/Select';
import { getActivityFeed } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';
import type { ActivityItem } from '../lib/types';

/** The three window sizes the endpoint is happy to merge. */
const LIMITS = [30, 60, 150];

/** Local calendar day of an ISO timestamp, used only to bucket the stream. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-words">{item.label}</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold tracking-wide border border-line bg-app text-mute">
            {item.kind}
          </span>
        </div>
        {item.detail ? <p className="text-xs text-mute mt-0.5 break-words">{item.detail}</p> : null}
      </div>
      <span className="text-xs text-mute shrink-0" title={formatDateTime(item.createdAt)}>
        {fromNow(item.createdAt)}
      </span>
      {item.href ? <Icon name="chevronRight" size={16} className="text-mute shrink-0" /> : null}
    </>
  );

  const base = 'flex items-center gap-3 bg-surface border border-line rounded-2xl p-3';

  // A row with no destination is rendered as plain text — a link to nowhere is
  // worse than no link at all.
  if (item.href) {
    return (
      <Link to={item.href} className={`${base} hover:bg-app/60 transition-colors`}>
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

export function ActivityPage() {
  const [limit, setLimit] = useState(60);

  const query = useQuery({
    queryKey: [...qk.adminActivity, { limit }],
    queryFn: () => getActivityFeed(limit),
  });

  const items = query.data?.items ?? [];
  const generatedAt = query.data?.generatedAt;

  // Bucket the already-newest-first stream by day, preserving source order.
  const groups: { key: string; label: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: formatDate(item.createdAt), items: [item] });
  }

  return (
    <>
      <AdminPageHeader
        title="Activity"
        description="A newest-first look at what has happened across the platform recently."
        actions={
          <Select
            label="Rows"
            className="max-w-32"
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            options={LIMITS.map((n) => ({ value: String(n), label: `Latest ${n}` }))}
          />
        }
      />

      <div className="space-y-4">
        <div className="flex items-start gap-3 bg-surface border border-line rounded-2xl p-4">
          <span className="w-8 h-8 rounded-xl bg-app border border-line flex items-center justify-center shrink-0 text-mute">
            <Icon name="info" size={16} />
          </span>
          <p className="text-xs text-mute max-w-3xl">
            This is a merged view of recent rows, not a stored event log. Each entry is computed
            from the record it points at, so there is no history beyond the latest rows and nothing
            to mark as read.
            {generatedAt ? <> Snapshot generated {formatDateTime(generatedAt)}.</> : null}
          </p>
        </div>

        <QueryState
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          isEmpty={!query.isPending && !query.isError && items.length === 0}
          emptyTitle="No recent activity"
          emptyMessage="Nothing has happened in the window this feed covers."
          onRetry={() => void query.refetch()}
          skeletonRows={4}
        >
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-mute">
                    {group.label}
                  </span>
                  <span className="text-xs text-mute">
                    {group.items.length} {group.items.length === 1 ? 'event' : 'events'}
                  </span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => (
                    <ActivityRow key={`${item.kind}-${item.id}`} item={item} />
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
