import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockedChannelsPage } from '../admin/pages/BlockedChannels';
import { BlockedAdsPage } from '../admin/pages/BlockedAds';
import {
  blockAdPost,
  blockChannel,
  listBlockedAds,
  listBlockedChannels,
  unblockAdPost,
  unblockChannel,
} from '../admin/lib/api';
import type { BlockedAdRow, BlockedChannelRow } from '../admin/lib/types';
import { useUiStore } from '../store/uiStore';

/**
 * The blocked-entity screens are only exercised through their own API module, so
 * the whole of `../admin/lib/api` is mocked — no live backend, no axios.
 */
vi.mock('../admin/lib/api', () => ({
  listBlockedChannels: vi.fn(),
  blockChannel: vi.fn(),
  unblockChannel: vi.fn(),
  listBlockedAds: vi.fn(),
  blockAdPost: vi.fn(),
  unblockAdPost: vi.fn(),
}));

const mockListChannels = vi.mocked(listBlockedChannels);
const mockBlockChannel = vi.mocked(blockChannel);
const mockUnblockChannel = vi.mocked(unblockChannel);
const mockListAds = vi.mocked(listBlockedAds);
const mockBlockAdPost = vi.mocked(blockAdPost);
const mockUnblockAdPost = vi.mocked(unblockAdPost);

const CHANNEL_ROW: BlockedChannelRow = {
  id: 'blk-1',
  channelId: 'chn-1',
  scope: 'DOMAIN',
  value: 'evil.example',
  reason: 'Repeat offender',
  createdAt: '2026-10-01T10:00:00.000Z',
  channel: { id: 'chn-1', title: 'News Channel', username: 'news', status: 'APPROVED' },
};

const AD_ROW: BlockedAdRow = {
  id: 'ad-1234567890',
  campaignName: 'Launch push',
  channelTitle: 'News Channel',
  status: 'DELETED',
  reason: 'Removed by moderation',
  createdAt: '2026-10-01T10:00:00.000Z',
};

function renderPage(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('BlockedChannelsPage', () => {
  it('requires a reason before it will submit a new block', async () => {
    const user = userEvent.setup();
    mockListChannels.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, hasMore: false });
    mockBlockChannel.mockResolvedValue({ ...CHANNEL_ROW });

    renderPage(<BlockedChannelsPage />);

    // Open the "Add a block" dialog from the page header.
    await user.click(screen.getByRole('button', { name: /add a block/i }));
    const dialog = await screen.findByRole('dialog');

    // Fill everything except the mandatory reason, then try to submit.
    await user.type(within(dialog).getByLabelText('Channel id'), 'chn-1');
    await user.type(within(dialog).getByLabelText('Value'), 'evil.example');
    await user.click(within(dialog).getByRole('button', { name: 'Add block' }));

    expect(within(dialog).getByText('Reason is required')).toBeInTheDocument();
    expect(mockBlockChannel).not.toHaveBeenCalled();
  });

  it('submits the scope, value and reason once the reason is provided', async () => {
    const user = userEvent.setup();
    mockListChannels.mockResolvedValue({
      items: [CHANNEL_ROW],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });
    mockBlockChannel.mockResolvedValue({ ...CHANNEL_ROW });

    renderPage(<BlockedChannelsPage />);
    await screen.findByText('News Channel');

    await user.click(screen.getByRole('button', { name: /add a block/i }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Channel id'), 'chn-1');
    await user.type(within(dialog).getByLabelText('Value'), 'evil.example');
    await user.type(within(dialog).getByLabelText('Reason'), 'Repeat offender');
    await user.click(within(dialog).getByRole('button', { name: 'Add block' }));

    expect(mockBlockChannel).toHaveBeenCalledWith({
      channelId: 'chn-1',
      scope: 'ADVERTISER',
      value: 'evil.example',
      reason: 'Repeat offender',
    });
  });
});

describe('BlockedAdsPage', () => {
  it('renders the block confirmation with the user-visible effect', async () => {
    const user = userEvent.setup();
    mockListAds.mockResolvedValue({
      items: [AD_ROW],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });
    mockBlockAdPost.mockResolvedValue({ id: AD_ROW.id, status: 'DELETED' });

    renderPage(<BlockedAdsPage />);
    await screen.findByText('Launch push');

    await user.click(screen.getAllByRole('button', { name: 'Block' })[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Block this ad post?')).toBeInTheDocument();
    expect(within(dialog).getByText(/stops being delivered/i)).toBeInTheDocument();
    // The reason field is part of the confirmation.
    expect(within(dialog).getByLabelText('Reason')).toBeInTheDocument();
  });
});
