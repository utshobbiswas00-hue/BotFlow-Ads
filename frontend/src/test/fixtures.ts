/**
 * Fixtures for frontend tests. Shapes mirror the backend contract 1:1
 * (shared DTOs + frontend/src/lib/contracts.ts). Never hit the network —
 * the api wrapper is always mocked.
 */
import type { BlocklistResponse, ChannelDetail } from '../lib/contracts';

export const CHANNEL_ID = 'ch-1';

export function makeChannel(overrides: Partial<ChannelDetail> = {}): ChannelDetail {
  return {
    id: CHANNEL_ID,
    telegramChannelId: '-1001234567890',
    username: 'demo_channel',
    title: 'Demo Channel',
    photoUrl: null,
    category: 'NEWS',
    language: 'en',
    country: 'US',
    subscriberCount: 12500,
    avgViews: 830,
    status: 'APPROVED',
    canPostMessages: true,
    botIsAdmin: true,
    pricingModel: 'FIXED',
    adPriceCents: 500,
    totalAdsPublished: 7,
    totalEarnedCents: 3500,
    stats: [
      { date: '2026-09-24', subscribers: 12400, avgViews: 810 },
      { date: '2026-09-25', subscribers: 12500, avgViews: 830 },
    ],
    adPosts: [],
    autoApprovePosts: false,
    maxPostsPerDay: 1,
    minHoursBetweenAds: 24,
    verificationStatus: 'VERIFIED',
    acceptAds: true,
    minAdPriceCents: 250,
    ...overrides,
  };
}

export function makeBlocklist(overrides: Partial<BlocklistResponse> = {}): BlocklistResponse {
  return {
    entries: [
      {
        id: 'b-1',
        channelId: CHANNEL_ID,
        scope: 'ADVERTISER',
        value: 'spam-advertiser',
        label: 'Repeat offender',
        createdAt: '2026-09-21T10:00:00.000Z',
      },
      {
        id: 'b-2',
        channelId: CHANNEL_ID,
        scope: 'DOMAIN',
        value: 'badsite.example.com',
        label: null,
        createdAt: '2026-09-20T10:00:00.000Z',
      },
    ],
    summary: { ADVERTISER: 1, CAMPAIGN: 0, CATEGORY: 0, DOMAIN: 1 },
    ...overrides,
  };
}
