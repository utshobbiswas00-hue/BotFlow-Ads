# Steps 3–6 — Inspection and Change Plan

> **Delivered differently, in one place.** This document is the proposal as it was
> shown before implementation, kept unedited as a record. For step 4 it recommended
> reusing the customer `notifications` table and said no migration was needed. The
> implementation that shipped uses a **dedicated `admin_notifications` table**
> (`AdminNotification` model + migration `20261002140000_add_admin_notifications`)
> instead, so admin read state is separate from the customer inbox. The rest of the
> plan below was followed as written.

**Nothing has been modified.** This document answers the inspection questions you asked for
and lists the exact files each step will touch, so you can approve or redirect before any
code changes.

Everything below was read out of the repository in this session. Where a finding contradicts
what the step assumes, it is called out rather than worked around.

---

## Headline: one of the four steps is already built

**Step 4 already exists.** The `Notification` model, the read/unread state, the paginated
list, the unread count, mark-one-read, mark-all-read and a user-facing inbox screen are all
present and wired, and **12 files already create notifications**. Implementing step 4 as
written ("create the required notification database model/table, add the required migration")
would mean building a second, parallel notification system.

Details and what genuinely *is* missing are in §2. The honest version of step 4 is much
smaller than planned.

---

## 1. Step 3 — Admin-scoped ticket thread

### What exists

| Piece | Where | State |
|---|---|---|
| `SupportTicket` model | `backend/prisma/schema.prisma` | id, userId, ticketNo, subject, category, status, priority, assignedToId, lastMessageAt, closedAt, indexes on `status` and `userId` |
| `TicketMessage` model | same | id, ticketId, senderId, **`senderType`** (`TicketSenderType`), body, **`attachmentUrl`**, createdAt, index `(ticketId, createdAt)` |
| Owner thread read | `services/ticket.service.ts` → `getTicket(userId, ticketId)` | calls `assertTicketOwner(ticketId, userId)` — **this is the 404 an admin hits** |
| Owner reply | `services/ticket.service.ts` → `addMessage(userId, ticketId, body)` | same ownership assertion; reopens a CLOSED/RESOLVED ticket |
| Admin list | `services/ticket.service.ts` → `listTicketsAdmin(...)` | exists, paginated |
| Admin reply | `services/ticket.service.ts` → `adminReplyTicket(adminId, ticketId, body)` | exists, writes `senderType: 'ADMIN'` |
| Admin status | `services/ticket.service.ts` → `setTicketStatus(...)` | exists |
| Admin routes | `routes/admin/support.routes.ts` | `GET /tickets` (`tickets.view`), `POST /tickets/:id/reply` (`tickets.manage`), `POST /tickets/:id/status` (`tickets.manage`). **No thread read.** |
| Admin UI | `frontend/src/admin/pages/Support.tsx` | list + reply + status; the missing thread read is documented in its own copy |

**So the gap is exactly one read path.** Attachments are already supported at the model and
service level (`attachmentUrl`), so "view attachments if already supported" is satisfied by
returning the field — no new storage.

### Files I intend to change (4, no migration)

| File | Change |
|---|---|
| `backend/src/services/ticket.service.ts` | Add `getTicketAdmin(ticketId)`: the same query as `getTicket` **minus** `assertTicketOwner`, ordered by `createdAt asc`. Throw `NotFoundError` for a missing ticket. Do **not** modify `getTicket` — the owner path must stay byte-identical (§6 of your requirements). |
| `backend/src/routes/admin/support.routes.ts` | Add `GET /tickets/:id` with `requirePermission('tickets.view')`, `validate({ params: idParams })`, returning `{ ticket, messages }`. Reuses the file's existing `idParams` schema. |
| `frontend/src/admin/lib/api.ts` | Add `getTicketThread(id)` + a `TicketThread` type. No other client change. |
| `frontend/src/admin/pages/Support.tsx` | Replace the "no thread endpoint" notice with the real thread: messages oldest-first, sender type per message, timestamps, attachment links, and the existing reply box wired to send into the same thread. |

Status codes fall out of the existing middleware, no new code: no/expired credential → **401**
(`adminPanelAuth`), authenticated without `tickets.view` → **403** (`requirePermission`),
unknown ticket id → **404** (`NotFoundError`).

Tests: `backend/src/services/__tests__/ticketThread.test.ts` (admin read works on another
user's ticket; missing ticket → 404; message ordering; the owner path still rejects a
non-owner — the regression guard for requirement 10).

---

## 2. Step 4 — the persistent notification inbox already exists

### The seven inspection answers

**1. Existing notification-related models** — `Notification`:

```
id, userId → User @relation(onDelete: Cascade), type NotificationType,
title, body, data Json?, link String?,
isRead Boolean @default(false), readAt DateTime?,
delivered Boolean @default(false), sentAt DateTime?,
createdAt
@@index([userId, isRead])  @@index([createdAt])
```

That is every field your step 4 lists: recipient id, type, title, message, `data` for a
reference payload, read/unread, created timestamp, read timestamp. `NotificationType` has 22
members including `SYSTEM`, `FRAUD_ALERT`, `SECURITY_ALERT`, `EARNINGS_AVAILABLE`.

**2. Existing attention-feed logic** — `routes/admin/attention.routes.ts`, added earlier in
this build. It is a **computed** view: eleven `count()` queries on live tables (pending
deposits, withdrawals, campaigns, channels, creative versions, failed deliveries, fraud
events, reports, tickets, crypto transfers, permissionless admins), sorted by severity,
returned with `href`s. It stores nothing. **It is not a notification system and does not
compete with one** — it answers "what is overdue right now", which a stored inbox cannot.

**3. Existing user model** — `User`, with `status` (`ACTIVE|SUSPENDED|BANNED|PENDING`), a
1:N `notifications` relation, and the cached role flags you already know about.

**4. Existing migration system** — Prisma, **13 hand-written SQL migrations** under
`backend/prisma/migrations/`, e.g. `20260929100000_add_channel_posting_schedule/migration.sql`
(the newest is a plain `ALTER TABLE … ADD COLUMN … JSONB` with an explanatory comment).
`migrate deploy` runs automatically on boot from both `start` and `start:worker`, idempotently
and under a Postgres advisory lock. So a migration is applied by the next deploy — it is not a
manual step.

**5. Existing notification API routes** — `routes/notification.routes.ts`, all
`requireUser`-scoped and **all already implemented**:

| Route | Handler |
|---|---|
| `GET /api/notifications` | `listNotifications(userId, page, unreadOnly)` — paginated (`skip`/`take`) |
| `POST /api/notifications/read` | `markNotificationsRead(userId, ids)` |
| `POST /api/notifications/read-all` | `markAllRead(userId)` |
| `GET /api/notifications/unread-count` | `countUnread(userId)` |

Pagination already uses the shared `getPagination`, and the queries are indexed on
`(userId, isRead)`.

**6. Where notifications should be created** — they already are, in **12 files**:
`notification.service.ts` (`createNotification`, `createBulkNotifications`), `houseDelivery`,
`myChatMember`, `conversion`, `delivery`, `alert`, `admin`, `withdrawal`, `deposit`,
`invoice`, plus the admin broadcast route. No new call sites are needed for the events
already covered.

**7. Existing frontend notification/inbox components** — `frontend/src/pages/Notifications.tsx`
exists and is routed; `frontend/src/pages/Dashboard.tsx` reads the unread count;
`frontend/src/lib/queryClient.ts` has the notification query keys.

### What is actually missing, and the minimum change

The only real gap: **notifications are user-scoped, so the admin panel has no inbox of its
own.** `alertAdmins()` in `notification.service.ts` sends Telegram text to
`TELEGRAM_ADMIN_IDS` and writes **no database row** — so an admin alert cannot be read later.

Minimum change, and it needs **no migration at all**: an admin *is* a `User`, and
`Notification.userId` is just a user id.

| File | Change |
|---|---|
| `backend/src/routes/admin/notifications.routes.ts` (new) | `GET /` (paginated, `unreadOnly`), `GET /unread-count`, `POST /read`, `POST /read-all` — each delegating to the **existing** `listNotifications` / `countUnread` / `markNotificationsRead` / `markAllRead` with `userId = req.adminUserId`. Gated by `requirePermission('dashboard.view')`. |
| `backend/src/routes/admin/index.ts` | Mount it at `/notifications`. |
| `backend/src/services/alert.service.ts` | Change `alertAdmins()` to **also** write a `Notification` row per admin user (type `SYSTEM`) alongside the Telegram send, so alerts become readable in the panel instead of only in a chat that scrolls away. |
| `frontend/src/admin/lib/api.ts` | The four client calls. |
| `frontend/src/admin/pages/Inbox.tsx` (new) | The inbox screen, reusing the Mini App's `Notifications.tsx` layout conventions. |
| `frontend/src/admin/components/TopBarTools.tsx` | Point the existing bell at the inbox for unread notifications, keeping the urgent *count* link to the attention feed. |

**Migration: none.** Aggregate counts, read state, pagination and indexes all already exist.

If you would rather have a *separate* `AdminNotification` table, that is a legitimate choice
(admins' alerts are not "their" personal notifications), but it duplicates the model and needs
a migration — I would not do it unless you want those two streams kept apart on purpose.

---

## 3. Step 5 — Broadcast delivery tracking

### The eight inspection answers

**1. Broadcast API** — `backend/src/routes/admin/broadcast.routes.ts` (built earlier in this
build): `GET /audience?audience=` → `{ audience, recipients }`, `POST /` → `{ enqueued, jobId,
audience, recipients }`, both `broadcast.send`, with `dryRun` support and a hard cap of 100.

**2. Job/queue implementation** — it enqueues one `send-broadcast` job on the existing
`botflow-notification` queue. The worker expands the audience and calls
`notification.service.createBulkNotifications()`, which per recipient inserts a `Notification`
row **and** enqueues a `send-telegram-notification` job.

**3. Job ID generation** — the BullMQ job id returned by `queue.add(...)` is what
`POST /broadcast` returns as `jobId`. **It is not persisted anywhere.**

**4. Telegram sending logic** — `notification.service.ts → deliverToTelegram(payload)`, driven
by the `send-telegram-notification` worker.

**5. Recipient selection logic** — `ALL` / `PUBLISHERS` (users with ≥1 channel) /
`ADVERTISERS` (users with ≥1 campaign), derived from relationships, counted through
`GET /audience` before sending.

**6. Existing broadcast database models** — **none.** `send-broadcast` is a queue name, not a
table. The only per-recipient artefact today is the `Notification` row, which carries
`delivered` (boolean) and `sentAt` — enough to know *that* something went out, not enough to
say what failed or to tie a row back to the broadcast that caused it.

**7. Existing admin broadcast page** — `frontend/src/admin/pages/Broadcast.tsx`: composer,
audience count, two-step confirm with `dryRun`. It has no history view, and says so.

**8. Existing retry/error handling** — the notification worker's own retry, plus a failed
Telegram send leaving `delivered = false`. There is no per-recipient error text and no
retry-from-the-panel path.

### Where delivery tracking has to be added

At the fan-out step — the moment the worker expands the audience into recipients
(`createBulkNotifications`'s caller) — because that is the only place that knows both the
broadcast and the individual recipient. Everything after it is a per-recipient send result,
which arrives in `deliverToTelegram`.

### Schema options

**Option A — two tables (recommended).**

```prisma
model BroadcastJob {
  id          String   @id @default(cuid())
  jobId       String?  @unique @map("job_id")   // the BullMQ id, now persisted
  audience    String
  title       String
  body        String
  createdById String   @map("created_by_id")
  total       Int      @default(0)
  pending     Int      @default(0)
  sent        Int      @default(0)
  failed      Int      @default(0)
  status      String   @default("QUEUED")       // QUEUED | SENDING | DONE | PARTIAL | FAILED
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  recipients  BroadcastRecipient[]
  @@index([createdAt])
  @@map("broadcast_jobs")
}

model BroadcastRecipient {
  id                String   @id @default(cuid())
  broadcastId       String   @map("broadcast_id")
  broadcast         BroadcastJob @relation(fields: [broadcastId], references: [id], onDelete: Cascade)
  userId            String   @map("user_id")
  status            String   @default("PENDING")  // PENDING | SENT | FAILED | SKIPPED
  telegramMessageId String?  @map("telegram_message_id")
  error             String?
  sentAt            DateTime? @map("sent_at")
  createdAt         DateTime @default(now()) @map("created_at")
  @@unique([broadcastId, userId])
  @@index([broadcastId, status])
  @@index([userId])
  @@map("broadcast_recipients")
}
```

**Option B — extend `Notification`** with `broadcastId`, `telegramMessageId`, `error`, and
derive the counts by `groupBy`. Fewer tables, but it makes an inbox row double as a delivery
record: a future "clear my notifications" would delete delivery history, and the aggregate
counts become a scan over the user-facing table.

**I recommend A**, for that reason. Both need a migration; neither needs a new queue.

### Files A would touch

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | The two models above. |
| `backend/prisma/migrations/<ts>_broadcast_delivery_tracking/migration.sql` | Hand-written, matching the existing convention. |
| `backend/src/services/broadcast.service.ts` (new) | Create the job, record recipients at fan-out, update per-recipient status on send, maintain the aggregate counts. |
| `backend/src/routes/admin/broadcast.routes.ts` | Persist the job before enqueueing; add `GET /jobs` (history, paginated), `GET /jobs/:id` (detail + counts), `GET /jobs/:id/recipients` (paginated delivery history). |
| `backend/src/workers/*` (the notification worker) | Report each send result back. |
| `frontend/src/admin/lib/api.ts`, `frontend/src/admin/pages/Broadcast.tsx` | History list, job detail, recipient table. |

---

## 4. Step 6 — Array-valued settings

### Why arrays fail today

```
shared/src/schemas.ts:213
value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())])
```

`z.record(...)` accepts an **object**, and zod rejects an array for it — so
`POST /api/admin/settings` with `["crypto"]` is a 422 before it ever reaches Prisma. The
failure is **validation only**. Storage is already fine:

```
model Setting { key String @unique, value Json, valueType String @default("string") }
// valueType comment: string | int | bool | json
```

The column is `Json` and the project already has a `json` value type, so the three
array settings are representable — and `GET /api/admin/settings` already returns them as
arrays, because `getAllSettings()` returns the merged map untouched.

The three affected keys, from `backend/src/config/constants.ts`: `allowed_withdrawal_methods`,
`allowed_deposit_methods`, `budget_alert_thresholds`.

### Minimum change

| File | Change |
|---|---|
| `shared/src/schemas.ts` | Add `z.array(z.union([z.string(), z.number(), z.boolean()]))` to the `value` union. Primitives keep their existing behaviour unchanged (§2 of your requirements). |
| `backend/src/routes/admin/settings.routes.ts` | Per-key item validation as a `.superRefine` **in the route**, so the rule lives next to the keys: read `SETTING_DEFAULTS` from `config/constants.ts`, and if the default is an array require every item to be the same primitive type as the defaults, plus a non-empty array. `shared/` cannot import backend constants, so it stays generic there. |
| `frontend/src/admin/pages/Settings.tsx` | Arrays are currently rendered read-only with an explanation. Replace with an editable control (one item per line) that preserves the existing type-preserving save path. |
| `frontend/src/admin/pages/settings/SettingsSectionPage.tsx` | Same editor, since the sub-pages reuse it. |

No migration. Tests as you listed: valid array, invalid array (wrong item type, empty,
a nested array), a primitive setting that must still round-trip, and a GET→UPDATE→GET round
trip.

---

## 5. Step 8 — the verification I will run

Not "it works" — the actual output:

1. `tsc --noEmit` on frontend and backend.
2. `eslint src` on the backend.
3. The full backend unit suite and the full frontend suite, before and after, so any
   regression is visible as a delta rather than an assertion.
4. Per-step tests as listed above, including the explicit negative cases: 401 (no credential),
   403 (credential without the permission), 404 (unknown id), validation rejections, and
   pagination boundaries.
5. `prisma validate` on the schema, and the migration SQL reviewed line by line.
6. `vite build`, with the chunk split re-checked so the Mini App's bundle still does not carry
   admin code.
7. A regression pass on the **existing** owner-facing ticket API and the existing
   notification routes, since both are the ones most likely to break.
8. The final report will list: tests executed, files changed, migrations created, endpoints
   added/changed, and **any remaining error or unverified item**.

---

## 6. One constraint you need to decide on

**There is no database reachable from this workspace** — no `.env`, no `DATABASE_URL`. So:

- I can **author** migrations in the existing hand-written style, and `prisma validate` can
  check the schema, but I **cannot apply** a migration or run a test that exercises real
  database behaviour here. `migrate deploy` will apply them on the next deploy, which is the
  project's normal path.
- That means steps 5 (and any schema change) will be verified by: schema validation, unit
  tests against mocked Prisma, type checking, and a careful line-by-line review of the SQL —
  **not** by a live round-trip. I will say so explicitly in the final report rather than
  implying the migration has been run.

If you want a genuinely applied migration verified end to end, either point me at a database
(a throwaway Postgres URL is enough) or run `npm run db:deploy` yourself after I hand over the
SQL and paste the result back.

---

## 7. Summary of the plan, in the order I would build it

| Step | Migration? | Files | Risk |
|---|---|---|---|
| 3 — Ticket thread | **No** | 4 (1 backend service, 1 backend route, 2 frontend) + 1 test | Low — additive read path, owner path untouched |
| 6 — Array settings | **No** | 4 (1 shared schema, 1 route, 2 frontend) + 1 test | Low — one union member, primitives unchanged |
| 4 — Admin inbox | **No** | 6 (1 new route, 1 service edit, 1 mount, 1 client, 1 new page, 1 bell edit) + 1 test | Low–medium — reuses the existing model; the risk is scope, not correctness |
| 5 — Broadcast delivery | **Yes** (2 tables) | 7 + 1 migration + 1 test | Medium — touches the notification worker, so a bug can affect every user notification, not just broadcasts. I would do this one last, on its own, with the worker change reviewed carefully. |

Say go and I will build them in that order, or tell me to reorder. Step 4 is the one worth a
decision first, since half of what it asks for is already in place.
