import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_CATEGORIES } from '@botflow/shared';
import { api, errMsg } from '../../lib/api';
import type { BlocklistAddBody, BlocklistEntry, BlocklistScope } from '../../lib/contracts';
import { categoryLabel, formatDate, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { useChannelBlocklist } from '../../hooks/useChannels';
import { showToast } from '../../store/uiStore';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { Icon } from '../ui/icons';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { Spinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';

const SCOPE_OPTIONS: Array<{ value: BlocklistScope; label: string }> = [
  { value: 'ADVERTISER', label: 'Advertiser' },
  { value: 'CAMPAIGN', label: 'Campaign' },
  { value: 'CATEGORY', label: 'Ad category' },
  { value: 'DOMAIN', label: 'Destination domain' },
];

const SCOPE_COUNT_LABELS: Record<BlocklistScope, string> = {
  ADVERTISER: 'Advertisers',
  CAMPAIGN: 'Campaigns',
  CATEGORY: 'Categories',
  DOMAIN: 'Domains',
};

/**
 * Mirror the server normalisation (backend blocklist.service) so the UI
 * shows exactly what will be stored:
 *   DOMAIN       -> lowercase, scheme stripped, leading "www." stripped
 *   CATEGORY     -> uppercase (chosen from CHANNEL_CATEGORIES)
 *   ADVERTISER / CAMPAIGN -> trimmed, lowercased
 */
function normalizeValue(scope: BlocklistScope, raw: string): string {
  const v = raw.trim();
  if (scope === 'DOMAIN') {
    return v
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
  if (scope === 'CATEGORY') return v.toUpperCase();
  return v.toLowerCase();
}

function valueLabelFor(scope: BlocklistScope): string {
  switch (scope) {
    case 'ADVERTISER':
      return 'Advertiser';
    case 'CAMPAIGN':
      return 'Campaign';
    case 'DOMAIN':
      return 'Domain';
    default:
      return 'Value';
  }
}

/**
 * Per-channel ad blocklist: view entries + per-scope counts, add a block
 * (advertiser / campaign / category / domain) and remove one behind a
 * confirmation. Mounted inside the channel detail page.
 */
export function BlocklistPanel({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const q = useChannelBlocklist(channelId);

  const [scope, setScope] = useState<BlocklistScope>('ADVERTISER');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [confirming, setConfirming] = useState<BlocklistEntry | null>(null);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: qk.channelBlocklist(channelId) });
  };

  const add = useMutation({
    mutationFn: (body: BlocklistAddBody): Promise<BlocklistEntry> =>
      api.post<BlocklistEntry>(`/api/channels/${channelId}/blocklist`, body),
    onSuccess: () => {
      showToast('success', 'Block entry added');
      setValue('');
      setLabel('');
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (entryId: string): Promise<{ removed: true }> =>
      api.delete(`/api/channels/${channelId}/blocklist/${entryId}`),
    onSuccess: () => {
      showToast('success', 'Block entry removed');
      setConfirming(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    const normalized = normalizeValue(scope, value);
    if (!normalized) {
      showToast('error', 'Enter a value to block');
      return;
    }
    if (normalized.length > 200) {
      showToast('error', 'Value is too long (max 200 characters)');
      return;
    }
    const cleanLabel = label.trim();
    if (cleanLabel.length > 120) {
      showToast('error', 'Label is too long (max 120 characters)');
      return;
    }
    add.mutate(cleanLabel ? { scope, value: normalized, label: cleanLabel } : { scope, value: normalized });
  };

  return (
    <Card>
      <CardTitle>Ad blocklist</CardTitle>
      <p className="text-xs text-mute -mt-2 mb-3">
        Blocked advertisers, campaigns, categories and domains are never served on this channel.
      </p>

      {q.isError && <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />}
      {q.isPending && (
        <div className="flex items-center gap-2 text-sm text-mute py-2">
          <Spinner size={16} /> Loading…
        </div>
      )}

      {q.data && (
        <>
          {/* Per-scope counts from the server summary */}
          <div className="grid grid-cols-4 gap-2 mb-3">
            {(Object.keys(SCOPE_COUNT_LABELS) as BlocklistScope[]).map((s) => (
              <div key={s} className="bg-app rounded-lg px-1.5 py-1.5 text-center">
                <p className="font-bold text-sm leading-tight">{q.data.summary[s]}</p>
                <p className="text-[10px] text-mute leading-tight">{SCOPE_COUNT_LABELS[s]}</p>
              </div>
            ))}
          </div>

          {q.data.entries.length === 0 ? (
            <div className="mb-1">
              <EmptyState
                icon="filter"
                title="Nothing blocked"
                message="Ads from blocked sources never reach this channel."
              />
            </div>
          ) : (
            <div className="divide-y divide-line -mx-4 mb-3">
              {q.data.entries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={entry.scope} />
                      <p className="text-sm font-medium truncate">{entry.value}</p>
                    </div>
                    {entry.label && <p className="text-xs text-mute mt-0.5 truncate">{entry.label}</p>}
                    <p className="text-[11px] text-mute mt-0.5">Added {formatDate(entry.createdAt)}</p>
                  </div>
                  <Button size="sm" variant="secondary" icon={<Icon name="trash" size={14} />} onClick={() => setConfirming(entry)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add entry */}
          <div className="space-y-2.5 border-t border-line pt-3">
            <p className="text-sm font-medium">Add a block</p>
            <Select
              label="Scope"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as BlocklistScope);
                setValue('');
              }}
              options={SCOPE_OPTIONS}
            />
            {scope === 'CATEGORY' ? (
              <Select
                label="Category"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                options={CHANNEL_CATEGORIES.map((x) => ({ value: x, label: categoryLabel(x) }))}
                placeholder="Select a category…"
                hint="Only advertised categories can be blocked."
              />
            ) : (
              <Input
                label={valueLabelFor(scope)}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={scope === 'DOMAIN' ? 'example.com' : undefined}
                hint={
                  scope === 'DOMAIN'
                    ? 'Scheme and “www.” are stripped automatically.'
                    : 'Blocked source id as shown in ad requests.'
                }
              />
            )}
            <Input
              label="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. repeat offender"
              maxLength={120}
            />
            <Button size="sm" full icon={<Icon name="plus" size={15} />} loading={add.isPending} onClick={submit}>
              Add to blocklist
            </Button>
          </div>
        </>
      )}

      {/* Remove confirmation */}
      <Modal open={confirming !== null} onClose={() => setConfirming(null)} title="Remove block entry">
        <p className="text-sm text-mute">
          Unblock <b>{confirming?.value}</b> ({confirming ? humanize(confirming.scope) : '—'}) for this channel? New ads
          from this source can reach the channel again.
        </p>
        <div className="flex gap-2 mt-4">
          <Button variant="secondary" full onClick={() => setConfirming(null)}>
            Keep
          </Button>
          <Button
            variant="danger"
            full
            loading={remove.isPending}
            onClick={() => {
              if (confirming) remove.mutate(confirming.id);
            }}
          >
            Unblock
          </Button>
        </div>
      </Modal>
    </Card>
  );
}
