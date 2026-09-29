import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';

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
 * User-facing routes only.
 *
 * The following transition names intentionally no longer exist, because this build does not bundle the staff dashboard. Every link that would use one of these names must point at a route that exists here instead.
 */

export const router = createBrowserRouter([
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
