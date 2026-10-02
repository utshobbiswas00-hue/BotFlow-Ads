/**
 * API logs (spec §27).
 *
 * The honest description, which the page states rather than implies: this is a
 * merged view of the failure records that already exist — `error_logs` rows for
 * Telegram / payment / webhook sources, `delivery_events` for ad-post failures,
 * and `webhook_deliveries` for outbound webhook failures.
 *
 * It is NOT a transport-level request log. Outbound Telegram HTTP calls are not
 * recorded per request anywhere in this codebase, so a screen claiming to be one
 * would be inventing data. What it does answer is "what is failing, and why",
 * from records that were actually written.
 */
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, fromNow } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import { listApiLogs } from '../lib/api';
import type { ApiLogRow } from '../lib/types';

const LIMIT = 50;

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'TELEGRAM', label: 'Telegram' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'WEBHOOK', label: 'Webhook' },
];

export function ApiLogsPage() {
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const source = params.get('source') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const query = useQuery({
    queryKey: [...qk.adminApiLogs, { page, source, from, to }],
    queryFn: () => listApiLogs({ page, limit: LIMIT, source, from, to }),
    placeholderData: (prev) => prev,
  });

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
  const hasFilters = Boolean(source || from || to);

  const columns: Column<ApiLogRow>[] = [
    {
      key: 'when',
      header: 'When',
      nowrap: true,
      render: (l) => (
        <TwoLine
          primary={<span title={formatDateTime(l.createdAt)}>{fromNow(l.createdAt)}</span>}
          secondary={<span className="text-mute text-[11px]">{formatDateTime(l.createdAt)}</span>}
        />
      ),
    },
    {
      key: 'source',
      header: 'Source',
      nowrap: true,
      render: (l) => <StatusBadge status={l.source === 'TELEGRAM' ? 'ACTIVE' : l.source} />,
    },
    {
      key: 'code',
      header: 'Code',
      nowrap: true,
      render: (l) => (l.code ? <Mono>{l.code}</Mono> : <span className="text-xs text-mute">—</span>),
    },
    {
      key: 'message',
      header: 'What went wrong',
      render: (l) => (
        <span className="block max-w-[52ch] truncate text-xs" title={l.message}>
          {l.message}
        </span>
      ),
    },
    {
      key: 'context',
      header: 'Where',
      hideBelow: 'lg',
      render: (l) =>
        l.context ? <Mono>{l.context}</Mono> : <span className="text-xs text-mute">—</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="API logs"
        description="Failures from the external calls this product makes: Telegram posting, payment and outbound webhooks. A merged view of the records that exist — not a per-request transport log, because outbound Telegram calls are not logged individually anywhere."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Source"
              value={source}
              options={SOURCE_OPTIONS}
              onChange={(e) => update({ source: e.target.value })}
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

      <Section
        title="Where each row comes from"
        description="So the absence of a row is not mistaken for a healthy call."
      >
        <ul className="text-xs text-mute space-y-1.5">
          <li>
            <strong className="text-ink">Telegram</strong> — ad-post failures recorded on the
            delivery event, with Telegram&rsquo;s own error code. Also any Telegram-sourced server
            error.
          </li>
          <li>
            <strong className="text-ink">Payment</strong> — payment-path server errors. A rejected
            deposit is a normal outcome and is not listed here.
          </li>
          <li>
            <strong className="text-ink">Webhook</strong> — outbound webhook deliveries that failed,
            with the response status when the endpoint answered.
          </li>
          <li>
            A source with no failures shows nothing, which is the correct reading. It does not mean
            no calls were made.
          </li>
        </ul>
      </Section>

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
          {' · '}
          <Link to="/admin/errors" className="text-link hover:underline">
            Every server error instead
          </Link>
        </p>
      ) : null}

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        isEmpty={rows.length === 0}
        emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No external call failures'}
        emptyMessage={
          hasFilters
            ? 'Widen or clear the filters above.'
            : 'Nothing has failed in the sources listed above.'
        }
      >
        <DataTable rows={rows} columns={columns} rowKey={(l) => l.id} />
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
