/**
 * Advertisers — the role-scoped list (spec §12).
 *
 * `GET /admin/users?isAdvertiser=true` returns every account that has created at
 * least one campaign. As with Publishers, the role is DERIVED from the
 * relationships server-side (an advertiser has at least one campaign), not read
 * from the cached `User.isAdvertiser` column, so the list cannot go stale: an
 * account enters when its first campaign is created and leaves when its last one
 * is removed.
 *
 * ── Why some obvious columns are missing ───────────────────────────────────
 * The endpoint returns `AdminUserRow` (a `UserProfile` plus the wallet
 * `balanceCents`, see `../lib/types.ts`). That shape carries the account's money
 * totals but NO per-advertiser campaign counts and NO active/budget aggregates —
 * those are computed per campaign, not per user, by the analytics endpoints.
 * Rather than invent a "campaigns" column from a page of 20 rows (which would be
 * a per-page count presented as a lifetime total), the table renders only the
 * fields the API actually returns. Campaign-level numbers live on the Campaigns
 * screen and on each user's dossier.
 *
 * The search box is debounced and mirrored into the URL, and the status filter
 * is URL-backed too, matching the other list screens.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { displayName, formatDate, groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { useDebounce } from '../../hooks/useDebounce';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { listUsers } from '../lib/api';
import { statusOptions } from '../lib/actions';
import { ListFilters, dateRangeParams, type ListFiltersValue } from '../components/ListFilters';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AdminUserRow } from '../lib/types';

const LIMIT = 20;

/** The account statuses a user filter can hold. Mirrors the server enum. */
const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING'] as const;

export function AdvertisersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounce(search, 350);
  const status = params.get('status') ?? '';
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
    queryKey: [
      ...qk.adminUsers,
      'advertisers',
      { search: debounced.trim(), status, from, to, sort, page },
    ],
    queryFn: () =>
      listUsers({
        isAdvertiser: true,
        search: debounced,
        status: status || undefined,
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

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  // Writes only the params the ListFilters control owns; the debounced search
  // lives in its own effect above and is left alone.
  const setFilters = (next: ListFiltersValue): void => {
    patch({ from: next.from, to: next.to, sort: next.sort, page: '1' });
  };

  const columns: Column<AdminUserRow>[] = [
    {
      key: 'advertiser',
      header: 'Advertiser',
      render: (u) => (
        <TwoLine
          primary={displayName(u)}
          secondary={u.username ? `@${u.username.replace(/^@/, '')}` : 'no username'}
        />
      ),
    },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    {
      key: 'spent',
      header: 'Total spent',
      align: 'right',
      nowrap: true,
      render: (u) => (
        <span className="num text-sm">
          <Money cents={u.totalSpentCents} />
        </span>
      ),
    },
    {
      key: 'deposited',
      header: 'Deposited',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (u) => (
        <span className="num text-sm text-mute">
          <Money cents={u.totalDepositedCents} />
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
        title="Advertisers"
        description="Accounts that have created at least one campaign, newest first. Open a row for the full dossier: balance, channels, campaigns and the last 20 money movements."
      />

      <p className="flex items-start gap-2 text-xs text-mute mb-4 max-w-3xl">
        <Icon name="info" size={14} className="mt-0.5 shrink-0" />
        <span>
          Membership is derived from the relationships: an advertiser is a user with at least one
          campaign, not a stored flag. An account appears here when its first campaign is created
          and leaves the list when its last campaign is removed.
        </span>
      </p>

      <ListFilters
        sortable="users"
        value={{ from, to, sort }}
        onChange={setFilters}
        onReset={() => patch({ from: null, to: null, sort: null, page: '1' })}
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
        <Select
          label="Status"
          className="max-w-44"
          placeholder="All statuses"
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: '1' })}
          options={statusOptions(USER_STATUSES)}
        />
        {status ? (
          <Button variant="ghost" size="sm" onClick={() => patch({ status: null, page: '1' })}>
            Clear status
          </Button>
        ) : null}
        <span className="text-xs text-mute mb-2.5 ml-auto num">
          {query.data ? `${groupNumber(query.data.total)} advertisers` : ''}
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
          emptyTitle="No advertisers found"
          emptyMessage={
            debounced.trim()
              ? `Nothing matches “${debounced.trim()}”.`
              : status
                ? `No advertisers are ${status.toLowerCase()}.`
                : 'No account has created a campaign yet.'
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
