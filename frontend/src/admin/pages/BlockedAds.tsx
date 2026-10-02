/**
 * Blocked ads — the "not deliverable" ad-post list.
 *
 * Read `backend/src/routes/admin/blocked.routes.ts` before changing this file.
 *
 * There is NO blocked-ads table, and `AdPostStatus` has NO `REMOVED` member (it
 * has DELETED and REJECTED). So this screen is an honest view of "cannot be
 * delivered", assembled from three real sources:
 *
 *   - posts whose status is DELETED or REJECTED, and
 *   - posts whose channel currently has any PublisherBlocklist entry.
 *
 * `reason` is derived server-side (admin-block marker → moderation message →
 * status → channel block), never a stored status.
 *
 * "Block" reuses the real removed state: the post is set to `status = DELETED`
 * and a `BLOCKED_BY_ADMIN:<reason>` marker is stamped into the post's
 * `errorMessage` column, alongside an `AD_POST_BLOCKED` audit row — the audit row
 * is the authoritative record. "Unblock" restores the status the post had before
 * it was blocked by reading that audit row, and deliberately refuses to reverse a
 * genuine moderation removal.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { blockAdPost, listBlockedAds, unblockAdPost } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { ConfirmDialog, type DialogField } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { BlockedAdRow } from '../lib/types';

const LIMIT = 20;

/** Which of the two row actions the dialog is currently collecting. */
type DialogKind = 'block' | 'unblock';
interface DialogState {
  row: BlockedAdRow;
  kind: DialogKind;
}

export function BlockedAdsPage() {
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const query = useQuery({
    queryKey: [...qk.adminBlockedAdPosts, { page }],
    queryFn: () => listBlockedAds({ page, limit: LIMIT }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminBlockedAdPosts });
  };

  const block = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => blockAdPost(id, reason),
    onSuccess: () => {
      showToast('success', 'Ad post blocked — it will not be delivered');
      setDialog(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const unblock = useMutation({
    mutationFn: (id: string) => unblockAdPost(id),
    onSuccess: () => {
      showToast('success', 'Admin block lifted — the post is restored to its previous status');
      setDialog(null);
      invalidate();
    },
    // A 409 here means the post was not blocked by an admin (e.g. a real
    // moderation removal), which the API refuses to reverse — surface that reason.
    onError: (e) => showToast('error', errMsg(e)),
  });

  const columns: Column<BlockedAdRow>[] = [
    {
      key: 'id',
      header: 'Ad post',
      render: (row) => <Mono title={row.id}>{row.id.length > 14 ? `${row.id.slice(0, 14)}…` : row.id}</Mono>,
    },
    {
      key: 'campaign',
      header: 'Campaign',
      render: (row) => (
        <TwoLine
          primary={row.campaignName || 'House ad'}
          secondary={row.channelTitle}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'reason',
      header: 'Reason (derived)',
      hideBelow: 'md',
      render: (row) =>
        row.reason ? (
          <span className="text-xs text-mute line-clamp-2 max-w-md block">{row.reason}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      hideBelow: 'sm',
      nowrap: true,
      render: (row) => <span className="text-xs text-mute">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setDialog({ row, kind: 'block' })}
            className="h-8 px-2.5 rounded-lg border border-danger/40 text-danger text-xs font-medium whitespace-nowrap"
          >
            Block
          </button>
          <button
            type="button"
            onClick={() => setDialog({ row, kind: 'unblock' })}
            className="h-8 px-2.5 rounded-lg border border-line text-ink text-xs font-medium whitespace-nowrap"
          >
            Unblock
          </button>
        </div>
      ),
    },
  ];

  const blockFields: DialogField[] = [
    {
      name: 'reason',
      label: 'Reason',
      type: 'textarea',
      required: true,
      maxLength: 500,
      placeholder: 'Why this post must not be delivered',
      hint: '3–500 characters, required. Kept on the AD_POST_BLOCKED audit record and shown in the list as the reason.',
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Blocked ads"
        description="Ad posts that are not deliverable: posts removed or rejected, plus posts whose channel is on the blocklist."
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

      <div className="bg-surface border border-line rounded-2xl p-4 mb-4 flex gap-3">
        <span className="text-link mt-0.5 shrink-0">
          <Icon name="info" size={18} />
        </span>
        <div className="text-xs text-mute space-y-1.5 leading-relaxed">
          <p>
            <span className="font-semibold text-ink">What this list is. </span>
            This is not a stored “blocked ads” list. There is no blocked-ads table, and a post has
            no REMOVED state — only DELETED and REJECTED. So this screen shows everything that
            cannot be delivered: posts that were removed or rejected, and posts whose channel is
            on the blocklist (any scope). A post can appear here for more than one of those
            reasons.
          </p>
          <p>
            <span className="font-semibold text-ink">The reason column is worked out, not stored. </span>
            The server derives it each time, in this order: an admin block marker, then the
            moderation message, then the post’s status, then “channel is on the blocklist”. It is a
            best-effort explanation, not a status field you can filter on.
          </p>
          <p>
            <span className="font-semibold text-ink">Blocking. </span>
            Blocking a post sets it to DELETED, the same state moderation removal writes, and
            records your reason. The authoritative record of a block is the audit entry
            (AD_POST_BLOCKED) — the visible marker on the post is only there so the reason can be
            shown without an extra lookup.
          </p>
          <p>
            <span className="font-semibold text-ink">Unblocking. </span>
            Unblocking restores the status the post had before the admin block, read from that audit
            entry, and clears the marker. A post that was removed by genuine moderation was not
            blocked by an admin, so it cannot be unblocked here — the server refuses and nothing
            changes.
          </p>
        </div>
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
          rowKey={(row) => row.id}
          emptyTitle="Nothing is undeliverable"
          emptyMessage="Every ad post is in a deliverable state and no channel is on the blocklist."
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

      <ConfirmDialog
        open={dialog?.kind === 'block'}
        title="Block this ad post?"
        description={
          dialog
            ? `This post stops being delivered and is set to the DELETED state — the same state a moderation removal uses. The reason you give is recorded on the audit entry that unblocking later reads. Post ${dialog.row.id.slice(0, 12)}…`
            : ''
        }
        fields={blockFields}
        confirmLabel="Block post"
        danger
        pending={block.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(values) => {
          if (!dialog) return;
          const reason = (values.reason ?? '').trim();
          if (reason.length < 3) {
            showToast('error', 'A reason of at least 3 characters is required');
            return;
          }
          block.mutate({ id: dialog.row.id, reason });
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'unblock'}
        title="Unblock this ad post?"
        description="This restores the status the post had before it was blocked by an admin (read from its audit entry) and clears the block marker, so the post can be delivered again. If the post was removed by genuine moderation rather than by an admin, this cannot be reversed and nothing will change."
        confirmLabel="Unblock"
        danger
        pending={unblock.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog) unblock.mutate(dialog.row.id);
        }}
      />
    </>
  );
}
