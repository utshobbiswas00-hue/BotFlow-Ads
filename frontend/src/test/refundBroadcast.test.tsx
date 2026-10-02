/**
 * The two irreversible money/notification actions, and the guards that must fire
 * BEFORE the request leaves the browser.
 *
 *  1. Refunds — the API requires a reason of at least 10 characters. The dialog
 *     enforces that minimum itself so the operator gets a clear message instead
 *     of learning the rule from a 422.
 *  2. Broadcast — irreversible and delivered to real users, so the confirmation
 *     must perform a `dryRun` (server validates + counts, enqueues nothing)
 *     before any real send is allowed to happen.
 *
 * Authorisation and the server's own caps are the API's job and are not
 * re-implemented here; these tests pin the client-side contract only.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BroadcastPage } from '../admin/pages/Broadcast';
import { RefundsPage } from '../admin/pages/Refunds';
import { ToastContainer } from '../components/ui/Toast';
import { useUiStore } from '../store/uiStore';
import {
  createRefund,
  getBroadcastAudience,
  listTransactions,
  sendBroadcast,
} from '../admin/lib/api';

vi.mock('../admin/lib/api', () => ({
  createRefund: vi.fn(),
  getBroadcastAudience: vi.fn(),
  listTransactions: vi.fn(),
  sendBroadcast: vi.fn(),
}));

const mockCreateRefund = vi.mocked(createRefund);
const mockListTransactions = vi.mocked(listTransactions);
const mockGetBroadcastAudience = vi.mocked(getBroadcastAudience);
const mockSendBroadcast = vi.mocked(sendBroadcast);

const EMPTY_PAGE = { items: [], page: 1, limit: 20, total: 0, hasMore: false };

function renderPage(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin']}>
        {node}
        <ToastContainer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('RefundsPage — refund composer', () => {
  it('refuses a reason shorter than 10 characters before calling the API', async () => {
    mockListTransactions.mockResolvedValue(EMPTY_PAGE);

    renderPage(<RefundsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /issue a refund/i }));

    fireEvent.change(await screen.findByLabelText('Campaign ID'), {
      target: { value: 'cmp-123' },
    });
    fireEvent.change(screen.getByLabelText(/Amount in USD/i), { target: { value: '49.99' } });
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: 'short' } });

    fireEvent.click(screen.getByRole('button', { name: /^issue refund$/i }));

    // The API must never be reached with a reason the server would reject.
    expect(mockCreateRefund).not.toHaveBeenCalled();
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
  });
});

describe('BroadcastPage — two-step confirm', () => {
  it('performs a dryRun call before any real send', async () => {
    mockGetBroadcastAudience.mockResolvedValue({ audience: 'ALL', recipients: 42 });
    mockSendBroadcast.mockImplementation((input) =>
      Promise.resolve(
        input.dryRun
          ? { enqueued: false, jobId: null, audience: input.audience, recipients: 42 }
          : { enqueued: true, jobId: 'job-1', audience: input.audience, recipients: 42 },
      ),
    );

    renderPage(<BroadcastPage />);

    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Maintenance' } });
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'We will be down at 22:00 UTC for 15 minutes.' },
    });

    // The recipient count is on screen before sending.
    expect(await screen.findByText('42')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /review broadcast/i }));
    fireEvent.click(await screen.findByRole('button', { name: /check recipients \(dry run\)/i }));

    await waitFor(() => expect(mockSendBroadcast).toHaveBeenCalledTimes(1));
    expect(mockSendBroadcast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ audience: 'ALL', dryRun: true }),
    );
    // The dry run must NOT have been a real send.
    expect(mockSendBroadcast).not.toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));

    fireEvent.click(await screen.findByRole('button', { name: /send now/i }));

    await waitFor(() => expect(mockSendBroadcast).toHaveBeenCalledTimes(2));
    expect(mockSendBroadcast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ audience: 'ALL', dryRun: false }),
    );
  });
});
