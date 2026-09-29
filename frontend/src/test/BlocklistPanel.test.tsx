import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlocklistPanel } from '../components/domain/BlocklistPanel';
import { api } from '../lib/api';
import type { BlocklistResponse } from '../lib/contracts';
import { useUiStore } from '../store/uiStore';
import { CHANNEL_ID, makeBlocklist } from './fixtures';

/* The axios wrapper is always mocked — no live backend, no real network. */
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {},
  baseURL: 'http://test.local',
}));

const mockApi = vi.mocked(api);

function renderPanel(response: BlocklistResponse) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mockApi.get.mockImplementation((url: string) =>
    url === `/api/channels/${CHANNEL_ID}/blocklist` ? Promise.resolve(response) : Promise.resolve({}),
  );
  mockApi.post.mockImplementation((() => Promise.resolve({})) as never);
  mockApi.delete.mockImplementation((() => Promise.resolve({ removed: true })) as never);
  return render(
    <QueryClientProvider client={qc}>
      <BlocklistPanel channelId={CHANNEL_ID} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('BlocklistPanel — list', () => {
  it('renders entries with their scope, label and the per-scope summary counts', async () => {
    renderPanel(makeBlocklist());

    const advertiserValue = await screen.findByText('spam-advertiser');
    expect(screen.getByText('badsite.example.com')).toBeInTheDocument();
    expect(screen.getByText('Repeat offender')).toBeInTheDocument();

    // Scope badge rendered inside the entry row
    const advertiserRow = advertiserValue.closest('div[class*="flex"]') as HTMLElement;
    expect(within(advertiserRow).getByText('Advertiser')).toBeInTheDocument();

    // Per-scope counts from the server summary
    for (const label of ['Advertisers', 'Campaigns', 'Categories', 'Domains']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Advertisers').parentElement?.textContent).toContain('1');
    expect(screen.getByText('Campaigns').parentElement?.textContent).toContain('0');
    expect(screen.getByText('Domains').parentElement?.textContent).toContain('1');
  });

  it('shows an empty state when the blocklist has no entries', async () => {
    renderPanel(makeBlocklist({ entries: [], summary: { ADVERTISER: 0, CAMPAIGN: 0, CATEGORY: 0, DOMAIN: 0 } }));
    expect(await screen.findByText('Nothing blocked')).toBeInTheDocument();
  });
});

describe('BlocklistPanel — add', () => {
  it('POSTs the chosen scope and normalised value (advertiser: trimmed + lowercased)', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.type(screen.getByLabelText('Advertiser'), '  Spam Guy ');
    await user.click(screen.getByRole('button', { name: /add to blocklist/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/channels/${CHANNEL_ID}/blocklist`, {
      scope: 'ADVERTISER',
      value: 'spam guy',
    });
  });

  it('POSTs DOMAIN values with scheme, www. and trailing slash stripped', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.selectOptions(screen.getByLabelText('Scope'), 'DOMAIN');
    await user.type(screen.getByLabelText('Domain'), 'HTTPS://WWW.BadSite.Example.com/');
    await user.click(screen.getByRole('button', { name: /add to blocklist/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/channels/${CHANNEL_ID}/blocklist`, {
      scope: 'DOMAIN',
      value: 'badsite.example.com',
    });
  });

  it('offers the channel categories as a select for CATEGORY scope and POSTs the chosen one', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.selectOptions(screen.getByLabelText('Scope'), 'CATEGORY');
    const categorySelect = screen.getByLabelText('Category');
    // Free text input is gone, replaced by the category select
    expect(screen.queryByLabelText('Domain')).not.toBeInTheDocument();
    await user.selectOptions(categorySelect, 'GAMING');
    await user.click(screen.getByRole('button', { name: /add to blocklist/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/channels/${CHANNEL_ID}/blocklist`, {
      scope: 'CATEGORY',
      value: 'GAMING',
    });
  });

  it('includes an optional label in the POST body when provided', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.type(screen.getByLabelText('Advertiser'), 'scammer-2');
    await user.type(screen.getByLabelText('Label (optional)'), '  Repeat offender  ');
    await user.click(screen.getByRole('button', { name: /add to blocklist/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/channels/${CHANNEL_ID}/blocklist`, {
      scope: 'ADVERTISER',
      value: 'scammer-2',
      label: 'Repeat offender',
    });
  });

  it('does not POST an empty value and surfaces a client-side error', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.click(screen.getByRole('button', { name: /add to blocklist/i }));

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.some((t) => t.kind === 'error' && /value to block/i.test(t.message))).toBe(
      true,
    );
  });
});

describe('BlocklistPanel — remove', () => {
  it('removes an entry behind a confirmation via DELETE on the entry URL', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    // First entry in the list (newest first) is b-1 / spam-advertiser
    await user.click(screen.getAllByRole('button', { name: /remove/i })[0]);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('spam-advertiser')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
    expect(mockApi.delete).toHaveBeenCalledWith(`/api/channels/${CHANNEL_ID}/blocklist/b-1`);
  });

  it('cancels without deleting when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderPanel(makeBlocklist());
    await screen.findByText('spam-advertiser');

    await user.click(screen.getAllByRole('button', { name: /remove/i })[1]); // b-2 row

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Keep' }));

    expect(mockApi.delete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
