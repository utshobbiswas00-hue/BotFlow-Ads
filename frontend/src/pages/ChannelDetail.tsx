import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import {
  CHANNEL_CATEGORIES,
  MAX_WEEKLY_POSTS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  weeklySlotCount,
  type PostingSchedule,
} from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { ChannelDetail as ChannelDetailT } from '../lib/contracts';
import { categoryLabel, compactNumber, formatDate, formatMoney, pricingLabel } from '../lib/format';
import { useChannel, useInvalidateChannels } from '../hooks/useChannels';
import { useAppConfig } from '../hooks/useTelegramUser';
import { openTelegramLink } from '../lib/telegram';
import { PageHeader } from '../components/layout/PageHeader';
import { LineChart } from '../components/charts/LineChart';
import { StatCard } from '../components/charts/StatCard';
import { BlocklistPanel } from '../components/domain/BlocklistPanel';
import { PostingScheduleEditor } from '../components/channels/PostingScheduleEditor';
import { Button } from '../components/ui/Button';
import { Card, CardTitle } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ChannelOnboardingCard } from '../components/ChannelOnboardingCard';
import { PageSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/icons';
import { showToast } from '../store/uiStore';

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const invalidate = useInvalidateChannels();
  const q = useChannel(id);
  const appConfig = useAppConfig();

  // Keep the page in sync while Telegram is being updated. The backend
  // automatically re-checks PENDING channels and promotes them once the bot
  // has Post Messages permission.
  useEffect(() => {
    if (!id || q.data?.status !== 'PENDING') return;
    const timer = window.setInterval(() => {
      void q.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id, q.data?.status, q.refetch]);

  // Re-check the bot's live Telegram permissions: once when this page first
  // has data for a channel that looks like it is missing access (not just
  // while PENDING — also an APPROVED channel whose last-saved permission
  // snapshot is stale, e.g. the bot was removed as admin afterwards, or the
  // snapshot was simply never correct), and again whenever the tab regains
  // visibility (the app's global refetchOnWindowFocus is off, so coming back
  // from Telegram's native "add admin" flow would otherwise never re-check).
  // A plain refetch only re-reads what the database already has; this asks
  // Telegram directly, so the status badge and the "Missing permissions"
  // banner can never disagree with each other for long.
  //
  // `verifiedForId` guards against two different bugs at once: firing before
  // `q.data` has loaded on first mount (a `[id]`-only dependency array would
  // run while `q.data` is still undefined, bail out, and then never run
  // again since `id` itself never changes), and firing on every single
  // render once data exists (a `[id, q.data]` array with no guard would
  // re-verify after every refetch, including the one this effect itself
  // triggers). The ref also backs the visibility listener so it always reads
  // the latest fetch result instead of whatever was current when the
  // listener was first attached.
  const verifiedForId = useRef<string | null>(null);
  const latestChannel = useRef(q.data);
  latestChannel.current = q.data;

  useEffect(() => {
    if (!id || !q.data) return;
    if (verifiedForId.current === id) return;
    if (q.data.botIsAdmin && q.data.canPostMessages) return;
    verifiedForId.current = id;
    api
      .post(`/api/channels/${id}/verify`)
      .then(() => q.refetch())
      .catch(() => undefined); // best-effort — the manual "Open access" flow still works either way
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, q.data]);

  useEffect(() => {
    if (!id) return;
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      const c = latestChannel.current;
      if (c?.botIsAdmin && c?.canPostMessages) return;
      api
        .post(`/api/channels/${id}/verify`)
        .then(() => q.refetch())
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('NEWS');
  const [autoApprove, setAutoApprove] = useState(false);
  const [acceptAds, setAcceptAds] = useState(true);
  const [minPrice, setMinPrice] = useState('');
  const [minPriceTouched, setMinPriceTouched] = useState(false);
  const [schedule, setSchedule] = useState<PostingSchedule>({});

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>): Promise<unknown> => api.patch(`/api/channels/${id}`, body),
    onSuccess: () => {
      showToast('success', 'Channel updated');
      setEditOpen(false);
      invalidate();
      void q.refetch();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const remove = useMutation({
    mutationFn: (): Promise<unknown> => api.delete(`/api/channels/${id}`),
    onSuccess: () => {
      showToast('success', 'Channel removed');
      invalidate();
      navigate('/channels', { replace: true });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError || !q.data)
    return (
      <>
        <PageHeader title="Channel" back />
        <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
      </>
    );

  const c = q.data;
  const history = c.stats.map((p) => ({ label: p.date.slice(5), value: p.avgViews }));
  const subHistory = c.stats.map((p) => ({ label: p.date.slice(5), value: p.subscribers }));

  const openEdit = (): void => {
    setPrice((c.adPriceCents / 100).toFixed(2));
    setCategory(c.category || 'NEWS');
    setAutoApprove(c.autoApprovePosts ?? false);
    setAcceptAds(c.acceptAds ?? true);
    setMinPrice((c.minAdPriceCents / 100).toFixed(2));
    setMinPriceTouched(false);
    // Seed the editor from the channel's schedule; null/absent = empty.
    setSchedule(
      c.postingSchedule
        ? Object.fromEntries(Object.entries(c.postingSchedule).map(([day, times]) => [day, [...times]]))
        : {},
    );
    setEditOpen(true);
  };

  const saveEdit = (): void => {
    const cents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      showToast('error', 'Enter a valid ad price');
      return;
    }
    // Minimum ad price: whole dollars, >= 0 (0 / empty = no floor). A field the
    // user did not edit round-trips the existing server value verbatim.
    let minCents: number;
    if (minPriceTouched) {
      const minRaw = minPrice.trim();
      const minNum = minRaw === '' ? 0 : parseFloat(minRaw);
      if (!Number.isFinite(minNum) || !Number.isInteger(minNum) || minNum < 0) {
        showToast('error', 'Minimum ad price must be a whole number of dollars (0 or more)');
        return;
      }
      minCents = Math.round(minNum * 100);
    } else {
      minCents = c.minAdPriceCents;
    }
    const weeklyTotal = weeklySlotCount(schedule);
    if (weeklyTotal > MAX_WEEKLY_POSTS) {
      showToast(
        'error',
        `A channel can accept at most ${MAX_WEEKLY_POSTS} posts a week (you picked ${weeklyTotal}). Remove ${
          weeklyTotal - MAX_WEEKLY_POSTS
        } to continue.`,
      );
      return;
    }
    update.mutate({
      channelId: id,
      adPriceCents: cents,
      category,
      autoApprovePosts: autoApprove,
      acceptAds,
      minAdPriceCents: minCents,
      postingSchedule: schedule,
    });
  };

  return (
    <>
      <PageHeader
        title={c.title || (c.username ? `@${c.username.replace(/^@/, '')}` : 'Channel')}
        subtitle={categoryLabel(c.category)}
        back
        actions={<StatusBadge status={c.status} />}
      />

      <div className="space-y-4 mt-2">
        {/* Publisher onboarding — the 4-stage card that walks the user through
            the steps of getting the channel live (NO_ACCESS / ON_HOLD /
            PENDING_REVIEW / NEEDS_GROWTH). Hidden once the channel is ACTIVE. */}
        {id && (
          <ChannelOnboardingCard
            channelId={id}
            snapshot={{
              botHasAccess: Boolean(c.botIsAdmin && c.canPostMessages && c.canEditMessages),
              meetsMarketplaceFloor: false,
              publisherStage: 'ON_HOLD', // re-fetched by the card from /onboarding
              status: c.status,
              subscribers: c.subscriberCount ?? 0,
              minSubscribers: 500,
              username: c.username,
              telegramChannelId: c.telegramChannelId,
            }}
          />
        )}

                {/* Ads-paused banner — visible at a glance when the publisher turned delivery off */}
        {c.acceptAds === false && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-sm font-semibold text-warn"
          >
            <Icon name="info" size={16} className="shrink-0" />
            Ads paused — this channel is not accepting sponsored ads.
          </div>
        )}

        {/* The old "Access to the channel" banner with its "Open access"
            Telegram deep-link was removed in favour of the new
            ChannelOnboardingCard, which now owns the publisher-facing state
            machine. NO_ACCESS shows the per-permission checklist + the
            "Re-check permissions" button; ON_HOLD shows the "Send to
            moderation" button. The Telegram deep-link that opens the
            admin-rights flow is rendered inside the card when the bot is
            missing permissions (see ChannelOnboardingCard.tsx). */}

        {/* Header card */}
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-14 h-14 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-lg overflow-hidden shrink-0">
              {c.photoUrl ? (
                <img src={c.photoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                (c.title || c.username || 'C').charAt(0).toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-bold truncate">{c.title}</p>
              {c.username && <p className="text-sm text-link truncate">@{c.username.replace(/^@/, '')}</p>}
              {c.username && (
                <a
                  href={`https://t.me/${c.username.replace(/^@/, '')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-mute mt-0.5"
                >
                  <Icon name="external" size={12} /> Open in Telegram
                </a>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="font-bold">{compactNumber(c.subscriberCount)}</p>
              <p className="text-xs text-mute">Subscribers</p>
            </div>
            <div>
              <p className="font-bold">{compactNumber(c.avgViews)}</p>
              <p className="text-xs text-mute">Avg views</p>
            </div>
            <div>
              <p className="font-bold">{c.totalAdsPublished}</p>
              <p className="text-xs text-mute">Ads posted</p>
            </div>
          </div>
        </Card>

        {/* Earnings */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="Total earned" value={formatMoney(c.totalEarnedCents)} icon={<Icon name="coin" size={16} />} />
          <StatCard label="Your price" value={pricingLabel(c.pricingModel, c.adPriceCents)} icon={<Icon name="dollar" size={16} />} />
        </div>

        {/* Posting schedule */}
        <Card>
          <CardTitle>Posting schedule</CardTitle>
          {weeklySlotCount(c.postingSchedule) === 0 ? (
            <p className="text-sm text-mute">
              No posting schedule set — this channel accepts sponsored posts within the daily limits only.
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {WEEKDAYS.map((day) => {
                  const times = [...((c.postingSchedule ?? {})[String(day)] ?? [])].sort();
                  if (times.length === 0) return null;
                  return (
                    <li key={day} className="flex items-start justify-between gap-3 text-sm">
                      <span className="text-mute">{WEEKDAY_LABELS[day]}</span>
                      <span className="text-right tabular-nums">{times.join(', ')}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-mute mt-3">
                {weeklySlotCount(c.postingSchedule)} of {MAX_WEEKLY_POSTS} posts a week
              </p>
            </>
          )}
        </Card>

        {/* Stats history */}
        <Card>
          <CardTitle>Avg views — last {Math.max(c.stats.length, 1)} days</CardTitle>
          <LineChart data={history} kind="number" />
          <p className="text-[11px] text-mute mt-2 text-right">
            Subscribers: {compactNumber(c.stats.at(-1)?.subscribers ?? c.subscriberCount)} · history{' '}
            {subHistory.length > 0 ? `(${compactNumber(subHistory[0].value)} → ${compactNumber(subHistory.at(-1)!.value)})` : ''}
          </p>
        </Card>

        {/* Recent posts */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-mute uppercase tracking-wide">Recent ad posts</h3>
            <Link to={`/channels/${c.id}/requests`} className="text-sm text-link font-medium">
              Inbox
            </Link>
          </div>
          {c.adPosts.length === 0 ? (
            <Card>
              <p className="text-sm text-mute text-center py-3">No sponsored posts yet.</p>
            </Card>
          ) : (
            <Card padded={false} className="divide-y divide-line">
              {c.adPosts.map((p) => (
                <div key={p.id} className="flex items-center gap-3 p-3.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      Sponsored post · <span className="text-mute">{p.publishedAt ? formatDate(p.publishedAt) : 'Not yet published'}</span>
                    </p>
                    <p className="text-xs text-mute mt-0.5">
                      {compactNumber(p.views)} views · {compactNumber(p.clicks)} clicks
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-ok">+{formatMoney(p.publisherEarningCents)}</p>
                    <StatusBadge status={p.status} className="mt-0.5" />
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* Publisher blocklist */}
        <BlocklistPanel channelId={c.id} />

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pb-4">
          <Button size="sm" variant="secondary" icon={<Icon name="edit" size={15} />} onClick={openEdit}>
            Edit
          </Button>
          <Button size="sm" variant="secondary" icon={<Icon name="doc" size={15} />} onClick={() => navigate(`/channels/${c.id}/requests`)}>
            Requests
          </Button>
          <Button size="sm" variant="danger" icon={<Icon name="trash" size={15} />} onClick={() => setDeleteOpen(true)}>
            Remove
          </Button>
        </div>
      </div>

      {/* Edit modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Edit channel">
        <div className="space-y-3">
          <Input
            label="Ad price"
            type="number"
            inputMode="decimal"
            prefix="$"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint={pricingLabel(c.pricingModel, Math.round(parseFloat(price || '0') * 100))}
          />
          <Input
            label="Minimum ad price"
            type="number"
            inputMode="decimal"
            prefix="$"
            value={minPrice}
            onChange={(e) => {
              setMinPrice(e.target.value);
              setMinPriceTouched(true);
            }}
            placeholder="0"
            hint="0 = no floor. Advertisers pricing below this can't target this channel."
          />
          <Select
            label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={CHANNEL_CATEGORIES.map((x) => ({ value: x, label: categoryLabel(x) }))}
          />
          <label className="flex items-center justify-between bg-app rounded-xl px-3.5 py-3 cursor-pointer">
            <span className="text-sm font-medium">Auto-approve all requests</span>
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              className="w-5 h-5 accent-[var(--tg-theme-button-color,#2481cc)]"
            />
          </label>
          <label className="flex items-start justify-between gap-3 bg-app rounded-xl px-3.5 py-3 cursor-pointer">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Accept sponsored ads</span>
              <span className="block text-xs text-mute mt-0.5">
                Turning this off pauses new sponsored delivery while keeping the channel listed.
              </span>
            </span>
            <input
              type="checkbox"
              checked={acceptAds}
              onChange={(e) => setAcceptAds(e.target.checked)}
              className="w-5 h-5 mt-0.5 shrink-0 accent-[var(--tg-theme-button-color,#2481cc)]"
            />
          </label>
          <PostingScheduleEditor value={schedule} onChange={setSchedule} />
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" full onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button full loading={update.isPending} onClick={saveEdit}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete modal */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Remove channel">
        <p className="text-sm text-mute">
          Removing <b>{c.title}</b> stops all future ad delivery on this channel. Earnings already
          credited are kept. This cannot be undone.
        </p>
        <div className="flex gap-2 mt-4">
          <Button variant="secondary" full onClick={() => setDeleteOpen(false)}>
            Keep channel
          </Button>
          <Button variant="danger" full loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        </div>
      </Modal>
    </>
  );
}
