import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AdminSupportPage } from '../admin/pages/Support';
import { getTicketThread, listTickets, replyTicket } from '../admin/lib/api';
import type { AdminTicket, AdminTicketThread } from '../admin/lib/types';

/**
 * The support panel after §50: opening a row loads the ticket's REAL thread — not
 * a notice claiming it cannot be read. Each message renders its sender type, body
 * and timestamp, with a link when an attachment is present; a reply refreshes the
 * thread.
 *
 * DB-free / network-free: the admin api module and the session hook are mocked,
 * so no axios instance is exercised and no backend is needed.
 */
vi.mock('../admin/lib/api', () => ({
  listTickets: vi.fn(),
  replyTicket: vi.fn(),
  setTicketStatus: vi.fn(),
  getTicketThread: vi.fn(),
}));

vi.mock('../admin/lib/session', () => ({
  useAdminSession: () => ({ can: () => true }),
}));

// StateBlock imports `ApiError` from the base api module, so the mock must carry it.
vi.mock('../lib/api', () => ({
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {},
}));

const listTicketsMock = vi.mocked(listTickets);
const getTicketThreadMock = vi.mocked(getTicketThread);
const replyTicketMock = vi.mocked(replyTicket);

const TICKET: AdminTicket = {
  id: 't1',
  ticketNo: 'BF-20261001-00001',
  subject: 'Cannot log in',
  category: 'general',
  status: 'OPEN',
  priority: 'NORMAL',
  assignedToId: null,
  lastMessageAt: '2026-10-01T10:05:00.000Z',
  closedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:05:00.000Z',
  user: { id: 'u1', firstName: 'Pat', lastName: 'User', username: 'pat', telegramId: '123456789' },
  userName: 'Pat User',
};

const THREAD: AdminTicketThread = {
  ticket: TICKET,
  messages: [
    {
      id: 'm1',
      senderId: 'u1',
      senderType: 'USER',
      body: 'I cannot log in.',
      attachmentUrl: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'm2',
      senderId: null,
      senderType: 'ADMIN',
      body: 'Reset link sent.',
      attachmentUrl: 'https://cdn.example.com/screenshot.png',
      createdAt: '2026-10-01T10:05:00.000Z',
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminSupportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listTicketsMock.mockResolvedValue({ items: [TICKET], page: 1, limit: 20, total: 1, hasMore: false });
  getTicketThreadMock.mockResolvedValue(THREAD);
  replyTicketMock.mockResolvedValue(TICKET);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminSupportPage — real ticket thread', () => {
  it('loads the thread when a row is opened and renders sender, body and attachment', async () => {
    renderPage();

    fireEvent.click(await screen.findByText('Cannot log in'));

    await waitFor(() => expect(getTicketThreadMock).toHaveBeenCalledWith('t1'));

    expect(await screen.findByText('I cannot log in.')).toBeInTheDocument();
    expect(screen.getByText('Reset link sent.')).toBeInTheDocument();

    // Each message carries its humanized sender type.
    expect(screen.getByText('I cannot log in.').closest('li')).toHaveTextContent('User');
    expect(screen.getByText('Reset link sent.').closest('li')).toHaveTextContent('Admin');

    // And an attachment renders as a link.
    const link = screen.getByRole('link', { name: /attachment/i });
    expect(link).toHaveAttribute('href', 'https://cdn.example.com/screenshot.png');
  });

  it('refreshes the thread after a reply', async () => {
    renderPage();

    fireEvent.click(await screen.findByText('Cannot log in'));
    await waitFor(() => expect(getTicketThreadMock).toHaveBeenCalledTimes(1));

    fireEvent.change(await screen.findByPlaceholderText(/Type the reply/i), {
      target: { value: 'We are on it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send reply/i }));

    await waitFor(() => expect(replyTicketMock).toHaveBeenCalledWith('t1', 'We are on it.'));
    // The mutation invalidates qk.adminTicket(id), so the thread re-reads.
    await waitFor(() => expect(getTicketThreadMock.mock.calls.length).toBeGreaterThan(1));
  });
});
