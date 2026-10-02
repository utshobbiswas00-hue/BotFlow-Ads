/**
 * Deposits.
 *
 * VERIFY is the only way money enters a wallet from a deposit, and it is
 * idempotent on the ledger reference `deposit:<id>` — so a second click, or a
 * gateway webhook racing the same admin action, cannot credit twice. REJECT
 * requires a note: the API refuses an empty one.
 */
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { depositAction, listDeposits } from '../lib/api';
import { DEPOSIT_STATUSES, depositActionsFor, statusOptions } from '../lib/actions';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminDepositRow } from '../lib/types';

const LIMIT = 20;

export function AdminDepositsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const query = useQuery({
    queryKey: [...qk.adminDeposits, { status, from, to, sort, page }],
    queryFn: () =>
      listDeposits({
        status: status || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const canManage = can('deposits.manage');

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminDeposits });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
    void queryClient.invalidateQueries({ queryKey: qk.adminTransactions });
  };

  const columns: Column<AdminDepositRow>[] = [
    {
      key: 'user',
      header: 'User',
      render: (d) => (
        <TwoLine primary={d.userName} secondary={<Mono title={d.id}>{d.id.slice(0, 10)}…</Mono>} />
      ),
    },
    { key: 'method', header: 'Method', render: (d) => <span className="text-sm">{d.method}</span> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      nowrap: true,
      render: (d) => (
        <span className="num text-sm font-medium">
          <Money cents={d.amountCents} />
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.status} /> },
    {
      key: 'proof',
      header: 'Proof',
      hideBelow: 'lg',
      render: (d) =>
        d.proofUrl ? (
          <a
            href={d.proofUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-link hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <Icon name="external" size={13} />
            Open
          </a>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (d) => <span className="text-xs text-mute">{formatDateTime(d.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;
        const available = depositActionsFor(d.status);
        if (available.length === 0) return <span className="text-xs text-mute">—</span>;

        const actions: RowAction[] = available.map((a) => ({
          key: a,
          label: a === 'VERIFY' ? 'Verify' : 'Reject',
          danger: a === 'REJECT',
          confirmTitle: a === 'VERIFY' ? `Credit ${d.userName}’s deposit?` : 'Reject this deposit?',
          confirmDescription:
            a === 'VERIFY'
              ? 'The deposit is marked VERIFIED and the amount is credited to the wallet through the ledger. Idempotent — crediting the same deposit twice is a no-op, not a double credit.'
              : 'The deposit is marked REJECTED and nothing is credited. A note is mandatory.',
          confirmLabel: a === 'VERIFY' ? 'Verify & credit' : 'Reject',
          fields: [
            {
              name: 'note',
              label: a === 'VERIFY' ? 'Note' : 'Reason',
              type: 'textarea',
              required: a === 'REJECT',
              maxLength: 500,
              hint: a === 'VERIFY' ? 'Optional, stored on the deposit row.' : 'Required by the API.',
            },
          ],
          run: (values) => depositAction(d.id, a, values.note),
          successMessage: a === 'VERIFY' ? 'Deposit verified and credited' : 'Deposit rejected',
        }));

        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Deposits"
        description="Every deposit request. Verifying one is what actually moves money into a wallet — and only a PENDING row can be verified or rejected."
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
        sortable="deposits"
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
          options={statusOptions(DEPOSIT_STATUSES)}
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
          rowKey={(d) => d.id}
          emptyTitle="No deposits"
          emptyMessage={status ? `Nothing in ${status}.` : 'No deposits recorded yet.'}
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
