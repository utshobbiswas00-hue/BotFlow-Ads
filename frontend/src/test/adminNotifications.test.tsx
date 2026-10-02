import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsPage } from '../admin/pages/Notifications';
import {
  getAdminUnreadCount,
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from '../admin/lib/api';
import { qk } from '../lib/queryClient';
import type { AdminNotification, AdminNotificationsResult } from '../admin/lib/types';

/**
 * The admin inbox is only exercised through its own API module, so the whole of
 * `../admin/lib/api` is mocked — no live backend, no axios. The session hook is
 * mocked to grant `dashboard.view`.
 */
vi.mock('../admin/lib/api', () => ({
  listAdminNotifications: vi.fn(),
  getAdminUnreadCount: vi.fn(),
  markAdminNotificationRead: vi.fn(),
  markAllAdminNotificationsRead: vi.fn(),
}));

vi.mock('../admin/lib/session', () => ({
  useAdminSession: () => ({ can: () => true }),
}));

// StateBlock imports `ApiError` from the base api module, so the mock carries it.
vi.mock('../lib/api', () => ({
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {},
}));

const mockList = vi.mocked(listAdminNotifications);
const mockUnread = vi.mocked(getAdminUnreadCount);
const mockMarkOne = vi.mocked(markAdminNotificationRead);
const mockMarkAll = vi.mocked(markAllAdminNotificationsRead);

const UNREAD: AdminNotification = {
  id: 'n-unread',
  type: 'SYSTEM',
  title: 'Deposit awaiting verification',
  body: 'A deposit of $500 is waiting on a manual credit decision.',
  data: { source: 'alertAdmins' },
  link: null,
  isRead: false,
  readAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
};

const READ: AdminNotification = {
  id: 'n-read',
  type: 'SYSTEM',
  title: 'Old withdrawal alert',
  body: 'A withdrawal was reviewed.',
  data: null,
  link: null,
  isRead: true,
  readAt: '2026-10-01T11:00:00.000Z',
  createdAt: '2026-09-30T09:00:00.000Z',
};

function result(overrides: Partial<AdminNotificationsResult> = {}): AdminNotificationsResult {
  return {
    items: [UNREAD, READ],
    page: 1,
    limit: 20,
    total: 2,
    hasMore: false,
    unread: 1,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={qc}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
  return { invalidateSpy, ...utils };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin notification inbox', () => {
  it('renders unread and read rows distinctly, with text — not colour alone', async () => {
    mockList.mockResolvedValue(result());
    mockUnread.mockResolvedValue({ unread: 1 });

    renderPage();

    await screen.findByText('Deposit awaiting verification');
    expect(screen.getByText('Old withdrawal alert')).toBeInTheDocument();
    // Both states carry a word, so the distinction survives without colour.
    expect(screen.getByText('Unread')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
  });

  it('marks one notification read and invalidates both notification keys', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue(result());
    mockUnread.mockResolvedValue({ unread: 1 });
    mockMarkOne.mockResolvedValue({ id: UNREAD.id, isRead: true });

    const { invalidateSpy } = renderPage();
    await screen.findByText('Deposit awaiting verification');

    await user.click(screen.getByRole('button', { name: 'Mark read' }));

    await waitFor(() => expect(mockMarkOne).toHaveBeenCalledWith(UNREAD.id));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.adminNotifications }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.adminNotificationsUnread });
  });

  it('mark-all-read calls the client and invalidates both notification keys', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue(result());
    mockUnread.mockResolvedValue({ unread: 1 });
    mockMarkAll.mockResolvedValue({ updated: 1 });

    const { invalidateSpy } = renderPage();
    await screen.findByText('Deposit awaiting verification');

    await user.click(screen.getByRole('button', { name: /mark all read/i }));

    await waitFor(() => expect(mockMarkAll).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.adminNotifications }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.adminNotificationsUnread });
  });

  it('pages via the Pager (Next requests page 2)', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue(result({ page: 1, total: 25, hasMore: true }));
    mockUnread.mockResolvedValue({ unread: 1 });

    renderPage();
    await screen.findByText('Deposit awaiting verification');

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
  });

  it('says so when the unread-only filter is on and offers a way back to all', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue(result({ items: [UNREAD], total: 1, unread: 1 }));
    mockUnread.mockResolvedValue({ unread: 1 });

    renderPage();
    await screen.findByText('Deposit awaiting verification');

    await user.click(screen.getByRole('button', { name: /unread only/i }));

    // It SAYS so (the banner), and offers a way back to all notifications.
    expect(await screen.findByText('unread only')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /show all notifications/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ unreadOnly: true })),
    );

    await user.click(screen.getByRole('button', { name: /show all notifications/i }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ unreadOnly: false })),
    );
  });
});
