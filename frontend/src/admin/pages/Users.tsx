/**
 * Users — search and open a full dossier.
 *
 * `GET /admin/users` searches username / first / last name and Telegram id (the
 * id match is a cast-to-text LIKE on the server, because a BigInt column cannot
 * be "contains"-matched through Prisma). The search box is debounced so typing
 * does not fire a query per keystroke, and the committed term is mirrored into
 * the URL so a search is shareable and survives a reload.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { displayName, formatDate, groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { useDebounce } from '../../hooks/useDebounce';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { listUsers } from '../lib/api';
import { ListFilters, dateRangeParams, type ListFiltersValue } from '../components/ListFilters';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AdminUserRow } from '../lib/types';

const LIMIT = 20;

export function AdminUsersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounce(search, 350);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  useEffect(() => {
    const current = params.get('search') ?? '';
    if (debounced === current) return;
    const merged = new URLSearchParams(params);
    if (debounced.trim()) merged.set('search', debounced.trim());
    else merged.delete('search');
    merged.set('page', '1');
    setParams(merged, { replace: true });
    // Keyed on the debounced term; `params` identity changes on every write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = useQuery({
    queryKey: [...qk.adminUsers, { search: debounced.trim(), from, to, sort, page }],
    queryFn: () =>
      listUsers({
        search: debounced,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });

  const setPage = (p: number): void => {
    const merged = new URLSearchParams(params);
    merged.set('page', String(p));
    setParams(merged, { replace: true });
  };

  // Writes only the params the ListFilters control owns; the debounced search
  // lives in its own effect above and is left alone.
  const setFilters = (next: ListFiltersValue): void => {
    const merged = new URLSearchParams(params);
    for (const key of ['from', 'to', 'sort'] as const) {
      const v = next[key];
      if (v) merged.set(key, v);
      else merged.delete(key);
    }
    merged.set('page', '1');
    setParams(merged, { replace: true });
  };

  const resetFilters = (): void => {
    const merged = new URLSearchParams(params);
    merged.delete('from');
    merged.delete('to');
    merged.delete('sort');
    merged.set('page', '1');
    setParams(merged, { replace: true });
  };

  const columns: Column<AdminUserRow>[] = [
    {
      key: 'user',
      header: 'User',
      render: (u) => (
        <TwoLine
          primary={
            <span className="inline-flex items-center gap-1.5">
              {displayName(u)}
              {u.isAdmin ? <StatusBadge status={u.adminRole ?? 'ADMIN'} /> : null}
            </span>
          }
          secondary={u.username ? `@${u.username.replace(/^@/, '')}` : 'no username'}
        />
      ),
    },
    {
      key: 'telegramId',
      header: 'Telegram ID',
      hideBelow: 'md',
      nowrap: true,
      render: (u) => <Mono>{u.telegramId}</Mono>,
    },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    {
      key: 'roles',
      header: 'Roles',
      hideBelow: 'lg',
      render: (u) => (
        <span className="text-xs text-mute">
          {[u.isAdvertiser && 'Advertiser', u.isPublisher && 'Publisher'].filter(Boolean).join(' · ') ||
            '—'}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      nowrap: true,
      render: (u) => (
        <div className="text-right">
          <div className="num text-sm font-medium">
            <Money cents={u.balanceCents} />
          </div>
          <div className="text-[10px] text-mute">available</div>
        </div>
      ),
    },
    {
      key: 'totals',
      header: 'Spent / earned',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (u) => (
        <div className="text-xs num text-mute">
          <div>
            <Money cents={u.totalSpentCents} />
          </div>
          <div>
            <Money cents={u.totalEarnedCents} />
          </div>
        </div>
      ),
    },
    {
      key: 'joined',
      header: 'Joined',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (u) => <span className="text-xs text-mute">{formatDate(u.createdAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Users"
        description="Search by name, @username or Telegram id. Open a row for the full dossier: balance, channels, campaigns and the last 20 money movements."
      />

      <ListFilters
        sortable="users"
        value={{ from, to, sort }}
        onChange={setFilters}
        onReset={resetFilters}
        busy={query.isFetching}
      >
        <Input
          label="Search"
          className="max-w-md"
          icon="search"
          placeholder="Name, @username or Telegram id"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search ? (
          <Button variant="ghost" size="sm" onClick={() => setSearch('')}>
            Clear
          </Button>
        ) : null}
        <span className="text-xs text-mute mb-2.5 ml-auto num">
          {query.data ? `${groupNumber(query.data.total)} matches` : ''}
        </span>
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
          rowKey={(u) => u.id}
          onRowClick={(u) => navigate(`/admin/users/${u.id}`)}
          emptyTitle="No users found"
          emptyMessage={
            debounced.trim() ? `Nothing matches “${debounced.trim()}”.` : 'No accounts yet.'
          }
        />
        {query.data ? (
          <TableFooter>
            <Pager
              page={query.data.page}
              limit={query.data.limit}
              total={query.data.total}
              hasMore={query.data.hasMore}
              busy={query.isFetching}
              onPage={setPage}
            />
            <span className="inline-flex items-center gap-1.5">
              <Icon name="info" size={13} />
              Click a row to open the dossier
            </span>
          </TableFooter>
        ) : null}
      </QueryState>
    </>
  );
}
