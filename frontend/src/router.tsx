import { Suspense, lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Skeleton } from './components/ui/Skeleton';

/* User pages — BotFlow Ads Mini App */
import { DashboardPage } from './pages/Dashboard';
import { AdvertisePage } from './pages/Advertise';
import { CreateCampaignPage } from './pages/CreateCampaign';
import { CampaignListPage } from './pages/CampaignList';
import { CampaignDetailPage } from './pages/CampaignDetail';
import { EarnFromAdsPage } from './pages/EarnFromAds';
import { MyChannelsPage } from './pages/MyChannels';
import { AddChannelPage } from './pages/AddChannel';
import { ChannelDetailPage } from './pages/ChannelDetail';
import { ChannelRequestsPage } from './pages/ChannelRequests';
import { MarketplacePage } from './pages/Marketplace';
import { AnalyticsPage } from './pages/Analytics';
import { WalletPage } from './pages/Wallet';
import { DepositPage } from './pages/Deposit';
import { WithdrawPage } from './pages/Withdraw';
import { TransactionsPage } from './pages/Transactions';
import { BillingPage } from './pages/billing/BillingPage';
import { InvoiceDetailPage } from './pages/billing/InvoiceDetailPage';
import { ReferralsPage } from './pages/Referrals';
import { BenefitsPage } from './pages/Benefits';
import { PremiumPage } from './pages/Premium';
import { SupportPage } from './pages/Support';
import { TicketDetailPage } from './pages/TicketDetail';
import { SettingsPage } from './pages/Settings';
import { NotFoundPage } from './pages/NotFound';
import { NotificationsPage } from './pages/Notifications';
import { TermsPage } from './pages/legal/TermsPage';
import { PrivacyPage } from './pages/legal/PrivacyPage';
import { RefundPolicyPage } from './pages/legal/RefundPolicyPage';
import { PublisherAgreementPage } from './pages/legal/PublisherAgreementPage';
import { AdvertiserPolicyPage } from './pages/legal/AdvertiserPolicyPage';
import { ProhibitedContentPage } from './pages/legal/ProhibitedContentPage';

/**
 * Routes.
 *
 * Two trees live here:
 *  - the Mini App under `/` (the `AppShell` column layout), and
 *  - the staff admin panel under `/admin` (a sidebar layout, its own chunk).
 *
 * The admin pages are lazy and all resolve through the single `./admin` barrel,
 * so the panel is one extra chunk fetched on first open — the Mini App's initial
 * bundle does not grow, and nobody who is not staff ever downloads it.
 *
 * Every admin request is authorised on the server by `telegramAuth` +
 * `requireAdmin` + `requirePermission`. The route guard below only decides what to
 * RENDER; the API is the boundary. Names for the panel are intentionally not
 * aliased onto user routes.
 */

const AdminShell = lazy(() => import('./admin').then((m) => ({ default: m.AdminShell })));
const AdminLoginPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminLoginPage })));
const AdminOverviewPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminOverviewPage })));
const AdminCampaignsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCampaignsPage })),
);
const AdminChannelsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminChannelsPage })));
const AdminUsersPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminUsersPage })));
const AdminUserDetailPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminUserDetailPage })),
);
const AdminDeliveryPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminDeliveryPage })));
const AdminDepositsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminDepositsPage })));
const AdminWithdrawalsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminWithdrawalsPage })),
);
const AdminLedgerPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminLedgerPage })));
const AdminAnalyticsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminAnalyticsPage })));
const AdminModerationPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminModerationPage })),
);
const AdminSupportPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminSupportPage })));
const AdminSettingsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminSettingsPage })));
const AdminSettingsSectionPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminSettingsSectionPage })),
);
const AdminAuditLogsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminAuditLogsPage })),
);
const AdminPlansPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminPlansPage })));
const AdminCryptoAddressesPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCryptoAddressesPage })),
);
const AdminCryptoTransfersPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCryptoTransfersPage })),
);
const AdminAdminsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminAdminsPage })));
const AdminNotFoundPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminNotFoundPage })));
// Round 6: activity stream, per-entity analytics, error log, API logs, exports.
const AdminActivityPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminActivityPage })));
const AdminCampaignAnalyticsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCampaignAnalyticsPage })),
);
const AdminChannelAnalyticsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminChannelAnalyticsPage })),
);
const AdminErrorsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminErrorsPage })));
const AdminApiLogsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminApiLogsPage })));
const AdminExportPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminExportPage })));
// The /api/admin/ops surface — a separate router in routes/policy.routes.ts.
const AdminOpsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminOpsPage })));
const AdminCreativeReviewPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCreativeReviewPage })),
);
const AdminHouseAdsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminHouseAdsPage })),
);
const AdminBlockedDomainsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminBlockedDomainsPage })),
);
const AdminCategoryPoliciesPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminCategoryPoliciesPage })),
);
const AdminAnalyticsBreakdownPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminAnalyticsBreakdownPage })),
);
const AdminSystemStatusPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminSystemStatusPage })),
);
const AdminAttentionPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminAttentionPage })),
);
const AdminBlockedChannelsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminBlockedChannelsPage })),
);
const AdminBlockedAdsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminBlockedAdsPage })),
);
const AdminPublishersPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminPublishersPage })),
);
const AdminAdvertisersPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminAdvertisersPage })),
);
const AdminRefundsPage = lazy(() => import('./admin').then((m) => ({ default: m.AdminRefundsPage })));
const AdminNotificationsPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminNotificationsPage })),
);
const AdminBroadcastReportPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminBroadcastReportPage })),
);
const AdminBroadcastPage = lazy(() =>
  import('./admin').then((m) => ({ default: m.AdminBroadcastPage })),
);

/** Shown while the admin chunk loads — only ever seen once per session. */
function AdminChunkFallback() {
  return (
    <div className="min-h-dvh bg-app p-6">
      <div className="max-w-3xl mx-auto space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  /*
   * Panel sign-in lives OUTSIDE the `/admin` shell on purpose: the shell's whole
   * job is to reject an unauthenticated caller, so the one screen that exists to
   * fix that must not be behind it. It is still lazy (same chunk as the rest of
   * the panel).
   */
  {
    path: '/admin/login',
    element: (
      <Suspense fallback={<AdminChunkFallback />}>
        <AdminLoginPage />
      </Suspense>
    ),
  },
  {
    path: '/admin',
    element: (
      <Suspense fallback={<AdminChunkFallback />}>
        <AdminShell />
      </Suspense>
    ),
    children: [
      { index: true, element: <AdminOverviewPage /> },
      { path: 'campaigns', element: <AdminCampaignsPage /> },
      { path: 'channels', element: <AdminChannelsPage /> },
      { path: 'users', element: <AdminUsersPage /> },
      { path: 'users/:id', element: <AdminUserDetailPage /> },
      { path: 'delivery', element: <AdminDeliveryPage /> },
      { path: 'finance/deposits', element: <AdminDepositsPage /> },
      { path: 'finance/withdrawals', element: <AdminWithdrawalsPage /> },
      { path: 'finance/ledger', element: <AdminLedgerPage /> },
      { path: 'crypto-addresses', element: <AdminCryptoAddressesPage /> },
      { path: 'crypto-transfers', element: <AdminCryptoTransfersPage /> },
      { path: 'moderation', element: <AdminModerationPage /> },
      { path: 'support', element: <AdminSupportPage /> },
      { path: 'analytics', element: <AdminAnalyticsPage /> },
      { path: 'plans', element: <AdminPlansPage /> },
      { path: 'settings', element: <AdminSettingsPage /> },
      // Spec §53–60: the ten named settings sub-pages. `/admin/settings` stays
      // as the "everything, grouped and searchable" view.
      { path: 'settings/:section', element: <AdminSettingsSectionPage /> },
      { path: 'audit-logs', element: <AdminAuditLogsPage /> },
      { path: 'admins', element: <AdminAdminsPage /> },
      { path: 'ops', element: <AdminOpsPage /> },
      { path: 'ops/creative', element: <AdminCreativeReviewPage /> },
      { path: 'ops/house-ads', element: <AdminHouseAdsPage /> },
      { path: 'ops/blocked-domains', element: <AdminBlockedDomainsPage /> },
      { path: 'ops/category-policies', element: <AdminCategoryPoliciesPage /> },
      // Round 3 additions.
      { path: 'attention', element: <AdminAttentionPage /> },
      { path: 'system', element: <AdminSystemStatusPage /> },
      { path: 'analytics/breakdown', element: <AdminAnalyticsBreakdownPage /> },
      { path: 'blocked/channels', element: <AdminBlockedChannelsPage /> },
      { path: 'blocked/ads', element: <AdminBlockedAdsPage /> },
      // Round 4: role-scoped lists, refunds and broadcast.
      { path: 'publishers', element: <AdminPublishersPage /> },
      { path: 'advertisers', element: <AdminAdvertisersPage /> },
      { path: 'finance/refunds', element: <AdminRefundsPage /> },
      { path: 'broadcast', element: <AdminBroadcastPage /> },
      { path: 'broadcast/report', element: <AdminBroadcastReportPage /> },
      { path: 'notifications', element: <AdminNotificationsPage /> },
      // Round 6.
      { path: 'activity', element: <AdminActivityPage /> },
      { path: 'export', element: <AdminExportPage /> },
      { path: 'system/errors', element: <AdminErrorsPage /> },
      { path: 'system/api-logs', element: <AdminApiLogsPage /> },
      { path: 'campaigns/:campaignId/analytics', element: <AdminCampaignAnalyticsPage /> },
      { path: 'channels/:channelId/analytics', element: <AdminChannelAnalyticsPage /> },
      { path: '*', element: <AdminNotFoundPage /> },
    ],
  },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'advertise', element: <AdvertisePage /> },
      { path: 'advertise/new', element: <CreateCampaignPage /> },
      { path: 'campaigns', element: <CampaignListPage /> },
      { path: 'campaigns/:id', element: <CampaignDetailPage /> },
      { path: 'earn', element: <EarnFromAdsPage /> },
      { path: 'channels', element: <MyChannelsPage /> },
      { path: 'channels/new', element: <AddChannelPage /> },
      { path: 'channels/:id', element: <ChannelDetailPage /> },
      { path: 'channels/:id/requests', element: <ChannelRequestsPage /> },
      { path: 'marketplace', element: <MarketplacePage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'wallet', element: <WalletPage /> },
      { path: 'wallet/deposit', element: <DepositPage /> },
      { path: 'wallet/withdraw', element: <WithdrawPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      // Invoices and downloadable statements. The backend has served these all
      // along; there was simply no screen for them.
      { path: 'billing', element: <BillingPage /> },
      { path: 'billing/:id', element: <InvoiceDetailPage /> },
      { path: 'referrals', element: <ReferralsPage /> },
      { path: 'benefits', element: <BenefitsPage /> },
      { path: 'premium', element: <PremiumPage /> },
      { path: 'support', element: <SupportPage /> },
      { path: 'support/:id', element: <TicketDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'legal/terms', element: <TermsPage /> },
      { path: 'legal/privacy', element: <PrivacyPage /> },
      { path: 'legal/refund', element: <RefundPolicyPage /> },
      { path: 'legal/publisher-agreement', element: <PublisherAgreementPage /> },
      { path: 'legal/advertiser-policy', element: <AdvertiserPolicyPage /> },
      { path: 'legal/prohibited', element: <ProhibitedContentPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
