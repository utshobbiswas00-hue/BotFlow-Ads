import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminShell } from '../admin/components/AdminShell';
import { AdminCampaignsPage } from '../admin/pages/Campaigns';
import { AdminOpsPage } from '../admin/pages/Ops';
import { api } from '../lib/api';
import { useUiStore } from '../store/uiStore';
import type { AdminCampaignRow, AdminSession, OpsSummary } from '../admin/lib/types';

/**
 * The panel's two load-bearing behaviours:
 *
 *  1. Rendering is driven by the SERVER's permission list, not by the role. The
 *     `can()` helper reads `admin.permissions` from `GET /api/admin/session`, so
 *     a role with no permissions gets a panel that offers nothing — which is what
 *     `requirePermission` would do to every request anyway.
 *  2. A rejected session (401/403) produces an explanation, not an empty shell.
 *
 * These tests assert the rendering contract only. Authorisation itself is the
 * API's job and is not re-implemented here.
 */
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {
    code: string;
    status?: number;
    constructor(message: string, code = 'ERROR', status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  baseURL: 'http://test.local',
}));

const mockApi = vi.mocked(api);
// Imported after the mock so the assertion below sees the same class the
// components do.
const { ApiError } = await import('../lib/api');

const CAMPAIGN: AdminCampaignRow = {
  id: 'cmp-1',
  name: 'Launch push',
  status: 'PENDING_REVIEW',
  promotionTarget: 'CHANNEL',
  pricingModel: 'FIXED',
  budgetTotalCents: 100_000,
  budgetSpentCents: 0,
  budgetReservedCents: 0,
  frequencyPerChannel: 1,
  isAutoTargeting: false,
  startAt: null,
  endAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  advertiserName: 'Test Advertiser',
};

function makeSession(role: string, permissions: string[], isSuperAdmin = false): AdminSession {
  return {
    // Telegram-authenticated by default: no cookie session, so no CSRF value and
    // no sign-out control. The cookie door is exercised by the backend tests.
    session: { active: false, csrf: null },
    admin: {
      id: 'adm-1',
      role,
      isActive: true,
      isSuperAdmin,
      permissions,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    user: {
      id: 'usr-1',
      telegramId: '123456789',
      username: 'tester',
      firstName: 'Test',
      lastName: 'Admin',
      photoUrl: null,
      status: 'ACTIVE',
      name: 'Test Admin',
    },
  };
}

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/campaigns']}>
        <Routes>
          <Route path="/admin" element={<AdminShell />}>
            <Route path="campaigns" element={<AdminCampaignsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockSession(session: AdminSession) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/admin/session') return Promise.resolve(session);
    if (url === '/api/admin/campaigns') {
      return Promise.resolve({ items: [CAMPAIGN], page: 1, limit: 20, total: 1, hasMore: false });
    }
    return Promise.resolve({});
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
});

describe('AdminShell — session gate', () => {
  it('explains a 403 instead of rendering an empty console', async () => {
    mockApi.get.mockImplementation(() =>
      Promise.reject(
        new ApiError('Admin access required', 'FORBIDDEN', 403),
      ),
    );

    renderPanel();

    expect(await screen.findByText('Admin access required')).toBeInTheDocument();
    // The shell must not render navigation the account cannot use.
    expect(screen.queryByText('Operations console')).not.toBeInTheDocument();
  });

  it('explains a 401 as a signing problem, not a permission problem', async () => {
    mockApi.get.mockImplementation(() => Promise.reject(new ApiError('Unauthorized', 'UNAUTHORIZED', 401)));

    renderPanel();

    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.queryByText('Admin access required')).not.toBeInTheDocument();
  });

  it('tells an admin with no permissions why every screen would fail', async () => {
    mockSession(makeSession('ADMIN', []));

    renderPanel();

    expect(await screen.findByText('No permissions granted')).toBeInTheDocument();
  });
});

describe('AdminShell — permission-driven rendering', () => {
  it('shows only the screens the permission list covers', async () => {
    mockSession(makeSession('MODERATOR', ['campaigns.view']));

    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    // Present in the nav map, absent from this admin's keys.
    expect(screen.queryByText('Withdrawals')).not.toBeInTheDocument();
    expect(screen.queryByText('Users')).not.toBeInTheDocument();
    expect(screen.queryByText('Audit log')).not.toBeInTheDocument();
  });

  it('hides the admin-accounts screen from a non super admin', async () => {
    mockSession(makeSession('ADMIN', ['campaigns.view']));

    renderPanel();

    await screen.findByRole('heading', { name: 'Campaigns' });
    // `admin-users` is gated by requireRole('SUPER_ADMIN'), not by a key.
    expect(screen.queryByText('Admin accounts')).not.toBeInTheDocument();
  });

  it('shows the admin-accounts screen to a super admin', async () => {
    mockSession(makeSession('SUPER_ADMIN', [], true));

    renderPanel();

    expect(await screen.findByText('Admin accounts')).toBeInTheDocument();
  });
});

describe('AdminCampaignsPage — action gating', () => {
  it('offers no override actions with view-only access', async () => {
    mockSession(makeSession('ANALYST', ['campaigns.view']));

    renderPanel();

    expect(await screen.findByText('Launch push')).toBeInTheDocument();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('offers exactly the actions the state machine allows', async () => {
    mockSession(makeSession('ADMIN', ['campaigns.view', 'campaigns.manage']));

    renderPanel();

    expect(await screen.findByText('Launch push')).toBeInTheDocument();
    // PENDING_REVIEW → APPROVE and REJECT only; PAUSE/RESUME/CANCEL/SUSPEND are
    // not valid transitions from here and must not be offered.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The /api/admin/ops surface (routes/policy.routes.ts).
 *
 * Its two settlement endpoints are gated with requireRole, NOT with a
 * permission key, so a role holding every permission must still be refused.
 * These tests pin that difference: the button is rendered but disabled, and the
 * reason is on screen rather than discovered as a 403.
 * ------------------------------------------------------------------ */

const OPS_SUMMARY: OpsSummary = {
  delivery: { total: 5, published: 3, pending: 1, failed: 1, awaitingApproval: 0, cancelled: 0 },
  house: { housePostsToday: 2, housePostsTotal: 40, activeCreatives: 3 },
  houseAds: { activeCreatives: 3, housePostsPublished: 40 },
  deliveryEvents: { PUBLISHED: 3, FAILED: 1 },
  creativeQueue: [],
  referrals: { pending: 2, rewarded: 5, rejected: 1, pendingRewardsCents: 1000 },
};

function mockOpsEndpoints(session: AdminSession) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/admin/session') return Promise.resolve(session);
    if (url === '/api/admin/ops/summary') return Promise.resolve(OPS_SUMMARY);
    if (url === '/health/queues') return Promise.resolve([]);
    if (url === '/api/admin/ops/delivery/events/recent') return Promise.resolve([]);
    return Promise.resolve({});
  });
}

function renderOps() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/ops']}>
        <Routes>
          <Route path="/admin" element={<AdminShell />}>
            <Route path="ops" element={<AdminOpsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminOpsPage — role-gated settlement sweeps', () => {
  it('refuses the sweeps for a role the API gate excludes, and says why', async () => {
    // MODERATOR holds both permissions but is not in
    // requireRole('ADMIN','SUPER_ADMIN','FINANCE_MANAGER').
    mockOpsEndpoints(
      makeSession('MODERATOR', ['dashboard.view', 'delivery.manage', 'delivery.view']),
    );

    renderOps();

    const sweep = await screen.findByRole('button', { name: /Run referral sweep now/i });
    expect(sweep).toBeDisabled();
    expect(screen.getByRole('button', { name: /Settle CPC posts/i })).toBeDisabled();
    expect(
      screen.getByText(/Your role \(MODERATOR\) is not in ADMIN \/ SUPER_ADMIN \/ FINANCE_MANAGER/),
    ).toBeInTheDocument();
  });

  it('allows the sweeps for a finance manager', async () => {
    mockOpsEndpoints(makeSession('FINANCE_MANAGER', ['dashboard.view']));

    renderOps();

    const sweep = await screen.findByRole('button', { name: /Run referral sweep now/i });
    expect(sweep).toBeEnabled();
    expect(
      screen.getByText(/role-gated \(ADMIN \/ SUPER_ADMIN \/ FINANCE_MANAGER\)/),
    ).toBeInTheDocument();
  });

  it('renders the aggregate it fetched, not a placeholder', async () => {
    mockOpsEndpoints(makeSession('ADMIN', ['dashboard.view']));

    renderOps();

    // Summary numbers, the 24h event breakdown, and the queue table are all fed
    // by the single /ops/summary call plus /health/queues.
    expect(await screen.findByText('PUBLISHED')).toBeInTheDocument();
    expect(screen.getByText('House posts today')).toBeInTheDocument();
    expect(screen.getByText('Referral queue')).toBeInTheDocument();
    expect(screen.getByText('Worker queues')).toBeInTheDocument();
  });
});

describe('AdminShell — the ops nav group', () => {
  it('exposes an ops screen only to a key that can use it', async () => {
    // settings.manage covers the house-ads / domains / categories screens;
    // campaigns.manage covers creative review; dashboard.view covers the
    // dashboard itself.
    mockOpsEndpoints(makeSession('ADMIN', ['dashboard.view']));

    renderOps();

    // "Ops dashboard" is both the nav label and the page heading — match the
    // heading so the assertion is unambiguous.
    expect(await screen.findByRole('heading', { name: 'Ops dashboard' })).toBeInTheDocument();
    expect(screen.queryByText('Creative review')).not.toBeInTheDocument();
    expect(screen.queryByText('House ads')).not.toBeInTheDocument();
    expect(screen.queryByText('Blocked domains')).not.toBeInTheDocument();
  });
});
