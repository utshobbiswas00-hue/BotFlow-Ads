/**
 * Admin notification inbox.
 *
 * This is the SAME `Notification` table as the user inbox, keyed on the ACTING
 * admin's own user id (`GET /api/admin/notifications`). No second model: an admin
 * IS a user, and a parallel table would put one read state in two places. The
 * durable rows are written by `alertAdmins`, so an ops alert survives being read
 * in Telegram.
 *
 * `unread` is returned WITH the page (see `AdminNotificationsResult`) rather than
 * computed from the loaded rows, so the count next to "Mark all read" and the nav
 * badge cannot disagree after a mark-as-read.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { showToast } from '../../store/uiStore';
import {
  getAdminUnreadCount,
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { QueryState } from '../components/StateBlock';
import type { AdminNotification } from '../lib/types';

const LIMIT = 20;

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canAct = can('dashboard.view');

  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const query = useQuery({
    queryKey: [...qk.adminNotifications, { page, unreadOnly }],
    queryFn: () => listAdminNotifications({ page, limit: LIMIT, unreadOnly }),
  });

  // The standalone badge query. The number SHOWN here prefers the one returned
  // with the page; this is only the fallback while the list is still loading, and
  // both keys are invalidated after every mutation.
  const unreadQuery = useQuery({
    queryKey: qk.adminNotificationsUnread,
    queryFn: getAdminUnreadCount,
  });

  const unread = query.data?.unread ?? unreadQuery.data?.unread ?? 0;

  const invalidate = (): void => {
    // `qk.adminNotifications` is a prefix of `qk.adminNotificationsUnread`, but
    // both are invalidated explicitly so intent is unambiguous.
    void queryClient.invalidateQueries({ queryKey: qk.adminNotifications });
    void queryClient.invalidateQueries({ queryKey: qk.adminNotificationsUnread });
  };

  const markOne = useMutation({
    mutationFn: (id: string) => markAdminNotificationRead(id),
    onSuccess: () => invalidate(),
    onError: (e) => showToast('error', errMsg(e)),
  });

  const markAll = useMutation({
    mutationFn: () => markAllAdminNotificationsRead(),
    onSuccess: (res) => {
      showToast('success', `Marked ${res.updated} notification${res.updated === 1 ? '' : 's'} read`);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const showAll = (): void => {
    setUnreadOnly(false);
    setPage(1);
  };

  const showUnreadOnly = (): void => {
    setUnreadOnly(true);
    setPage(1);
  };

  const columns: Column<AdminNotification>[] = [
    {
      key: 'notification',
      header: 'Notification',
      render: (n) => (
        <TwoLine
          primary={n.title}
          secondary={<span className="text-xs text-mute line-clamp-2 max-w-xl">{n.body}</span>}
        />
      ),
    },
    {
      key: 'type',
      header: 'Type',
      hideBelow: 'md',
      render: (n) => <Mono>{n.type.replace(/_/g, ' ')}</Mono>,
    },
    {
      key: 'status',
      header: 'Status',
      // Not colour alone: the word "Unread" / "Read" is always present, and the
      // dot is decoration on top of it.
      render: (n) =>
        n.isRead ? (
          <span className="text-xs text-mute">Read</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-link">
            <span aria-hidden>●</span>Unread
          </span>
        ),
    },
    {
      key: 'received',
      header: 'Received',
      align: 'right',
      nowrap: true,
      render: (n) => <span className="text-xs text-mute">{formatDateTime(n.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (n) =>
        n.isRead ? (
          <span className="text-xs text-mute">—</span>
        ) : canAct ? (
          <Button
            variant="secondary"
            size="sm"
            loading={markOne.isPending && markOne.variables === n.id}
            onClick={() => markOne.mutate(n.id)}
          >
            Mark read
          </Button>
        ) : (
          <span className="text-xs text-mute">View only</span>
        ),
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Notifications"
        description="Operational alerts for this admin account — deposits, withdrawals, delivery failures and fraud signals. An admin only ever sees their own inbox."
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
            {unreadOnly ? (
              <Button variant="secondary" size="sm" onClick={showAll}>
                Show all
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={unread === 0}
                onClick={showUnreadOnly}
              >
                Unread only{unread > 0 ? ` (${unread})` : ''}
              </Button>
            )}
            {canAct ? (
              <Button
                size="sm"
                icon={<Icon name="check" size={15} />}
                disabled={unread === 0 || markAll.isPending}
                loading={markAll.isPending}
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </Button>
            ) : null}
          </div>
        }
      />

      {unreadOnly ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-app/60 px-3 py-2">
          <p className="text-xs text-mute">
            Showing <span className="font-medium text-ink">unread only</span> — {unread} unread.
          </p>
          <button
            type="button"
            onClick={showAll}
            className="text-xs font-medium text-link underline underline-offset-2"
          >
            Show all notifications
          </button>
        </div>
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
          rowKey={(n) => n.id}
          emptyTitle={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
          emptyMessage={
            unreadOnly
              ? 'Everything has been read. Switch back to all notifications to see the history.'
              : 'Admin alerts about deposits, withdrawals, delivery and fraud will appear here.'
          }
        />
        {query.data ? (
          <TableFooter>
            <span className="text-xs text-mute">
              {unread > 0 ? `${unread} unread` : 'All read'}
            </span>
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
