/**
 * Ad creative review — the queue of creative versions waiting on a human.
 *
 * Where the data comes from: there is no dedicated list endpoint. The only
 * source is `GET /api/admin/ops/summary`, whose `creativeQueue` field is
 * `pendingReviewVersions()` — every version with `requiresReview && status =
 * PENDING_REVIEW`. The decision is posted to
 * `POST /api/admin/ops/creative-versions/:id/review` with `campaigns.manage`.
 *
 * Why this matters: a creative changed after approval is appended as a NEW
 * version with `requiresReview = true` and the ad goes back to PENDING_REVIEW.
 * Without this screen those versions could never be approved, and the ad would
 * sit frozen — the endpoint existed but nothing called it.
 *
 * Rendered as cards, not a table: an ad decision needs the actual text, image,
 * button and destination in front of the reviewer, and none of that reads well
 * squeezed into table cells.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { getOpsSummary, reviewCreativeVersion } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, KpiGrid, KpiTile } from '../components/Kpi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import { useState } from 'react';
import type { PendingCreativeItem } from '../lib/types';

export function AdminCreativeReviewPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('campaigns.manage');

  const query = useQuery({ queryKey: qk.adminOpsSummary, queryFn: getOpsSummary });

  const [decision, setDecision] = useState<{
    item: PendingCreativeItem;
    action: 'APPROVE' | 'REJECT';
  } | null>(null);

  const review = useMutation({
    mutationFn: ({
      id,
      action,
      note,
    }: {
      id: string;
      action: 'APPROVE' | 'REJECT';
      note: string;
    }) => reviewCreativeVersion(id, action, note),
    onSuccess: (_r, vars) => {
      showToast('success', vars.action === 'APPROVE' ? 'Version approved' : 'Version rejected');
      setDecision(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminOpsSummary });
      void queryClient.invalidateQueries({ queryKey: qk.adminCampaigns });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const queue = query.data?.creativeQueue ?? [];

  return (
    <>
      <AdminPageHeader
        title="Creative review"
        description="Versions waiting for a decision. A creative edited after approval comes back here as a new version and the ad is held at PENDING_REVIEW until someone approves or rejects it."
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
        skeletonRows={3}
      >
        <KpiGrid className="lg:grid-cols-3 mb-6">
          <KpiTile
            label="Awaiting review"
            value={queue.length}
            icon="eye"
            tone={queue.length > 0 ? 'warn' : 'good'}
          />
          <KpiTile
            label="Distinct ads held"
            value={new Set(queue.map((c) => c.adId)).size}
            icon="megaphone"
          />
          <KpiTile
            label="Oldest wait"
            value={
              queue.length > 0
                ? formatDateTime(
                    queue.reduce((oldest, c) => (c.createdAt < oldest ? c.createdAt : oldest), queue[0].createdAt),
                  )
                : '—'
            }
            icon="clock"
          />
        </KpiGrid>

        {queue.length === 0 ? (
          <div className="bg-surface border border-line rounded-2xl p-6 text-center">
            <span className="w-12 h-12 mx-auto rounded-2xl bg-ok/10 text-ok flex items-center justify-center mb-3">
              <Icon name="check" size={22} />
            </span>
            <p className="font-semibold">Nothing waiting</p>
            <p className="text-sm text-mute mt-1">
              Every creative version has been reviewed. New versions land here as soon as an
              advertiser edits a live creative.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {queue.map((item) => (
              <article
                key={item.id}
                className="bg-surface border border-line rounded-2xl p-4 grid gap-4 lg:grid-cols-[1fr_320px]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{item.ad.campaign.name}</span>
                    <span className="text-xs text-mute">by {item.ad.campaign.advertiser.name}</span>
                    <StatusBadge status={item.format} />
                    <span className="text-[11px] num px-2 py-0.5 rounded-md bg-app border border-line">
                      v{item.version}
                    </span>
                  </div>

                  <p className="text-xs text-mute mt-1 num">
                    ad {item.ad.id.slice(0, 12)}… · slug {item.ad.trackingSlug} ·{' '}
                    {formatDateTime(item.createdAt)}
                  </p>

                  <div className="mt-3 bg-app border border-line rounded-xl p-3">
                    <p className="text-[11px] uppercase tracking-wide text-mute font-semibold mb-1.5">
                      Post text
                    </p>
                    <p className="text-sm whitespace-pre-wrap break-words">{item.text}</p>
                  </div>

                  {item.changeNote ? (
                    <p className="text-xs text-warn mt-2">
                      <strong>Advertiser&apos;s change note:</strong> {item.changeNote}
                    </p>
                  ) : null}

                  {item.destinationUrl ? (
                    <p className="text-xs text-mute mt-2">
                      Destination:{' '}
                      <a
                        href={item.destinationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-link hover:underline break-all"
                      >
                        {item.destinationUrl}
                      </a>
                    </p>
                  ) : null}

                  <div className="flex flex-wrap gap-2 mt-4">
                    <Button
                      size="sm"
                      disabled={!canManage}
                      icon={<Icon name="check" size={14} />}
                      onClick={() => setDecision({ item, action: 'APPROVE' })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!canManage}
                      icon={<Icon name="x" size={14} />}
                      onClick={() => setDecision({ item, action: 'REJECT' })}
                    >
                      Reject
                    </Button>
                    {!canManage ? (
                      <span className="text-xs text-warn self-center">
                        Needs <code className="num">campaigns.manage</code>
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Preview column */}
                <div className="bg-app border border-line rounded-xl p-3 space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-mute font-semibold">
                    Rendered preview
                  </p>
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="w-full rounded-lg border border-line object-cover max-h-48"
                    />
                  ) : null}
                  <p className="text-sm whitespace-pre-wrap break-words">{item.text}</p>
                  {item.buttonText ? (
                    <div className="pt-1">
                      <span className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-ink text-app text-xs font-medium">
                        {item.buttonText}
                        <Icon name="chevronRight" size={13} />
                      </span>
                      {item.buttonUrl ? (
                        <p className="text-[10px] text-mute mt-1 break-all num">{item.buttonUrl}</p>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-[10px] text-mute pt-1">
                    Preview is a close approximation — Telegram&apos;s own rendering is what users see.
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </QueryState>

      <ConfirmDialog
        open={decision !== null}
        title={
          decision?.action === 'APPROVE'
            ? 'Approve this creative version?'
            : 'Reject this creative version?'
        }
        description={
          decision?.action === 'APPROVE'
            ? `Version ${decision.item.version} of “${decision.item.ad.campaign.name}” becomes the live creative and the ad is released back to delivery.`
            : decision
              ? `Version ${decision.item.version} is closed and the previous approved version stays live. The advertiser is told why.`
              : ''
        }
        confirmLabel={decision?.action === 'APPROVE' ? 'Approve' : 'Reject'}
        danger={decision?.action === 'REJECT'}
        pending={review.isPending}
        fields={[
          {
            name: 'note',
            label: decision?.action === 'REJECT' ? 'Reason' : 'Note',
            type: 'textarea',
            required: decision?.action === 'REJECT',
            maxLength: 300,
            hint:
              decision?.action === 'REJECT'
                ? 'Shown to the advertiser so they can fix it. Max 300 characters.'
                : 'Optional. Max 300 characters.',
          },
        ]}
        onCancel={() => setDecision(null)}
        onConfirm={(values) => {
          if (!decision) return;
          review.mutate({
            id: decision.item.id,
            action: decision.action,
            note: values.note ?? '',
          });
        }}
      />
    </>
  );
}
