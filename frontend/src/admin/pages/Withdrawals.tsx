/**
 * Withdrawals — the payout queue.
 *
 * Money has already left the wallet by the time the request exists, so the three
 * actions mean something narrower than they look:
 *   APPROVE   marks a PENDING row for payout. No money moves.
 *   REJECT    refunds principal + fee through the ledger (reference
 *             `withdrawal:refund:<id>`, so it can only happen once). A reason is
 *             mandatory — the API refuses an empty one.
 *   MARK_PAID records the off-platform transfer as proof, so `txRef` is
 *             mandatory. It is the only place the payout reference is stored,
 *             which is why the dialog treats it as required and cannot be
 *             overwritten later.
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
import { listWithdrawals, withdrawalAction } from '../lib/api';
import { WITHDRAWAL_STATUSES, statusOptions, withdrawalActionsFor } from '../lib/actions';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminWithdrawalRow } from '../lib/types';

const LIMIT = 20;

export function AdminWithdrawalsPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const query = useQuery({
    queryKey: [...qk.adminWithdrawals, { status, from, to, sort, page }],
    queryFn: () =>
      listWithdrawals({
        status: status || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const canManage = can('withdrawals.manage');

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminWithdrawals });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
    void queryClient.invalidateQueries({ queryKey: qk.adminTransactions });
  };

  const columns: Column<AdminWithdrawalRow>[] = [
    {
      key: 'user',
      header: 'User',
      render: (w) => (
        <TwoLine primary={w.userName} secondary={<Mono title={w.id}>{w.id.slice(0, 10)}…</Mono>} />
      ),
    },
    {
      key: 'method',
      header: 'Method',
      hideBelow: 'md',
      render: (w) => <span className="text-sm">{w.method}</span>,
    },
    {
      key: 'amount',
      header: 'Amount / net',
      align: 'right',
      nowrap: true,
      render: (w) => (
        <div className="text-right num text-sm">
          <div>
            <Money cents={w.amountCents} />
          </div>
          <div className="text-xs text-mute">
            net <Money cents={w.netAmountCents} />
          </div>
        </div>
      ),
    },
    {
      key: 'account',
      header: 'Destination',
      hideBelow: 'lg',
      render: (w) =>
        w.accountMasked ? (
          <Mono>{w.accountMasked}</Mono>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (w) => (
        <span className="inline-flex flex-col items-start gap-1">
          <StatusBadge status={w.status} />
          {w.status === 'REJECTED' && w.rejectReason ? (
            <span className="text-[10px] text-mute max-w-40 truncate" title={w.rejectReason}>
              {w.rejectReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Requested',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (w) => <span className="text-xs text-mute">{formatDateTime(w.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (w) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;
        const available = withdrawalActionsFor(w.status);
        if (available.length === 0) return <span className="text-xs text-mute">—</span>;

        const actions: RowAction[] = available.map((a) => {
          if (a === 'APPROVE') {
            return {
              key: a,
              label: 'Approve',
              confirmTitle: `Approve this payout to ${w.userName}?`,
              confirmDescription:
                'The withdrawal is marked APPROVED and enters the payout queue. No money moves at this step — the wallet was debited when the request was made.',
              confirmLabel: 'Approve',
              fields: [{ name: 'note', label: 'Note', hint: 'Optional.', maxLength: 500 }],
              run: (values) => withdrawalAction(w.id, 'APPROVE', { note: values.note }),
              successMessage: 'Withdrawal approved',
            };
          }
          if (a === 'MARK_PROCESSING') {
            return {
              key: a,
              label: 'Mark processing',
              confirmTitle: 'Mark the payout as in-flight?',
              confirmDescription:
                'The withdrawal is moved to PROCESSING. The user gets a notification that their money is on the way, and the off-platform reference becomes the proof of intent. You will still need to "Mark as paid" once the transfer clears.',
              confirmLabel: 'Mark as processing',
              fields: [
                {
                  name: 'payoutRef',
                  label: 'Payout reference',
                  required: true,
                  maxLength: 128,
                  mono: true,
                  hint: 'Anything that identifies the in-flight payout: txid, batch id, bank slip number.',
                },
              ],
              run: (values) =>
                withdrawalAction(w.id, 'MARK_PROCESSING', { payoutRef: values.payoutRef }),
              successMessage: 'Withdrawal marked as processing',
            };
          }
          if (a === 'REJECT') {
            return {
              key: a,
              label: 'Reject',
              danger: true,
              confirmTitle: 'Reject this withdrawal?',
              confirmDescription:
                'The full amount — principal plus fee — is refunded to the user’s available balance through the ledger. The refund is keyed on the withdrawal id, so it can only be applied once.',
              confirmLabel: 'Reject & refund',
              fields: [
                {
                  name: 'note',
                  label: 'Reason',
                  type: 'textarea',
                  required: true,
                  maxLength: 500,
                  hint: 'Sent to the user. Required by the API.',
                },
              ],
              run: (values) => withdrawalAction(w.id, 'REJECT', { note: values.note }),
              successMessage: 'Withdrawal rejected and refunded',
            };
          }
          return {
            key: a,
            label: 'Mark paid',
            confirmTitle: 'Record the payout transfer',
            confirmDescription:
              'The withdrawal is marked PAID and this reference becomes the proof of the off-platform transfer. It cannot be overwritten later, so enter the real transaction id.',
            confirmLabel: 'Mark as paid',
            fields: [
              {
                name: 'txRef',
                label: 'Payout transaction reference',
                required: true,
                maxLength: 128,
                mono: true,
                hint: 'On-chain txid or the payout provider’s id.',
              },
            ],
            run: (values) => withdrawalAction(w.id, 'MARK_PAID', { txRef: values.txRef }),
            successMessage: 'Withdrawal marked as paid',
          };
        });

        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Withdrawals"
        description="Requests are already debited from the wallet, so approving is a promise to pay and marking paid is the record that you did."
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
        sortable="withdrawals"
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
          options={statusOptions(WITHDRAWAL_STATUSES)}
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
          rowKey={(w) => w.id}
          emptyTitle="No withdrawals"
          emptyMessage={status ? `Nothing in ${status}.` : 'No withdrawal requests yet.'}
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
