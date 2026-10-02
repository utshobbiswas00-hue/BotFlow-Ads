/**
 * Blocked domains — destination URLs that may not be advertised.
 *
 * `GET/POST /api/admin/ops/blocked-domains` and `DELETE /:id`, all
 * `settings.manage`. The service normalises what it is given to the registrable
 * parent domain, so adding `promo.evil.example` blocks the whole of
 * `evil.example` — which is why the table shows the stored value rather than
 * echoing the input back.
 *
 * `hardBlock` is the difference between "refused at creation" and "flagged for
 * review", so the dialog asks for it explicitly instead of defaulting silently.
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
import { addBlockedDomain, listBlockedDomains, removeBlockedDomain } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { ConfirmDialog, type DialogField } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { BlockedDomainRow } from '../lib/types';

const LIMIT = 20;

export function AdminBlockedDomainsPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<BlockedDomainRow | null>(null);

  const query = useQuery({
    queryKey: [...qk.adminBlockedDomains, page],
    queryFn: () => listBlockedDomains({ page, limit: LIMIT }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminBlockedDomains });
  };

  const add = useMutation({
    mutationFn: ({ domain, reason, hardBlock }: { domain: string; reason: string; hardBlock: boolean }) =>
      addBlockedDomain({
        domain: domain.trim(),
        reason: reason.trim() || undefined,
        hardBlock,
      }),
    onSuccess: (row) => {
      showToast('success', `Blocked ${row.domain}`);
      setAdding(false);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeBlockedDomain(id),
    onSuccess: () => {
      showToast('success', 'Domain unblocked');
      setRemoving(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const columns: Column<BlockedDomainRow>[] = [
    {
      key: 'domain',
      header: 'Domain',
      render: (d) => (
        <TwoLine
          primary={<span className="num">{d.domain}</span>}
          secondary={
            d.channel ? (
              <span className="text-xs text-mute">
                scoped to {d.channel.username ? `@${d.channel.username}` : d.channel.id.slice(0, 10)}
              </span>
            ) : (
              <span className="text-xs text-mute">global</span>
            )
          }
        />
      ),
    },
    {
      key: 'hardBlock',
      header: 'Enforcement',
      render: (d) => (
        <StatusBadge status={d.hardBlock ? 'BLOCKED' : 'REVIEW_REQUIRED'} />
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      hideBelow: 'md',
      render: (d) =>
        d.reason ? (
          <span className="text-xs text-mute line-clamp-2 max-w-md block">{d.reason}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'by',
      header: 'Added by',
      hideBelow: 'lg',
      render: (d) => <Mono>{d.createdById ? `${d.createdById.slice(0, 10)}…` : 'system'}</Mono>,
    },
    {
      key: 'created',
      header: 'Added',
      align: 'right',
      nowrap: true,
      render: (d) => <span className="text-xs text-mute">{formatDateTime(d.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) =>
        canManage ? (
          <button
            type="button"
            onClick={() => setRemoving(d)}
            className="h-8 px-2.5 rounded-lg border border-danger/40 text-danger text-xs font-medium"
          >
            Unblock
          </button>
        ) : (
          <span className="text-xs text-mute">View only</span>
        ),
    },
  ];

  const addFields: DialogField[] = [
    {
      name: 'domain',
      label: 'Domain',
      required: true,
      mono: true,
      maxLength: 253,
      placeholder: 'evil.example',
      hint: 'Stored normalised to the registrable parent, so a subdomain blocks the whole domain.',
    },
    {
      name: 'hardBlock',
      label: 'Enforcement',
      type: 'select',
      required: true,
      initialValue: 'true',
      options: [
        { value: 'true', label: 'Hard block — refuse the campaign' },
        { value: 'false', label: 'Flag only — send it to review' },
      ],
    },
    {
      name: 'reason',
      label: 'Reason',
      type: 'textarea',
      maxLength: 300,
      hint: 'Optional, kept on the row for the next operator.',
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Blocked domains"
        description="Destination URLs that campaigns may not point at. A hard block refuses the campaign outright; a flag sends it to review instead."
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
              <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setAdding(true)}>
                Block a domain
              </Button>
            ) : null}
          </div>
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
          rowKey={(d) => d.id}
          emptyTitle="No blocked domains"
          emptyMessage="Nothing is blocked, so every destination passes URL validation on its own merits."
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
        open={adding}
        title="Block a destination domain"
        description="The domain is normalised to its registrable parent before it is stored, so blocking a subdomain blocks the whole site."
        fields={addFields}
        confirmLabel="Block domain"
        danger
        pending={add.isPending}
        onCancel={() => setAdding(false)}
        onConfirm={(values) =>
          add.mutate({
            domain: values.domain ?? '',
            reason: values.reason ?? '',
            hardBlock: values.hardBlock !== 'false',
          })
        }
      />

      <ConfirmDialog
        open={removing !== null}
        title={`Unblock ${removing?.domain ?? ''}?`}
        description="The domain stops being rejected and future campaigns can point at it. Existing campaigns are not re-validated by this change."
        confirmLabel="Unblock"
        danger
        pending={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
        }}
      />
    </>
  );
}
