/**
 * Support — the ticket queue, with reply and status control.
 *
 * Deliberately a panel rather than a detail ROUTE. Clicking a row opens the panel
 * and loads that ticket's full thread from `GET /admin/support/tickets/:id` — the
 * admin twin of the owner-scoped read. Same ticket, same messages, no ownership
 * assertion (that was the 404 staff used to hit); authorisation is the route's
 * `tickets.view` permission. Each message shows its sender type, body, timestamp
 * and, when the sender attached one, a link to the file. Replies and status
 * changes post against the ticket id, and the thread is refreshed after a reply.
 *
 * Ordering note: the API sorts by `priority desc, lastMessageAt desc`, not by
 * activity alone, so an urgent ticket that has gone quiet still floats up.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Textarea } from '../../components/ui/Textarea';
import { showToast } from '../../store/uiStore';
import { getTicketThread, listTickets, replyTicket, setTicketStatus } from '../lib/api';
import { TICKET_STATUSES, statusOptions } from '../lib/actions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AdminTicket } from '../lib/types';

const LIMIT = 20;

const PRIORITY_TONE: Record<string, string> = {
  URGENT: 'text-danger',
  HIGH: 'text-warn',
  NORMAL: '',
  LOW: 'text-mute',
};

export function AdminSupportPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [open, setOpen] = useState<AdminTicket | null>(null);

  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const query = useQuery({
    queryKey: [...qk.adminTickets, { status, page }],
    queryFn: () => listTickets({ status: status || undefined, page, limit: LIMIT }),
  });

  const patch = (next: Record<string, string | null>): void => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged, { replace: true });
  };

  const columns: Column<AdminTicket>[] = [
    {
      key: 'subject',
      header: 'Ticket',
      render: (t) => <TwoLine primary={t.subject} secondary={<Mono>{t.ticketNo}</Mono>} />,
    },
    {
      key: 'user',
      header: 'User',
      render: (t) => <TwoLine primary={t.userName} secondary={<Mono>{t.user.telegramId}</Mono>} />,
    },
    {
      key: 'priority',
      header: 'Priority',
      hideBelow: 'md',
      render: (t) => (
        <span className={`text-xs font-medium ${PRIORITY_TONE[t.priority] ?? ''}`}>
          {humanize(t.priority)}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    {
      key: 'category',
      header: 'Category',
      hideBelow: 'lg',
      render: (t) => <span className="text-xs text-mute">{t.category}</span>,
    },
    {
      key: 'last',
      header: 'Last activity',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (t) => <span className="text-xs text-mute">{formatDateTime(t.lastMessageAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Support"
        description="Every ticket across all users, urgent first then most recently active. Open a row to reply or change its status."
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
        <Select
          label="Status"
          className="max-w-56"
          placeholder="All statuses"
          value={status}
          onChange={(e) => patch({ status: e.target.value, page: '1' })}
          options={statusOptions(TICKET_STATUSES)}
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
          rowKey={(t) => t.id}
          onRowClick={(t) => setOpen(t)}
          emptyTitle="No tickets"
          emptyMessage={status ? `Nothing in ${status}.` : 'No user has opened a ticket yet.'}
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
            <span className="inline-flex items-center gap-1.5">
              <Icon name="info" size={13} />
              Click a row to open the reply panel
            </span>
          </TableFooter>
        ) : null}
      </QueryState>

      {open ? (
        <TicketPanel
          ticket={open}
          canManage={can('tickets.manage')}
          onClose={() => setOpen(null)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: qk.adminTickets });
          }}
        />
      ) : null}
    </>
  );
}

function TicketPanel({
  ticket,
  canManage,
  onClose,
  onChanged,
}: {
  ticket: AdminTicket;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const thread = useQuery({
    queryKey: qk.adminTicket(ticket.id),
    queryFn: () => getTicketThread(ticket.id),
  });

  const reply = useMutation({
    mutationFn: () => replyTicket(ticket.id, body.trim()),
    onSuccess: () => {
      setBody('');
      showToast('success', 'Reply sent to the user');
      // Re-read the thread so the reply appears where the user will see it.
      void queryClient.invalidateQueries({ queryKey: qk.adminTicket(ticket.id) });
      onChanged();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const change = useMutation({
    mutationFn: (next: string) => setTicketStatus(ticket.id, next),
    onSuccess: (_res, next) => {
      showToast('success', `Ticket moved to ${humanize(next)}`);
      onChanged();
      onClose();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  return (
    <Modal open onClose={onClose} title={ticket.subject}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Mono>{ticket.ticketNo}</Mono>
          <StatusBadge status={ticket.status} />
          <StatusBadge status={ticket.priority} />
        </div>

        <dl className="text-xs">
          <DetailRow label="User" value={`${ticket.userName} · ${ticket.user.telegramId}`} />
          <DetailRow label="Category" value={ticket.category} />
          <DetailRow label="Opened" value={formatDateTime(ticket.createdAt)} />
          <DetailRow label="Last activity" value={formatDateTime(ticket.lastMessageAt)} />
          <DetailRow label="Assigned to" value={ticket.assignedToId ?? 'Unassigned'} />
        </dl>

        <div className="space-y-2">
          <p className="text-sm font-medium">Conversation</p>
          {thread.isPending ? (
            <p className="text-xs text-mute bg-app border border-line rounded-lg p-2.5">Loading thread…</p>
          ) : thread.isError ? (
            <p className="text-xs text-danger bg-app border border-line rounded-lg p-2.5">
              {errMsg(thread.error)}
            </p>
          ) : thread.data.messages.length === 0 ? (
            <p className="text-xs text-mute bg-app border border-line rounded-lg p-2.5">
              No messages on this ticket yet.
            </p>
          ) : (
            <ol className="space-y-2">
              {thread.data.messages.map((m) => (
                <li key={m.id} className="bg-app border border-line rounded-lg p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wide ${
                        m.senderType === 'ADMIN' ? 'text-accent' : 'text-mute'
                      }`}
                    >
                      {humanize(m.senderType)}
                    </span>
                    <span className="text-[11px] text-mute">{formatDateTime(m.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
                  {m.attachmentUrl ? (
                    <a
                      href={m.attachmentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-accent mt-1 underline"
                    >
                      <Icon name="external" size={13} />
                      Attachment
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>

        <Textarea
          label="Reply"
          placeholder="Type the reply the user will receive in the bot…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          showCount
          rows={4}
        />

        <Button
          full
          loading={reply.isPending}
          disabled={!canManage || body.trim().length === 0}
          icon={<Icon name="send" size={15} />}
          onClick={() => reply.mutate()}
        >
          Send reply
        </Button>

        <div>
          <p className="text-sm font-medium mb-2">Move to status</p>
          <div className="flex flex-wrap gap-1.5">
            {TICKET_STATUSES.filter((s) => s !== ticket.status).map((s) => (
              <button
                key={s}
                type="button"
                disabled={!canManage || change.isPending}
                onClick={() => change.mutate(s)}
                className="h-8 px-3 rounded-lg border border-line bg-surface text-xs font-medium disabled:opacity-40"
              >
                {humanize(s)}
              </button>
            ))}
          </div>
          <p className="text-xs text-mute mt-2">
            Replying reopens a CLOSED or RESOLVED ticket; moving one to CLOSED or RESOLVED stamps its
            closed time.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="text-mute shrink-0">{label}</dt>
      <dd className="font-medium text-right break-all">{value}</dd>
    </div>
  );
}
