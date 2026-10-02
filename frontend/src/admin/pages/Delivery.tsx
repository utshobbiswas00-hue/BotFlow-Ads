/**
 * Delivery queue — every scheduled ad post and its outcome.
 *
 * The retry action deserves its warning label. `retryDeliveryJob` refuses two
 * cases outright: a COMPLETED job ("already published"), and — the common one for
 * a FAILED row — any job whose slot reservation was already returned to the
 * advertiser (`escrow:release:job:<id>` exists). That second case throws a plain
 * Error, which the API surfaces as a generic 500, so the confirmation says it up
 * front rather than letting an operator discover it by clicking. Retry is
 * therefore offered only for states where it can still mean something, and never
 * for PENDING/SCHEDULED — that would enqueue a second worker job for a row that
 * already has one.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, groupNumber, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  getDeliveryStats,
  getDeliveryTimeline,
  getRecentDeliveryEvents,
  listDelivery,
  refreshAllChannelHealth,
  retryDelivery,
} from '../lib/api';
import { DELIVERY_STATUSES, RETRYABLE_DELIVERY_STATES, statusOptions } from '../lib/actions';
import { ListFilters, dateRangeParams } from '../components/ListFilters';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminDeliveryRow, DeliveryEventRow, DeliveryTimelineEntry } from '../lib/types';

const LIMIT = 20;

export function AdminDeliveryPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = params.get('sort') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  const query = useQuery({
    queryKey: [...qk.adminDelivery, { status, from, to, sort, page }],
    queryFn: () =>
      listDelivery({
        status: status || undefined,
        ...dateRangeParams(from, to),
        sort: sort || undefined,
        page,
        limit: LIMIT,
      }),
  });
  const stats = useQuery({ queryKey: qk.adminDeliveryStats, queryFn: getDeliveryStats });

  const canManage = can('delivery.manage');
  const [timelineFor, setTimelineFor] = useState<AdminDeliveryRow | null>(null);

  // `POST /api/admin/ops/health/refresh-all` — re-derives every channel's
  // bot-permission snapshot and status. It lives on the /ops router, not here,
  // but it is a delivery concern and belongs next to the queue.
  const refreshHealth = useMutation({
    mutationFn: refreshAllChannelHealth,
    onSuccess: (res) => {
      showToast('success', `Channel health refreshed — ${res.changed} channel(s) changed state`);
      void queryClient.invalidateQueries({ queryKey: qk.adminChannels });
      void queryClient.invalidateQueries({ queryKey: qk.adminOpsSummary });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminDelivery });
    void queryClient.invalidateQueries({ queryKey: qk.adminDeliveryStats });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
  };

  const columns: Column<AdminDeliveryRow>[] = [
    {
      key: 'campaign',
      header: 'Campaign',
      render: (j) => (
        <TwoLine
          primary={j.campaignName}
          secondary={<Mono title={j.id}>{j.id.slice(0, 10)}…</Mono>}
        />
      ),
    },
    {
      key: 'channel',
      header: 'Channel',
      render: (j) => <span className="text-sm">{j.channelTitle}</span>,
    },
    { key: 'status', header: 'Status', render: (j) => <StatusBadge status={j.status} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      align: 'right',
      nowrap: true,
      render: (j) => <Mono>{j.attempts}</Mono>,
    },
    {
      key: 'error',
      header: 'Error',
      hideBelow: 'md',
      render: (j) =>
        j.errorCode ? (
          <TwoLine
            primary={<span className="num text-xs">{j.errorCode}</span>}
            secondary={j.errorMessage ? <span className="text-xs">{j.errorMessage}</span> : undefined}
          />
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'scheduled',
      header: 'Scheduled',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (j) => (
        <span className="text-xs text-mute">{j.scheduledAt ? formatDateTime(j.scheduledAt) : '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (j) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {/* Available to anyone who can see the queue — the timeline is the
              audit trail of what happened to this post, not a mutation. */}
          <button
            type="button"
            onClick={() => setTimelineFor(j)}
            title="Every recorded event for this job"
            className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium whitespace-nowrap"
          >
            Timeline
          </button>

          {canManage && RETRYABLE_DELIVERY_STATES.includes(j.status) ? (
            <RowActions actions={retryActions(j)} onDone={invalidate} />
          ) : null}
        </div>
      ),
    },
  ];

  function retryActions(job: AdminDeliveryRow): RowAction[] {
    return [
      {
        key: 'retry',
        label: 'Retry',
        confirmTitle: 'Re-queue this delivery job?',
        confirmDescription:
          'The row is reset to PENDING and enqueued again. Two cases are refused by the server: a job that already published, and a job whose reserved budget was already returned to the advertiser — a retry of that kind cannot re-reserve the slot and comes back as a generic error.',
        confirmLabel: 'Re-queue',
        run: () => retryDelivery(job.id),
        successMessage: 'Delivery job re-queued',
      },
    ];
  }

  return (
    <>
      <AdminPageHeader
        title="Delivery"
        description="Every ad post the platform has scheduled, and how it ended. A FAILED row is a post an advertiser paid for and a publisher did not receive."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={15} />}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
            {canManage ? (
              <Button
                variant="secondary"
                size="sm"
                loading={refreshHealth.isPending}
                icon={<Icon name="channel" size={15} />}
                onClick={() => refreshHealth.mutate()}
              >
                Refresh channel health
              </Button>
            ) : null}
          </div>
        }
      />

      <Section title="Queue health" className="mb-6">
        <QueryState
          isPending={stats.isPending}
          isError={stats.isError}
          error={stats.error}
          onRetry={() => void stats.refetch()}
          skeletonRows={1}
        >
          {stats.data ? (
            <KpiGrid>
              <KpiTile
                label="Published"
                value={groupNumber(stats.data.published)}
                icon="check"
                tone="good"
              />
              <KpiTile
                label="In flight"
                value={groupNumber(stats.data.pending)}
                sub={`${groupNumber(stats.data.awaitingApproval)} awaiting publisher approval`}
                icon="send"
              />
              <KpiTile
                label="Failed"
                value={groupNumber(stats.data.failed)}
                icon="alert"
                tone={stats.data.failed > 0 ? 'bad' : 'good'}
                onClick={() => patch({ status: 'FAILED', page: '1' })}
              />
              <KpiTile label="Cancelled" value={groupNumber(stats.data.cancelled)} icon="x" />
            </KpiGrid>
          ) : null}
        </QueryState>
      </Section>

      <ListFilters
        sortable="delivery"
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
          options={statusOptions(DELIVERY_STATUSES)}
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
          rowKey={(j) => j.id}
          emptyTitle="No delivery jobs"
          emptyMessage={status ? `Nothing in ${status}.` : 'Nothing has been scheduled yet.'}
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
        title="Recent delivery events"
        description="The newest 100 events across every job, from GET /admin/ops/delivery/events/recent. This is the raw trail the retry logic reacts to."
      >
        <RecentEvents />
      </Section>

      {timelineFor ? (
        <TimelineModal job={timelineFor} onClose={() => setTimelineFor(null)} />
      ) : null}
    </>
  );
}

/** Newest 100 delivery events across all jobs (`/admin/ops/delivery/events/recent`). */
function RecentEvents() {
  const query = useQuery({ queryKey: qk.adminDeliveryEvents, queryFn: getRecentDeliveryEvents });
  const events: DeliveryEventRow[] = query.data ?? [];

  return (
    <QueryState
      isPending={query.isPending}
      isError={query.isError}
      error={query.error}
      onRetry={() => void query.refetch()}
      skeletonRows={3}
    >
      <DataTable
        rows={events}
        rowKey={(e) => e.id}
        columns={eventColumns}
        emptyTitle="No events"
        emptyMessage="Nothing has happened in the delivery pipeline yet."
      />
    </QueryState>
  );
}

const eventColumns: Column<DeliveryEventRow>[] = [
  {
    key: 'type',
    header: 'Event',
    render: (e) => (
      <TwoLine
        primary={<span className="num text-xs font-medium">{e.type}</span>}
        secondary={
          <span className="text-xs text-mute">
            {e.deliveryJob.campaign.name} · {e.deliveryJob.channel.title}
          </span>
        }
      />
    ),
  },
  {
    key: 'actor',
    header: 'Actor',
    hideBelow: 'md',
    render: (e) => <span className="text-xs text-mute">{humanize(e.actorType)}</span>,
  },
  {
    key: 'error',
    header: 'Error',
    hideBelow: 'lg',
    render: (e) =>
      e.errorCode ? (
        <span className="num text-xs text-danger">{e.errorCode}</span>
      ) : (
        <span className="text-xs text-mute">—</span>
      ),
  },
  {
    key: 'at',
    header: 'When',
    align: 'right',
    nowrap: true,
    render: (e) => <span className="text-xs text-mute">{formatDateTime(e.createdAt)}</span>,
  },
];

/**
 * The full recorded timeline for one job (`/admin/ops/delivery/:id/timeline`).
 * Read-only by design: events are written by the worker, not by an operator.
 */
function TimelineModal({ job, onClose }: { job: AdminDeliveryRow; onClose: () => void }) {
  const query = useQuery({
    queryKey: qk.adminDeliveryTimeline(job.id),
    queryFn: () => getDeliveryTimeline(job.id),
  });

  const entries: DeliveryTimelineEntry[] = query.data ?? [];

  return (
    <Modal open onClose={onClose} title="Delivery timeline">
      <div className="space-y-4">
        <div className="text-xs">
          <p className="font-medium">{job.campaignName}</p>
          <p className="text-mute">
            {job.channelTitle} · <span className="num">{job.id}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={job.status} />
            <span className="text-mute num">
              {job.attempts} attempt(s)
              {job.scheduledAt ? ` · scheduled ${formatDateTime(job.scheduledAt)}` : ''}
            </span>
          </p>
        </div>

        <QueryState
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          isEmpty={entries.length === 0}
          emptyIcon="clock"
          emptyTitle="No events recorded"
          emptyMessage="This job has not produced any delivery event yet."
          skeletonRows={3}
        >
          <ol className="space-y-0">
            {entries.map((entry, i) => (
              <li key={entry.id} className="flex gap-3">
                <div className="flex flex-col items-center pt-1">
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      entry.errorCode
                        ? 'bg-danger'
                        : entry.type === 'PUBLISHED'
                          ? 'bg-ok'
                          : 'bg-mute'
                    }`}
                  />
                  {i < entries.length - 1 ? <span className="w-px flex-1 bg-line my-1" /> : null}
                </div>
                <div className="pb-3 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-xs font-medium">{entry.type}</span>
                    <span className="text-[11px] text-mute">
                      {humanize(entry.actorType)} · attempt {entry.attempt}
                    </span>
                  </div>
                  <p className="text-[11px] text-mute">{formatDateTime(entry.createdAt)}</p>
                  {entry.message ? (
                    <p className="text-xs mt-0.5 break-words">{entry.message}</p>
                  ) : null}
                  {entry.errorCode ? (
                    <p className="num text-[11px] text-danger mt-0.5">{entry.errorCode}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </QueryState>
      </div>
    </Modal>
  );
}
