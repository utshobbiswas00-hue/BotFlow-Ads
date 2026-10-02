/**
 * Admin panel barrel — the single module specifier the router lazy-loads from.
 *
 * Why one barrel: `router.tsx` imports each screen through
 * `lazy(() => import('./admin').then(m => ({ default: m.X })))`. Because every
 * one of those dynamic imports names the SAME module, the bundler emits a single
 * extra chunk for the whole panel instead of one chunk per screen — so the Mini
 * App's initial bundle is untouched, and the panel arrives in one request the
 * first time someone opens `/admin`.
 */
export { AdminShell } from './components/AdminShell';
export { AdminLoginPage } from './pages/Login';
export { AdminOverviewPage } from './pages/Overview';
export { AdminCampaignsPage } from './pages/Campaigns';
export { AdminChannelsPage } from './pages/Channels';
export { AdminUsersPage } from './pages/Users';
export { AdminUserDetailPage } from './pages/UserDetail';
export { AdminDeliveryPage } from './pages/Delivery';
export { AdminDepositsPage } from './pages/Deposits';
export { AdminWithdrawalsPage } from './pages/Withdrawals';
export { AdminLedgerPage } from './pages/Ledger';
export { AdminAnalyticsPage } from './pages/Analytics';
export { AdminModerationPage } from './pages/Moderation';
export { AdminSupportPage } from './pages/Support';
export { AdminSettingsPage } from './pages/Settings';
export { SettingsSectionPage as AdminSettingsSectionPage } from './pages/settings/SettingsSectionPage';
export { AdminAuditLogsPage } from './pages/AuditLogs';
export { AdminPlansPage } from './pages/Plans';
export { AdminCryptoAddressesPage } from './pages/CryptoAddresses';
export { AdminCryptoTransfersPage } from './pages/CryptoTransfers';
export { AdminAdminsPage } from './pages/Admins';
export { AdminNotFoundPage } from './pages/NotFound';
// The /api/admin/ops surface (routes/policy.routes.ts).
export { AdminOpsPage } from './pages/Ops';
export { AdminCreativeReviewPage } from './pages/CreativeReview';
export { AdminHouseAdsPage } from './pages/HouseAds';
export { AdminBlockedDomainsPage } from './pages/BlockedDomains';
export { AdminCategoryPoliciesPage } from './pages/CategoryPolicies';
// Round 3: aggregates, subsystem health, the computed attention feed, and the
// blocked-entity lists.
export { AnalyticsBreakdownPage as AdminAnalyticsBreakdownPage } from './pages/AnalyticsBreakdown';
export { SystemStatusPage as AdminSystemStatusPage } from './pages/SystemStatus';
export { AttentionPage as AdminAttentionPage } from './pages/Attention';
export { BlockedChannelsPage as AdminBlockedChannelsPage } from './pages/BlockedChannels';
export { BlockedAdsPage as AdminBlockedAdsPage } from './pages/BlockedAds';
// Round 4: role-scoped lists, refunds and broadcast.
export { PublishersPage as AdminPublishersPage } from './pages/Publishers';
export { AdvertisersPage as AdminAdvertisersPage } from './pages/Advertisers';
export { RefundsPage as AdminRefundsPage } from './pages/Refunds';
export { BroadcastPage as AdminBroadcastPage } from './pages/Broadcast';
// Round 5: the admin's own notification inbox, and the per-recipient broadcast
// delivery report.
export { NotificationsPage as AdminNotificationsPage } from './pages/Notifications';
export { BroadcastReportPage as AdminBroadcastReportPage } from './pages/BroadcastReport';
// Round 6: the last of the spec gaps - activity stream, per-entity analytics,
// error log, API logs, exports.
export { ActivityPage as AdminActivityPage } from './pages/Activity';
export { CampaignAnalyticsPage as AdminCampaignAnalyticsPage } from './pages/CampaignAnalytics';
export { ChannelAnalyticsPage as AdminChannelAnalyticsPage } from './pages/ChannelAnalytics';
export { ErrorsPage as AdminErrorsPage } from './pages/Errors';
export { ApiLogsPage as AdminApiLogsPage } from './pages/ApiLogs';
export { ExportPage as AdminExportPage } from './pages/Export';

