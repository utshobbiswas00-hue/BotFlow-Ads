import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  adjustBalance,
  banUser,
  getUser,
  recalculateRisk,
  suspendUser,
  unbanUser,
  unsuspendUser,
} from '../admin/lib/api';
import { AdminUserDetailPage } from '../admin/pages/UserDetail';
import { useUiStore } from '../store/uiStore';
import type { AdminUserDetail } from '../admin/lib/types';

/**
 * The suspend / ban controls on the user dossier (spec §9, §10, §45).
 *
 * Four endpoints existed with no way to reach them from the panel. What matters
 * here is that the screen offers exactly the transitions the CURRENT status
 * accepts (a Suspend button on a BANNED account is a guaranteed 409), that the
 * reason is collected for the two that require one, and that permission gates
 * RENDERING rather than disabling.
 */
vi.mock('../admin/lib/api', () => ({
  getUser: vi.fn(),
  adjustBalance: vi.fn(),
  recalculateRisk: vi.fn(),
  suspendUser: vi.fn(),
  unsuspendUser: vi.fn(),
  banUser: vi.fn(),
  unbanUser: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({ can: true }));
vi.mock('../admin/lib/session', () => ({
  useAdminSession: () => ({ can: () => sessionState.can }),
}));

// StateBlock imports `ApiError` from the base api module; UserDetail imports errMsg.
vi.mock('../lib/api', () => ({
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));

const mockGetUser = vi.mocked(getUser);
const mockSuspend = vi.mocked(suspendUser);
const mockBan = vi.mocked(banUser);
const mockUnsuspend = vi.mocked(unsuspendUser);
const mockUnban = vi.mocked(unbanUser);
const mockAdjust = vi.mocked(adjustBalance);
const mockRisk = vi.mocked(recalculateRisk);

function makeDetail(
  overrides: Partial<AdminUserDetail['profile']> = {},
  suspendedReason?: string | null,
): AdminUserDetail {
  const profile = {
    id: 'usr-1',
    telegramId: '123456789',
    username: 'target',
    firstName: 'Target',
    lastName: 'User',
    photoUrl: null,
    status: 'ACTIVE',
    isAdvertiser: true,
    isPublisher: false,
    referralCode: 'REF123',
    totalEarnedCents: 0,
    totalSpentCents: 0,
    totalWithdrawnCents: 0,
    totalDepositedCents: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    isAdmin: false,
    adminRole: null,
    balanceCents: 0,
    ...overrides,
  } as AdminUserDetail['profile'] & { suspendedReason?: string | null };
  if (suspendedReason !== undefined) profile.suspendedReason = suspendedReason;
  return {
    profile,
    channels: [],
    campaigns: [],
    transactions: [],
    deposits: [],
    withdrawals: [],
    earnings: {
      totalPosts: 0,
      totalGrossCents: 0,
      totalNetCents: 0,
      pendingCents: 0,
      availableCents: 0,
      paidCents: 0,
    },
  };
}

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/users/usr-1']}>
        <Routes>
          <Route path="/admin/users/:id" element={<AdminUserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionState.can = true;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('UserDetail — moderation controls by status', () => {
  it('offers Suspend and Ban for an ACTIVE account', async () => {
    mockGetUser.mockResolvedValue(makeDetail({ status: 'ACTIVE' }));

    renderDetail();

    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsuspend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unban' })).not.toBeInTheDocument();
  });

  it('offers Unsuspend and Ban — not Suspend — for a SUSPENDED account', async () => {
    mockGetUser.mockResolvedValue(makeDetail({ status: 'SUSPENDED' }));

    renderDetail();

    expect(await screen.findByRole('button', { name: 'Unsuspend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unban' })).not.toBeInTheDocument();
  });

  it('offers only Unban for a BANNED account', async () => {
    mockGetUser.mockResolvedValue(makeDetail({ status: 'BANNED' }));

    renderDetail();

    expect(await screen.findByRole('button', { name: 'Unban' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsuspend' })).not.toBeInTheDocument();
  });

  it('renders nothing for the controls when the admin lacks users.manage', async () => {
    sessionState.can = false;
    mockGetUser.mockResolvedValue(makeDetail({ status: 'ACTIVE' }));

    renderDetail();

    // Wait for the dossier to load, then assert the whole panel is absent.
    expect(await screen.findByRole('heading', { level: 1, name: 'Target User' })).toBeInTheDocument();
    expect(screen.queryByText('Account moderation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
  });
});

describe('UserDetail — suspend/ban dialogs', () => {
  it('requires a reason and sends it to suspendUser', async () => {
    const user = userEvent.setup();
    mockGetUser.mockResolvedValue(makeDetail({ status: 'ACTIVE' }));
    mockSuspend.mockResolvedValue({ id: 'usr-1', status: 'SUSPENDED' });

    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Suspend' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Suspend this account')).toBeInTheDocument();
    // The destructive consequence is named in words.
    expect(dialog.getByText(/telegramAuth rejects SUSPENDED and BANNED/i)).toBeInTheDocument();

    // Empty submit is refused client-side, mirroring the API's rule.
    await user.click(dialog.getByRole('button', { name: 'Suspend' }));
    expect(await dialog.findByText(/is required/i)).toBeInTheDocument();
    expect(mockSuspend).not.toHaveBeenCalled();

    await user.type(dialog.getByLabelText(/Reason/), 'Repeated spam complaints');
    await user.click(dialog.getByRole('button', { name: 'Suspend' }));

    await waitFor(() =>
      expect(mockSuspend).toHaveBeenCalledWith('usr-1', 'Repeated spam complaints'),
    );
  });

  it('bans with a reason and toasts the outcome', async () => {
    const user = userEvent.setup();
    mockGetUser.mockResolvedValue(makeDetail({ status: 'ACTIVE' }));
    mockBan.mockResolvedValue({ id: 'usr-1', status: 'BANNED' });

    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Ban' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText(/Reason/), 'Fraudulent deposits');
    await user.click(dialog.getByRole('button', { name: 'Ban' }));

    await waitFor(() => expect(mockBan).toHaveBeenCalledWith('usr-1', 'Fraudulent deposits'));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.message === 'User banned')).toBe(true),
    );
  });

  it('takes no reason for Unsuspend and states the reason is cleared', async () => {
    const user = userEvent.setup();
    mockGetUser.mockResolvedValue(makeDetail({ status: 'SUSPENDED' }));
    mockUnsuspend.mockResolvedValue({ id: 'usr-1', status: 'ACTIVE' });

    renderDetail();

    await user.click(await screen.findByRole('button', { name: 'Unsuspend' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/recorded suspension reason is cleared/i)).toBeInTheDocument();
    // No textarea: unsuspend carries no body.
    expect(dialog.queryByLabelText(/Reason/)).not.toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Unsuspend' }));

    await waitFor(() => expect(mockUnsuspend).toHaveBeenCalledWith('usr-1'));
  });
});

describe('UserDetail — moderation context', () => {
  it('surfaces the recorded suspension reason when present', async () => {
    mockGetUser.mockResolvedValue(makeDetail({ status: 'SUSPENDED' }, 'Chargeback abuse'));

    renderDetail();

    expect(await screen.findByText('Chargeback abuse')).toBeInTheDocument();
    expect(screen.getByText(/Recorded reason/)).toBeInTheDocument();
  });

  it('warns that an admin target has server-side protections', async () => {
    mockGetUser.mockResolvedValue(makeDetail({ status: 'ACTIVE', isAdmin: true, adminRole: 'ADMIN' }));

    renderDetail();

    expect(
      await screen.findByText(/refuses to ban an ACTIVE admin unless the actor is a SUPER_ADMIN/i),
    ).toBeInTheDocument();
  });
});
