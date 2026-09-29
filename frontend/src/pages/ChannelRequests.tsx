import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { ChannelRequest } from '../lib/contracts';
import { formatDate, formatMoney, fromNow } from '../lib/format';
import { PageHeader } from '../components/layout/PageHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Textarea } from '../components/ui/Textarea';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

export function ChannelRequestsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: [...qk.channel(id ?? ''), 'requests'],
    enabled: !!id,
    // Only AWAITING_APPROVAL jobs are returned, and each row carries no status.
    queryFn: (): Promise<Paginated<ChannelRequest>> =>
      api.get<Paginated<ChannelRequest>>(`/api/channels/${id}/requests`, { page: 1, limit: 30 }),
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [reason, setReason] = useState('');

  const act = useMutation({
    // Backend enum is lowercase: requestActionBody = z.enum(['approve','reject']).
    mutationFn: (body: { requestId: string; action: 'approve' | 'reject'; reason?: string }): Promise<unknown> =>
      api.post(`/api/channels/${id}/requests/${body.requestId}`, { action: body.action, reason: body.reason }),
    onSuccess: (_d, body) => {
      showToast('success', body.action === 'approve' ? 'Request approved — posting will begin' : 'Request rejected');
      setPendingId(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: [...qk.channel(id ?? ''), 'requests'] });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
      void qc.invalidateQueries({ queryKey: qk.wallet });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const items = q.data?.items ?? [];

  return (
    <>
      <PageHeader title="Ad requests" subtitle="Sponsorships for your channel" back />

      {q.isPending ? (
        <ListSkeleton rows={3} />
      ) : q.isError ? (
        <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="doc"
          title="No requests yet"
          message="When an advertiser wants to sponsor your channel, their request will appear here."
        />
      ) : (
        <div className="space-y-4 mt-2">
          <div>
            <h3 className="text-sm font-semibold text-mute uppercase tracking-wide mb-2">Pending ({items.length})</h3>
            <div className="space-y-3">
              {items.map((r) => (
                <RequestCard key={r.id} r={r} onAction={(a) => { setAction(a); setPendingId(r.id); }} busy={act.isPending} />
              ))}
            </div>
          </div>
        </div>
      )}

      <Modal open={pendingId !== null} onClose={() => setPendingId(null)} title={action === 'approve' ? 'Approve request' : 'Reject request'}>
        <p className="text-sm text-mute">
          {action === 'approve'
            ? 'The sponsored post will be published according to your channel settings.'
            : 'The advertiser will be refunded. This helps us improve matching.'}
        </p>
        {action === 'reject' && (
          <div className="mt-3">
            <Textarea
              label="Reason (optional)"
              placeholder="e.g. Not relevant to my audience"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
        )}
        <div className="flex gap-2 mt-4">
          <Button variant="secondary" full onClick={() => setPendingId(null)}>
            Cancel
          </Button>
          <Button
            full
            variant={action === 'reject' ? 'danger' : 'primary'}
            loading={act.isPending}
            onClick={() => pendingId && act.mutate({ requestId: pendingId, action, reason: reason.trim() || undefined })}
          >
            {action === 'approve' ? 'Approve' : 'Reject'}
          </Button>
        </div>
      </Modal>

    </>
  );
}

function RequestCard({
  r,
  onAction,
  busy,
}: {
  r: ChannelRequest;
  onAction?: (a: 'approve' | 'reject') => void;
  busy?: boolean;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{r.campaignName}</p>
          <p className="text-xs text-mute mt-0.5">
            {r.advertiserName} · {fromNow(r.createdAt)} · {formatDate(r.createdAt)}
          </p>
        </div>
        <span className="font-bold text-sm whitespace-nowrap text-ok">+{formatMoney(r.priceCents)}</span>
      </div>
      <p className="text-sm text-mute bg-app rounded-xl px-3 py-2.5 mt-2.5 line-clamp-3 whitespace-pre-wrap">
        “{r.adText}”
      </p>
      {onAction && (
        <div className="flex gap-2 mt-3">
          <Button size="sm" variant="secondary" className="flex-1" disabled={busy} onClick={() => onAction('reject')}>
            Reject
          </Button>
          <Button size="sm" className="flex-1" disabled={busy} icon={<Icon name="check" size={15} />} onClick={() => onAction('approve')}>
            Approve
          </Button>
        </div>
      )}
    </Card>
  );
}
