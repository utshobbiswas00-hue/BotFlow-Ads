/**
 * Moderation — user reports, the ad-post takedown control, and the fraud scan.
 *
 * One gap is called out in the UI rather than papered over:
 * `GET /admin/moderation/reports` returns the REPORT row only
 * (`{ id, reporterName, reason, details, status, createdAt }`) — it does not
 * include the ad post the report refers to. So there is no way to REMOVE the
 * reported post straight from a row. `POST /admin/moderation/ads/action` takes an
 * `adPostId`, so the panel provides an explicit takedown control that accepts one
 * and says where to find it.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { adPostAction, listReports, reportAction, runFraudScan } from '../lib/api';
import { REPORT_STATUSES, statusOptions } from '../lib/actions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { AdminReportRow } from '../lib/types';

const LIMIT = 20;

/** Reasons that describe something dangerous are the ones worth colouring. */
const REASON_TONE: Record<string, string> = {
  SCAM: 'text-danger',
  SPAM: 'text-warn',
  MISLEADING: 'text-warn',
  INAPPROPRIATE: 'text-danger',
};

export function AdminModerationPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();

  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const query = useQuery({
    queryKey: [...qk.adminReports, { status, page }],
    queryFn: () => listReports({ status: status || undefined, page, limit: LIMIT }),
  });

  const canManage = can('fraud.manage');

  const scan = useMutation({
    mutationFn: runFraudScan,
    onSuccess: (res) => {
      showToast('success', `Fraud scan finished — ${res.events} new event(s) recorded`);
      void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
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
    void queryClient.invalidateQueries({ queryKey: qk.adminReports });
  };

  const columns: Column<AdminReportRow>[] = [
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => (
        <span className={`text-sm font-medium ${REASON_TONE[r.reason] ?? ''}`}>
          {humanize(r.reason)}
        </span>
      ),
    },
    {
      key: 'reporter',
      header: 'Reported by',
      render: (r) => (
        <TwoLine primary={r.reporterName} secondary={<Mono>{r.id.slice(0, 10)}…</Mono>} />
      ),
    },
    {
      key: 'details',
      header: 'Details',
      hideBelow: 'md',
      render: (r) =>
        r.details ? (
          <span className="text-xs text-mute line-clamp-2 max-w-md block">{r.details}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'created',
      header: 'Filed',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (r) => <span className="text-xs text-mute">{formatDateTime(r.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;
        if (r.status === 'RESOLVED' || r.status === 'DISMISSED') {
          return <span className="text-xs text-mute">Closed</span>;
        }

        const actions: RowAction[] = [
          {
            key: 'RESOLVE',
            label: 'Resolve',
            confirmTitle: 'Resolve this report',
            confirmDescription:
              'Marks the report RESOLVED with the action you took recorded against it. A report carries no ad-post reference, so removing the post itself is a separate action in the takedown panel below.',
            confirmLabel: 'Resolve',
            fields: [
              {
                name: 'actionTaken',
                label: 'Action taken',
                type: 'textarea',
                maxLength: 500,
                hint: 'Recorded on the report row for the audit trail.',
              },
            ],
            run: (values) => reportAction(r.id, 'RESOLVE', values.actionTaken),
            successMessage: 'Report resolved',
          },
          {
            key: 'DISMISS',
            label: 'Dismiss',
            danger: true,
            confirmTitle: 'Dismiss this report?',
            confirmDescription: 'Marks the report DISMISSED. No action is taken against the post.',
            confirmLabel: 'Dismiss',
            fields: [
              {
                name: 'actionTaken',
                label: 'Note',
                type: 'textarea',
                maxLength: 500,
                hint: 'Optional.',
              },
            ],
            run: (values) => reportAction(r.id, 'DISMISS', values.actionTaken),
            successMessage: 'Report dismissed',
          },
        ];
        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Moderation"
        description="User reports on sponsored posts, the direct takedown control, and the click-pattern fraud scan."
        actions={
          canManage ? (
            <Button
              size="sm"
              loading={scan.isPending}
              icon={<Icon name="shield" size={15} />}
              onClick={() => scan.mutate()}
            >
              Run fraud scan
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Select
          label="Status"
          className="max-w-56"
          placeholder="All statuses"
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: '1' })}
          options={statusOptions(REPORT_STATUSES)}
        />
        {status ? (
          <Button variant="ghost" size="sm" onClick={() => patch({ status: null, page: '1' })}>
            Clear filter
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
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(r) => r.id}
          emptyTitle="No reports"
          emptyMessage={status ? `Nothing in ${status}.` : 'Nobody has reported a post yet.'}
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
        title="Ad post takedown"
        description="REMOVE deletes a live post on Telegram and marks it DELETED; APPROVE releases a post that is being held back into the delivery queue. Both need the ad post id itself."
      >
        <AdPostActionPanel canManage={canManage} />
      </Section>
    </>
  );
}

function AdPostActionPanel({ canManage }: { canManage: boolean }) {
  const [adPostId, setAdPostId] = useState('');

  const act = useMutation({
    mutationFn: (action: 'REMOVE' | 'APPROVE') => adPostAction(adPostId.trim(), action),
    onSuccess: (_res, action) =>
      showToast('success', action === 'REMOVE' ? 'Post removed' : 'Post released to the queue'),
    onError: (e) => showToast('error', errMsg(e)),
  });

  return (
    <div className="bg-surface border border-line rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Ad post id"
          className="max-w-md"
          placeholder="The ad_posts row id"
          value={adPostId}
          onChange={(e) => setAdPostId(e.target.value)}
        />
        <Button
          variant="danger"
          size="sm"
          disabled={!canManage || !adPostId.trim()}
          loading={act.isPending}
          icon={<Icon name="trash" size={15} />}
          onClick={() => act.mutate('REMOVE')}
        >
          Remove post
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canManage || !adPostId.trim()}
          loading={act.isPending}
          icon={<Icon name="check" size={15} />}
          onClick={() => act.mutate('APPROVE')}
        >
          Release held post
        </Button>
      </div>
      <p className="text-xs text-mute">
        Report rows do not carry the ad post they refer to, so this input is the only way to act on a
        specific post. The id comes from the delivery list, where each job row is an ad post.
      </p>
      {!canManage ? (
        <p className="text-xs text-warn">
          Your account is missing <code className="num">fraud.manage</code>, so these actions are
          disabled.
        </p>
      ) : null}
    </div>
  );
}
