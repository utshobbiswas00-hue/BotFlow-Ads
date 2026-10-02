/**
 * Crypto deposit addresses.
 *
 * Saving an address is what puts a network on the deposit screen; disabling or
 * deleting it takes the network back off. That is why the destructive controls
 * are phrased in terms of the user-visible effect, not the row.
 *
 * `GET /admin/crypto-addresses` returns every network in the canonical
 * `CRYPTO_NETWORKS` order, including the ones with no address yet, so the gap is
 * visible rather than implied by an absence. The network is a closed enum
 * server-side, which is why the client never invents one.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  deleteCryptoAddress,
  listCryptoAddresses,
  saveCryptoAddress,
  setCryptoAddressActive,
} from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TwoLine, type Column } from '../components/DataTable';
import { ConfirmDialog, type DialogField } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { CryptoAddressView } from '../lib/types';

export function AdminCryptoAddressesPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminCryptoAddresses, queryFn: listCryptoAddresses });

  const [editing, setEditing] = useState<CryptoAddressView | null>(null);
  const [deleting, setDeleting] = useState<CryptoAddressView | null>(null);

  const save = useMutation({
    mutationFn: ({
      network,
      address,
      memo,
      label,
      isActive,
    }: {
      network: string;
      address: string;
      memo: string;
      label: string;
      isActive: boolean;
    }) =>
      saveCryptoAddress(network, {
        address,
        memo: memo.trim() ? memo.trim() : null,
        label: label.trim() ? label.trim() : null,
        isActive,
      }),
    onSuccess: (_r, vars) => {
      showToast('success', `${vars.network} address saved`);
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminCryptoAddresses });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const toggle = useMutation({
    mutationFn: ({ network, isActive }: { network: string; isActive: boolean }) =>
      setCryptoAddressActive(network, isActive),
    onSuccess: (_r, vars) => {
      showToast(
        'success',
        vars.isActive
          ? `${vars.network} is accepting deposits`
          : `${vars.network} deposits stopped`,
      );
      void queryClient.invalidateQueries({ queryKey: qk.adminCryptoAddresses });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (network: string) => deleteCryptoAddress(network),
    onSuccess: (_r, network) => {
      showToast('success', `${network} removed from the deposit screen`);
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminCryptoAddresses });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const columns: Column<CryptoAddressView>[] = [
    {
      key: 'network',
      header: 'Network',
      render: (a) => (
        <TwoLine primary={`${a.asset} · ${a.chain}`} secondary={<Mono>{a.network}</Mono>} />
      ),
    },
    {
      key: 'address',
      header: 'Address',
      render: (a) =>
        a.address ? (
          <Mono title={a.address}>{`${a.address.slice(0, 14)}…${a.address.slice(-6)}`}</Mono>
        ) : (
          <span className="text-xs text-mute">not configured</span>
        ),
    },
    {
      key: 'memo',
      header: 'Memo / tag',
      hideBelow: 'lg',
      render: (a) => <Mono>{a.memo ?? '—'}</Mono>,
    },
    {
      key: 'label',
      header: 'Label',
      hideBelow: 'md',
      render: (a) => <span className="text-xs text-mute">{a.label ?? '—'}</span>,
    },
    {
      key: 'state',
      header: 'State',
      render: (a) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge status={a.configured ? 'ACTIVE' : 'INACTIVE'} />
          {a.configured && !a.isActive ? <StatusBadge status="SUSPENDED" /> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;
        return (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setEditing(a)}
              className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium"
            >
              {a.configured ? 'Replace' : 'Set address'}
            </button>
            {a.configured ? (
              <button
                type="button"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ network: a.network, isActive: !a.isActive })}
                className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium disabled:opacity-40"
              >
                {a.isActive ? 'Stop deposits' : 'Resume'}
              </button>
            ) : null}
            {a.configured ? (
              <button
                type="button"
                onClick={() => setDeleting(a)}
                className="h-8 px-2.5 rounded-lg border border-danger/40 text-danger text-xs font-medium"
              >
                Delete
              </button>
            ) : null}
          </div>
        );
      },
    },
  ];

  const configured = (query.data ?? []).filter((a) => a.configured).length;
  const activeCount = (query.data ?? []).filter((a) => a.configured && a.isActive).length;

  return (
    <>
      <AdminPageHeader
        title="Deposit addresses"
        description={`${configured} of ${query.data?.length ?? 0} networks have an address; ${activeCount} are accepting deposits. Saving an address is what puts a network on the deposit screen.`}
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
        skeletonRows={4}
      >
        <DataTable rows={query.data ?? []} columns={columns} rowKey={(a) => a.network} emptyTitle="No networks" />
      </QueryState>

      {editing ? (
        <AddressDialog
          view={editing}
          pending={save.isPending}
          onCancel={() => setEditing(null)}
          onConfirm={(values) =>
            save.mutate({
              network: editing.network,
              address: values.address ?? '',
              memo: values.memo ?? '',
              label: values.label ?? '',
              isActive: values.isActive !== 'false',
            })
          }
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete the ${deleting?.network} address?`}
        description="Deposits on this network stop immediately and it disappears from the deposit screen. Use “Stop deposits” instead if you only want to pause it — that keeps the address on file for reconciliation."
        confirmLabel="Delete address"
        danger
        pending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.network);
        }}
      />
    </>
  );
}

/**
 * Its own dialog rather than the shared confirm: the address is a
 * real-money destination, so the field hint explains what replacing it does.
 * The API caps the address at 128 characters and requires it non-empty; the
 * `required` flag here mirrors that.
 */
function AddressDialog({
  view,
  pending,
  onCancel,
  onConfirm,
}: {
  view: CryptoAddressView;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
}) {
  const fields: DialogField[] = [
    {
      name: 'address',
      label: 'Address',
      required: true,
      maxLength: 128,
      mono: true,
      initialValue: view.address ?? '',
      hint: 'Where users send funds. Replacing it redirects real deposits — double-check it.',
    },
    {
      name: 'memo',
      label: 'Memo / tag',
      maxLength: 64,
      mono: true,
      initialValue: view.memo ?? '',
      hint: 'Required by some chains that share one deposit address.',
    },
    {
      name: 'label',
      label: 'Label',
      maxLength: 64,
      initialValue: view.label ?? '',
      hint: 'Internal note, e.g. the wallet name.',
    },
    {
      name: 'isActive',
      label: 'Accepting deposits (true/false)',
      initialValue: view.configured ? String(view.isActive) : 'true',
      hint: 'Save with false to keep the address on file but off the deposit screen.',
    },
  ];

  return (
    <ConfirmDialog
      open
      title={`${view.configured ? 'Replace' : 'Set'} ${view.asset} on ${view.chain}`}
      description={`Network code ${view.network}. The network is validated against the supported list server-side, so a typo cannot create an unusable pair.`}
      fields={fields}
      confirmLabel="Save address"
      pending={pending}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
