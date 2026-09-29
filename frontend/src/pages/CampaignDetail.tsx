import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import { formatMoney, formatDate, humanize, ctrString } from '../lib/format';
import { useCampaign, useInvalidateCampaigns } from '../hooks/useCampaigns';
import { AdPreview } from '../components/domain/AdPreview';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card, CardTitle } from '../components/ui/Card';
import { Modal } from '../components/ui/Modal';
import { Textarea } from '../components/ui/Textarea';
import { StatusBadge } from '../components/ui/StatusBadge';
import { PageSkeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

/** Mirrors the backend's POST /api/campaigns/:id/{pause|resume|cancel}. */
type Action = 'PAUSE' | 'RESUME' | 'CANCEL';

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateCampaigns();
  const q = useCampaign(id);

  const [actionModal, setActionModal] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (a: Action): Promise<unknown> =>
      api.post(`/api/campaigns/${id}/${a.toLowerCase()}`, { note: note.trim() || undefined }),
    onSuccess: (_data, a) => {
      showToast('success', `${humanize(a.toLowerCase())} — done`);
      setActionModal(null);
      setNote('');
      invalidate();
      void q.refetch();
      void qc.invalidateQueries({ queryKey: qk.dashboard });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data)
    return (
      <>
        <PageHeader title="Campaign" back />
        <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
      </>
    );

  const c = q.data;
  const s = c.stats;
  const spentPct = c.budgetTotalCents > 0 ? Math.min(100, Math.round((c.budgetSpentCents / c.budgetTotalCents) * 100)) : 0;

  const confirm = (): void => {
    if (actionModal === 'CANCEL' && note.trim().length < 3) {
      setNoteError('Please give a short reason for cancelling');
      return;
    }
    if (actionModal) act.mutate(actionModal);
  };

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={humanize(c.promotionTarget)}
        back
        actions={<StatusBadge status={c.status} />}
      />

      <div className="space-y-4 mt-2">
        {/* Budget */}
        <Card>
          <div className="flex justify-between text-xs text-mute mb-1">
            <span>Budget used</span>
            <span>
              {formatMoney(c.budgetSpentCents)} / {formatMoney(c.budgetTotalCents)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-line overflow-hidden mb-3">
            <div className="h-full rounded-full bg-accent" style={{ width: `${spentPct}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="font-bold">{s.views.toLocaleString()}</p>
              <p className="text-xs text-mute">Views</p>
            </div>
            <div>
              <p className="font-bold">{s.clicks.toLocaleString()}</p>
              <p className="text-xs text-mute">Clicks</p>
            </div>
            <div>
              <p className="font-bold text-link">{ctrString(s.ctr)}</p>
              <p className="text-xs text-mute">CTR</p>
            </div>
          </div>
        </Card>

        {/* Meta */}
        <Card className="space-y-2.5">
          <MetaRow k="Status" v={<StatusBadge status={c.status} />} />
          <MetaRow k="Pricing" v={humanize(c.pricingModel)} />
          <MetaRow k="Posts per channel" v={String(c.frequencyPerChannel)} />
          <MetaRow
            k="Targeting"
            v={c.isAutoTargeting ? 'Auto-targeting' : c.stats ? `${c.stats.targetChannels} selected channels` : '—'}
          />
          <MetaRow
            k="Channels reached"
            v={`${s.published} published · ${s.awaitingApproval} awaiting · ${s.pending} pending · ${s.failed} failed`}
          />
          <MetaRow k="Created" v={formatDate(c.createdAt)} />
          {c.startAt && <MetaRow k="Starts" v={formatDate(c.startAt)} />}
          {c.endAt && <MetaRow k="Ends" v={formatDate(c.endAt)} />}
          {c.budgetReservedCents > 0 && (
            <MetaRow k="Reserved" v={formatMoney(c.budgetReservedCents)} />
          )}
        </Card>

        {/* Creatives */}
        <div>
          <CardTitle>Ad creatives</CardTitle>
          <div className="space-y-3">
            {(c.ads ?? []).map((cr, i) => (
              <AdPreview
                key={cr.id ?? i}
                channelName={c.name}
                text={cr.text}
                imageUrl={cr.imageUrl}
                buttonText={cr.buttonText}
                buttonUrl={cr.buttonUrl}
              />
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pb-4">
          {c.status === 'RUNNING' && (
            <Button variant="secondary" icon={<Icon name="clock" size={16} />} onClick={() => setActionModal('PAUSE')}>
              Pause
            </Button>
          )}
          {(c.status === 'PAUSED' || c.status === 'SUSPENDED') && (
            <Button icon={<Icon name="refresh" size={16} />} onClick={() => setActionModal('RESUME')}>
              Resume
            </Button>
          )}
          {!['CANCELLED', 'COMPLETED'].includes(c.status) && (
            <Button variant="danger" icon={<Icon name="x" size={16} />} onClick={() => setActionModal('CANCEL')}>
              Cancel
            </Button>
          )}
          <Button
            variant="ghost"
            icon={<Icon name="plus" size={16} />}
            onClick={() => navigate('/advertise/new')}
          >
            New campaign
          </Button>
        </div>
      </div>

      {/* Action modal */}
      <Modal open={actionModal !== null} onClose={() => setActionModal(null)} title={actionModal ? `Confirm ${humanize(actionModal.toLowerCase())}` : ''}>
        <p className="text-sm text-mute mb-3">
          {actionModal === 'CANCEL'
            ? 'Cancelling releases reserved budget and stops delivery. This cannot be undone.'
            : actionModal === 'PAUSE'
              ? 'The campaign will stop delivering until you resume it.'
              : 'Delivery will resume on the scheduled channels.'}
        </p>
        {actionModal === 'CANCEL' && (
          <Textarea
            label="Reason (required)"
            placeholder="e.g. Campaign no longer needed"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteError(null);
            }}
            error={noteError ?? undefined}
            rows={3}
          />
        )}
        <div className="flex gap-2 mt-4">
          <Button variant="secondary" full onClick={() => setActionModal(null)}>
            Keep
          </Button>
          <Button variant={actionModal === 'CANCEL' ? 'danger' : 'primary'} full loading={act.isPending} onClick={confirm}>
            {actionModal ? humanize(actionModal.toLowerCase()) : ''}
          </Button>
        </div>
      </Modal>

    </>
  );
}

function MetaRow({ k, v }: { k: string; v: string | ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-mute shrink-0">{k}</span>
      <span className="font-medium text-right">{v}</span>
    </div>
  );
}
