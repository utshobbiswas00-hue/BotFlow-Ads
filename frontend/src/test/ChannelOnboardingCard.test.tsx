import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelOnboardingCard } from '../components/ChannelOnboardingCard';
import * as apiMod from '../lib/api';

function mockApi(responses: Record<string, unknown>): void {
  // api is a const object with { get, post, ... }. vi.spyOn an object's method by
  // grabbing the live reference on import and replacing its impl.
  const liveApi = apiMod.api as unknown as {
    get: (path: string) => Promise<unknown>;
    post: (path: string, body?: unknown) => Promise<unknown>;
  };
  vi.spyOn(liveApi, 'get').mockImplementation(async (path: string) => {
    const r = responses[path];
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
        minSubscribers: 500,
      },
    });
    const { container } = render(mount());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
