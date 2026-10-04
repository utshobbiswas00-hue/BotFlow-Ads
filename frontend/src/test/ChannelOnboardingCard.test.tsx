import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelOnboardingCard } from '../components/ChannelOnboardingCard';
import * as apiMod from '../lib/api';

function mockApi(responses: Record<string, unknown>): void {
  // Default the /api/app-config response to a stable bot username so the
  // NoAccess deep-link test has a target. Tests that want to verify the
  // missing-config path can override the key.
  const merged: Record<string, unknown> = {
    '/api/app-config': { botUsername: 'BotFlowBot' },
    ...responses,
  };
  // api is a const object with { get, post, ... }. vi.spyOn an object's method by
  // grabbing the live reference on import and replacing its impl.
  const liveApi = apiMod.api as unknown as {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body?: unknown) => Promise<unknown>;
  };
  vi.spyOn(liveApi, 'get').mockImplementation(async (path: string) => {
    const r = merged[path];
    if (!r) throw new Error(`unmocked GET ${path}`);
    return r;
  });
  vi.spyOn(liveApi, 'post').mockImplementation(async () => ({}));
}

function mount(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ChannelOnboardingCard channelId="ch1" />
    </QueryClientProvider>
  );
}

describe('ChannelOnboardingCard', () => {
  it('renders NO_ACCESS with the re-check button', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'NO_ACCESS',
        botHasAccess: false,
        meetsMarketplaceFloor: false,
        status: 'PENDING',
        username: 'testchan',
        telegramChannelId: '123456',
        subscribers: 100,
        minSubscribers: 500,
      },
    });
    render(mount());
    await waitFor(() => expect(screen.getByText(/Open access to the bot/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Re-check permissions/i })).toBeInTheDocument();
  });

  it('renders ON_HOLD with the Send to moderation button', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'ON_HOLD',
        botHasAccess: true,
        meetsMarketplaceFloor: false,
        status: 'READY_FOR_REVIEW',
        username: 'testchan',
        telegramChannelId: '123456',
        subscribers: 100,
        minSubscribers: 500,
      },
    });
    render(mount());
    await waitFor(() => expect(screen.getByText(/You.?re on hold/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Send to moderation/i })).toBeInTheDocument();
  });

  it('renders PENDING_REVIEW without an action button', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'PENDING_REVIEW',
        botHasAccess: true,
        meetsMarketplaceFloor: false,
        status: 'INACTIVE',
        username: 'testchan',
        telegramChannelId: '123456',
        subscribers: 100,
        minSubscribers: 500,
      },
    });
    render(mount());
    await waitFor(() => expect(screen.getByText(/under review/i)).toBeInTheDocument());
  });

  it('renders NEEDS_GROWTH with the remaining count', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'NEEDS_GROWTH',
        botHasAccess: true,
        meetsMarketplaceFloor: false,
        status: 'APPROVED',
        subscribers: 200,
        username: 'testchan',
        telegramChannelId: '123456',
        minSubscribers: 500,
      },
    });
    render(mount());
    await waitFor(() => expect(screen.getByText(/Almost there/i)).toBeInTheDocument());
    expect(screen.getByText(/300/)).toBeInTheDocument();
  });

  it('renders nothing when ACTIVE', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'ACTIVE',
        botHasAccess: true,
        meetsMarketplaceFloor: true,
        status: 'APPROVED',
        subscribers: 5000,
        username: 'testchan',
        telegramChannelId: '123456',
        minSubscribers: 500,
      },
    });
    const { container } = render(mount());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});

declare global {
  interface Window { __openCalls?: Array<{ url: string; target: string; features: string }> }
}

describe('ChannelOnboardingCard — NoAccess deep-link', () => {
  it('renders the "Open access in Telegram" button when the bot has no access', async () => {
    mockApi({
      '/api/channels/ch1/onboarding': {
        publisherStage: 'NO_ACCESS',
        botHasAccess: false,
        meetsMarketplaceFloor: false,
        status: 'PENDING',
        subscribers: 100,
        minSubscribers: 500,
        username: 'testchan',
        telegramChannelId: '123456',
      },
    });
    // Spy on window.open so the test does not actually navigate.
    const calls: Array<{ url: string }> = [];
    const originalOpen = window.open;
    window.open = ((url?: string | URL) => {
      calls.push({ url: String(url) });
      return null;
    }) as typeof window.open;

    try {
      render(mount());
      await waitFor(() =>
        expect(screen.getByText(/Open access to the bot/i)).toBeInTheDocument(),
      );
      const btn = screen.getByRole('button', { name: /Open access in Telegram/i });
      expect(btn).toBeInTheDocument();
      // Click and verify the deep-link includes the rights and the bot's
      // telegram username.
      fireEvent.click(btn);
      expect(calls).toHaveLength(1);
      // URL contract: t.me/<botUsername>?startchannel&admin=<rights joined by +>
      expect(calls[0].url).toMatch(/^https:\/\/t\.me\/[^/?]+\?startchannel&admin=post_messages\+edit_messages/);
    } finally {
      window.open = originalOpen;
    }
  });
});
