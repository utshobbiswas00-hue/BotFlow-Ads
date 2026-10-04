import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppConfig } from '../hooks/useTelegramUser';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { showToast } from '../store/uiStore';
import { qk } from '../lib/queryClient';
import type { ChannelOnboarding, PublisherOnboardingStage } from '../lib/contracts';

/* ---------------------------------------------------------------
 *  ChannelOnboardingCard
 *
 *  Renders the publisher's 4-stage state on the channel page:
 *
 *    NO_ACCESS         → bot lacks permissions; tell them how to fix it.
 *    ON_HOLD           → every permission recorded; show "Send to moderation".
 *    PENDING_REVIEW    → publisher submitted; show "On hold" copy.
 *    NEEDS_GROWTH      → approved but below the subscriber floor.
 *    ACTIVE            → approved + above floor (the card hides).
 *
 *  The page-level <StatusBadge /> still reads the raw enum so the badge stays
 *  a single source of truth; this card is the publisher-facing explainer.
 * ------------------------------------------------------------- */

const REQUIRED_PERMISSIONS: ReadonlyArray<{
  key: 'botIsAdmin' | 'canPostMessages' | 'canEditMessages' | 'canDeleteMessages';
  label: string;
}> = [
  { key: 'botIsAdmin', label: 'BotFlow Bot is an administrator' },
  { key: 'canPostMessages', label: 'Post messages permission' },
  { key: 'canEditMessages', label: 'Edit messages permission' },
  { key: 'canDeleteMessages', label: 'Delete messages permission' },
];

export interface ChannelOnboardingCardProps {
  channelId: string;
  /** When the raw channel snapshot is already in hand, we read it directly to
   *  avoid a second fetch — the publisher page already loaded the channel.
   *  The full payload is passed (not a Pick) so the `username` /
   *  `telegramChannelId` deep-link target is available without a refetch. */
  snapshot?: ChannelOnboarding | null;
}

export function ChannelOnboardingCard({
  channelId,
  snapshot,
}: ChannelOnboardingCardProps): JSX.Element | null {
  const qc = useQueryClient();
  const appConfigQuery = useAppConfig();
  // useAppConfig returns a UseQueryResult whose data is `{ botUsername: string } | undefined`.
  // Until it resolves we have nothing useful to put on the deep-link — the button still
  // works because `window.open` would just go to a 404 in that brief moment, but we
  // prefer to disable the button until the config is in.
  const botUsername = appConfigQuery.data?.botUsername ?? null;
  const [submitting, setSubmitting] = useState(false);

  const onboarding = useQuery({
    queryKey: qk.channelOnboarding(channelId),
    queryFn: (): Promise<ChannelOnboarding> =>
      api.get<ChannelOnboarding>(`/api/channels/${channelId}/onboarding`),
    // Trust the parent snapshot if it was passed in — saves a request, and any
    // mismatch is repaired on the next refetch.
    initialData: snapshot ?? undefined,
    staleTime: 30_000,
    // Re-poll while the publisher is mid-flow: myChatMember moves the status
    // from PENDING → READY_FOR_REVIEW when the bot is granted permissions in
    // Telegram, but the webhook can lag by a few seconds. A 5s poll keeps the
    // "Open access" button disappearing promptly without hammering the API.
    refetchInterval: (q) => {
      const stage = q.state.data?.publisherStage;
      return stage === 'NO_ACCESS' || stage === 'ON_HOLD' || stage === 'PENDING_REVIEW' ? 5_000 : false;
    },
  });

  // When the publisher comes back from Telegram (where they granted bot
  // permissions), refetch immediately so the card flips from NO_ACCESS to
  // ON_HOLD without waiting for the next 5s tick.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void onboarding.refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [onboarding]);

  const submit = useMutation({
    mutationFn: (): Promise<unknown> =>
      api.post(`/api/channels/${channelId}/submit-for-review`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channel(channelId) });
      void qc.invalidateQueries({ queryKey: qk.channelOnboarding(channelId) });
    },
  });

  const data = onboarding.data;
  if (!data) return null;

  // ACTIVE — nothing to say, the page is the rest of the page.
  if (data.publisherStage === 'ACTIVE') return null;

  if (data.publisherStage === 'SUSPENDED') {
    return (
      <Card
        tone="error"
        title="Channel suspended"
        body="A moderator suspended the channel. Open a ticket from the Support page to ask for reinstatement."
      />
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-4 space-y-3">
      {data.publisherStage === 'NO_ACCESS' && (
        <NoAccessStage
          snapshot={data}
          botUsername={botUsername}
          onRecheck={() => {
              void onboarding.refetch();
            }}
        />
      )}

      {data.publisherStage === 'ON_HOLD' && (
        <OnHoldStage
          submitting={submitting || submit.isPending}
          onSubmit={() => {
              setSubmitting(true);
              submit.mutate(undefined, { onSettled: () => setSubmitting(false) });
            }}
          error={submit.error ? extractMessage(submit.error) : null}
        />
      )}

      {data.publisherStage === 'PENDING_REVIEW' && (
        <Card
          tone="info"
          title="On hold — under review"
          body="You sent the channel for moderation. A moderator will approve it shortly; you'll get a notification when it goes live."
        />
      )}

      {data.publisherStage === 'NEEDS_GROWTH' && (
        <NeedsGrowthStage
          subscribers={data.subscribers}
          minSubscribers={data.minSubscribers}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- helpers --- */

function NoAccessStage({
  snapshot,
  botUsername,
  onRecheck,
}: {
  snapshot: ChannelOnboarding;
  botUsername: string | null;
  onRecheck: () => void;
}): JSX.Element {
  // Telegram's deep-link syntax (core.telegram.org/api/links, "Group/channel
  // bot links") for adding a bot as admin: `?startchannel&admin=<rights>`.
  // Rights are joined with a literal `+`, NOT a comma — that is its own
  // mini-syntax, not URL encoding, and the `+` must survive unescaped.
  const openTelegram = (): void => {
    if (!botUsername) {
      showToast('error', 'Could not open Telegram right now — try again in a moment');
      return;
    }
    const rights = ['post_messages', 'edit_messages', 'delete_messages', 'invite_users', 'restrict_members'].join('+');
    window.open(`https://t.me/${botUsername}?startchannel&admin=${rights}`, '_blank', 'noopener');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-warn text-lg leading-none">⚠️</span>
        <div>
          <p className="font-bold">Open access to the bot</p>
          <p className="text-sm text-mute mt-0.5">
            Telegram needs every permission below, then come back and tap{' '}
            <strong>Re-check</strong>.
          </p>
        </div>
      </div>

      <ul className="space-y-1.5 text-sm">
        {REQUIRED_PERMISSIONS.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={
                permGranted(snapshot, p.key)
                  ? 'inline-block h-2.5 w-2.5 rounded-full bg-ok'
                  : 'inline-block h-2.5 w-2.5 rounded-full bg-line'
              }
            />
            <span className={permGranted(snapshot, p.key) ? 'text-ok' : 'text-text'}>
              {p.label}
            </span>
          </li>
        ))}
      </ul>

      {/* "Open access" deep-link — opens Telegram's own admin-rights screen
          for this channel with the four required rights pre-toggled ON. The
          publisher taps it once, accepts the rights in Telegram, then comes
          back and taps "Re-check permissions" below. The two-step flow
          matters: the deep-link is what removes the friction, but the
          re-check is what clears the banner — Telegram's permission report
          only fires when the publisher actually saves. */}
      <button
        type="button"
        onClick={openTelegram}
        className="w-full rounded-xl border border-accent bg-accent/10 px-4 py-2 text-sm font-semibold text-accent active:scale-[0.98]"
      >
        Open access in Telegram
      </button>

      <button
        type="button"
        onClick={onRecheck}
        className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white active:scale-[0.98]"
      >
        Re-check permissions
      </button>
    </div>
  );
}

function OnHoldStage({
  submitting,
  onSubmit,
  error,
}: {
  submitting: boolean;
  onSubmit: () => void;
  error: string | null;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-ok text-lg leading-none">✓</span>
        <div>
          <p className="font-bold">You're on hold</p>
          <p className="text-sm text-mute mt-0.5">
            BotFlow Bot has every permission it needs in your channel. Send it
            to a moderator to finish setup.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="w-full rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white active:scale-[0.98] disabled:opacity-60"
      >
        {submitting ? 'Sending…' : 'Send to moderation'}
      </button>

      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function NeedsGrowthStage({
  subscribers,
  minSubscribers,
}: {
  subscribers: number;
  minSubscribers: number;
}): JSX.Element {
  const remaining = Math.max(0, minSubscribers - subscribers);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="text-accent text-lg leading-none">📈</span>
        <div>
          <p className="font-bold">Almost there</p>
          <p className="text-sm text-mute mt-0.5">
            Your channel is approved. Advertisers can request ads as soon as you
            cross the {minSubscribers.toLocaleString()} subscriber mark — you have{' '}
            <strong>{subscribers.toLocaleString()}</strong>, so{' '}
            <strong>{remaining.toLocaleString()}</strong> more to unlock the
            marketplace.
          </p>
        </div>
      </div>
    </div>
  );
}

function Card({
  tone,
  title,
  body,
}: {
  tone: 'info' | 'error';
  title: string;
  body: string;
}): JSX.Element {
  const ring =
    tone === 'error'
      ? 'border-error/40 bg-error/10 text-error'
      : 'border-accent/30 bg-accent/10 text-text';
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-sm ${ring}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5 text-text/80">{body}</p>
    </div>
  );
}

/**
 * The muting permissions are not on the onboarding payload (it carries only the
 * aggregated `botHasAccess` flag) — but the raw channel snapshot in the parent
 * component does have them. We accept the full channel via the `snapshot`
 * field when present, falling back to `botHasAccess` for the four indicators.
 */
function permGranted(
  snapshot: ChannelOnboarding,
  key: 'botIsAdmin' | 'canPostMessages' | 'canEditMessages' | 'canDeleteMessages',
): boolean {
  // Without botHasAccess we know at least one required right is missing — the
  // onboarding payload aggregates the four checks into one boolean, so we
  // cannot show fine-grained state. Render all four indicators greyed and
  // rely on "Re-check" to flip them green after the publisher fixes Telegram.
  return snapshot.botHasAccess;
}

function extractMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Could not submit the channel. Try again.';
}