/**
 * Broadcast (§52) — send one message to a group of real users.
 *
 * WHAT THIS IS
 * `POST /admin/broadcast` enqueues ONE job carrying the resolved recipient ids;
 * the existing notification worker fans it out per user via
 * `createBulkNotifications`, which persists an in-app notification and enqueues
 * a Telegram push. So this reaches real Telegram chats. It cannot be recalled
 * and there is no "unsend".
 *
 * WHY THE COUNT COMES FIRST
 * `GET /admin/broadcast/audience` exists for exactly one reason: a broadcast is
 * irreversible, so "ALL" has to be a decision with a number attached, not a
 * guess. The composer fetches the count for the selected audience and shows it
 * before anything is queued.
 *
 * WHY THE CONFIRM IS TWO STEPS
 * The first confirmation performs a `dryRun` — the server validates and
 * re-counts, and enqueues NOTHING — and shows the count it returned. Only a
 * second, explicit confirmation performs the real send. That way the number on
 * the final button is the server's own count at confirm time, not a stale one
 * from the page.
 *
 * WHY WE REFUSE RATHER THAN TRUNCATE
 * The server caps a broadcast at 100 recipients and REJECTS an over-limit send
 * with a 400 naming the actual count and the limit. It never silently sends to
 * the first 100: that would deliver a partial broadcast while telling the
 * operator it reached everyone, and there would be no record that the rest were
 * skipped. A refusal is recoverable — narrow the audience and try again — but a
 * partial blast cannot be taken back. This panel surfaces the server's message
 * verbatim and makes no attempt to trim the list itself.
 *
 * NOT THE "NEEDS ATTENTION" FEED
 * The "needs attention" feed is a read-only, computed view FOR ADMINS. This is
 * the opposite: an outbound message TO USERS. They are unrelated.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { groupNumber } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Textarea';
import { showToast } from '../../store/uiStore';
import { getBroadcastAudience, sendBroadcast } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { BroadcastAudience, BroadcastResult } from '../lib/types';

/**
 * Display-only hint that mirrors the server's published recipient maximum
 * (`BROADCAST_MAX_RECIPIENTS` in backend/src/routes/admin/broadcast.routes.ts).
 * It is used ONLY to warn the operator before they try; it never blocks, trims
 * or alters a send. The SERVER is the authority and refuses an over-limit send
 * with a message naming the real count and limit.
 */
const BROADCAST_MAX_RECIPIENTS = 100;

const AUDIENCE_OPTIONS: { value: BroadcastAudience; label: string }[] = [
  { value: 'ALL', label: 'All users' },
  { value: 'PUBLISHERS', label: 'Publishers (has at least one channel)' },
  { value: 'ADVERTISERS', label: 'Advertisers (has at least one campaign)' },
];

function audienceLabel(audience: BroadcastAudience): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? audience;
}

export function BroadcastPage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<BroadcastAudience>('ALL');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [finalOpen, setFinalOpen] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<BroadcastResult | null>(null);

  // The count for the CURRENTLY selected audience — the whole point of the
  // audience endpoint. Refetched whenever the selection changes.
  const audienceQuery = useQuery({
    queryKey: [...qk.adminBroadcastAudience, audience],
    queryFn: () => getBroadcastAudience(audience),
  });

  const dryRun = useMutation({
    mutationFn: () =>
      sendBroadcast({ title: title.trim(), body: body.trim(), audience, dryRun: true }),
    onSuccess: (res: BroadcastResult) => {
      // The server re-counted and queued nothing. Show ITS number on the final
      // step rather than the count this page rendered earlier.
      setDryRunResult(res);
      setReviewOpen(false);
      setFinalOpen(true);
    },
    onError: (e) => {
      // Over-limit, invalid input, permission — whatever the server said.
      showToast('error', errMsg(e));
      setReviewOpen(false);
    },
  });

  const send = useMutation({
    mutationFn: () =>
      sendBroadcast({ title: title.trim(), body: body.trim(), audience, dryRun: false }),
    onSuccess: (res: BroadcastResult) => {
      showToast(
        'success',
        `Broadcast queued to ${groupNumber(res.recipients)} recipient(s) (${audienceLabel(
          res.audience,
        )}).`,
      );
      setFinalOpen(false);
      setDryRunResult(null);
      setTitle('');
      setBody('');
      void queryClient.invalidateQueries({ queryKey: qk.adminBroadcastAudience });
    },
    onError: (e) => {
      showToast('error', errMsg(e));
      setFinalOpen(false);
    },
  });

  const recipients = audienceQuery.data?.recipients ?? 0;
  const overLimit =
    !audienceQuery.isPending && !audienceQuery.isError && recipients > BROADCAST_MAX_RECIPIENTS;

  const openReview = (): void => {
    if (!title.trim()) {
      showToast('error', 'A title is required');
      return;
    }
    if (!body.trim()) {
      showToast('error', 'A message body is required');
      return;
    }
    setReviewOpen(true);
  };

  return (
    <>
      <AdminPageHeader
        title="Broadcast"
        description="Send one message to a group of real users. It is delivered as an in-app notification and a Telegram message, and it cannot be recalled."
      />

      <div className="space-y-6">
        <div className="flex items-start gap-3 bg-surface border border-warn/40 rounded-2xl p-4">
          <span className="w-8 h-8 rounded-xl bg-warn/10 text-warn flex items-center justify-center shrink-0">
            <Icon name="alert" size={16} />
          </span>
          <div className="text-xs text-mute max-w-3xl space-y-1.5">
            <p>
              This delivers to <span className="text-ink font-medium">real users</span>: an in-app
              notification plus a Telegram message, one per recipient. Once sent it{' '}
              <span className="text-ink font-medium">cannot be recalled or edited</span>.
            </p>
            <p>
              This is <span className="text-ink font-medium">not</span> the &ldquo;needs
              attention&rdquo; feed. That feed is a read-only, computed view for admins and never
              sends anything; this screen sends an outbound message to users.
            </p>
            <p>
              What this screen cannot show: there is no per-recipient delivery report and no
              broadcast history here. The send is queued and the notification worker fans it out
              asynchronously, so delivery completes after this page is gone. The audit log records
              that a broadcast was sent, to which audience, and with what title.
            </p>
          </div>
        </div>

        <Section
          title="Compose"
          description="Title and message are sent to every recipient exactly as written."
        >
          <div className="bg-surface border border-line rounded-2xl p-4 space-y-4">
            <Input
              label="Title"
              placeholder="Short subject line"
              maxLength={120}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              hint="Up to 120 characters."
            />
            <Textarea
              label="Message"
              placeholder="Write the message recipients will read"
              maxLength={2000}
              showCount
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <Select
              label="Audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as BroadcastAudience)}
              options={AUDIENCE_OPTIONS}
              hint="Who receives this. The count is fetched for the selected audience."
            />

            <div>
              <QueryState
                isPending={audienceQuery.isPending}
                isError={audienceQuery.isError}
                error={audienceQuery.error}
                onRetry={() => void audienceQuery.refetch()}
                skeletonRows={1}
              >
                <KpiGrid className="lg:grid-cols-2">
                  <KpiTile
                    label="Recipients right now"
                    value={groupNumber(recipients)}
                    sub={audienceLabel(audience)}
                    icon="user"
                    tone={overLimit ? 'bad' : 'neutral'}
                  />
                  <KpiTile
                    label="Audience"
                    value={audience}
                    sub="Resolved server-side from the recipient relationships"
                    icon="target"
                  />
                </KpiGrid>
                {overLimit ? (
                  <p className="text-xs text-danger mt-2 max-w-3xl">
                    This audience is larger than the server&apos;s maximum of{' '}
                    {BROADCAST_MAX_RECIPIENTS}. The send will be refused — nothing is truncated or
                    silently trimmed. Narrow the audience and try again.
                  </p>
                ) : null}
              </QueryState>
            </div>

            <div className="flex justify-end">
              <Button icon={<Icon name="send" size={15} />} onClick={openReview}>
                Review broadcast
              </Button>
            </div>
          </div>
        </Section>
      </div>

      {/* Step 1 — review, then a dry run. Nothing is queued here. */}
      <ConfirmDialog
        open={reviewOpen}
        title="Review broadcast"
        description={`Audience: ${audienceLabel(audience)} (${groupNumber(
          recipients,
        )} users counted). Title: "${title.trim()}". Continuing runs a dry run: the server validates and re-counts the audience and enqueues nothing.`}
        confirmLabel="Check recipients (dry run)"
        pending={dryRun.isPending}
        onCancel={() => setReviewOpen(false)}
        onConfirm={() => dryRun.mutate()}
      />

      {/* Step 2 — the real send, using the count the server just returned. */}
      <ConfirmDialog
        open={finalOpen}
        title="Send this broadcast?"
        description={`The dry run confirmed delivery to ${groupNumber(
          dryRunResult?.recipients ?? 0,
        )} recipient(s) in ${audienceLabel(
          audience,
        )}. This is the real send: it creates an in-app notification and a Telegram message for each recipient and cannot be recalled.`}
        confirmLabel="Send now"
        danger
        pending={send.isPending}
        onCancel={() => {
          setFinalOpen(false);
          setDryRunResult(null);
        }}
        onConfirm={() => send.mutate()}
      />
    </>
  );
}
