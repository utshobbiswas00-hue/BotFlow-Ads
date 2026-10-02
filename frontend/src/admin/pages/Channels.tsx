/**
 * Channels — publisher inventory and its approval state.
 *
 * The bot-permission snapshot matters as much as the review decision:
 * `adminChannelAction('APPROVE')` refuses a channel where the bot is not an
 * administrator with post rights, so both facts are shown side by side and the
 * approve button is disabled with the backend's own explanation rather than
 * failing after the click.
 *
 * `GET /admin/channels/blocked` is surfaced underneath: a channel that keeps
 * refusing posts is a delivery problem, and that aggregate is the only place the
 * error codes show up as a pattern.
 *
 * Note: `ChannelSummary` carries no `createdAt`, so the table shows what the
 * contract actually provides — performance and status, not a join date.
 */
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { categoryLabel, formatMoney, groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { channelAction, getBlockedAds, listChannels } from '../lib/api';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import {
  CHANNEL_STATUSES,
  channelActionsFor,
  channelApproveBlockedReason,
  statusOptions,
} from '../lib/actions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminChannelRow } from '../lib/types';

const LIMIT = 20;

const ACTION_LABELS: Record<string, string> = {
  APPROVE: 'Approve',
  REJECT: 'Reject',
  SUSPEND: 'Suspend',
  REACTIVATE: 'Reactivate',
};

export function AdminChannelsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const query = useQuery({
    queryKey: [...qk.adminChannels, { status, from, to, sort, page }],
    queryFn: () =>
      listChannels({
        status: status || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const blocked = useQuery({ queryKey: qk.adminBlockedAds, queryFn: getBlockedAds });

  const canManage = can('channels.manage');

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminChannels });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
  };

  const columns: Column<AdminChannelRow>[] = [
    {
      key: 'title',
      header: 'Channel',
      render: (c) => (
        <TwoLine
          primary={c.title}
          secondary={
            <span className="num">
              {c.username ? `@${c.username.replace(/^@/, '')}` : 'private'} · {categoryLabel(c.category)}
            </span>
          }
        />
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      hideBelow: 'md',
      render: (c) => <span className="text-sm">{c.ownerName}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <span className="inline-flex flex-col items-start gap-1">
          <StatusBadge status={c.status} />
          {c.status === 'REJECTED' && c.rejectionReason ? (
            <span className="text-[10px] text-mute max-w-40 truncate" title={c.rejectionReason}>
              {c.rejectionReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Reach',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (c) => (
        <TwoLine
          primary={<span className="num">{groupNumber(c.subscriberCount)}</span>}
          secondary={<span className="num">{groupNumber(c.avgViews)} avg views</span>}
        />
      ),
    },
    {
      key: 'performance',
      header: 'Published / earned',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (c) => (
        <TwoLine
          primary={<span className="num">{groupNumber(c.totalAdsPublished)} ads</span>}
          secondary={<span className="num">{formatMoney(c.totalEarnedCents)}</span>}
        />
      ),
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (c) => <Mono>{formatMoney(c.adPriceCents)} / post</Mono>,
    },
    {
      key: 'bot',
      header: 'Bot access',
      hideBelow: 'lg',
      render: (c) =>
        channelApproveBlockedReason(c) ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-danger">
            <Icon name="alert" size={13} />
            Missing rights
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-ok">
            <Icon name="check" size={13} />
            Can post
          </span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;

        const blockedReason = channelApproveBlockedReason(c);
        const actions: RowAction[] = channelActionsFor(c.status).map((a) => ({
          key: a,
          label: ACTION_LABELS[a] ?? a,
          danger: a === 'REJECT' || a === 'SUSPEND',
          disabledReason: a === 'APPROVE' ? blockedReason : null,
          confirmTitle: `${ACTION_LABELS[a] ?? a} “${c.title}”?`,
          confirmDescription:
            a === 'APPROVE'
              ? 'The channel becomes eligible for sponsored delivery and appears in the marketplace.'
              : a === 'SUSPEND'
                ? 'Delivery stops and every queued job on this channel is cancelled.'
                : a === 'REACTIVATE'
                  ? 'The channel goes back to APPROVED and can receive ads again.'
                  : 'The owner is notified with your note.',
          fields: [
            {
              name: 'note',
              label: a === 'REJECT' ? 'Reason' : 'Note',
              type: 'textarea',
              required: a === 'REJECT',
              hint:
                a === 'REJECT'
                  ? 'Stored as the rejection reason and sent to the owner. The API refuses an empty one.'
                  : 'Optional.',
              maxLength: 500,
            },
          ],
          run: (values) => channelAction(c.id, a, values.note),
          successMessage: `Channel ${(ACTION_LABELS[a] ?? a).toLowerCase()}d`,
        }));

        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Channels"
        description="Publisher inventory, its review state, and whether the bot can actually post there."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={15} />}
            onClick={() => void query.refetch()}
          >
            Refresh
          </Button>
        }
      />

      <ListFilters
        sortable="channels"
        value={{ from, to, sort }}
        onChange={(next) => patch({ from: next.from, to: next.to, sort: next.sort, page: '1' })}
        onReset={() => patch({ from: null, to: null, sort: null, page: '1' })}
        busy={query.isFetching}
      >
        <Select
          label="Status"
          className="max-w-56"
          placeholder="All statuses"
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: '1' })}
          options={statusOptions(CHANNEL_STATUSES)}
        />
        {status ? (
          <Button variant="ghost" size="sm" onClick={() => patch({ status: null, page: '1' })}>
            Clear filter
          </Button>
        ) : null}
      </ListFilters>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(c) => c.id}
          emptyTitle="No channels match"
          emptyMessage={status ? `Nothing in ${status}.` : 'No publisher has added a channel yet.'}
        />
        {query.data ? (
          <TableFooter>
            <Pager
              page={query.data.page}
              limit={query.data.limit}
              total={query.data.total}
              hasMore={query.data.hasMore}
              busy={query.isFetching}
              onPage={(p) => patch({ page: String(p) })}
            />
          </TableFooter>
        ) : null}
      </QueryState>

      <Section
        className="mt-8"
        title="Removed ad posts"
        description="Posts Telegram refused, grouped by the error code the delivery worker recorded. A code that keeps appearing is a channel problem, not a campaign problem."
      >
        <QueryState
          isPending={blocked.isPending}
          isError={blocked.isError}
          error={blocked.error}
          onRetry={() => void blocked.refetch()}
          skeletonRows={2}
        >
          {blocked.data ? (
            blocked.data.total === 0 ? (
              <div className="bg-surface border border-line rounded-2xl p-4 text-sm text-mute">
                No posts have been removed.
              </div>
            ) : (
              <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm font-semibold">Total removed</span>
                  <span className="num text-sm font-bold">{groupNumber(blocked.data.total)}</span>
                </div>
                {Object.entries(blocked.data.byErrorCode)
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, count]) => (
                    <div key={code} className="flex items-center justify-between px-4 py-2.5">
                      <span className="num text-xs">{code}</span>
                      <span className="num text-sm">{groupNumber(count)}</span>
                    </div>
                  ))}
              </div>
            )
          ) : null}
        </QueryState>
      </Section>
    </>
  );
}
