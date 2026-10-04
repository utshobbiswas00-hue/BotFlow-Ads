# Admin Guide

BotFlow Ads's `/admin` section is the operator's panel — moderation queues,
finance review, settings and audit logs. This guide explains what every
screen does and what to do when something looks wrong.

## Top-level structure

The admin panel is mounted at `/admin`. Login is required: only accounts
listed in the `AdminUser` table (seeded from the `TELEGRAM_ADMIN_IDS` env
var) can reach it. Every action is logged to the **audit log** with
`actorId`, `oldValue`, `newValue` and timestamp.

## Overview (`/admin`)

The first screen shows counts of every queue that needs attention:

- Channels awaiting moderation
- Deposits awaiting verification
- Withdrawals awaiting approval
- Failed deliveries in the last hour
- Errors emitted by the API in the last hour

Click any number to jump to the queue.

## Campaigns (`/admin/campaigns`)

Every campaign, every state. Use the status filter to find what needs
attention:

- `QUEUED` — funding confirmed, not yet delivered.
- `LIVE` — currently in flight in the channel.
- `COMPLETED` — fully delivered.
- `CANCELLED` — refunded.

Actions:

- **Cancel** refunds the unspent budget to the advertiser's wallet.
- **Refund** initiates a partial refund for specific posts.

## Channels (`/admin/channels`)

Every registered channel, regardless of state. Statuses:

- `READY_FOR_REVIEW` — bot has permissions; publisher has tapped "Send to
  moderation". This is the main approval queue.
- `INACTIVE` — submitted; verify the URL is your actual channel before approving.
- `PENDING` — bot is not yet admin; nothing to do until the publisher fixes
  the permissions.
- `APPROVED` — live in the marketplace.
- `REJECTED` — publisher was sent a reason; do not re-approve silently.
- `SUSPENDED` — was approved, has been taken down by an admin. Reinstate
  from the same page.
- `ATTENTION_REQUIRED` — bot lost permissions. Tell the publisher.

Action shortcuts:

- **Approve anyway** — when the bot's permissions look fine in Telegram
  even though the database says they're not (snapshot can lag when the
  webhook is misconfigured). Override only after visually confirming.

## Users (`/admin/users`)

Every user with their wallet, channel count and last-seen. The user detail
page has tabs:

- **Profile** — role toggles (advertiser / publisher).
- **Wallet** — balance, ledger entries, ad-hoc credit / debit (ad-hoc
  writes always carry an audit reason).
- **Channels** — channels they own.
- **Transactions** — their ledger.
- **Notifications** — notification log.
- **Sessions** — current active sessions (for sign-out everywhere).

## Finance

### Deposits (`/admin/finance/deposits`)

Every deposit. The actions are:

- **Approve** — verifies the deposit and credits the user's wallet. The
  credited amount is `amountCents - feeCents`. The deposit's status moves
  from `PENDING` to `VERIFIED`. Two admins cannot race because the action
  uses an atomic updateMany guard.
- **Reject** — sets status to `REJECTED` and carries a reason. The user's
  wallet is **not** touched (no money landed yet).

### Withdrawals (`/admin/finance/withdrawals`)

Every withdrawal. The state machine is:

```
PENDING → APPROVED → PROCESSING → PAID
   │         │           │
   └────┬────┘           └─ from any of these states, an admin can REJECT
        └─────────────────── which refunds principal + fee through the ledger
```

- **Approve** moves PENDING → APPROVED.
- **Mark processing** moves APPROVED → PROCESSING — the operator has
  broadcast the transfer. The `payoutRef` is required (tx hash, batch id,
  …) and is shown to the user in the notification.
- **Mark paid** moves APPROVED/PROCESSING → PAID. The `txRef` is required
  and is the final receipt.
- **Reject** refunds the entire amount through the ledger (idempotent via
  the unique reference `withdrawal:refund:<id>`).

### Ledger (`/admin/finance/ledger`)

The single source of truth. Every balance on the platform can be rebuilt
from these rows. Use this view to reconcile any discrepancy — never trust a
denormalised total over a ledger row.

## Delivery (`/admin/delivery`)

The webhook delivery queue. Each row is a single POST attempt to a
publisher's endpoint (house ads / sponsor delivery / etc.). Actions:

- **Retry** replays the row.
- **Disable endpoint** takes the endpoint out of rotation after repeated
  failures.

## Moderation (`/admin/moderation`)

The channel approval queue (subset of Channels, filtered to READY_FOR_REVIEW
+ INACTIVE).

## Audit log (`/admin/audit-logs`)

Every state-changing action records: actor, action type, target, old /
new values, timestamp. Filter by actor and action type. The export button
dumps the visible filters to CSV.

## Settings (`/admin/settings`)

All platform settings. Each key is documented inline with its safe range.
Some keys (e.g. `MIN_SUBSCRIBERS_FOR_MONETIZATION`) need a confirmation when
the change would exclude already-approved channels.

## Support inbox (`/admin/support`)

User-submitted tickets. The triage workflow:

1. **Assign** to a moderator.
2. **Reply** with a button — the user sees the reply in their own support
   tab.
3. **Resolve** when the issue is closed.

## System (`/admin/system`)

Health dashboards: API p95 latency, queue depth, Redis free memory, last
deployment timestamp.

## Common operator pitfalls

- **Double-approving a withdrawal**. Each state transition uses an atomic
  updateMany guard — the second operator sees a conflict and is told who
  acted first.
- **Marking paid before the transfer clears**. If the tx hash was entered
  wrong, you cannot edit it; the operator flow is to refund the user and
  ask them to re-submit. The original `txRef` is preserved on the
  withdrawal for the audit trail.
- **Editing settings without reading the warning**. Some keys (e.g.
  platform fee) carry a confirmation — the value will take effect on the
  next event, not retroactively.

## Recovering from incidents

- **Service degradation** — `/admin/system` shows where the pressure is.
  For queue depth, the right move is to scale Render dynos and let the
  queue drain. Do not pause new campaigns unless the queue is older than
  30 minutes.
- **Suspected fraud** — suspend the channel (Channels → Suspend) and
  reverse any pending ad posts. The platform's audit log preserves
  everything; no action is destructive.