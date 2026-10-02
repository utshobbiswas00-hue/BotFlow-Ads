/**
 * Broadcast delivery report (§52).
 *
 * WHAT THIS IS
 * The composer (`Broadcast.tsx`) sends a message and forgets about it: the send
 * is queued and fans out asynchronously, so when the page closes there was
 * nothing left to look at. This screen is the durable record — every broadcast,
 * who was messaged, and what Telegram said about each attempt.
 *
 * TWO VIEWS, ONE SCREEN
 * The list is the history (newest first). Selecting a row opens the detail, which
 * shows the aggregate counts and the paginated recipient table. It is a read-only
 * view: nothing here can resend or edit a broadcast.
 *
 * COUNTS COME FROM THE RECIPIENT ROWS
 * The detail view shows the job's own `sentCount`/`failedCount` AND a live
 * `groupBy` over the recipients. They are two numbers on purpose — if they drift
 * that is worth seeing, not hiding.
 *
 * BIGINT SAFETY
 * `telegramMessageId` is a Telegram id larger than 32 bits and arrives as a
 * decimal STRING. It is rendered as text and never coerced to a number, which
 * would silently round it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDateTime, groupNumber, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import {
  getBroadcastJob,
  listBroadcastHistory,
  listBroadcastRecipients,
} from '../lib/api';
import type {
  BroadcastAudience,
  BroadcastJobSummary,
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
} from '../lib/types';

const LIMIT = 20;

const AUDIENCE_LABEL: Record<BroadcastAudience, string> = {
  ALL: 'All users',
  PUBLISHERS: 'Publishers',
  ADVERTISERS: 'Advertisers',
};

const RECIPIENT_STATUSES: BroadcastRecipientStatus[] = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'];

/** The report page: a history list that opens a detail view. */
export function BroadcastReportPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (selectedId) {
    return <BroadcastDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return <BroadcastHistory onOpen={setSelectedId} />;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function BroadcastHistory({ onOpen }: { onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: [...qk.adminBroadcastHistory, { page }],
    queryFn: () => listBroadcastHistory({ page, limit: LIMIT }),
  });

  const columns: Column<BroadcastJobSummary>[] = [
    {
      key: 'title',
      header: 'Broadcast',
      render: (job) => (
        <TwoLine
          primary={job.title}
          secondary={<Mono title={job.id}>{job.id.slice(0, 10)}…</Mono>}
        />
      ),
    },
    {
      key: 'audience',
      header: 'Audience',
      hideBelow: 'md',
      render: (job) => (
        <span className="text-sm text-mute">{AUDIENCE_LABEL[job.audience] ?? job.audience}</span>
      ),
    },
    { key: 'status', header: 'Status', render: (job) => <StatusBadge status={job.status} /> },
    {
      key: 'delivery',
      header: 'Sent / failed / total',
      align: 'right',
      nowrap: true,
      render: (job) => (
        <span className="num text-sm">
          <span className="text-ok">{groupNumber(job.sentCount)}</span>
          <span className="text-mute"> / </span>
          <span className={job.failedCount > 0 ? 'text-danger' : 'text-mute'}>
            {groupNumber(job.failedCount)}
          </span>
          <span className="text-mute"> / {groupNumber(job.totalRecipients)}</span>
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      hideBelow: 'sm',
      nowrap: true,
      render: (job) => <span className="text-xs text-mute">{formatDateTime(job.createdAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Broadcast report"
        description="Every broadcast that has been sent, and per-recipient delivery outcomes. Read-only."
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

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(job) => job.id}
          onRowClick={(job) => onOpen(job.id)}
          emptyTitle="No broadcasts yet"
          emptyMessage="Nothing has been sent. Use the Broadcast composer to send one."
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
          </TableFooter>
        ) : null}
      </QueryState>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

function BroadcastDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<BroadcastRecipientStatus | ''>('');

  const jobQuery = useQuery({
    queryKey: qk.adminBroadcastJob(id),
    queryFn: () => getBroadcastJob(id),
  });

  const recipientsQuery = useQuery({
    queryKey: [...qk.adminBroadcastRecipients(id), { page, status }],
    queryFn: () => listBroadcastRecipients(id, { page, limit: LIMIT, status }),
  });

  const report = jobQuery.data;
  const counts = report?.counts;

  const columns: Column<BroadcastRecipientRow>[] = [
    {
      key: 'recipient',
      header: 'Recipient',
      render: (r) => <TwoLine primary={r.userName} secondary={<Mono>{r.userId.slice(0, 10)}…</Mono>} />,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'error',
      header: 'Error',
      hideBelow: 'md',
      render: (r) =>
        r.error ? (
          <span className="text-xs text-danger break-words">{r.error}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'message',
      header: 'Message id',
      hideBelow: 'lg',
      // A BigInt arrived as a decimal string — rendered as text, never a number.
      render: (r) => (r.telegramMessageId ? <Mono>{r.telegramMessageId}</Mono> : <span className="text-xs text-mute">—</span>),
    },
    {
      key: 'sent',
      header: 'Sent',
      align: 'right',
      hideBelow: 'sm',
      nowrap: true,
      render: (r) => <span className="text-xs text-mute">{formatDateTime(r.sentAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title={report?.job.title ?? 'Broadcast'}
        description={
          report
            ? `${AUDIENCE_LABEL[report.job.audience] ?? report.job.audience} · created ${formatDateTime(
                report.job.createdAt,
              )}`
            : 'Delivery detail'
        }
        actions={
          <Button variant="secondary" size="sm" icon={<Icon name="back" size={15} />} onClick={onBack}>
            Back to history
          </Button>
        }
      />

      <QueryState
        isPending={jobQuery.isPending}
        isError={jobQuery.isError}
        error={jobQuery.error}
        onRetry={() => void jobQuery.refetch()}
        skeletonRows={2}
      >
        {report && counts ? (
          <Section title="Delivery summary" className="mb-6">
            <KpiGrid>
              <KpiTile
                label="Recipients"
                value={groupNumber(counts.total)}
                sub={`Job recorded ${groupNumber(report.job.totalRecipients)}`}
                icon="user"
              />
              <KpiTile
                label="Sent"
                value={groupNumber(counts.sent)}
                sub={`Job recorded ${groupNumber(report.job.sentCount)}`}
                icon="check"
                tone="good"
              />
              <KpiTile
                label="Failed"
                value={groupNumber(counts.failed)}
                sub={`Job recorded ${groupNumber(report.job.failedCount)}`}
                icon="alert"
                tone={counts.failed > 0 ? 'bad' : 'neutral'}
              />
              <KpiTile
                label="Skipped"
                value={groupNumber(counts.skipped)}
                sub={`${groupNumber(counts.pending)} still pending`}
                icon="x"
                tone={counts.pending > 0 ? 'warn' : 'neutral'}
              />
            </KpiGrid>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mute">
              <StatusBadge status={report.job.status} />
              {report.job.completedAt ? (
                <span>Completed {formatDateTime(report.job.completedAt)}</span>
              ) : (
                <span>Not finished yet</span>
              )}
              <span className="text-mute/70">
                Counts are recomputed from the recipient rows; the job&apos;s own counters are shown
                beneath each tile so any drift is visible.
              </span>
            </div>

            {report.job.body ? (
              <p className="mt-4 text-xs text-mute whitespace-pre-wrap border border-line rounded-xl p-3">
                {report.job.body}
              </p>
            ) : null}
          </Section>
        ) : null}
      </QueryState>

      <Section title="Recipients" description="One row per recipient, newest job first.">
        <div className="mb-3 max-w-56">
          <Select
            label="Status"
            placeholder="All statuses"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as BroadcastRecipientStatus | '');
              setPage(1);
            }}
            options={RECIPIENT_STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
          />
        </div>

        <QueryState
          isPending={recipientsQuery.isPending}
          isError={recipientsQuery.isError}
          error={recipientsQuery.error}
          onRetry={() => void recipientsQuery.refetch()}
        >
          <DataTable
            rows={recipientsQuery.data?.items ?? []}
            columns={columns}
            rowKey={(r) => r.id}
            emptyTitle="No recipients"
            emptyMessage={status ? `No ${humanize(status).toLowerCase()} recipients.` : 'This broadcast has no recipient rows.'}
          />
          {recipientsQuery.data ? (
            <TableFooter>
              <Pager
                page={recipientsQuery.data.page}
                limit={recipientsQuery.data.limit}
                total={recipientsQuery.data.total}
                hasMore={recipientsQuery.data.hasMore}
                busy={recipientsQuery.isFetching}
                onPage={setPage}
              />
            </TableFooter>
          ) : null}
        </QueryState>
      </Section>
    </>
  );
}

/**
 * Aliases so the route/nav wiring can import either naming convention without a
 * second file. `index.ts` is owned by the caller and is not edited here.
 */
export const AdminBroadcastReportPage = BroadcastReportPage;
