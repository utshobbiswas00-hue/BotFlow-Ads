/**
 * House ads — the creatives used to fill unsold inventory.
 *
 * `GET/POST /api/admin/ops/house-ads` and `POST .../:id/active`, all
 * `settings.manage`. `upsertHouseAd` is keyed on `code`: with a code it looks the
 * row up and updates it, without one it always creates.
 *
 * One trap worth guarding: `links` defaults to `[]` in the service when the field
 * is absent, and the zod body accepts it as an optional array. So an edit that
 * omits `links` would silently WIPE an ad's links. This editor therefore always
 * sends the parsed links back, prefilled from the row being edited, and refuses
 * to submit a malformed one.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Textarea } from '../../components/ui/Textarea';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { getHouseAds, setHouseAdActive, upsertHouseAd, type HouseAdInput } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { QueryState } from '../components/StateBlock';
import type { HouseAdRow } from '../lib/types';

export function AdminHouseAdsPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminHouseAds, queryFn: getHouseAds });
  const [editing, setEditing] = useState<HouseAdRow | 'new' | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminHouseAds });
    void queryClient.invalidateQueries({ queryKey: qk.adminOpsSummary });
  };

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      setHouseAdActive(id, isActive),
    onSuccess: (_r, vars) => {
      showToast('success', vars.isActive ? 'House ad activated' : 'House ad paused');
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const ads = query.data?.ads ?? [];
  const activeCount = ads.filter((a) => a.isActive).length;

  const columns: Column<HouseAdRow>[] = [
    {
      key: 'title',
      header: 'House ad',
      render: (a) => (
        <TwoLine
          primary={a.title}
          secondary={<Mono>{a.code ? `code ${a.code}` : `id ${a.id.slice(0, 10)}…`}</Mono>}
        />
      ),
    },
    {
      key: 'body',
      header: 'Body',
      hideBelow: 'md',
      render: (a) => (
        <span className="text-xs text-mute line-clamp-2 max-w-md block">{a.body}</span>
      ),
    },
    {
      key: 'content',
      header: 'Assets',
      hideBelow: 'lg',
      render: (a) => {
        const links = Array.isArray(a.links) ? a.links.length : 0;
        return (
          <span className="text-[11px] text-mute">
            {a.imageUrl ? 'image ' : ''}
            {a.buttonText ? 'button ' : ''}
            {links > 0 ? `${links} link(s)` : ''}
            {!a.imageUrl && !a.buttonText && links === 0 ? 'text only' : ''}
          </span>
        );
      },
    },
    {
      key: 'weight',
      header: 'Weight',
      align: 'right',
      nowrap: true,
      render: (a) => <Mono>{a.weight}</Mono>,
    },
    {
      key: 'order',
      header: 'Sort',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (a) => <Mono>{a.sortOrder}</Mono>,
    },
    {
      key: 'state',
      header: 'State',
      render: (a) => <StatusBadge status={a.isActive ? 'ACTIVE' : 'INACTIVE'} />,
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (a) => <span className="text-xs text-mute">{formatDateTime(a.createdAt)}</span>,
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
              Edit
            </button>
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ id: a.id, isActive: !a.isActive })}
              className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium disabled:opacity-40"
            >
              {a.isActive ? 'Pause' : 'Activate'}
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="House ads"
        description="Creatives used to fill inventory that no paid campaign claimed. House posts are always written in English; a paid post uses the advertiser's own language."
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
              <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>
                New house ad
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
        skeletonRows={3}
      >
        <KpiGrid className="lg:grid-cols-3 mb-6">
          <KpiTile label="Active creatives" value={activeCount} icon="megaphone" />
          <KpiTile label="Total creatives" value={ads.length} icon="doc" />
          <KpiTile
            label="Paused"
            value={ads.length - activeCount}
            icon="x"
            tone={ads.length - activeCount > 0 ? 'warn' : 'neutral'}
          />
        </KpiGrid>

        <DataTable
          rows={ads}
          columns={columns}
          rowKey={(a) => a.id}
          emptyTitle="No house ads"
          emptyMessage="Unsold inventory has nothing to fill it with yet."
        />

        {query.data ? (
          <TableFooter>
            <span className="text-xs text-mute">
              Language rule: {query.data.languageRule}
            </span>
          </TableFooter>
        ) : null}
      </QueryState>

      {editing ? (
        <HouseAdEditor
          ad={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}

      <Section
        className="mt-8"
        title="How house fill works"
        description="House ads only run in inventory that paid campaigns did not claim, and the weight controls how often a given creative is chosen against the others."
      >
        <div className="bg-surface border border-line rounded-2xl p-4 text-xs text-mute space-y-1.5">
          <p>• Weight is clamped to 1–10 by the service, whatever is sent.</p>
          <p>• A paused ad is skipped entirely; it is not down-weighted.</p>
          <p>• Sort order breaks ties between creatives of equal weight.</p>
        </div>
      </Section>
    </>
  );
}

function HouseAdEditor({
  ad,
  onClose,
  onSaved,
}: {
  ad: HouseAdRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(ad?.code ?? '');
  const [title, setTitle] = useState(ad?.title ?? '');
  const [body, setBody] = useState(ad?.body ?? '');
  const [imageUrl, setImageUrl] = useState(ad?.imageUrl ?? '');
  const [buttonText, setButtonText] = useState(ad?.buttonText ?? '');
  const [buttonUrl, setButtonUrl] = useState(ad?.buttonUrl ?? '');
  const [weight, setWeight] = useState(String(ad?.weight ?? 1));
  const [sortOrder, setSortOrder] = useState(String(ad?.sortOrder ?? 0));
  const [note, setNote] = useState(ad?.note ?? '');
  const [isActive, setIsActive] = useState(ad?.isActive ?? true);
  const [linksText, setLinksText] = useState(() => linksToText(ad?.links));

  const save = useMutation({
    mutationFn: (input: HouseAdInput) => upsertHouseAd(input),
    onSuccess: () => {
      showToast('success', 'House ad saved');
      onSaved();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    if (title.trim().length < 3) {
      showToast('error', 'Title must be at least 3 characters');
      return;
    }
    if (body.trim().length < 3) {
      showToast('error', 'Body must be at least 3 characters');
      return;
    }
    const parsed = parseLinks(linksText);
    if ('error' in parsed) {
      showToast('error', parsed.error);
      return;
    }
    const w = Number(weight);
    if (!Number.isInteger(w) || w < 1 || w > 10) {
      showToast('error', 'Weight must be a whole number from 1 to 10');
      return;
    }

    save.mutate({
      // Sending the code is what makes this an update rather than a create.
      code: code.trim() || undefined,
      title: title.trim(),
      body: body.trim(),
      imageUrl: imageUrl.trim() || null,
      buttonText: buttonText.trim() || null,
      buttonUrl: buttonUrl.trim() || null,
      links: parsed.links,
      weight: w,
      sortOrder: Number(sortOrder) || 0,
      note: note.trim() || null,
      isActive,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-app overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 lg:p-6">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-bold">{ad ? `Edit “${ad.title}”` : 'New house ad'}</h1>
          <Button variant="ghost" size="sm" icon={<Icon name="x" size={15} />} onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="bg-surface border border-line rounded-2xl p-4 space-y-3">
          <Input
            label="Code (upsert key)"
            className="num"
            placeholder="Leave empty to always create a new ad"
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            hint="A code that already exists updates that row — this is how an edit is saved."
          />
          <Input
            label="Title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            label="Body"
            value={body}
            rows={5}
            maxLength={2000}
            showCount
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Image URL"
              placeholder="https://…"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
            <Input
              label="Button text"
              maxLength={64}
              value={buttonText}
              onChange={(e) => setButtonText(e.target.value)}
            />
            <Input
              label="Button URL"
              placeholder="https://…"
              value={buttonUrl}
              onChange={(e) => setButtonUrl(e.target.value)}
            />
            <Input
              label="Weight (1–10)"
              inputMode="numeric"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              hint="Clamped to 1–10 server-side."
            />
            <Input
              label="Sort order"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
            <Input label="Note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <Textarea
            label="Links (one per line, “Label | https://url”)"
            rows={3}
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
            hint="Sent on every save — leaving a link out removes it. An empty box means no links."
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4"
            />
            Active (eligible to fill unsold inventory)
          </label>
        </div>

        <div className="flex gap-2 mt-6">
          <Button variant="secondary" full onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button full loading={save.isPending} onClick={submit}>
            {ad ? 'Save house ad' : 'Create house ad'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** `unknown` from a JSON column → "Label | url" lines. */
function linksToText(links: unknown): string {
  if (!Array.isArray(links)) return '';
  return links
    .map((l) => {
      if (l && typeof l === 'object' && 'label' in l && 'url' in l) {
        return `${String((l as { label: unknown }).label)} | ${String((l as { url: unknown }).url)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Validate against the zod body: label ≤ 60 chars, url must parse as a URL. */
function parseLinks(
  text: string,
): { links: { label: string; url: string }[] } | { error: string } {
  const out: { label: string; url: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [labelPart, ...urlParts] = line.split('|');
    const label = (labelPart ?? '').trim();
    const url = urlParts.join('|').trim();
    if (!label || !url) return { error: `Each link needs “Label | https://url” — got “${line}”` };
    if (label.length > 60) return { error: `Link label “${label}” is longer than 60 characters` };
    try {
      new URL(url);
    } catch {
      return { error: `“${url}” is not a valid URL` };
    }
    out.push({ label, url });
  }
  return { links: out };
}
