# Steps 3–8 — Implementation and Verification Report

Everything below is from tool output in this session. Nothing was committed or pushed.
The two delegated workstreams were both **interrupted by their own time limit during their
final verification run**, so every number here is from **my own consolidated re-run**, not
from an agent's report.

---

## 1. Tests executed

| Suite | Command | Result |
|---|---|---|
| Backend unit (DB-free) | `node node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts` (cwd `backend/`) | **22 files, 246 tests passed** |
| Frontend | `node node_modules/vitest/vitest.mjs run` (cwd `frontend/`) | **15 files, 84 tests passed** |
| Backend typecheck | `tsc -p backend/tsconfig.json --noEmit` | clean |
| Frontend typecheck | `tsc -p frontend/tsconfig.json --noEmit` | clean |
| Backend lint | `eslint src` (cwd `backend/`) | clean |
| Production build | `vite build` (cwd `frontend/`) | OK — 1097 modules |

New test files this round (20 backend test files and 13 frontend test files now exist in total):

- `backend/src/services/__tests__/ticketThread.test.ts` — 4
- `backend/src/routes/admin/__tests__/settings.routes.test.ts` — 11
- `backend/src/routes/admin/__tests__/notifications.routes.test.ts` — 11
- `backend/src/services/__tests__/alertAdmins.test.ts` — 7
- `backend/src/services/__tests__/broadcastTracking.test.ts` — 26
- `backend/src/workers/__tests__/notification.processor.test.ts` — 7
- `frontend/src/test/SupportPanel.test.tsx` — 2
- `frontend/src/test/settingsRow.test.tsx` — 14
- `frontend/src/test/adminNotifications.test.tsx` — 5
- `frontend/src/test/broadcastReport.test.tsx` — 3

**Not run: the backend integration suite.** `backend` `npm test` runs `vitest run` without
the `--config vitest.unit.config.ts` override, which requires a live Postgres. No database is
reachable from this environment, so those were skipped. This is the main coverage caveat.

---

## 2. Step-by-step outcome

### Step 3 — Admin ticket thread

**Root cause confirmed:** the only thread read in the API was `ticket.service.ts:164`
`getTicket(userId, ticketId)`, which calls `assertTicketOwner`; that assertion is what returned
404 to staff. `TicketMessage.attachmentUrl` already existed, so attachments needed no schema work.

- `backend/src/services/ticket.service.ts` — added `getTicketAdmin(ticketId)` mirroring `getTicket`'s
  query, minus the ownership assertion; `NotFoundError` for an unknown id. Added
  `ADMIN_MESSAGE_SELECT` so the response carries `senderId` + `attachmentUrl`. `MESSAGE_SELECT` and
  `getTicket`/`assertTicketOwner` are unchanged.
- `backend/src/routes/admin/support.routes.ts:42` — `GET /tickets/:id`, `requirePermission('tickets.view')`.
- `frontend/src/admin/pages/Support.tsx` — panel now loads and renders the real thread (sender type,
  body, timestamp, attachment link) and refreshes it after a reply.
- Owner API preserved; a test asserts the owner path still refuses a non-owner.

### Step 4 — Notification inbox (+ the real gap)

**Finding:** the persistent user inbox already existed — model, read/unread, `readAt`, pagination,
4 routes, an inbox screen, 12 call sites. **No new model, no migration** (an admin is a `User`).
The actual gap was `alertAdmins()` writing no database row, so ops alerts vanished.

- `backend/src/routes/admin/notifications.routes.ts` (new, 165 lines) — gated
  `requirePermission('dashboard.view')`; `GET /`, `GET /unread-count`, `POST /:id/read`,
  `POST /read-all`. The acting user id comes from `req.user.id`, never a query param. A foreign
  notification id returns **404, not 403**, so existence is not leaked. `unread` is returned with
  the page so list and badge cannot disagree.
- `backend/src/services/notification.service.ts` — `alertAdmins()` now also persists one
  `SYSTEM` notification per **active** admin (`SYSTEM` was chosen over `SECURITY_ALERT` because the
  latter means "new device" and is in the email fan-out set). Persistence is non-throwing; the
  Telegram behaviour is unchanged.
- `frontend/src/admin/pages/Notifications.tsx` (new) — inbox with unread/read distinguished by
  **words**, not colour alone; mark-one, mark-all, unread-only filter with a way back, pager.

### Step 5 — Broadcast delivery report

**Finding:** no broadcast model existed. Per-recipient state was only `Notification.delivered`/`sentAt`,
which cannot say which broadcast a message belonged to, what Telegram said on failure, or the message id.

- **Migration created** (offline, see §4): `prisma/migrations/20261002100000_add_broadcast_delivery_tracking/migration.sql` — 12 statements: 3 enums, 2 tables, 5 indexes, 2 foreign keys.
- `backend/src/services/broadcast.service.ts` (new) — `createBroadcastJob` (job + `PENDING` recipients
  in one transaction), `recordBroadcastOutcome` (never throws), `recomputeBroadcastJob`,
  `listBroadcastHistory`, `getBroadcastJob`, `listBroadcastRecipients`.
- `backend/src/routes/admin/broadcast.routes.ts` — `POST /` creates the rows **before** enqueuing and
  marks the job FAILED if the enqueue rejects; `dryRun` still writes nothing; over-limit is still a
  refusal, never a truncation. Added `GET /history`, `GET /:id`, `GET /:id/recipients`.
- `backend/src/workers/notification.processor.ts` (new) + `notification.worker.ts` reduced to bootstrap.
  The tracking branch is keyed on the presence of a broadcast recipient id, so a non-broadcast
  notification is a **no-op** — asserted both ways (the tracked functions are never called; and one
  id alone still takes the old path).
- `frontend/src/admin/pages/BroadcastReport.tsx` (new) — history → detail with the live `groupBy`
  counts shown **beside** the job's denormalised counters, so drift is visible rather than hidden;
  recipient table with status filter; `telegramMessageId` rendered as a string.

> **Risk worth your attention:** this round rewrote the worker plumbing that serves **every**
> user notification, not just broadcasts. That is the highest-risk change in the whole round.

### Step 6 — Array settings

**Root cause confirmed independently:** `updateSettingSchema.value` was
`string | number | boolean | record(...)`; zod rejects an **array** for `z.record`, so validation
failed before Prisma was reached. Storage was already correct — `Setting.value` is `Json`,
`valueType` supports `json`, and `getArraySetting()` already read arrays. GET already returned
arrays as arrays; nothing about storage was "fixed".

- `shared/src/schemas.ts` — union extended with `z.array(z.union([string, number, boolean]))`; every
  existing member untouched. `shared/dist` regenerated (the backend resolves `@botflow/shared`
  from `dist`).
- `backend/src/routes/admin/settings.routes.ts` — `updateSettingRouteSchema` refines per key,
  deriving the expected item type from that key's own default in `SETTING_DEFAULTS`. Mismatch → 400
  naming the key and the expected type.
- `frontend/src/admin/pages/settings/SettingsRow.tsx` — arrays are now editable, and item types are
  preserved on parse: a default of `[50, 25, 10, 5]` submits **numbers**, not `["50"]` (which would
  silently break the threshold comparison at runtime). `Settings.tsx` now imports the shared row
  instead of keeping a divergent copy.

---

## 3. Files changed

**Modified (6)**
```
shared/src/schemas.ts                              union + array member
backend/src/services/ticket.service.ts             + getTicketAdmin, ADMIN_MESSAGE_SELECT
backend/src/services/notification.service.ts       alertAdmins persists; readAt in list select
backend/src/routes/admin/settings.routes.ts        per-key array refinement
backend/src/workers/notification.worker.ts         reduced to bootstrap, processor extracted
frontend/src/pages/Settings.tsx                    imports the shared row
```

**New (backend)**
```
backend/prisma/migrations/20261002100000_add_broadcast_delivery_tracking/migration.sql
backend/src/routes/admin/notifications.routes.ts
backend/src/services/broadcast.service.ts
backend/src/workers/notification.processor.ts
+ 6 test files (see §1)
```

**New (frontend)**
```
frontend/src/admin/pages/Notifications.tsx
frontend/src/admin/pages/BroadcastReport.tsx
+ 4 test files (see §1)
```

**Wiring I did by hand** (the agents were told not to touch these):
`backend/src/routes/admin/index.ts` (mounted `/notifications`), `frontend/src/router.tsx`
(routes `broadcast/report`, `notifications`), `frontend/src/admin/index.ts` (2 barrel exports),
`frontend/src/admin/lib/permissions.ts` (Broadcast sub-entries + Notifications nav),
plus the frozen contracts in `admin/lib/api.ts`, `admin/lib/types.ts`, `lib/queryClient.ts`,
and the schema + migration for step 5.

---

## 4. Migrations created

One, and it was generated **without a database**:

```
prisma migrate diff --from-schema-datamodel /tmp/schema-before.prisma \
                    --to-schema-datamodel backend/prisma/schema.prisma --script
```

That is a schema-to-schema diff — fully offline, so no `DATABASE_URL` was needed. The output was
verified to contain **only** broadcast objects (no unrelated drift), and the Prisma client was
regenerated (`prisma generate`, also offline) so `prisma.broadcastJob` /
`prisma.broadcastRecipient` exist. `prisma validate` → valid.

**It has NOT been applied.** There is no reachable Postgres here. It applies automatically on boot
via `runMigrationsOnBoot()` (advisory-locked), or manually with `npm run db:deploy`.

Two things about the toolchain worth knowing, both load-bearing if this is ever deployed:
the `prisma` CLI is a **devDependency**, so if the build stops installing dev dependencies then
migrations **silently stop running**; and another agent regenerated `shared/dist` because the
backend resolves `@botflow/shared` from `dist`, not `src` — a `shared/` edit without a rebuild
changes nothing at runtime.

---

## 5. API endpoints added / changed

| Method + path | Permission | State |
|---|---|---|
| `GET /api/admin/support/tickets/:id` | `tickets.view` | **new** |
| `GET /api/admin/notifications` | `dashboard.view` | **new** |
| `GET /api/admin/notifications/unread-count` | `dashboard.view` | **new** |
| `POST /api/admin/notifications/:id/read` | `dashboard.view` | **new** |
| `POST /api/admin/notifications/read-all` | `dashboard.view` | **new** |
| `GET /api/admin/broadcast/history` | `broadcast.send` | **new** |
| `GET /api/admin/broadcast/:id` | `broadcast.send` | **new** |
| `GET /api/admin/broadcast/:id/recipients` | `broadcast.send` | **new** |
| `POST /api/admin/broadcast` | `broadcast.send` | **changed** — now creates the job + recipient rows first; `dryRun` unchanged |
| `POST /api/admin/settings` | `settings.manage` | **changed** — accepts arrays, validates item types per key |
| `POST /api/admin/support/tickets/:id/reply` | `tickets.manage` | unchanged |

Totals after this round: **94 in `routes/admin/` + 16 ops + 1 health probe = 111 admin endpoints**
(36 screens, 36 admin routes, 30 nav entries).

---

## 6. Remaining errors and open items

1. **The migration is unapplied** (no database here) — the single most important follow-up.
2. **No live database round-trip was tested.** All Prisma interaction is covered by mocked-client
   tests; the backend integration suite needs Postgres and was not run.
3. **`notification.worker.ts` was refactored** into bootstrap + `notification.processor.ts`. Covered
   by 7 tests including the non-broadcast no-op, but it is shared by every user notification and
   deserves review before deploy.
4. **400 vs 422 (deliberate deviation):** the repo's `errorHandler` maps `ZodError` → **422**. To
   meet the explicit "invalid item type → 400" requirement, the array refinement **throws an
   `AppError`** (400) instead of calling `ctx.addIssue`. If 422 is preferred for consistency, that
   is a two-line change.
5. ~~**A bare primitive for an array-defaulted key still validates.**~~ **Closed.** A scalar sent for
   a key whose default is a list is now a **400** naming the key and the expected item type. The
   silent-failure path it removes: the scalar was stored, `getArraySetting` ignored it, and the
   setting quietly reverted to its default while the admin saw "saved". Primitive-typed keys are
   untouched — asserted by tests.
6. ~~**The `[]` accept-anything branch** is exercised by logic only.~~ **Closed.** The item-type
   computation is now the pure exported `expectedArrayItemTypes()`, so the empty-default branch and
   the dedupe/sort behaviour are covered directly, without needing a key that happens to default to
   `[]`.

**Re-run after both closures** — the authoritative final state:

```
backend  tsc : clean           backend  tests: 22 files, 259 passed, 0 failing files
frontend tsc : clean           frontend tests: 15 files,  84 passed
backend eslint: clean          vite build: OK, 1097 modules
prisma validate: valid         migration applied: NO — no database reachable
```

### Environment note (cost me three repair cycles)

This workspace was re-provisioned twice mid-work (the hostname changed). Each time, the
`node_modules/@botflow/shared` link that resolves the workspace package disappeared, which broke the
backend typecheck and made **15 of 22 backend test files fail to even collect** — while the code was
fine. On a real machine `npm ci` creates that link; here it has to be re-created by hand:

```
mkdir -p node_modules/@botflow backend/node_modules/@botflow frontend/node_modules/@botflow
ln -sfn ../../shared    node_modules/@botflow/shared
ln -sfn ../../../shared backend/node_modules/@botflow/shared
ln -sfn ../../../shared frontend/node_modules/@botflow/shared
```

If a verification run ever reports a large block of `Cannot find module '@botflow/shared'`, that is
the cause — not a regression.
7. **Broadcast `counts` vs denormalised counters** are recomputed from a `groupBy` and returned
   alongside the stored columns on purpose, so drift is visible. Nothing reconciles them
   automatically.
8. **Nothing is pushed.** `HEAD = origin/main = 3449716`, 0 commits ahead, 73 changed paths
   (28 modified, 45 new).
