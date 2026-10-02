/**
 * Error log (spec §84).
 *
 * What this shows: server-side failures the API actually recorded — 5xx responses
 * and unhandled errors — with the code to grep for, the route it happened on, and
 * the request id to correlate with the log drain.
 *
 * What it deliberately does NOT show, and why the page says so out loud:
 *  - 4xx rejections. A validation 400 is not an incident; persisting every one
 *    would bury the real failures, so they are logged but not stored.
 *  - headers, cookies, bodies and query strings. Those carry initData, session
 *    cookies and payment payloads, and this screen is read by more people than
 *    the database is. The service cannot accept them at all.
 */
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDateTime, fromNow } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import { listErrorLogs } from '../lib/api';
import type { ErrorLogRow } from '../lib/types';

const LIMIT = 50;

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'HTTP', label: 'HTTP' },
  { value: 'DATABASE', label: 'Database' },
  { value: 'WORKER', label: 'Worker' },
  { value: 'TELEGRAM', label: 'Telegram' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'WEBHOOK', label: 'Webhook' },
];

const LEVEL_OPTIONS = [
  { value: '', label: 'All levels' },
  { value: 'ERROR', label: 'Error' },
  { value: 'WARN', label: 'Warning' },
];

export function ErrorsPage() {
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const source = params.get('source') ?? '';
  const level = params.get('level') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const query = useQuery({
    queryKey: [...qk.adminErrors, { page, source, level, from, to }],
    queryFn: () => listErrorLogs({ page, limit: LIMIT, source, level, from, to }),
    placeholderData: (prev) => prev,
  });

  /** Any filter change resets to page 1 — staying on page 7 of a new filter shows nothing. */
  function update(patch: Record<string, string>): void {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  }

  const rows = query.data?.items ?? [];
  const hasFilters = Boolean(source || level || from || to);

  const columns: Column<ErrorLogRow>[] = [
    {
      key: 'when',
      header: 'When',
      nowrap: true,
      render: (e) => (
        <TwoLine
          primary={<span title={formatDateTime(e.createdAt)}>{fromNow(e.createdAt)}</span>}
          secondary={<span className="text-mute text-[11px]">{formatDateTime(e.createdAt)}</span>}
        />
      ),
    },
    {
      key: 'level',
      header: 'Level',
      nowrap: true,
      render: (e) => <StatusBadge status={e.level === 'WARN' ? 'WARNING' : e.level} />,
    },
    {
      key: 'source',
      header: 'Source',
      nowrap: true,
      render: (e) => <span className="text-xs">{e.source}</span>,
    },
    {
      key: 'code',
      header: 'Code',
      nowrap: true,
      render: (e) => (e.code ? <Mono>{e.code}</Mono> : <span className="text-xs text-mute">—</span>),
    },
    {
      key: 'message',
      header: 'Message',
      render: (e) => (
        <span className="block max-w-[46ch] truncate text-xs" title={e.message}>
          {e.message}
        </span>
      ),
    },
    {
      key: 'context',
      header: 'Where',
      hideBelow: 'lg',
      render: (e) =>
        e.context ? (
          <Mono>{e.context}</Mono>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'who',
      header: 'Actor',
      align: 'right',
      hideBelow: 'lg',
      render: (e) => (
        <div className="text-right">
          {e.userId ? (
            <Link
              to={`/admin/users/${encodeURIComponent(e.userId)}`}
              className="text-link text-xs hover:underline"
            >
              {e.userId.slice(0, 10)}…
            </Link>
          ) : (
            <span className="text-xs text-mute">—</span>
          )}
          {e.requestId ? (
            <p className="text-[11px] text-mute" title={e.requestId}>
              req {e.requestId.slice(0, 8)}
            </p>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Error log"
        description="Server failures the API recorded — 5xx responses and unhandled errors. 4xx rejections are logged to the log drain but not stored here, and request headers, bodies and query strings are never persisted because they carry session cookies and payment payloads. Read the correlation id to find the full trace."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Source"
              value={source}
              options={SOURCE_OPTIONS}
              onChange={(e) => update({ source: e.target.value })}
            />
            <Select
              label="Level"
              value={level}
              options={LEVEL_OPTIONS}
              onChange={(e) => update({ level: e.target.value })}
            />
            <Input
              label="From"
              type="date"
              value={from}
              onChange={(e) => update({ from: e.target.value })}
            />
            <Input
              label="To"
              type="date"
              value={to}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        }
      />

      {hasFilters ? (
        <p className="text-xs text-mute mb-3">
          Filtered view.{' '}
          <button
            type="button"
            className="text-link hover:underline"
            onClick={() => setParams(new URLSearchParams())}
          >
            Clear filters
          </button>
        </p>
      ) : null}

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        isEmpty={rows.length === 0}
        emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No errors recorded'}
        emptyMessage={
          hasFilters
            ? 'Widen or clear the filters above.'
            : 'Nothing has failed yet since the error log was introduced. 4xx rejections never appear here by design.'
        }
      >
        <DataTable rows={rows} columns={columns} rowKey={(e) => e.id} />
        <TableFooter>
          <Pager
            page={query.data?.page ?? page}
            limit={query.data?.limit ?? LIMIT}
            total={query.data?.total ?? 0}
            hasMore={query.data?.hasMore ?? false}
            onPage={(p) => update({ page: String(p) })}
          />
        </TableFooter>
      </QueryState>
    </>
  );
}
