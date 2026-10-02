/**
 * User dossier — everything the admin API knows about one account.
 *
 * One call, `GET /admin/users/:id`, returns
 * `{ profile, channels, campaigns, transactions, deposits, withdrawals, earnings }`.
 * The balance adjustment is the one money-moving control here and it is the
 * ledger-backed one (`POST /admin/users/adjust-balance`): the server writes a
 * MANUAL_ADJUSTMENT transaction and refuses a debit that would take the available
 * balance below zero. The panel validates the sign and the non-zero rule, and
 * deliberately does not try to duplicate the balance check — it cannot see the
 * reserved/pending split that makes the server's decision correct.
 */
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { displayName, formatDate, formatDateTime, formatMoney, parseCents } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { adjustBalance, getUser, recalculateRisk } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, TwoLine, type Column } from '../components/DataTable';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorBlock, QueryState } from '../components/StateBlock';
import type {
  AdminUserDetail,
  AdminUserDetailDeposit,
  AdminUserDetailTransaction,
  AdminUserDetailWithdrawal,
} from '../lib/types';

export function AdminUserDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [adjustOpen, setAdjustOpen] = useState(false);

  const query = useQuery({
    queryKey: qk.adminUser(id),
    queryFn: () => getUser(id),
    enabled: Boolean(id),
  });

  const adjust = useMutation({
    mutationFn: ({ cents, reason }: { cents: number; reason: string }) =>
      adjustBalance(id, cents, reason),
    onSuccess: (res) => {
      showToast(
        'success',
        `Balance updated: ${formatMoney(res.previousBalanceCents)} → ${formatMoney(res.newBalanceCents)}`,
      );
      setAdjustOpen(false);
      void queryClient.invalidateQueries({ queryKey: qk.adminUser(id) });
      void queryClient.invalidateQueries({ queryKey: qk.adminUsers });
      void queryClient.invalidateQueries({ queryKey: qk.adminTransactions });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const risk = useMutation({
    mutationFn: () => recalculateRisk(id),
    onSuccess: (res) => showToast('success', `Risk score recalculated: ${res.score}`),
    onError: (e) => showToast('error', errMsg(e)),
  });

  if (!id) return <ErrorBlock error={new Error('No user id in the URL')} />;

  const d = query.data;

  return (
    <>
      <Link
        to="/admin/users"
        className="inline-flex items-center gap-1.5 text-xs text-link hover:underline mb-3"
      >
        <Icon name="back" size={14} />
        All users
      </Link>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={5}
      >
        {d ? (
          <>
            <AdminPageHeader
              title={displayName(d.profile)}
              description={`${d.profile.username ? `@${d.profile.username.replace(/^@/, '')}` : 'No username'} · Telegram ID ${d.profile.telegramId}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {can('fraud.manage') ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={risk.isPending}
                      icon={<Icon name="shield" size={15} />}
                      onClick={() => risk.mutate()}
                    >
                      Recalculate risk
                    </Button>
                  ) : null}
                  {can('users.balance.adjust') ? (
                    <Button
                      size="sm"
                      icon={<Icon name="dollar" size={15} />}
                      onClick={() => setAdjustOpen(true)}
                    >
                      Adjust balance
                    </Button>
                  ) : null}
                </div>
              }
            />

            <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
              <div className="space-y-6">
                <div className="bg-surface border border-line rounded-2xl p-4">
                  <div className="flex items-center gap-3">
                    <span className="w-14 h-14 rounded-full bg-app border border-line flex items-center justify-center overflow-hidden shrink-0">
                      {d.profile.photoUrl ? (
                        <img src={d.profile.photoUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Icon name="user" size={22} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="font-bold truncate">{displayName(d.profile)}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <StatusBadge status={d.profile.status} />
                        {d.profile.isAdmin ? (
                          <StatusBadge status={d.profile.adminRole ?? 'ADMIN'} />
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <dl className="mt-4 divide-y divide-line/60">
                    <Row label="Referral code" value={<Mono>{d.profile.referralCode}</Mono>} />
                    <Row label="Joined" value={formatDate(d.profile.createdAt)} />
                    <Row
                      label="Roles"
                      value={
                        [d.profile.isAdvertiser && 'Advertiser', d.profile.isPublisher && 'Publisher']
                          .filter(Boolean)
                          .join(' · ') || '—'
                      }
                    />
                    <Row label="Admin role" value={d.profile.adminRole ?? '—'} />
                  </dl>
                  <Link
                    to={`/admin/finance/ledger?userId=${encodeURIComponent(d.profile.id)}`}
                    className="mt-4 inline-flex items-center gap-1.5 text-xs text-link hover:underline"
                  >
                    Full ledger for this user
                    <Icon name="chevronRight" size={13} />
                  </Link>
                </div>

                <Section title="Publisher earnings" description="Grouped by the earning row's own status.">
                  <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60 text-sm">
                    <Row label="Posts" value={<span className="num">{d.earnings.totalPosts}</span>} />
                    <Row label="Gross" value={<Money cents={d.earnings.totalGrossCents} />} />
                    <Row label="Net" value={<Money cents={d.earnings.totalNetCents} />} />
                    <Row label="Pending" value={<Money cents={d.earnings.pendingCents} />} />
                    <Row label="Available" value={<Money cents={d.earnings.availableCents} />} />
                    <Row label="Paid" value={<Money cents={d.earnings.paidCents} />} />
                  </div>
                </Section>
              </div>

              <div className="space-y-6 min-w-0">
                <KpiGrid>
                  <KpiTile
                    label="Available"
                    value={<Money cents={d.profile.balanceCents} />}
                    icon="wallet"
                  />
                  <KpiTile
                    label="Deposited"
                    value={<Money cents={d.profile.totalDepositedCents} />}
                    icon="arrowDown"
                  />
                  <KpiTile
                    label="Spent"
                    value={<Money cents={d.profile.totalSpentCents} />}
                    icon="megaphone"
                  />
                  <KpiTile
                    label="Withdrawn"
                    value={<Money cents={d.profile.totalWithdrawnCents} />}
                    icon="arrowUp"
                  />
                </KpiGrid>

                <Section title={`Channels (${d.channels.length})`}>
                  <DataTable
                    rows={d.channels}
                    rowKey={(c) => c.id}
                    columns={channelColumns}
                    emptyTitle="No channels"
                  />
                </Section>

                <Section title={`Campaigns (${d.campaigns.length})`}>
                  <DataTable
                    rows={d.campaigns}
                    rowKey={(c) => c.id}
                    columns={campaignColumns}
                    emptyTitle="No campaigns"
                  />
                </Section>

                <Section title="Recent transactions" description="Latest 20 ledger rows.">
                  <DataTable
                    rows={d.transactions}
                    rowKey={(t) => t.id}
                    columns={transactionColumns}
                    emptyTitle="No transactions"
                  />
                </Section>

                <Section title="Recent deposits" description="Latest 20.">
                  <DataTable
                    rows={d.deposits}
                    rowKey={(t) => t.id}
                    columns={depositColumns}
                    emptyTitle="No deposits"
                  />
                </Section>

                <Section title="Recent withdrawals" description="Latest 20.">
                  <DataTable
                    rows={d.withdrawals}
                    rowKey={(t) => t.id}
                    columns={withdrawalColumns}
                    emptyTitle="No withdrawals"
                  />
                </Section>
              </div>
            </div>

            <ConfirmDialog
              open={adjustOpen}
              title="Adjust available balance"
              description="Positive credits, negative debits. The amount is written to the ledger as a MANUAL_ADJUSTMENT and is audited — the API refuses a debit that would take the available balance below zero."
              confirmLabel="Apply adjustment"
              pending={adjust.isPending}
              fields={[
                {
                  name: 'amount',
                  label: 'Amount in USD (e.g. 12.50 or -5.00)',
                  placeholder: '12.50',
                  required: true,
                  hint: 'Negative values debit. Cents are preserved exactly.',
                },
                {
                  name: 'reason',
                  label: 'Reason',
                  type: 'textarea',
                  required: true,
                  maxLength: 500,
                  hint: 'Stored on the ledger row and in the audit log.',
                },
              ]}
              onCancel={() => setAdjustOpen(false)}
              onConfirm={(values) => {
                const cents = parseCents(values.amount ?? '');
                if (cents === null || cents === 0) {
                  showToast('error', 'Enter a non-zero amount, e.g. 12.50 or -5.00');
                  return;
                }
                adjust.mutate({ cents, reason: values.reason ?? '' });
              }}
            />
          </>
        ) : null}
      </QueryState>
    </>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-mute shrink-0">{label}</dt>
      <dd className="font-medium text-right min-w-0 truncate">{value}</dd>
    </div>
  );
}

const channelColumns: Column<AdminUserDetail['channels'][number]>[] = [
  {
    key: 'title',
    header: 'Channel',
    render: (c) => (
      <TwoLine primary={c.title} secondary={c.username ? `@${c.username}` : 'private'} />
    ),
  },
  { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  {
    key: 'subs',
    header: 'Subscribers',
    align: 'right',
    nowrap: true,
    render: (c) => <Mono>{c.subscriberCount.toLocaleString('en-US')}</Mono>,
  },
  {
    key: 'price',
    header: 'Price',
    align: 'right',
    nowrap: true,
    render: (c) => <Money cents={c.adPriceCents} />,
  },
];

const campaignColumns: Column<AdminUserDetail['campaigns'][number]>[] = [
  { key: 'name', header: 'Campaign', render: (c) => c.name },
  { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  {
    key: 'budget',
    header: 'Spent / budget',
    align: 'right',
    nowrap: true,
    render: (c) => (
      <span className="num text-xs">
        <Money cents={c.budgetSpentCents} /> / <Money cents={c.budgetTotalCents} />
      </span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    nowrap: true,
    render: (c) => <span className="text-xs text-mute">{formatDate(c.createdAt)}</span>,
  },
];

const transactionColumns: Column<AdminUserDetailTransaction>[] = [
  {
    key: 'type',
    header: 'Type',
    render: (t) => <TwoLine primary={t.type} secondary={<Mono>{t.reference}</Mono>} />,
  },
  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    nowrap: true,
    render: (t) => <Money cents={t.amountCents} currency={t.currency} signed />,
  },
  {
    key: 'at',
    header: 'When',
    align: 'right',
    hideBelow: 'md',
    nowrap: true,
    render: (t) => <span className="text-xs text-mute">{formatDateTime(t.createdAt)}</span>,
  },
];

const depositColumns: Column<AdminUserDetailDeposit>[] = [
  { key: 'method', header: 'Method', render: (t) => t.method },
  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    nowrap: true,
    render: (t) => <Money cents={t.amountCents} currency={t.currency} />,
  },
  {
    key: 'at',
    header: 'When',
    align: 'right',
    hideBelow: 'md',
    nowrap: true,
    render: (t) => <span className="text-xs text-mute">{formatDateTime(t.createdAt)}</span>,
  },
];

const withdrawalColumns: Column<AdminUserDetailWithdrawal>[] = [
  { key: 'method', header: 'Method', render: (t) => t.method },
  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  {
    key: 'net',
    header: 'Net',
    align: 'right',
    nowrap: true,
    render: (t) => <Money cents={t.netAmountCents} currency={t.currency} />,
  },
  {
    key: 'at',
    header: 'When',
    align: 'right',
    hideBelow: 'md',
    nowrap: true,
    render: (t) => <span className="text-xs text-mute">{formatDateTime(t.createdAt)}</span>,
  },
];
