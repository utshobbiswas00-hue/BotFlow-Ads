# BotFlow Ads Admin Panel — Specification vs Codebase Gap Analysis

Input: the 88-section "Complete A to Z Specification".
Method: every claim in the spec was checked against the repository. Nothing below is
from memory — each row cites the file or query that produced it.
Base commit: `3449716` · Panel already built: see `ADMIN-PANEL-REPORT.md`

Legend
- **✅ BUILT** — exists and is reachable in the panel today
- **◐ PARTIAL** — the data or the mechanism exists, but not the endpoint/screen
- **✗ NEW WORK** — needs new backend code (and often a migration)
- **⚠ DECISION** — the spec contradicts the codebase; someone has to choose

---

## 1. Headline numbers

| | Count |
|---|---|
| Prisma models | **41** |
| Enums | **38** |
| Admin endpoints reachable today | **58** (41 in `routes/admin/` + 16 in `/api/admin/ops` + 1 `/health/queues`) |
| Endpoints the spec's §68 example list names | 36 |
| Screens in the panel today | 24 |
| Spec tables named that have no model | **3** — `refunds`, `roles`/`permissions` |

The API is **richer than the spec's own example list**: §68 asks for 36 endpoints and
58 already exist. The gaps are almost entirely in *auth*, *user moderation*, *admin
notifications*, *exports*, *sub-section navigation* and *list ergonomics* — not in the
core ad/finance machinery, which is already deep (escrow, CPM/CPC settlement,
blocklists, category policy, webhooks, invoices, crypto scanning).

---

## 2. Data model — spec §66

34 of the 37 named tables exist under a PascalCase name:

`User · Wallet · Transaction · Deposit · Withdrawal · PublisherEarning · Referral ·
Channel · ChannelStat · Campaign · Ad · AdPost · DeliveryJob · Click · Impression ·
ConversionEvent · SupportTicket · TicketMessage · Report · FraudEvent · AuditLog ·
Notification · Setting · BlockedDomain · AdCreativeVersion · DeliveryEvent ·
PublisherBlocklist · CategoryPolicyRule · SubscriptionPlan · Subscription · HouseAd ·
Invoice · LoginEvent · AdminUser`

Plus models the spec does not mention: `CryptoDepositAddress`, `CryptoChainTransfer`,
`AdvertiserApiKey`, `WebhookEndpoint`, `WebhookDelivery`, `ChannelDeliveryLog`.

| Spec table | Reality |
|---|---|
| `refunds` | **No table.** Refunds are `Transaction` rows of type `REFUND` (enum `TransactionType.REFUND` exists). This is arguably better — a refund is a ledger entry, not a separate entity. |
| `roles`, `permissions` | **No tables.** RBAC is `AdminRole` enum + `AdminUser.permissions` JSON array + a hardcoded `ADMIN_PERMISSIONS` const in `middleware/adminAuth.ts`. |
| `blocked_ads` | **No table.** Ad suppression today is `AdPostStatus` + moderation REMOVE (`POST /admin/moderation/ads/action`). |
| `blocked_channels` | **Correction to the first version of this document.** `PublisherBlocklist` is *not* scoped GLOBAL/USER/CHANNEL and has **no `reason` column**. It is a per-**channel** list whose `BlocklistScope` enum is `ADVERTISER | CAMPAIGN | CATEGORY | DOMAIN`, keyed on `(channelId, scope, value)`, and its free-text column is **`label`**. The admin routes built against it (`/api/admin/blocked/*`) map `label` ↔ `reason` on the wire. |
| `impressions` | `Impression` exists and is **really written** by `services/cpmPayout.service.ts`. So §44's rule ("never show a metric as real impressions when the API cannot provide it") is satisfiable: impressions here mean CPM-measured views, not an invented number. |

---

## 3. ⚠ The one real conflict: §4 / §70 admin login

The spec asks for **Email / Username + Password + 2FA + sessions + CSRF + device
logging**.

The codebase has **no password anywhere**:

```
grep -riE "bcrypt|argon2|totp|speakeasy|password" backend/src   → no matches
grep -riE "password|totp|2fa" backend/prisma/schema.prisma      → no matches
```

Authentication today is **Telegram initData only** (`middleware/telegramAuth.ts`):
the Mini App receives a signed payload from Telegram, the server verifies the HMAC
against the bot token, and that is the session. There is no credential to phish or
leak, no password database to breach, and no session cookie to hijack. `LoginEvent`
exists and is written by `alert.service.ts`, so device/IP sign-in logging already
works.

This is a genuine fork, and it changes every downstream screen:

| Option | What it means |
|---|---|
| **A — keep Telegram-only** (current) | §4 is marked N/A. Everything in Phases 1–10 below proceeds as-is. Nothing to build. |
| **B — add password + 2FA as a second door** | New: `AdminCredential` model (hashed), TOTP enrolment + backup codes, session store, lockout, CSRF token for cookie-based requests. Telegram stays. ~1 new subsystem, new deps (`argon2`/`bcrypt`, `otplib` or `speakeasy`, `express-session`/`cookie`). Two doors into the same privileges = two attack surfaces, so it needs to be done properly or not at all. |
| **C — replace Telegram auth with password auth** | **Not recommended.** It removes a stronger, phishing-resistant factor and replaces it with the weakest one, and it breaks the Mini App, which has no way to hold a password session. |

I did not build any of the three. This is the first decision below.

---

## 4. What already satisfies the spec (✅)

| Spec | Coverage |
|---|---|
| §5, §6 Dashboard cards | `/admin` + `/admin/ops` cover users, advertisers, publishers, channels, campaigns, revenue, pending deposits/withdrawals/campaigns, failed deliveries, fraud alerts. |
| §7 Charts | Revenue per day (7/30/90/365) at `/admin/analytics`. Missing: campaign-status, delivery and user-growth charts — see §6 below. |
| §9, §10 User list & details | `/admin/users` + `/admin/users/:id` with profile, wallet, transactions, channels, campaigns, deposits, withdrawals, earnings. Balance adjustment is audited and ledger-backed. |
| §13–16 Channels | `/admin/channels`: owner, subscribers, avg views, category, price, status, bot rights, published count, earnings, rejection reason, removed-post breakdown. Approve/Reject/Suspend/Reactivate with mandatory reason. |
| §17 Channel pricing | `Channel.adPriceCents`, `paidAdSharePercent`, `minAdPriceCents`, plus `SubscriptionPlan` entitlements. Readable in the panel; price *editing* is not exposed to admins (publishers own it). |
| §18–20 Campaigns | `/admin/campaigns` with approve/reject/pause/resume/cancel/suspend, gated per state, reason required where the API requires it. |
| §21 Ad review | `/admin/ops/creative` — rendered preview, approve/reject versions held at `PENDING_REVIEW`. **This was unreachable before this build.** |
| §22 URL security | `services/urlSecurity.service.ts` + `BlockedDomain` + `/admin/ops/blocked-domains`. |
| §23–25 Delivery | `/admin/delivery`: statuses, attempts, error code+message, retry (with the escrow caveat stated), per-job **timeline**, recent events. |
| §26 Scheduled posts | Delivery list filtered by `SCHEDULED`, plus ops event feed. |
| §29–31 Finance | Deposits (verify/reject), withdrawals (approve/reject/mark-paid), transactions ledger with `balanceAfter`. |
| §32 Wallet | Wallet balances in the user dossier; manual adjustment with mandatory reason + audit. |
| §33 Transaction types | All 10 spec types exist as `TransactionType` values. |
| §34 Idempotency | Deposit verification is idempotent on `deposit:<id>`; crypto transfers keyed on tx hash; withdrawal refunds keyed on `withdrawal:refund:<id>`. |
| §35 Reserved balance | `budgetReservedCents` + `services/escrow.service.ts` (`hold`/`release` references). |
| §36 Publisher earnings | `PublisherEarning` with gross / net / platform-fee split; created by `escrow`, `cpmPayout`, `cpcBilling` services after delivery — not at campaign creation. |
| §37 Revenue | `/admin/analytics` (fee booked on published posts) + `/admin/ops` (gross/pending/billed). |
| §39–42 Analytics | Network/revenue figures in `/admin/ops` and `/admin/analytics`; per-campaign, per-channel and per-user breakdowns appear inside the dossiers. Standalone analytics sub-screens are not built. |
| §43 Click tracking | `Click` model + `track.routes.ts` + CPC billing on valid clicks only. |
| §45 Fraud detection | `FraudEvent`, `/admin/moderation` scan, per-user risk recalc, `/admin/users/:id`. |
| §46 Reports | `/admin/moderation` with resolve/dismiss + action taken. |
| §49 Blocked domains | `/admin/ops/blocked-domains` (list/add/unblock, hard-block vs flag). |
| §50 Support tickets | `/admin/support` with reply + status control. |
| §51 Referrals | `/admin/ops` referral queue + `POST /admin/ops/referrals/settle`. |
| §53–60 Settings | `/admin/settings` (grouped, searchable, type-aware) — one screen, not the spec's 10 sub-pages. |
| §61 Admin roles | All 6 spec roles exist as `AdminRole` enum values. |
| §63 Audit log | `/admin/audit-logs` with before/after JSON, actor, IP, user agent. `recordAudit` is called from **21 files** including `deposit.service.ts`, `withdrawal.service.ts`, `admin.service.ts`, `moderation.service.ts`. |
| §67 Backend services | 20+ service modules exist covering every spec §67 bullet. |
| §69 Business rules | Verified: R1 (`delivery.service.ts:205` campaign must be APPROVED/SCHEDULED/RUNNING), R3 (`:224` `botIsAdmin && canPostMessages`), R10 (`:221` `CHANNEL_SUSPENDED`), R11 (rejected campaigns not delivered), R12/R14 (`blocklist.service.ts`, `blockedChannelIdsForCampaign`), R4 (`escrow.service.ts`), R5 (`deposit:<id>` idempotency), R6 (earnings created by settlement services), R8 (`recordAudit` on financial paths). |
| §73 Retry system | `retryDeliveryJob` + retry from the delivery screen. Max attempts configurable via settings. |
| §74 Channel health | `ChannelHealthStatus` + `POST /admin/ops/health/refresh-all` + `ATTENTION_REQUIRED` status. |
| §76 Revenue model | Commission + markup + platform fee all configurable in settings. |
| §77 Priority levels | `TicketPriority` and `FraudSeverity` enums exist. |
| §79 Pagination | Every list endpoint paginates with `{items,page,limit,total,hasMore}`; the panel pages them. |
| §80 Responsive | Sidebar collapses to a drawer; tables scroll horizontally with columns dropping by breakpoint. |
| §81 UI basics | Sidebar, topbar, stat cards, tables, filters, charts, modals, confirm dialogs, toasts. Missing: **breadcrumbs**, **global search**, **notification bell**. |
| §82 Action confirmation | One shared `ConfirmDialog` collects mandatory reasons and refuses to submit what the API would reject. |
| §83 System status | Partially: `/health` and `/health/queues` are shown in `/admin/ops`. No DB/bot/worker/payment status board. |

---

## 5. ✗ Gaps needing new backend code

Ordered by value, not by the spec's numbering.

| # | Spec | Gap | Work needed |
|---|---|---|---|
| 1 | §9, §10, §45 | **Suspend / Unsuspend / Ban / Unban / Restrict a user.** `UserStatus` already has `SUSPENDED` and `BANNED`, and `User.suspendedReason` exists — but **no endpoint sets them anywhere** (`grep` across `routes/` returns nothing). So today an admin literally cannot suspend a user, which is the single most expected moderation action. | New service fn + 2–4 endpoints + audit + UI actions + tests |
| 2 | §61, §62 | **No endpoint writes `AdminUser.permissions`.** `POST/PATCH /admin/admin-users` accept only `telegramId`, `role`, `isActive`. A non-SUPER_ADMIN grant is therefore unusable — it starts with an empty array, which `requirePermission` reads as "denied". | 1 field added to the existing PATCH + UI |
| 3 | §52 | **Admin notification centre.** `notification.routes.ts` is user-scoped only (`GET /notifications`, `/read-all`, `/unread-count`). No admin feed, no bell. | New admin-scoped list + read state + UI |
| 4 | §78 | **Export.** CSV exists **only** for user-scoped billing statements (`/api/billing/statement?format=csv`). No admin export of users/channels/campaigns/transactions/deposits/withdrawals/earnings/revenue. | Per-table CSV endpoint (Excel/PDF would add deps) + UI |
| 5 | §46, §47, §48 | **Blocked ads / blocked channels lists.** `PublisherBlocklist` exists with no admin endpoint; there is no "blocked ads" entity. | New endpoints + UI, or reuse the blocklist model |
| 6 | §27, §28, §83, §84 | **Bot / webhook / worker / error-log monitoring.** `/health` + `/health/queues` exist; there is no bot-status, webhook-status, API-log or error-log endpoint. | Status aggregation endpoint + error-log model or log query |
| 7 | §64 | **Global search** across users/channels/campaigns/ads/transactions/tickets. | New endpoint + UI |
| 8 | §12 | **Advertiser management.** No advertiser-scoped list endpoint (the Users list has no role filter param). | 2 filter params on the users list, or a new endpoint |
| 9 | §7 | **Campaign-status / delivery / user-growth charts.** No aggregate endpoint; revenue only. | 1 aggregate endpoint |
| 10 | §79 | **Sorting + date-range filters** on big tables. Most list endpoints accept status/page/limit only. | Date-range + sort params per list |
| 11 | §38 | **Admin refund action.** Refunds exist as ledger entries created by cancel flows; no admin-initiated refund control. | New endpoint + UI |
| 12 | §65 | **Activity monitor feed.** Partly served by `/admin/ops/delivery/events/recent` + the audit log; no unified "recent activity" stream. | Could be composed from two existing endpoints |

---

## 6. ◐ Gaps that are frontend-only (buildable now, no backend change)

| Spec | Gap | Note |
|---|---|---|
| §8 | Sidebar **sub-menus**. The spec lists `Users → All / Advertisers / Publishers / Suspended / Banned` as separate nav entries. Today the filters live inside each screen. | Adding sub-items that link to filtered URLs is pure frontend. Careful: `/admin/users?status=SUSPENDED` needs a backend `status` filter to be truthful (see gap #1/#8). |
| §30, §31 | Deposit / withdrawal **sub-sections** by status. | Same pattern as above; status filters already exist for these two. |
| §53–60 | Settings split into 10 named sub-pages (General / Advertising / Publisher / Advertiser / Payments / Withdrawals / Referrals / Notifications / Telegram / Maintenance). | Pure frontend regrouping of the existing key-level editor. Note: **bot token must never reach the browser** — §59 is already respected (token is server-side only); those fields would render as presence indicators, not inputs. |
| §11, §12 | Publisher / advertiser dossier screens. | Today these are tabs inside one user dossier; separate screens are a frontend re-cut of the same data. |
| §39–42 | Standalone analytics sub-screens. | Same data as the dossiers, different framing. |
| §8 | `Telegram → Bot Status / Webhook / API Logs` nav. | Needs gap #6 first. |
| §81 | Breadcrumbs, global-search box, notification bell, system-status widget. | Breadcrumbs are pure frontend; the search box and bell need gaps #7 and #3. |

---

## 7. Where the spec and the code disagree on names — ⚠ second decision

§62 lists permission keys such as `users.suspend`, `users.ban`, `ads.approve`,
`ads.reject`, `deposits.approve`, `withdrawals.mark_paid`, `wallets.adjust`,
`reports.resolve`, `audit_logs.view`.

The code implements **22 different keys** (`users.manage`, `campaigns.manage`,
`deposits.manage`, `withdrawals.manage`, `fraud.manage`, `audit.view`, …) as a
hardcoded const, and **every route guard references them**. Renaming to the spec's
names is a breaking change across ~40 guards plus any live admin row's permission
array. Options: adopt the spec names (rename + migrate), or keep the implemented keys
and present the spec names as display labels. I did not change either.

---

## 8. Proposed order of work

The spec's §87 priority list is followed, with the already-built parts removed.

| Phase | Spec | Status | Remaining |
|---|---|---|---|
| 1 | Auth, dashboard, roles & permissions | ◐ | Dashboard ✅ · roles ✅ · **permissions writable (gap 2)** · auth = decision |
| 2 | Users, publishers, advertisers, channels | ◐ | Channels ✅ · users ✅ · **suspend/ban (gap 1)** · advertiser/publisher lists (gap 8) |
| 3 | Campaigns, ads, review, moderation | ✅ | built |
| 4 | Delivery, bot, scheduled, retry | ◐ | delivery ✅ · **bot/webhook status (gap 6)** |
| 5 | Wallet, deposits, withdrawals, transactions, earnings, revenue | ✅ | built (refund control = gap 11) |
| 6 | Analytics & tracking | ◐ | revenue ✅ · **aggregate charts (gap 9)** · sorting/date-range (gap 10) |
| 7 | Fraud, reports, blocked domains/channels | ◐ | fraud/reports/domains ✅ · **blocked ads/channels (gap 5)** |
| 8 | Support, referrals, notifications | ◐ | support ✅ · referrals ✅ · **admin notifications (gap 3)** |
| 9 | Settings, Telegram, payments, maintenance | ◐ | settings editor ✅ · **sub-pages (§6)** · telegram config (gap 6) |
| 10 | Audit, security, performance, error monitoring | ◐ | audit ✅ · **error monitoring (gap 6)** · exports (gap 4) |

---

## 9. Security posture — spec §70, verified

| Requirement | State |
|---|---|
| HTTPS | Deployment concern (Render/Railway terminates TLS). |
| Secure authentication | ✅ Telegram initData HMAC verification. Password path: decision. |
| Password hashing | N/A today (no passwords). |
| 2FA | **Not present.** Decision. |
| RBAC | ✅ `AdminRole` + `requireRole`. |
| Permission-based authorization | ✅ `requirePermission` on every admin route. |
| Rate limiting | ✅ `limiters.admin` and per-route limiters. |
| CSRF | N/A today (no cookies; auth rides a header). Would become required under auth option B/C. |
| Input validation | ✅ zod `validate` middleware on bodies/queries. |
| API authentication | ✅ `telegramAuth` on the whole `/api` router. |
| Webhook verification | ✅ `webhook.routes.ts` + `WebhookDelivery` model + signature handling in `webhook.service.ts`. |
| Audit logs | ✅ 21 files call `recordAudit`, including all financial services. |
| Sensitive secrets | ✅ Bot token is server-side only; the panel renders configuration presence, never the value. |
| Server-side env vars | ✅ `config/env.ts`. |

---

## 10. Checked and deliberately NOT built

- **Fake impressions.** §44 forbids it and the codebase agrees: `Impression` rows are written only by the CPM payout path. Nothing in the panel invents a view count; where Telegram gives no reliable number, the panel shows `—`.
- **A broadcast screen.** The `broadcast.send` permission and the
  `broadcast-admin-alert` worker exist, but nothing enqueues that job and no route
  reads the permission. A screen would have had nothing to call.
- **An admin ticket thread.** The only route returning ticket messages is
  ownership-scoped to the ticket's own user; an admin gets a 404. The panel says so
  instead of showing an empty thread.
- **Array-valued settings editing.** `updateSettingSchema` rejects arrays, so
  `allowed_withdrawal_methods`, `allowed_deposit_methods` and
  `budget_alert_thresholds` are read-only with the reason shown.

---

## 11. Files produced by this analysis

```
ADMIN-PANEL-SPEC-GAP-ANALYSIS.md   this document
ADMIN-PANEL-REPORT.md              what the panel does today, and how it was verified
```

Nothing has been committed or pushed. `HEAD` is still `3449716` = `origin/main`.
