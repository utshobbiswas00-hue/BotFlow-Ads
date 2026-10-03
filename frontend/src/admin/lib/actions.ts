/**
 * Which admin action is offered for which status.
 *
 * Read straight off the backend's own guards, so the panel never renders a
 * button that can only return 409/422:
 *
 *  Campaigns
 *   - APPROVE  → `approveCampaign` accepts PENDING_REVIEW and special-cases
 *                PAUSED (re-approval is how an admin un-pauses one). Any other
 *                state falls through to `assertTransition`, where APPROVED is
 *                only reachable from PENDING_REVIEW.
 *   - REJECT   → `rejectCampaign` transitions to REJECTED, reachable only from
 *                PENDING_REVIEW (campaignStateMachine.ALLOWED_TRANSITIONS).
 *   - PAUSE    → `setCampaignStatus('pause')` requires APPROVED/SCHEDULED/RUNNING.
 *   - RESUME   → `setCampaignStatus('resume')` requires PAUSED.
 *   - CANCEL   → refuses COMPLETED/CANCELLED/REJECTED; EXPIRED is terminal in the
 *                transition table, so it is excluded here too.
 *   - SUSPEND  → direct update; offered wherever it still means something.
 *
 *  Channels
 *   - APPROVE  → also needs `botIsAdmin && canPostMessages`; when that is not
 *                met the button is disabled with the backend's own explanation
 *                rather than hidden, because the fix is an action the operator
 *                can ask the owner to take.
 *   - REJECT   → PENDING only.
 *   - SUSPEND  → stops delivery; offered on live-ish states.
 *   - REACTIVATE → brings a channel back to APPROVED.
 *
 *  Deposits / withdrawals — see the two helpers below.
 */
import type { CampaignAction, ChannelAction } from './api';

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'SUSPENDED',
] as const;

const CAMPAIGN_ACTIONS: Record<CampaignAction, readonly string[]> = {
  APPROVE: ['PENDING_REVIEW', 'PAUSED'],
  REJECT: ['PENDING_REVIEW'],
  PAUSE: ['APPROVED', 'SCHEDULED', 'RUNNING'],
  RESUME: ['PAUSED'],
  CANCEL: ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED', 'SUSPENDED'],
  SUSPEND: ['APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'],
};

export function campaignActionsFor(status: string): CampaignAction[] {
  return (Object.keys(CAMPAIGN_ACTIONS) as CampaignAction[]).filter((a) =>
    CAMPAIGN_ACTIONS[a].includes(status),
  );
}

export const CAMPAIGN_ACTION_LABELS: Record<CampaignAction, string> = {
  APPROVE: 'Approve',
  REJECT: 'Reject',
  PAUSE: 'Pause',
  RESUME: 'Resume',
  CANCEL: 'Cancel',
  SUSPEND: 'Suspend',
};

/** Actions that stop delivery or move money — always confirmed, styled as danger. */
export const CAMPAIGN_ACTION_DANGER: Record<CampaignAction, boolean> = {
  APPROVE: false,
  REJECT: true,
  PAUSE: false,
  RESUME: false,
  CANCEL: true,
  SUSPEND: true,
};

/** `rejectCampaign` refuses an empty reason. */
export const CAMPAIGN_ACTION_NOTE_REQUIRED: Record<CampaignAction, boolean> = {
  APPROVE: false,
  REJECT: true,
  PAUSE: false,
  RESUME: false,
  CANCEL: false,
  SUSPEND: false,
};

export const CAMPAIGN_ACTION_NOTE_HINT: Record<CampaignAction, string | undefined> = {
  APPROVE: 'Optional — the advertiser is notified.',
  REJECT: 'Shown to the advertiser. The remaining budget is refunded immediately.',
  PAUSE: undefined,
  RESUME: undefined,
  CANCEL: 'The remaining escrow is released back to the advertiser.',
  SUSPEND: 'Optional. Every job that has not started is cancelled.',
};

export const CHANNEL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'INACTIVE',
  'ATTENTION_REQUIRED',
] as const;

const CHANNEL_ACTIONS: Record<ChannelAction, readonly string[]> = {
  APPROVE: ['PENDING'],
  REJECT: ['PENDING'],
  SUSPEND: ['PENDING', 'APPROVED', 'INACTIVE', 'ATTENTION_REQUIRED'],
  REACTIVATE: ['REJECTED', 'SUSPENDED', 'INACTIVE', 'ATTENTION_REQUIRED'],
  // Deliberately no statuses: VERIFY is not a status transition, it is a question about
  // the rights snapshot, which is orthogonal to status. The Channels page offers it when
  // channelNeedsRightsRecheck() is true, so listing statuses here would show it on rows
  // that do not need it — and twice on the rows that do.
  VERIFY: [],
};

export function channelActionsFor(status: string): ChannelAction[] {
  return (Object.keys(CHANNEL_ACTIONS) as ChannelAction[]).filter((a) =>
    CHANNEL_ACTIONS[a].includes(status),
  );
}

/** `adminChannelAction` refuses APPROVE unless the bot can actually post. */
export function channelNeedsRightsRecheck(channel: {
  botIsAdmin: boolean;
  canPostMessages: boolean;
}): boolean {
  return !(channel.botIsAdmin && channel.canPostMessages);
}

export function channelApproveBlockedReason(channel: {
  botIsAdmin: boolean;
  canPostMessages: boolean;
  title: string;
}): string | null {
  if (!channelNeedsRightsRecheck(channel)) return null;
  // The old copy promised the snapshot "updates on its own". It does — via the
  // `my_chat_member` push — but that push never arrives if the webhook was misconfigured
  // when the bot was added, which is precisely the case this message is shown in. It now
  // names the action that answers instead of promising something that may never come.
  return `BotFlow Bot is not recorded as an administrator with post rights in "${channel.title}". If you have just added it, use "Re-check rights" to ask Telegram again. Otherwise ask the owner to add the bot.`;
}

/**
 * Deposits: `verifyDeposit` is idempotent and `rejectDeposit` requires
 * `status === 'PENDING'`, so both actions exist only for a pending row.
 */
export function depositActionsFor(status: string): ('VERIFY' | 'REJECT')[] {
  return status === 'PENDING' ? ['VERIFY', 'REJECT'] : [];
}

/**
 * Withdrawals, from the service guards:
 *   APPROVE   → PENDING only (`approveWithdrawal`).
 *   REJECT    → PENDING or APPROVED; refunds principal + fee via the ledger.
 *   MARK_PAID → APPROVED or PROCESSING; `txRef` is required as payout proof.
 */
export function withdrawalActionsFor(status: string): ('APPROVE' | 'REJECT' | 'MARK_PAID')[] {
  const out: ('APPROVE' | 'REJECT' | 'MARK_PAID')[] = [];
  if (status === 'PENDING') out.push('APPROVE');
  if (status === 'PENDING' || status === 'APPROVED') out.push('REJECT');
  if (status === 'APPROVED' || status === 'PROCESSING') out.push('MARK_PAID');
  return out;
}

/** States where a delivery retry can still do something useful. */
export const RETRYABLE_DELIVERY_STATES = ['FAILED', 'RETRYING', 'LOCKED', 'PROCESSING'];

export const DEPOSIT_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'FAILED'] as const;
export const WITHDRAWAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'PROCESSING',
  'PAID',
  'REJECTED',
  'CANCELLED',
] as const;
export const DELIVERY_STATUSES = [
  'PENDING',
  'SCHEDULED',
  'LOCKED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'AWAITING_APPROVAL',
] as const;
export const REPORT_STATUSES = ['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED'] as const;
export const TICKET_STATUSES = ['OPEN', 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export const TRANSACTION_TYPES = [
  'DEPOSIT',
  'CAMPAIGN_CHARGE',
  'PUBLISHER_EARNING',
  'WITHDRAWAL',
  'REFUND',
  'PLATFORM_FEE',
  'REFERRAL_REWARD',
  'MANUAL_ADJUSTMENT',
  'ESCROW_HOLD',
  'ESCROW_RELEASE',
] as const;

/** Options for a filter <Select>, with readable labels. */
export function statusOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((v) => ({
    value: v,
    label: v
      .split('_')
      .map((w) => (w.length ? w[0] + w.slice(1).toLowerCase() : w))
      .join(' '),
  }));
}
