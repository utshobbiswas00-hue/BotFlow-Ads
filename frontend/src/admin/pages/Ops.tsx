/**
 * Operations — the `/api/admin/ops` surface, plus the live queue probe.
 *
 * This is a different router from everything else in the panel: it is defined in
 * `routes/policy.routes.ts` and mounted as `/api/admin/ops`. Its `/summary`
 * endpoint is an aggregate (queue counts, house fill, unpaid creative review,
 * referral queue) rather than a filtered list, which is why this screen is a
 * dashboard and not a table with filters.
 *
 * Two actions here are **role-gated, not permission-gated**:
 * `/ops/cpc/settle` and `/ops/referrals/settle` use
 * `requireRole('ADMIN','SUPER_ADMIN','FINANCE_MANAGER')`. A MODERATOR holding
 * every permission key still cannot call them, so the buttons check the session
 * role as well — otherwise they would offer a guaranteed 403.
 *
 * `GET /health/queues` lives at the app root (not under /api) but is still
 * admin-gated, and is the only view of BullMQ waiting/active/failed counts.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  getCpcSummary,
  getOpsSummary,
  getQueueHealth,
  getRecentDeliveryEvents,
  refreshAllChannelHealth,
  settleCpc,
  settleReferrals,
} from '../lib/api';
import { SETTLEMENT_ROLES } from '../lib/permissions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, TwoLine, type Column } from '../components/DataTable';
import { QueryState } from '../components/StateBlock';
import type { CpcBillingSummary, DeliveryEventRow, QueueHealthRow } from '../lib/types';

export function AdminOpsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can, role } = useAdminSession();

  const summary = useQuery({ queryKey: qk.adminOpsSummary, queryFn: getOpsSummary });
  const queues = useQuery({ queryKey: qk.adminQueueHealth, queryFn: getQueueHealth });
  const events = useQuery({ queryKey: qk.adminDeliveryEvents, queryFn: getRecentDeliveryEvents });

  const canSettle = role !== null && SETTLEMENT_ROLES.includes(role);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminOpsSummary });
    void queryClient.invalidateQueries({ queryKey: qk.adminQueueHealth });
    void queryClient.invalidateQueries({ queryKey: qk.adminDeliveryEvents });
  };

  const health = useMutation({
    mutationFn: refreshAllChannelHealth,
    onSuccess: (res) => {
      showToast('success', `Channel health refreshed — ${res.changed} channel(s) changed state`);
      void queryClient.invalidateQueries({ queryKey: qk.adminChannels });
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const cpc = useMutation({
    mutationFn: settleCpc,
    onSuccess: (res) => {
      showToast('success', `CPC settled — ${res.settled} post(s) charged`);
      void queryClient.invalidateQueries({ queryKey: qk.adminTransactions });
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const referrals = useMutation({
    mutationFn: settleReferrals,
    onSuccess: (res) => {
      showToast('success', `Referral sweep finished — ${res.rewarded} reward(s) paid`);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const d = summary.data;

  const queueColumns: Column<QueueHealthRow>[] = [
    { key: 'name', header: 'Queue', render: (q) => <Mono>{q.name}</Mono> },
    {
      key: 'waiting',
      header: 'Waiting',
      align: 'right',
      nowrap: true,
      render: (q) => <QueueCount value={q.waiting} tone="warn" />,
    },
    {
      key: 'active',
      header: 'Active',
      align: 'right',
      nowrap: true,
      render: (q) => <QueueCount value={q.active} tone="neutral" />,
    },
    {
      key: 'failed',
      header: 'Failed',
      align: 'right',
      nowrap: true,
      render: (q) => <QueueCount value={q.failed} tone="bad" />,
    },
    {
      key: 'delayed',
      header: 'Delayed',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (q) => <QueueCount value={q.delayed} tone="neutral" />,
    },
    {
      key: 'completed',
      header: 'Completed',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (q) => <span className="num text-xs text-mute">{q.completed}</span>,
    },
  ];

  const eventColumns: Column<DeliveryEventRow>[] = [
    {
      key: 'type',
      header: 'Event',
      render: (e) => (
        <TwoLine
          primary={<span className="num text-xs font-medium">{e.type}</span>}
          secondary={
            <span className="text-xs text-mute">
              {e.deliveryJob.campaign.name} · {e.deliveryJob.channel.title}
            </span>
          }
        />
      ),
    },
    {
      key: 'actor',
      header: 'Actor',
      hideBelow: 'md',
      render: (e) => <span className="text-xs text-mute">{humanize(e.actorType)}</span>,
    },
    {
      key: 'error',
      header: 'Error',
      hideBelow: 'lg',
      render: (e) =>
        e.errorCode ? (
          <span className="num text-xs text-danger">{e.errorCode}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'message',
      header: 'Message',
      hideBelow: 'md',
      render: (e) =>
        e.message ? (
          <span className="text-xs text-mute line-clamp-2 max-w-sm block">{e.message}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'at',
      header: 'When',
      align: 'right',
      nowrap: true,
      render: (e) => <span className="text-xs text-mute">{formatDateTime(e.createdAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Ops dashboard"
        description="Queue depth, unsold-inventory fill, the creative review backlog and the referral queue — the aggregate the other screens are filtered views of."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={15} />}
              onClick={() => void summary.refetch()}
            >
              Refresh
            </Button>
            {can('delivery.manage') ? (
              <Button
                size="sm"
                variant="secondary"
                loading={health.isPending}
                icon={<Icon name="channel" size={15} />}
                onClick={() => health.mutate()}
              >
                Refresh channel health
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryState
        isPending={summary.isPending}
        isError={summary.isError}
        error={summary.error}
        onRetry={() => void summary.refetch()}
        skeletonRows={4}
      >
        {d ? (
          <div className="space-y-8">
            <Section title="Queues" description="Delivery backlog, grouped the way the worker sees it.">
              <KpiGrid>
                <KpiTile
                  label="Published"
                  value={d.delivery.published}
                  icon="check"
                  tone="good"
                  onClick={() => navigate('/admin/delivery?status=COMPLETED')}
                />
                <KpiTile
                  label="In flight"
                  value={d.delivery.pending}
                  sub={`${d.delivery.awaitingApproval} awaiting publisher approval`}
                  icon="send"
                />
                <KpiTile
                  label="Failed"
                  value={d.delivery.failed}
                  icon="alert"
                  tone={d.delivery.failed > 0 ? 'bad' : 'good'}
                  onClick={() => navigate('/admin/delivery?status=FAILED')}
                />
                <KpiTile label="Cancelled" value={d.delivery.cancelled} icon="x" />
              </KpiGrid>
            </Section>

            <Section
              title="Inventory fill & creatives"
              description="House posts only run in inventory no paid campaign claimed."
            >
              <KpiGrid>
                <KpiTile
                  label="House posts today"
                  value={d.house.housePostsToday}
                  sub={`${d.house.housePostsTotal} all time`}
                  icon="megaphone"
                />
                <KpiTile label="Active house creatives" value={d.houseAds.activeCreatives} icon="doc" />
                <KpiTile
                  label="Awaiting creative review"
                  value={d.creativeQueue.length}
                  icon="eye"
                  tone={d.creativeQueue.length > 0 ? 'warn' : 'good'}
                  onClick={() => navigate('/admin/ops/creative')}
                />
                <KpiTile
                  label="Distinct ads held"
                  value={new Set(d.creativeQueue.map((c) => c.adId)).size}
                  icon="target"
                />
              </KpiGrid>
            </Section>

            <Section
              title="Referral queue"
              description="Rewards held back for review or a minimum threshold. The sweep normally runs on a schedule; it can be forced here."
            >
              <KpiGrid>
                <KpiTile
                  label="Pending"
                  value={d.referrals.pending}
                  sub={
                    d.referrals.pendingRewardsCents > 0
                      ? `${formatMoney(d.referrals.pendingRewardsCents)} payable`
                      : undefined
                  }
                  icon="clock"
                  tone={d.referrals.pending > 0 ? 'warn' : 'neutral'}
                />
                <KpiTile label="Rewarded" value={d.referrals.rewarded} icon="check" tone="good" />
                <KpiTile label="Rejected" value={d.referrals.rejected} icon="x" />
                <KpiTile
                  label="Pending payout value"
                  value={<Money cents={d.referrals.pendingRewardsCents} />}
                  icon="coin"
                />
              </KpiGrid>

              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Button
                  size="sm"
                  disabled={!canSettle}
                  loading={referrals.isPending}
                  icon={<Icon name="coin" size={15} />}
                  onClick={() => referrals.mutate()}
                >
                  Run referral sweep now
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canSettle}
                  loading={cpc.isPending}
                  icon={<Icon name="dollar" size={15} />}
                  onClick={() => cpc.mutate()}
                >
                  Settle CPC posts
                </Button>
                <span className="text-xs text-mute">
                  {canSettle
                    ? 'Both sweeps are role-gated (ADMIN / SUPER_ADMIN / FINANCE_MANAGER), not permission-gated.'
                    : `Your role (${role ?? 'unknown'}) is not in ADMIN / SUPER_ADMIN / FINANCE_MANAGER, so the API refuses both sweeps.`}
                </span>
              </div>
            </Section>

            <Section
              title="Delivery events, last 24h"
              description="Only event types that actually occurred appear; a missing type means zero."
            >
              {Object.keys(d.deliveryEvents).length === 0 ? (
                <div className="bg-surface border border-line rounded-2xl p-4 text-sm text-mute">
                  No delivery events in the last 24 hours.
                </div>
              ) : (
                <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
                  {Object.entries(d.deliveryEvents)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between px-4 py-2.5">
                        <span className="num text-xs">{type}</span>
                        <span className="num text-sm font-medium">{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </Section>
          </div>
        ) : null}
      </QueryState>

      <Section
        className="mt-8"
        title="Worker queues"
        description="Live BullMQ counts from GET /health/queues — the only place a stuck queue is visible."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={15} />}
            onClick={() => void queues.refetch()}
          >
            Refresh
          </Button>
        }
      >
        <QueryState
          isPending={queues.isPending}
          isError={queues.isError}
          error={queues.error}
          onRetry={() => void queues.refetch()}
          skeletonRows={3}
        >
          <DataTable
            rows={queues.data ?? []}
            columns={queueColumns}
            rowKey={(q) => q.name}
            emptyTitle="No queues reported"
          />
        </QueryState>
      </Section>

      <Section
        className="mt-8"
        title="Recent delivery events"
        description="The newest 100 events across every job — the raw trail behind the delivery table."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={15} />}
            onClick={() => void events.refetch()}
          >
            Refresh
          </Button>
        }
      >
        <QueryState
          isPending={events.isPending}
          isError={events.isError}
          error={events.error}
          onRetry={() => void events.refetch()}
          skeletonRows={3}
        >
          <DataTable
            rows={events.data ?? []}
            columns={eventColumns}
            rowKey={(e) => e.id}
            emptyTitle="No events"
            emptyMessage="Nothing has happened in the delivery pipeline yet."
          />
        </QueryState>
      </Section>

      <Section
        className="mt-8"
        title="CPC billing summary"
        description="CPC is billed on valid tracked clicks only — fraud-flagged clicks are excluded and settlement is idempotent per click count."
      >
        <CpcLookup />
      </Section>
    </>
  );
}

function QueueCount({ value, tone }: { value: number; tone: 'bad' | 'warn' | 'neutral' }) {
  const cls = value === 0 ? 'text-mute' : tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink';
  return <span className={`num text-sm font-medium ${cls}`}>{value}</span>;
}

function CpcLookup() {
  const [advertiserId, setAdvertiserId] = useState('');
  const [result, setResult] = useState<CpcBillingSummary | null>(null);

  const lookup = useMutation({
    mutationFn: (id: string) => getCpcSummary(id),
    onSuccess: (data) => setResult(data),
    onError: (e) => {
      setResult(null);
      showToast('error', errMsg(e));
    },
  });

  return (
    <div className="bg-surface border border-line rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Advertiser user id"
          className="max-w-md num"
          placeholder="internal user id (cuid)"
          value={advertiserId}
          onChange={(e) => setAdvertiserId(e.target.value)}
        />
        <Button
          size="sm"
          loading={lookup.isPending}
          disabled={!advertiserId.trim()}
          icon={<Icon name="search" size={15} />}
          onClick={() => lookup.mutate(advertiserId.trim())}
        >
          Look up
        </Button>
      </div>

      {result ? (
        <KpiGrid className="lg:grid-cols-4">
          <KpiTile label="CPC posts" value={result.posts} icon="megaphone" />
          <KpiTile label="Valid clicks" value={result.validClicks} icon="target" />
          <KpiTile label="Billed" value={<Money cents={result.billedCents} />} icon="dollar" />
          <KpiTile
            label="Pending settlement"
            value={<Money cents={result.pendingSettlementCents} />}
            icon="clock"
            tone={result.pendingSettlementCents > 0 ? 'warn' : 'good'}
          />
        </KpiGrid>
      ) : (
        <p className="text-xs text-mute">
          Enter an advertiser&apos;s internal user id (from the user dossier) to see their CPC totals.
        </p>
      )}
    </div>
  );
}
