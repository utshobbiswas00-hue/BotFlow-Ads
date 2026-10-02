/**
 * Campaigns — every campaign on the platform, with the admin override actions.
 *
 * The admin API exposes no campaign detail endpoint (the advertiser's
 * `/campaigns/:id` is ownership-scoped and refuses another account), so the table
 * carries the columns needed to make a review decision and the actions are
 * performed from the row. `GET /admin/campaigns` returns `CAMPAIGN_SELECT`,
 * which is where these fields come from.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatMoney } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { campaignAction, listCampaigns } from '../lib/api';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import {
  CAMPAIGN_ACTION_DANGER,
  CAMPAIGN_ACTION_LABELS,
  CAMPAIGN_ACTION_NOTE_HINT,
  CAMPAIGN_ACTION_NOTE_REQUIRED,
  CAMPAIGN_STATUSES,
  campaignActionsFor,
  statusOptions,
} from '../lib/actions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminCampaignRow } from '../lib/types';

const LIMIT = 20;

export function AdminCampaignsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const query = useQuery({
    queryKey: [...qk.adminCampaigns, { status, from, to, sort, page }],
    queryFn: () =>
      listCampaigns({
        status: status || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const canManage = can('campaigns.manage');

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminCampaigns });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
  };

  const columns: Column<AdminCampaignRow>[] = [
    {
      key: 'name',
      header: 'Campaign',
      render: (c) => (
        <TwoLine
          primary={
            <Link
              to={`/admin/campaigns/${encodeURIComponent(c.id)}/analytics`}
              className="text-link hover:underline"
              title="Open per-campaign analytics"
            >
              {c.name}
            </Link>
          }
          secondary={<Mono title={c.id}>{c.id.slice(0, 10)}…</Mono>}
        />
      ),
    },
    {
      key: 'advertiser',
      header: 'Advertiser',
      hideBelow: 'md',
      render: (c) => <span className="text-sm">{c.advertiserName}</span>,
    },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      nowrap: true,
      render: (c) => (
        <div className="inline-block text-right">
          <div className="num text-sm">
            <Money cents={c.budgetSpentCents} />
            <span className="text-mute"> / </span>
            <Money cents={c.budgetTotalCents} />
          </div>
          <BudgetBar
            spent={c.budgetSpentCents}
            total={c.budgetTotalCents}
            reserved={c.budgetReservedCents}
          />
        </div>
      ),
    },
    {
      key: 'pricing',
      header: 'Pricing',
      hideBelow: 'lg',
      render: (c) => <TwoLine primary={c.pricingModel} secondary={`${c.frequencyPerChannel}× per channel`} />,
    },
    {
      key: 'window',
      header: 'Window',
      hideBelow: 'lg',
      render: (c) => (
        <span className="text-xs text-mute whitespace-nowrap">
          {formatDate(c.startAt)} → {formatDate(c.endAt)}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      hideBelow: 'md',
      nowrap: true,
      render: (c) => <span className="text-xs text-mute">{formatDate(c.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;

        const actions: RowAction[] = campaignActionsFor(c.status).map((a) => ({
          key: a,
          label: CAMPAIGN_ACTION_LABELS[a],
          danger: CAMPAIGN_ACTION_DANGER[a],
          confirmTitle: `${CAMPAIGN_ACTION_LABELS[a]} “${c.name}”?`,
          confirmDescription:
            a === 'APPROVE'
              ? 'The campaign is approved and its delivery jobs are queued. The advertiser is notified.'
              : a === 'SUSPEND'
                ? 'Delivery stops immediately and every job that has not started is cancelled.'
                : `Current state ${c.status}. The campaign moves to ${
                    a === 'REJECT'
                      ? 'REJECTED'
                      : a === 'CANCEL'
                        ? 'CANCELLED'
                        : a === 'PAUSE'
                          ? 'PAUSED'
                          : 'RUNNING'
                  }.`,
          confirmLabel: CAMPAIGN_ACTION_LABELS[a],
          fields: [
            {
              name: 'note',
              label: 'Note',
              type: 'textarea',
              required: CAMPAIGN_ACTION_NOTE_REQUIRED[a],
              hint: CAMPAIGN_ACTION_NOTE_HINT[a],
              maxLength: 500,
            },
          ],
          run: (values) => campaignAction(c.id, a, values.note),
          successMessage: `Campaign ${CAMPAIGN_ACTION_LABELS[a].toLowerCase()}d`,
        }));

        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Campaigns"
        description="Every campaign, newest first. Actions mirror the campaign state machine — a button is only offered for a transition the API will actually accept."
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
        sortable="campaigns"
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
          options={statusOptions(CAMPAIGN_STATUSES)}
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
          emptyTitle="No campaigns match"
          emptyMessage={status ? `Nothing in ${status}.` : 'No campaigns have been created yet.'}
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
    </>
  );
}

/** Spent-vs-total bar. Reserved (escrowed, not yet spent) is the lighter band. */
function BudgetBar({ spent, total, reserved }: { spent: number; total: number; reserved: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;
  const reservedPct = total > 0 ? Math.min(100 - pct, Math.round((reserved / total) * 100)) : 0;
  return (
    <div className="mt-1.5 w-full min-w-28">
      <div className="h-1.5 rounded-full bg-line overflow-hidden flex">
        <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
        <div className="h-full bg-mute/50" style={{ width: `${reservedPct}%` }} />
      </div>
      <div className="text-[10px] text-mute mt-0.5 num" title={`reserved ${formatMoney(reserved)}`}>
        {pct}% spent
      </div>
    </div>
  );
}
