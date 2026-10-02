/**
 * Ledger — every transaction across every account, newest first.
 *
 * Read-only on purpose: the ledger is append-only and no admin route updates or
 * deletes a transaction. Corrections are made with a compensating entry
 * (`POST /admin/users/adjust-balance`), which the user dossier offers — so this
 * screen links out to it rather than pretending to be editable.
 *
 * `userId` can be preset from the URL, which is how the user dossier links here.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Money } from '../../components/ui/Money';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { listTransactions } from '../lib/api';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import { TRANSACTION_TYPES, statusOptions } from '../lib/actions';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AdminTransactionRow } from '../lib/types';

const LIMIT = 25;

export function AdminLedgerPage() {
  const [params, setParams] = useSearchParams();
  const userId = params.get('userId') ?? '';
  const type = params.get('type') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  // '' → no `sort` param → the server's own default (newest first). We never
  // inject a default sort key here, so the ledger's ordering is unchanged.
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const [userInput, setUserInput] = useState(userId);
  useEffect(() => {
    setUserInput(userId);
  }, [userId]);

  const query = useQuery({
    queryKey: [...qk.adminTransactions, { userId, type, from, to, sort, page }],
    queryFn: () =>
      listTransactions({
        userId: userId || undefined,
        type: type || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const columns: Column<AdminTransactionRow>[] = [
    {
      key: 'type',
      header: 'Type',
      render: (t) => (
        <TwoLine
          primary={t.type}
          secondary={t.description ? <span className="text-xs">{t.description}</span> : undefined}
        />
      ),
    },
    {
      key: 'user',
      header: 'User',
      render: (t) => (
        <Link
          to={`/admin/users/${t.userId}`}
          className="text-sm hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {t.userName}
        </Link>
      ),
    },
    {
      key: 'reference',
      header: 'Reference',
      hideBelow: 'lg',
      render: (t) => <Mono title={t.reference}>{t.reference.slice(0, 22)}</Mono>,
    },
    {
      key: 'status',
      header: 'Status',
      hideBelow: 'md',
      render: (t) => <StatusBadge status={t.status} />,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      nowrap: true,
      render: (t) => (
        <span className="num text-sm font-medium">
          <Money cents={t.amountCents} currency={t.currency} signed />
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: 'Balance after',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (t) => (
        <span className="num text-xs text-mute">
          <Money cents={t.balanceAfter} currency={t.currency} />
        </span>
      ),
    },
    {
      key: 'created',
      header: 'When',
      align: 'right',
      nowrap: true,
      render: (t) => <span className="text-xs text-mute">{formatDateTime(t.createdAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Ledger"
        description="Append-only record of every money movement. No admin route edits or deletes a transaction by design — corrections are compensating entries made from the user dossier."
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
        sortable="transactions"
        value={{ from, to, sort }}
        onChange={(next) => patch({ from: next.from, to: next.to, sort: next.sort, page: '1' })}
        onReset={() => patch({ from: null, to: null, sort: null, page: '1' })}
        busy={query.isFetching}
      >
        <Select
          label="Type"
          className="max-w-56"
          placeholder="All types"
          value={type}
          onChange={(e) => patch({ type: e.target.value, page: '1' })}
          options={statusOptions(TRANSACTION_TYPES)}
        />
        <Input
          label="User id"
          className="max-w-72"
          placeholder="Filter by a user's internal id"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onBlur={() => patch({ userId: userInput.trim() || null, page: '1' })}
        />
        {type || userId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUserInput('');
              patch({ type: null, userId: null, page: '1' });
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </ListFilters>

      {userId ? (
        <p className="text-xs text-mute mb-3">
          Filtered to user <Mono>{userId}</Mono>.{' '}
          <Link to={`/admin/users/${userId}`} className="text-link hover:underline">
            Open the dossier
          </Link>
        </p>
      ) : null}

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(t) => t.id}
          emptyTitle="No transactions"
          emptyMessage={type || userId ? 'Nothing matches these filters.' : 'No money has moved yet.'}
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
