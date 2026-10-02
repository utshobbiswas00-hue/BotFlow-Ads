/**
 * Crypto deposit queue — the human step between "seen on chain" and "credited".
 *
 * A chain cannot tell us WHO a transfer belongs to, so detection and crediting are
 * separate steps and an operator stands between them. That is the control that
 * stops an incoming transfer landing in a guessed wallet, not a limitation to be
 * engineered away — which is why the credit action demands a user id rather than
 * trying to match one.
 *
 * `POST /crypto-transfers` is also the manual door for a transfer an operator can
 * see on a block explorer but whose chain this deployment does not scan; it runs
 * through the same conversion and the same idempotency as a scanned one. The form
 * asks for the amount in the asset's smallest unit, exactly as the API does — a
 * decimal here would be a rounding bug that misprices a deposit.
 */
import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  creditCryptoTransfer,
  getScannableNetworks,
  ignoreCryptoTransfer,
  listCryptoTransfers,
  recordCryptoTransfer,
  runCryptoScan,
} from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TwoLine, type Column } from '../components/DataTable';
import { RowActions, type RowAction } from '../components/RowActions';
import { QueryState } from '../components/StateBlock';
import type { CryptoTransfer } from '../lib/types';

export function AdminCryptoTransfersPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('deposits.manage');

  const query = useQuery({ queryKey: qk.adminCryptoTransfers, queryFn: listCryptoTransfers });
  const scannable = useQuery({
    queryKey: qk.adminScannableNetworks,
    queryFn: getScannableNetworks,
  });

  const scan = useMutation({
    mutationFn: runCryptoScan,
    onSuccess: (res) => {
      showToast(
        'success',
        `Scanned ${res.scanned} · ${res.recorded} new · ${res.skipped} already known`,
      );
      void queryClient.invalidateQueries({ queryKey: qk.adminCryptoTransfers });
      void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminCryptoTransfers });
    void queryClient.invalidateQueries({ queryKey: qk.adminDeposits });
    void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
  };

  const columns: Column<CryptoTransfer>[] = [
    {
      key: 'tx',
      header: 'Transfer',
      render: (t) => (
        <TwoLine
          primary={<Mono title={t.txHash}>{`${t.txHash.slice(0, 14)}…${t.txHash.slice(-6)}`}</Mono>}
          secondary={<span className="text-xs text-mute">{t.network}</span>}
        />
      ),
    },
    {
      key: 'from',
      header: 'From → to',
      hideBelow: 'lg',
      render: (t) => (
        <TwoLine
          primary={
            <Mono title={t.fromAddress}>
              {`${t.fromAddress.slice(0, 10)}…${t.fromAddress.slice(-4)}`}
            </Mono>
          }
          secondary={
            <Mono title={t.toAddress}>{`${t.toAddress.slice(0, 10)}…${t.toAddress.slice(-4)}`}</Mono>
          }
        />
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      nowrap: true,
      render: (t) => (
        <div className="text-right">
          <div className="num text-sm font-medium">
            {t.amountCents === null ? (
              <span className="text-warn">unpriced</span>
            ) : (
              <Money cents={t.amountCents} />
            )}
          </div>
          <div className="text-[10px] text-mute num" title={`raw ${t.amountRaw}`}>
            {t.amountRaw}
            {t.priceUsdCents !== null ? ` @ ${formatMoney(t.priceUsdCents)}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (t) => (
        <span className="inline-flex flex-col items-start gap-1">
          <StatusBadge status={t.status} />
          <span className="text-[10px] text-mute num">
            {t.confirmations} conf{t.depositId ? ` · deposit ${t.depositId.slice(0, 8)}…` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'observed',
      header: 'Observed',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (t) => <span className="text-xs text-mute">{formatDateTime(t.observedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (t) => {
        if (!canManage) return <span className="text-xs text-mute">View only</span>;
        if (t.status !== 'DETECTED') {
          return <span className="text-xs text-mute">{t.creditedAt ? 'Credited' : 'Closed'}</span>;
        }

        const actions: RowAction[] = [
          {
            key: 'credit',
            label: 'Credit',
            confirmTitle: 'Credit this transfer to a user',
            confirmDescription:
              'The transfer is marked CREDITED and a deposit is created for the user id below, through the ledger. The chain cannot tell us who the sender was, so this attribution is the operator’s decision — get the id from the user dossier, not from the wallet address.',
            confirmLabel: 'Credit to user',
            fields: [
              {
                name: 'userId',
                label: 'User id',
                required: true,
                mono: true,
                hint: 'Internal user id (cuid) — not the Telegram id.',
              },
            ],
            run: (values) => creditCryptoTransfer(t.id, values.userId.trim()),
            successMessage: 'Transfer credited',
          },
          {
            key: 'ignore',
            label: 'Ignore',
            danger: true,
            confirmTitle: 'Ignore this transfer?',
            confirmDescription:
              'The transfer is marked IGNORED and will not be credited or scanned again. Use this for dust, test transfers and anything that is not a customer deposit.',
            confirmLabel: 'Ignore transfer',
            fields: [
              {
                name: 'reason',
                label: 'Reason',
                required: true,
                maxLength: 200,
                hint: 'At least 3 characters. Stored on the transfer row.',
              },
            ],
            run: (values) => ignoreCryptoTransfer(t.id, values.reason.trim()),
            successMessage: 'Transfer ignored',
          },
        ];
        return <RowActions actions={actions} onDone={invalidate} />;
      },
    },
  ];

  const pending = (query.data ?? []).filter((t) => t.status === 'DETECTED').length;

  return (
    <>
      <AdminPageHeader
        title="Crypto queue"
        description={`${pending} transfer(s) seen and not yet dealt with. Detection and crediting are separate because a chain cannot name the customer.`}
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
                size="sm"
                loading={scan.isPending}
                icon={<Icon name="target" size={15} />}
                onClick={() => scan.mutate()}
              >
                Scan now
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-5 bg-surface border border-line rounded-2xl p-3.5">
        <p className="text-xs font-medium mb-1.5">
          Chains this deployment can see
          <span className="text-mute font-normal"> — a gap here means manual entry</span>
        </p>
        <QueryState
          isPending={scannable.isPending}
          isError={scannable.isError}
          error={scannable.error}
          onRetry={() => void scannable.refetch()}
          skeletonRows={1}
        >
          {scannable.data ? (
            scannable.data.networks.length === 0 ? (
              <p className="text-xs text-warn">
                No chain is scannable — every transfer has to be recorded by hand. Configure a
                scanner API key for the networks you support.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {scannable.data.networks.map((n) => (
                  <span key={n} className="text-[11px] px-2 py-1 rounded-lg bg-app border border-line num">
                    {n}
                  </span>
                ))}
              </div>
            )
          ) : null}
        </QueryState>
      </div>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={3}
      >
        <DataTable
          rows={query.data ?? []}
          columns={columns}
          rowKey={(t) => t.id}
          emptyTitle="Nothing waiting"
          emptyMessage="No on-chain transfer is waiting for a decision."
        />
      </QueryState>

      <Section
        className="mt-8"
        title="Record a transfer by hand"
        description="For a deposit you can see on a block explorer but whose chain is not scanned. It goes through the same conversion and idempotency as a scanned transfer, so recording one twice is safe."
      >
        <RecordForm canManage={canManage} onRecorded={invalidate} />
      </Section>
    </>
  );
}

function RecordForm({ canManage, onRecorded }: { canManage: boolean; onRecorded: () => void }) {
  const [form, setForm] = useState({
    network: '',
    txHash: '',
    asset: '',
    fromAddress: '',
    toAddress: '',
    amountRaw: '',
    decimals: '',
    blockNumber: '',
  });
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const record = useMutation({
    mutationFn: () =>
      recordCryptoTransfer({
        network: form.network.trim(),
        txHash: form.txHash.trim(),
        asset: form.asset.trim(),
        fromAddress: form.fromAddress.trim(),
        toAddress: form.toAddress.trim(),
        amountRaw: form.amountRaw.trim(),
        decimals: form.decimals.trim() ? Number(form.decimals) : null,
        blockNumber: form.blockNumber.trim() ? Number(form.blockNumber) : null,
      }),
    onSuccess: () => {
      showToast('success', 'Transfer recorded and queued for a credit decision');
      setForm({
        network: '',
        txHash: '',
        asset: '',
        fromAddress: '',
        toAddress: '',
        amountRaw: '',
        decimals: '',
        blockNumber: '',
      });
      onRecorded();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    const required: (keyof typeof form)[] = [
      'network',
      'txHash',
      'asset',
      'fromAddress',
      'toAddress',
      'amountRaw',
    ];
    for (const k of required) {
      if (!form[k].trim()) {
        setError(`${k} is required`);
        return;
      }
    }
    if (!/^\d+$/.test(form.amountRaw.trim())) {
      setError('amountRaw must be a plain integer string — no decimal point, no exponent');
      return;
    }
    if (form.decimals.trim() && !/^\d+$/.test(form.decimals.trim())) {
      setError('decimals must be a whole number');
      return;
    }
    setError(null);
    record.mutate();
  };

  return (
    <div className="bg-surface border border-line rounded-2xl p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          label="Network"
          className="num"
          placeholder="e.g. TRON"
          value={form.network}
          onChange={set('network')}
        />
        <Input
          label="Transaction hash"
          className="num"
          value={form.txHash}
          onChange={set('txHash')}
        />
        <Input
          label="Asset"
          className="num"
          placeholder="Token contract, or the native symbol"
          value={form.asset}
          onChange={set('asset')}
        />
        <Input label="From address" className="num" value={form.fromAddress} onChange={set('fromAddress')} />
        <Input label="To address" className="num" value={form.toAddress} onChange={set('toAddress')} />
        <Input
          label="Amount (raw integer)"
          className="num"
          placeholder="e.g. 2500000 for 2.5 USDT"
          value={form.amountRaw}
          onChange={set('amountRaw')}
          hint="Smallest unit. A decimal here misprices the deposit."
        />
        <Input
          label="Decimals"
          className="num"
          placeholder="Optional — pinned value used if empty"
          value={form.decimals}
          onChange={set('decimals')}
        />
        <Input
          label="Block number"
          className="num"
          placeholder="Optional"
          value={form.blockNumber}
          onChange={set('blockNumber')}
        />
      </div>

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <Button
        size="sm"
        disabled={!canManage}
        loading={record.isPending}
        icon={<Icon name="plus" size={15} />}
        onClick={submit}
      >
        Record transfer
      </Button>
      {!canManage ? (
        <p className="text-xs text-warn">
          Your account is missing <code className="num">deposits.manage</code>, so this form is
          disabled.
        </p>
      ) : null}
      <p className="text-xs text-mute">
        The transfer lands in the queue above as DETECTED — recording it does not credit anyone. Only
        a DETECTED row can be credited or ignored, and that decision is the next deliberate step.
      </p>
    </div>
  );
}
