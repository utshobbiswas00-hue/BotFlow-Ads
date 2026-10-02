# Admin Panel — Build Report

Repo: `utshobbiswas00-hue/BotFlow-Ads` (private) · branch `main` · base commit `3449716`
Scope: Option A — the panel ships inside the existing frontend, mounted at `/admin/*`.
Status: **built and verified locally. NOTHING HAS BEEN PUSHED.**

---

## 0. Correction to the first version of this report

The first pass claimed full coverage of "16 admin routers". That was wrong. The
admin surface is **two routers**, and only one of them lives in `routes/admin/`:

| Surface | Defined in | Mounted at | Endpoints |
|---|---|---|---|
| Admin router | `backend/src/routes/admin/index.ts` (16 sub-routers) | `/api/admin/*` | 34 |
| Ops router | `backend/src/routes/policy.routes.ts` (lines 300–516) | `/api/admin/ops/*` | 16 |
| Queue probe | `backend/src/routes/health.routes.ts` | `/health/queues` (outside `/api`) | 1 |

The ops router was missed on the first pass because it is not under `routes/admin/`,
and `routes/index.ts` mounts it indirectly (`router.use(policyRouter)`, which mounts
`/admin/ops` internally) rather than as a visible `/admin` prefix. All 17 endpoints
it adds are now covered.

---

## 1. What was built

A sidebar operations console over **both** admin surfaces.

| Piece | Detail |
|---|---|
| Shell | `AdminShell` — sidebar + drawer, permission-filtered nav, session gate, toast host |
| Screens | **24 routes** across 7 nav groups |
| New backend route | `GET /api/admin/session` — the acting admin's role + permission keys |
| API coverage | **67 client calls** over 18 routers/files |
| New code | 37 files in `frontend/src/admin/` (9,572 lines) + 1 backend route + 322 lines of tests |

### Why the one backend addition was necessary

Every admin route is gated by `requirePermission`, which reads the
`AdminUser.permissions` JSON array — but nothing told the client what that array
contained. `GET /api/me` reports `isAdmin` / `adminRole` only. Without the new
endpoint the panel would have to guess a role → permission mapping, and that guess
is wrong for every account whose permission array has been tuned by hand. The new
route reads the same row `requireAdmin` reads, so the panel hides exactly what
would 403. It is mounted with `requireAdmin` alone, because an admin with an empty
permission list must still be able to ask what it has — otherwise the only possible
UI is a blank 403.

---

## 2. Verification (all run locally, all green)

| Check | Result |
|---|---|
| Frontend typecheck (`tsc --noEmit`) | **clean** |
| Backend typecheck (`tsc --noEmit`) | **clean** |
| Backend lint (`eslint src`) | **clean** |
| Backend build (`tsc`) | **clean**, `dist/routes/admin/session.routes.js` emitted |
| Frontend build (`vite build`) | **1079 modules, 6.25s** |
| Frontend tests (`vitest run`) | **37/37 pass** (25 pre-existing + 12 new) |
| Backend unit tests | **7/7 pass** |

### Code-splitting verified

```
dist/assets/index-Ba2vLIB0.js   153.34 kB │ gzip:  38.49 kB   <- admin panel
dist/assets/index-xvUhn2jk.js   972.61 kB │ gzip: 281.50 kB   <- Mini App (unchanged)
```

All 24 lazy imports resolve through the single `frontend/src/admin/index.ts` barrel,
so the bundler emits one extra chunk rather than 24. The Mini App's initial bundle
does not grow, and a non-staff user never downloads the panel.

### New tests — `frontend/src/test/AdminPanel.test.tsx` (12 tests)

Session gate (403 → "Admin access required", 401 → "Not signed in", empty
permission list → an explanation instead of an empty shell); permission-driven nav
(a `MODERATOR` with only `campaigns.view` sees Campaigns and no other entry);
super-admin-only screens; campaign action gating against the state machine; and the
ops role gate (a `MODERATOR` holding every relevant permission key still gets
disabled settlement buttons **with the reason on screen**, while a
`FINANCE_MANAGER` gets them enabled).

---

## 3. Screens

### 3a. `routes/admin/*` — the main router

| Route | Permission | What it does |
|---|---|---|
| `/admin` | `dashboard.view` | KPIs, queue health, 30-day revenue; tiles link to filtered lists |
| `/admin/campaigns` | `campaigns.view` | Approve / Reject / Pause / Resume / Cancel / Suspend |
| `/admin/channels` | `channels.view` | Approval + bot-rights gate; removed-post breakdown by error code |
| `/admin/users` | `users.view` | Debounced search (name / @username / Telegram id) |
| `/admin/users/:id` | `users.view` | Full dossier, balance adjustment, risk recalc |
| `/admin/delivery` | `delivery.view` | Queue health, per-job retry, **timeline**, recent events |
| `/admin/finance/deposits` | `deposits.view` | Verify & credit / reject, with proof link |
| `/admin/finance/withdrawals` | `withdrawals.view` | Approve / reject & refund / mark paid (`txRef` required) |
| `/admin/finance/ledger` | `deposits.view` | Append-only ledger, filterable by type and user |
| `/admin/crypto-addresses` | `settings.manage` | Per-network deposit addresses |
| `/admin/crypto-transfers` | `deposits.manage` | Detect → human credit step; manual recording; scan |
| `/admin/moderation` | `fraud.view` | Reports, ad-post takedown, fraud scan |
| `/admin/support` | `tickets.view` | Ticket queue, reply + status control |
| `/admin/analytics` | `dashboard.view` | Revenue per UTC day, 7–365d |
| `/admin/plans` | `settings.manage` | Price + every entitlement |
| `/admin/settings` | `settings.manage` | Runtime settings, grouped and searchable |
| `/admin/audit-logs` | `audit.view` | Admin action trail (skip/take paging) |
| `/admin/admins` | SUPER_ADMIN only | Grant / change role / deactivate admins |

### 3b. `routes/policy.routes.ts` — the ops router (added on the second pass)

| Route | Permission | What it does |
|---|---|---|
| `/admin/ops` | `dashboard.view` | Aggregate dashboard: queue depth, house fill, creative backlog, referral queue, 24h event counts, live BullMQ counts, CPC lookup, settlement sweeps |
| `/admin/ops/creative` | `campaigns.manage` | **Ad creative review** — approve/reject versions held at `PENDING_REVIEW` |
| `/admin/ops/house-ads` | `settings.manage` | House-ad creatives: list, create/edit, pause/activate |
| `/admin/ops/blocked-domains` | `settings.manage` | Blocked destination domains: list, add, unblock |
| `/admin/ops/category-policies` | `settings.manage` | Per-category ALLOWED / REVIEW_REQUIRED / BLOCKED |

Action availability is derived from the backend's own guards, not from optimistic
guessing. `frontend/src/admin/lib/actions.ts` documents, per action, which service
function and which status list it was read from — so the panel never renders a
button whose only possible outcome is a 409/422.

---

## 4. API quirks found, and how the panel handles them

### Fixed by the second pass

1. **Ad creative review had no reachable UI.** `reviewCreativeVersion` and
   `pendingReviewVersions` existed and were routed — but on `/admin/ops/*`, so
   nothing surfaced them. A creative edited after approval is appended as a new
   version with `requiresReview = true` and the ad returns to `PENDING_REVIEW`;
   without a screen those versions could never be approved and the ad would sit
   frozen. Now `/admin/ops/creative`.
2. **House ads, blocked domains and category policies** were equally unreachable.
   Category policy is the difference between a campaign being refused and being
   queued for review, so leaving it database-only was a real operational gap.
3. **`/health/queues`** is the only view of BullMQ waiting/active/failed counts —
   the one place a stuck queue is visible. It is mounted outside `/api`, so it is
   easy to miss; the client calls `/health/queues` directly.

### Surfaced in the UI rather than hidden

1. **No admin read for a ticket's message thread.** The only route returning ticket
   messages is `GET /api/support/tickets/:id`, which is ownership-scoped to the
   ticket's own user — an admin gets a 404. The support panel shows the list-row
   fields, posts replies against the ticket id, and states the missing thread read.
2. **A report row carries no ad-post reference.** `GET /admin/moderation/reports`
   returns the report only, so the reported post cannot be removed from the row. The
   takedown control takes an explicit `adPostId`.
3. **Array-valued settings cannot be written.** `updateSettingSchema` accepts a
   string, number, boolean or flat object — not an array. `allowed_withdrawal_methods`,
   `allowed_deposit_methods` and `budget_alert_thresholds` render read-only with the
   reason (an object with numeric keys would corrupt the reader).
4. **No endpoint writes `AdminUser.permissions`.** `POST/PATCH /admin/admin-users`
   accept only `telegramId`, `role`, `isActive`. A non-SUPER_ADMIN grant therefore
   starts with an empty permission array, which `requirePermission` reads as
   "denied". The create dialog states this consequence.
5. **`broadcast.send` is declared but unused.** No route in either admin router reads
   it; the only broadcast machinery is the `broadcast-admin-alert` queue job, which
   has no HTTP entry point — and nothing enqueues it. No screen was invented.
6. **`GET /admin/settings` returns merged values only.** It cannot report which keys
   have a database override, so the settings screen cannot distinguish "default" from
   "overridden".
7. **Delivery retry can fail with a generic 500.** `retryDeliveryJob` refuses a job
   whose slot escrow was already released and throws a plain `Error`, which the error
   handler surfaces as an internal error. Retry is offered only for `FAILED` /
   `RETRYING` / `LOCKED` / `PROCESSING` — never `PENDING`/`SCHEDULED`, which would
   enqueue a second worker job — and the dialog says so.
8. **House-ad `links` resets when omitted.** `upsertHouseAd` defaults an absent
   `links` to `[]`, and the zod body accepts it as optional. So an edit that omitted
   the field would silently wipe an ad's links. The editor always sends the parsed
   list back, prefilled, and refuses a malformed entry.
9. **`/admin/ops/*` does not use `jsonSafe`.** It calls `res.json` directly, unlike
   `routes/admin/common.ts`. No function on that surface projects a BigInt column, so
   nothing breaks today — but a future BigInt field there would throw on serialise.
   Noted in `admin/lib/types.ts`.

---

## 5. Files changed

**Modified (4)**

```
backend/src/routes/admin/index.ts      +6    mount the session router
frontend/src/lib/queryClient.ts       +26    admin + ops query keys
frontend/src/pages/Settings.tsx       +29/-6 "Staff" section linking to /admin (isAdmin only)
frontend/src/router.tsx              +131/-3 lazy /admin route tree, 24 children
```

**New (4 paths)**

```
backend/src/routes/admin/session.routes.ts     the acting admin's role + permission keys
frontend/src/admin/                            37 files — shell, lib, components, 24 pages
frontend/src/test/AdminPanel.test.tsx          12 tests
ADMIN-PANEL-REPORT.md                          this report
```

`frontend/dist/`, `backend/dist/` and `node_modules/` are gitignored, so build
artifacts are not part of the change set.

---

## 6. Local environment note

Dependencies were carried over from the previous clone rather than installed, so
`npm`'s workspace symlink for `@botflow/shared` was missing and the backend could not
resolve it. It has been recreated (`node_modules/@botflow/shared -> ../../shared`),
which is exactly what `npm install` produces. On a clean machine use:

```bash
npm ci --include=dev
npm run db:generate
npm run build -w @botflow/shared    # required before the backend typechecks
npm run dev:backend                 # API
npm run dev:frontend                # Mini App + /admin
```

Then open `/admin` **from inside Telegram** (the session rides `initData`; a plain
browser has no signed session and will correctly show "Not signed in"). The link also
appears in Settings → Staff for any account the API reports as admin.

---

## 7. Suggested next steps (not done)

- **Grant permissions.** The panel renders an explained empty state until an admin
  row has at least `dashboard.view`. Fixing this properly means adding a `permissions`
  field to `PATCH /admin/admin-users/:id` — the one API change that would make role
  management usable end to end.
- **Array settings.** Either extend `updateSettingSchema` to accept arrays or add a
  dedicated endpoint, so the three list-valued settings become editable.
- **Ticket thread for staff.** An admin-scoped `GET /admin/support/tickets/:id`
  returning messages would replace the reply-only panel with a real thread.
- **A broadcast producer.** `broadcast.send` and the `broadcast-admin-alert` worker
  both exist with no way to enqueue a job; a route plus a screen would close that loop.
