/**
 * Blocked channels — the publisher blocklist as an operator-facing list.
 *
 * Read `backend/src/routes/admin/blocked.routes.ts` before changing this file.
 *
 * The data model is NOT "one global channel blocklist". `PublisherBlocklist` is a
 * per-channel list, keyed by the triple (channelId, scope, value), where `scope`
 * is one of ADVERTISER | CAMPAIGN | CATEGORY | DOMAIN. There is no CHANNEL scope
 * and, importantly, NO `reason` column: the only free-text column is `label`.
 *
 * The route maps `label` → `reason` on the wire (and back), so every reason an
 * operator types in the dialog below lands in `PublisherBlocklist.label`, not in
 * a column named `reason`. That mapping is spelled out in the dialog help text so
 * nobody is surprised when they see it in the database.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { blockChannel, listBlockedChannels, unblockChannel } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { ConfirmDialog, type DialogField } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { BlockedChannelRow } from '../lib/types';

const LIMIT = 20;

const SCOPE_OPTIONS = [
  { value: 'ADVERTISER', label: 'Advertiser — match an advertiser id / name' },
  { value: 'CAMPAIGN', label: 'Campaign — match a campaign id / name' },
  { value: 'CATEGORY', label: 'Category — match a channel category' },
  { value: 'DOMAIN', label: 'Domain — match a destination domain' },
];

/**
 * The route returns the channel joined under `channel`; a few responses flatten
 * it to `channelTitle` / `channelUsername`. Read both so the cell is never blank.
 */
function channelIdentity(row: BlockedChannelRow): { title: string; username: string | null } {
  const flat = row as BlockedChannelRow & {
    channelTitle?: string;
    channelUsername?: string | null;
  };
  return {
    title: row.channel?.title ?? flat.channelTitle ?? 'Unknown channel',
    username: row.channel?.username ?? flat.channelUsername ?? null,
  };
}

export function BlockedChannelsPage() {
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [unblocking, setUnblocking] = useState<BlockedChannelRow | null>(null);

  // Debounce the box so a fast typist does not fire one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useQuery({
    queryKey: [...qk.adminBlockedChannels, { page, search }],
    queryFn: () =>
      listBlockedChannels({ page, limit: LIMIT, search: search || undefined }),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminBlockedChannels });
  };

  const block = useMutation({
    mutationFn: (body: {
      channelId: string;
      scope: BlockedChannelRow['scope'];
      value: string;
      reason: string;
    }) => blockChannel(body),
    onSuccess: (row) => {
      showToast('success', `Block added for ${row.value}`);
      setAdding(false);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const unblock = useMutation({
    mutationFn: (id: string) => unblockChannel(id),
    onSuccess: () => {
      showToast('success', 'Channel block lifted');
      setUnblocking(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const columns: Column<BlockedChannelRow>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (row) => {
        const { title, username } = channelIdentity(row);
        return (
          <TwoLine
            primary={title}
            secondary={username ? `@${username}` : row.channelId.slice(0, 12)}
          />
        );
      },
    },
    {
      key: 'scope',
      header: 'Scope',
      render: (row) => <StatusBadge status={row.scope} />,
    },
    {
      key: 'value',
      header: 'Value',
      render: (row) => <Mono title={row.value}>{row.value}</Mono>,
    },
    {
      key: 'reason',
      header: 'Reason',
      hideBelow: 'md',
      render: (row) =>
        row.reason ? (
          <span className="text-xs text-mute line-clamp-2 max-w-md block">{row.reason}</span>
        ) : (
          <span className="text-xs text-mute">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Added',
      align: 'right',
      hideBelow: 'sm',
      nowrap: true,
      render: (row) => <span className="text-xs text-mute">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          onClick={() => setUnblocking(row)}
          className="h-8 px-2.5 rounded-lg border border-danger/40 text-danger text-xs font-medium whitespace-nowrap"
        >
          Unblock
        </button>
      ),
    },
  ];

  /**
   * The reason field maps to `PublisherBlocklist.label`. `scope` and `value` are
   * both NOT NULL and are the row's natural key, so they cannot be omitted.
   */
  const addFields: DialogField[] = [
    {
      name: 'channelId',
      label: 'Channel id',
      required: true,
      mono: true,
      maxLength: 64,
      placeholder: 'The channels.id this entry belongs to',
      hint: 'The block is stored on this channel, not globally. Find the id on the Channels screen.',
    },
    {
      name: 'scope',
      label: 'Scope',
      type: 'select',
      required: true,
      initialValue: 'ADVERTISER',
      options: SCOPE_OPTIONS,
      hint: 'What the value below matches. There is no whole-channel scope; an entry always names one.',
    },
    {
      name: 'value',
      label: 'Value',
      required: true,
      maxLength: 200,
      placeholder: 'e.g. spam-advertiser, GAMING, evil.example',
      hint: 'Normalised before it is stored (domains lose scheme/www, categories upper-case).',
    },
    {
      name: 'reason',
      label: 'Reason',
      type: 'textarea',
      required: true,
      maxLength: 500,
      hint: '3–500 characters, required. Stored in the entry\'s "label" column and shown back here as "reason" — PublisherBlocklist has no reason column.',
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Blocked channels"
        description="Publisher blocklist entries: each row blocks one advertiser, campaign, category or domain for one channel. A row is unique on (channel, scope, value), so adding an existing combination just updates its reason."
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
            <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setAdding(true)}>
              Add a block
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Input
          label="Search"
          className="max-w-sm"
          icon="search"
          placeholder="Channel, value or reason"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          emptyTitle="No blocked entries"
          emptyMessage={
            search
              ? `Nothing matches “${search}”.`
              : 'No publisher blocklist entries yet. Published posts are matched on their own merits.'
          }
        />
        {query.data ? (
          <TableFooter>
            <Pager
              page={query.data.page}
              limit={query.data.limit}
              total={query.data.total}
              hasMore={query.data.hasMore}
              busy={query.isFetching}
              onPage={setPage}
            />
          </TableFooter>
        ) : null}
      </QueryState>

      <ConfirmDialog
        open={adding}
        title="Add a block entry"
        description="A block row is keyed on (channel, scope, value). Re-adding the same three updates the existing entry instead of creating a second one. The reason is kept in the entry's label field — PublisherBlocklist has no reason column — and is returned to this screen as the reason."
        fields={addFields}
        confirmLabel="Add block"
        danger
        pending={block.isPending}
        onCancel={() => setAdding(false)}
        onConfirm={(values) => {
          const reason = (values.reason ?? '').trim();
          if (reason.length < 3) {
            showToast('error', 'A reason of at least 3 characters is required');
            return;
          }
          block.mutate({
            channelId: (values.channelId ?? '').trim(),
            scope: (values.scope ?? 'ADVERTISER') as BlockedChannelRow['scope'],
            value: (values.value ?? '').trim(),
            reason,
          });
        }}
      />

      <ConfirmDialog
        open={unblocking !== null}
        title={
          unblocking
            ? `Unblock ${channelIdentity(unblocking).title}?`
            : 'Unblock this channel?'
        }
        description={
          unblocking
            ? `This lifts the ${unblocking.scope} block for “${unblocking.value}”. The channel stops being excluded for that value, so matching posts can be delivered again. Posts already delivered are not recalled.`
            : ''
        }
        confirmLabel="Unblock"
        danger
        pending={unblock.isPending}
        onCancel={() => setUnblocking(null)}
        onConfirm={() => {
          if (unblocking) unblock.mutate(unblocking.id);
        }}
      />
    </>
  );
}
