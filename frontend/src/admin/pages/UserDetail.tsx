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
import { Icon, type IconName } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  adjustBalance,
  banUser,
  getUser,
  recalculateRisk,
  suspendUser,
  unbanUser,
  unsuspendUser,
} from '../lib/api';
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
  const [moderation, setModeration] = useState<ModerationAction | null>(null);

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

  // One mutation for all four moderation endpoints. The dossier and the user
  // LIST both change when a status flips, so both caches are invalidated — a
  // stale list row showing ACTIVE after a ban is how an operator bans twice.
  const moderate = useMutation({
    mutationFn: ({ action, reason }: { action: ModerationAction; reason: string }) => {
      switch (action) {
        case 'suspend':
          return suspendUser(id, reason);
        case 'ban':
          return banUser(id, reason);
        case 'unsuspend':
          return unsuspendUser(id);
        case 'unban':
          return unbanUser(id);
      }
    },
    onSuccess: (_res, vars) => {
      showToast('success', MODERATION_META[vars.action].toast);
      setModeration(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminUser(id) });
      void queryClient.invalidateQueries({ queryKey: qk.adminUsers });
    },
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

                {can('users.manage') ? (
                  <ModerationPanel profile={d.profile} onAction={setModeration} />
                ) : null}

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

            {moderation && can('users.manage') ? (
              <ConfirmDialog
                open
                title={MODERATION_META[moderation].title}
                description={MODERATION_META[moderation].description}
                confirmLabel={MODERATION_META[moderation].confirmLabel}
                danger={MODERATION_META[moderation].danger}
                pending={moderate.isPending}
                fields={
                  MODERATION_META[moderation].needsReason
                    ? [
                        {
                          name: 'reason',
                          label: 'Reason (3–500 characters)',
                          type: 'textarea',
                          required: true,
                          maxLength: 500,
                          hint: 'Stored as the audit-facing record of why and shown on this dossier while the status lasts.',
                        },
                      ]
                    : []
                }
                onCancel={() => setModeration(null)}
                onConfirm={(values) => {
                  const meta = MODERATION_META[moderation];
                  if (meta.needsReason) {
                    const reason = (values.reason ?? '').trim();
                    // The API requires 3..500; the dialog's `required` blocks an
                    // empty box but not a 1-character one.
                    if (reason.length < 3) {
                      showToast('error', 'Enter a reason of at least 3 characters');
                      return;
                    }
                    moderate.mutate({ action: moderation, reason });
                  } else {
                    moderate.mutate({ action: moderation, reason: '' });
                  }
                }}
              />
            ) : null}
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

/* ------------------------------------------------------------------
 *  Moderation (spec §9, §10, §45)
 *
 *  The four endpoints existed backend-only. Which control appears is a pure
 *  function of the CURRENT `profile.status` — offering "Suspend" on a BANNED
 *  account, or "Unsuspend" on an ACTIVE one, is a guaranteed 409 from the
 *  service, so those buttons are never rendered rather than shown disabled.
 *  Suspending and banning are destructive: each dialog names the concrete
 *  consequence (telegramAuth rejects SUSPENDED/BANNED on every request) before
 *  the operator can confirm.
 * ------------------------------------------------------------------ */

type ModerationAction = 'suspend' | 'ban' | 'unsuspend' | 'unban';

interface ModerationMeta {
  title: string;
  confirmLabel: string;
  /** Red confirm button for the two destructive transitions. */
  danger: boolean;
  needsReason: boolean;
  toast: string;
  description: string;
}

const MODERATION_META: Record<ModerationAction, ModerationMeta> = {
  suspend: {
    title: 'Suspend this account',
    confirmLabel: 'Suspend',
    danger: true,
    needsReason: true,
    toast: 'User suspended',
    description:
      "Suspending takes effect immediately: this user's API access stops — telegramAuth rejects SUSPENDED and BANNED accounts on every request, so the bot and Mini App stop working for them until the suspension is lifted. No money is moved; balances, escrow and open campaigns are left untouched.",
  },
  ban: {
    title: 'Ban this account',
    confirmLabel: 'Ban',
    danger: true,
    needsReason: true,
    toast: 'User banned',
    description:
      "Banning takes effect immediately: this user's API access stops — telegramAuth rejects BANNED and SUSPENDED accounts on every request. It is the same block as a suspension, but intended to be permanent until an admin lifts it. No money is moved; balances are left in place.",
  },
  unsuspend: {
    title: 'Lift this suspension',
    confirmLabel: 'Unsuspend',
    danger: false,
    needsReason: false,
    toast: 'Suspension lifted',
    description:
      'The account returns to ACTIVE and the recorded suspension reason is cleared. Access is restored immediately.',
  },
  unban: {
    title: 'Lift this ban',
    confirmLabel: 'Unban',
    danger: false,
    needsReason: false,
    toast: 'Ban lifted',
    description:
      'The account returns to ACTIVE and the recorded ban reason is cleared. Access is restored immediately.',
  },
};

/**
 * The only actions each status accepts. A status the panel does not recognise
 * (or a future one) maps to no buttons — the server is the authority, and an
 * unknown state must not be given a guess.
 */
const STATUS_ACTIONS: Record<string, ModerationAction[]> = {
  ACTIVE: ['suspend', 'ban'],
  SUSPENDED: ['unsuspend', 'ban'],
  BANNED: ['unban'],
};

const ACTION_ICON: Record<ModerationAction, IconName> = {
  suspend: 'clock',
  ban: 'alert',
  unsuspend: 'check',
  unban: 'check',
};

function ModerationPanel({
  profile,
  onAction,
}: {
  profile: AdminUserDetail['profile'];
  onAction: (action: ModerationAction) => void;
}) {
  const actions = STATUS_ACTIONS[profile.status] ?? [];
  // `suspendedReason` is the audit-facing record of why, when the API supplies
  // it. Read defensively: it is optional on the wire.
  const suspendedReason =
    (profile as { suspendedReason?: string | null }).suspendedReason ?? null;

  return (
    <Section
      title="Account moderation"
      description="Suspending or banning stops this user's API access immediately (telegramAuth rejects SUSPENDED and BANNED accounts) and moves no money."
    >
      <div className="bg-surface border border-line rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-mute">Current status</span>
          <StatusBadge status={profile.status} />
        </div>

        {suspendedReason ? (
          <div className="text-xs">
            <span className="text-mute">Recorded reason · </span>
            <span className="font-medium break-words">{suspendedReason}</span>
          </div>
        ) : null}

        {profile.isAdmin ? (
          <p className="text-xs text-warn flex items-start gap-1.5">
            <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
            <span>
              This account is an admin. The server refuses to moderate your own account, and refuses
              to ban an ACTIVE admin unless the actor is a SUPER_ADMIN.
            </span>
          </p>
        ) : null}

        {actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action) => {
              const meta = MODERATION_META[action];
              return (
                <Button
                  key={action}
                  variant={meta.danger ? 'danger' : 'primary'}
                  size="sm"
                  icon={<Icon name={ACTION_ICON[action]} size={15} />}
                  onClick={() => onAction(action)}
                >
                  {meta.confirmLabel}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </Section>
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
