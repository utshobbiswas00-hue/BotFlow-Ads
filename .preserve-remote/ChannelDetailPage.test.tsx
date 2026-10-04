import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ChannelDetailPage } from '../pages/ChannelDetail';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';
import { CHANNEL_ID, makeBlocklist, makeChannel } from './fixtures';

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

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'ch-1' }),
  useNavigate: () => () => {},
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));

/* recharts needs a real layout engine (ResizeObserver) — stub it in jsdom. */
vi.mock('../components/charts/LineChart', () => ({
  LineChart: () => <div data-testid="line-chart-mock" />,
}));

const mockApi = vi.mocked(api);

function renderPage(channel: ReturnType<typeof makeChannel>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mockApi.get.mockImplementation((url: string) => {
    if (url === `/api/channels/${CHANNEL_ID}`) return Promise.resolve(channel);
    if (url === `/api/channels/${CHANNEL_ID}/blocklist`) return Promise.resolve(makeBlocklist());
    return Promise.resolve({});
  });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelDetailPage />
    </QueryClientProvider>,
  );
}

async function openEditModal(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByRole('heading', { name: 'Demo Channel' });
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('heading', { name: 'Edit channel' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('ChannelDetailPage — ad settings', () => {
  it('shows the ads-paused banner only when acceptAds is false', async () => {
    const { unmount } = renderPage(makeChannel({ acceptAds: false }));
    expect(await screen.findByText(/ads paused — this channel is not accepting sponsored ads/i)).toBeInTheDocument();
    unmount();

    renderPage(makeChannel({ acceptAds: true }));
    await screen.findByRole('heading', { name: 'Demo Channel' });
    expect(screen.queryByText(/ads paused/i)).not.toBeInTheDocument();
  });

  it('sends acceptAds=false in the PATCH payload when the toggle is turned off', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ acceptAds: true }));
    await openEditModal(user);

    const toggle = screen.getByLabelText(/accept sponsored ads/i);
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/channels/${CHANNEL_ID}`,
      expect.objectContaining({
        acceptAds: false,
        adPriceCents: 500,
        category: 'NEWS',
        autoApprovePosts: false,
        // untouched min-price field round-trips the existing value
        minAdPriceCents: 250,
      }),
    );
  });

  it('prefills and converts the minimum ad price from dollars to cents in the PATCH payload', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ minAdPriceCents: 250 }));
    await openEditModal(user);

    const minInput = screen.getByLabelText('Minimum ad price');
    expect(minInput).toHaveValue(2.5); // 250 cents -> $2.50
    await user.clear(minInput);
    await user.type(minInput, '25');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/channels/${CHANNEL_ID}`,
      expect.objectContaining({ minAdPriceCents: 2500 }),
    );
  });

  it('round-trips the existing floor when the minimum price field is not touched', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ minAdPriceCents: 500 }));
    await openEditModal(user);

    expect(screen.getByLabelText('Minimum ad price')).toHaveValue(5); // 500 cents -> $5.00
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/channels/${CHANNEL_ID}`,
      expect.objectContaining({ minAdPriceCents: 500 }),
    );
  });

  it('treats a cleared minimum price as 0 (no floor)', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ minAdPriceCents: 500 }));
    await openEditModal(user);

    await user.clear(screen.getByLabelText('Minimum ad price'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/channels/${CHANNEL_ID}`,
      expect.objectContaining({ minAdPriceCents: 0 }),
    );
  });

  it('rejects a non-whole-dollar minimum price client-side without calling the API', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ minAdPriceCents: 0 }));
    await openEditModal(user);

    const minInput = screen.getByLabelText('Minimum ad price');
    await user.clear(minInput);
    await user.type(minInput, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.some((t) => t.kind === 'error' && /whole number/i.test(t.message))).toBe(true);
  });

  it('rejects a negative minimum price client-side', async () => {
    const user = userEvent.setup();
    renderPage(makeChannel({ minAdPriceCents: 0 }));
    await openEditModal(user);

    const minInput = screen.getByLabelText('Minimum ad price');
    await user.clear(minInput);
    await user.type(minInput, '-3');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.some((t) => t.kind === 'error' && /whole number/i.test(t.message))).toBe(true);
  });

  it('surfaces a server rejection (e.g. 400 above the platform max) via the error toast', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockImplementation(() => Promise.reject(new Error('Minimum ad price above platform maximum')));
    renderPage(makeChannel({ minAdPriceCents: 0 }));
    await openEditModal(user);

    const minInput = screen.getByLabelText('Minimum ad price');
    await user.clear(minInput);
    await user.type(minInput, '999999');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        useUiStore.getState().toasts.some(
          (t) => t.kind === 'error' && t.message === 'Minimum ad price above platform maximum',
        ),
      ).toBe(true),
    );
  });
});
