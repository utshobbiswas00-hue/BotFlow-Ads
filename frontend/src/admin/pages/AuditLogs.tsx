/**
 * Audit log — the append-only trail of admin actions.
 *
 * `GET /admin/settings/audit-logs` returns `{ total, items }`, NOT the usual
 * 5-key paginated envelope, and it pages on `skip`/`take` rather than
 * `page`/`limit`. The controls follow that contract exactly: `take` is capped at
 * 200 by the query schema, so the page-size selector stops at 200.
 */
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { getAuditLogs } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AuditLogEntry } from '../lib/types';

const PAGE_SIZES = [20, 50, 100, 200];

export function AdminAuditLogsPage() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<AuditLogEntry | null>(null);

  const action = params.get('action') ?? '';
  const actorId = params.get('actorId') ?? '';
  const targetType = params.get('targetType') ?? '';
  const take = Math.min(200, Math.max(1, Number(params.get('take')) || 20));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const skip = (page - 1) * take;

  const query = useQuery({
    queryKey: [...qk.adminAuditLogs, { action, actorId, targetType, skip, take }],
    queryFn: () => getAuditLogs({ action, actorId, targetType, skip, take }),
  });

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const columns: Column<AuditLogEntry>[] = [
    {
      key: 'action',
      header: 'Action',
      render: (e) => (
        <TwoLine
          primary={<span className="num text-xs">{e.action}</span>}
          secondary={e.targetType ?? undefined}
        />
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (e) => (
        <TwoLine
          primary={e.actor ? (e.actor.firstName ?? `@${e.actor.username ?? 'unknown'}`) : e.actorType}
          secondary={<Mono>{e.actor?.telegramId ?? e.actorId ?? 'system'}</Mono>}
        />
      ),
    },
    {
      key: 'target',
      header: 'Target id',
      hideBelow: 'lg',
      render: (e) =>
        e.targetId ? (
          <Mono title={e.targetId}>{`${e.targetId.slice(0, 14)}…`}</Mono>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'change',
      header: 'Change',
      hideBelow: 'md',
      render: (e) => (
        <span className="text-xs text-mute">
          {summarize(e.oldValue)} → {summarize(e.newValue)}
        </span>
      ),
    },
    {
      key: 'at',
      header: 'When',
      align: 'right',
      nowrap: true,
      render: (e) => <span className="text-xs text-mute">{formatDateTime(e.createdAt)}</span>,
    },
    {
      key: 'open',
      header: '',
      align: 'right',
      render: (e) => (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            setOpen(e);
          }}
          className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium"
        >
          Details
        </button>
      ),
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Audit log"
        description="Append-only trail of admin actions. Money movements, status overrides and permission changes all land here."
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

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Input
          label="Action"
          className="max-w-56"
          placeholder="e.g. PREMIUM_PLAN_UPSERTED"
          value={action}
          onChange={(e) => patch({ action: e.target.value, page: '1' })}
        />
        <Input
          label="Actor id"
          className="max-w-56"
          placeholder="Acting admin's user id"
          value={actorId}
          onChange={(e) => patch({ actorId: e.target.value, page: '1' })}
        />
        <Input
          label="Target type"
          className="max-w-48"
          placeholder="e.g. CAMPAIGN"
          value={targetType}
          onChange={(e) => patch({ targetType: e.target.value, page: '1' })}
        />
        <Select
          label="Page size"
          className="max-w-32"
          value={String(take)}
          onChange={(e) => patch({ take: e.target.value, page: '1' })}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} rows` }))}
        />
        {action || actorId || targetType ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patch({ action: null, actorId: null, targetType: null, page: '1' })}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={items}
          columns={columns}
          rowKey={(e) => e.id}
          emptyTitle="No audit rows"
          emptyMessage="Nothing matches these filters."
        />
        <TableFooter>
          <span className="num">{groupNumber(total)} rows in total</span>
          <Pager
            page={page}
            limit={take}
            total={total}
            hasMore={skip + items.length < total}
            busy={query.isFetching}
            onPage={(p) => patch({ page: String(p) })}
          />
        </TableFooter>
      </QueryState>

      {open ? (
        <Modal open onClose={() => setOpen(null)} title={open.action}>
          <div className="space-y-3 text-xs">
            <Field label="Actor">
              {open.actor
                ? `${open.actor.firstName ?? ''} @${open.actor.username ?? ''} (${open.actor.telegramId})`
                : open.actorType}
            </Field>
            <Field label="Target">{`${open.targetType ?? '—'} ${open.targetId ?? ''}`.trim()}</Field>
            <Field label="When">{formatDateTime(open.createdAt)}</Field>
            <Field label="IP">{open.ip ?? '—'}</Field>
            <Json label="Before" value={open.oldValue} />
            <Json label="After" value={open.newValue} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-mute shrink-0">{label}</span>
      <span className="font-medium text-right break-all">{children}</span>
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-mute mb-1">{label}</p>
      {value === null || value === undefined ? (
        <p className="text-mute">—</p>
      ) : (
        <pre className="num bg-app border border-line rounded-lg p-2.5 overflow-x-auto text-[11px]">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** One-line hint of what changed, for the table cell. */
function summarize(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}
