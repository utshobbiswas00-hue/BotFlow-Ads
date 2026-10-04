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
import { useChannel, useInvalidateChannels, useVerifyChannel } from '../hooks/useChannels';
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

  // Keep the page in sync while an admin decision is pending. This only re-reads the
  // stored record; it says nothing about the bot's rights (see the verify effect below).
  useEffect(() => {
    if (!id || q.data?.status !== 'PENDING') return;
    const timer = window.setInterval(() => {
      void q.refetch();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id, q.data?.status, q.refetch]);

  const verify = useVerifyChannel(id);
  // Held in a ref so the polling effect below does not depend on the mutation object: a
  // fresh identity each render would restart the effect, and restarting it asks Telegram
  // again — a runaway loop against the Bot API.
  const verifyNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    verifyNow.current = (): void => {
      verify.mutate();
    };
  });

  // Whether the banner above is showing — i.e. whether the stored snapshot still says the
  // bot cannot post here.
  const needsAccess = !!q.data && (!q.data.botIsAdmin || !q.data.canPostMessages);

  // The banner disappears only when the snapshot changes, and only `my_chat_member` (which
  // needs a registered webhook) or a verify call changes it. Refetching alone re-read the
  // same stale snapshot, so granting access left the banner sitting there. Ask Telegram
  // instead: once as the page opens, again whenever it returns to the foreground — that is
  // precisely the moment the owner comes back from the Telegram admin screen — then a
  // bounded number of retries. Bounded, because a channel whose owner never finishes the
  // steps would otherwise poll the Bot API for ever.
  useEffect(() => {
    if (!id || !needsAccess) return;

    const kick = (): void => {
      if (document.visibilityState === 'visible') verifyNow.current();
    };

    kick();
    const onReturn = (): void => kick();
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);

    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (ticks > 12) {
        window.clearInterval(timer);
        return;
      }
      kick();
    }, 10_000);

    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.clearInterval(timer);
    };
  }, [id, needsAccess]);

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

        {/* Bot-access banner. Telegram runs the permission UI; the panel shows the state
            it last stored, and the verify effect above keeps asking until it agrees. */}
        {(!c.botIsAdmin || !c.canPostMessages) && (
          <Card className="border-warn/40 bg-warn/10 space-y-3">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warn/20 text-warn">
                <Icon name="alert" size={18} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">Access to the channel</p>
                <p className="text-xs text-mute">Missing permissions</p>
              </div>
            </div>
            <ul className="space-y-1.5 text-sm">
              <li className="flex items-center gap-2">
                <Icon name={c.botIsAdmin ? 'check' : 'shield'} size={14} className={c.botIsAdmin ? 'text-ok' : 'text-mute'} />
                BotFlow Bot is an administrator
              </li>
              <li className="flex items-center gap-2">
                <Icon name={c.canPostMessages ? 'check' : 'shield'} size={14} className={c.canPostMessages ? 'text-ok' : 'text-mute'} />
                "Post messages" permission enabled
              </li>
            </ul>
            <p className="text-xs text-mute leading-relaxed">
              Open your channel → Administrators → add <b>BotFlow Bot</b> → turn on <b>Post messages</b>.
              Come back here and this banner clears on its own once Telegram reports the permission.
            </p>
            <Button
              full
              size="lg"
              icon={<Icon name="shield" size={18} />}
              onClick={() => {
                if (!appConfig.data?.botUsername) {
                  showToast('error', 'Could not open Telegram right now — try again in a moment');
                  return;
                }
                const rights = ['post_messages', 'edit_messages', 'invite_users'].join(',');
                openTelegramLink(`https://t.me/${appConfig.data.botUsername}?startchannel&admin=${rights}`);
              }}
            >
              Open access
            </Button>

            {/* The way out when Telegram's own notification never reaches us: ask the
                backend to read the rights again. Without this there is nothing the owner
                can do from here if the banner outlives the permission. */}
            <Button
              full
              variant="secondary"
              size="sm"
              loading={verify.isPending}
              icon={<Icon name="refresh" size={14} />}
              onClick={() => verify.mutate()}
            >
              Re-check access
            </Button>
            {verify.isSuccess && verify.data?.permissionLost && (
              <p className="text-xs text-mute">
                Telegram still reports no posting rights in this channel. Finish the steps above,
                then re-check.
              </p>
            )}
          </Card>
        )}

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
