import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { getActivityFeed } from '../admin/lib/api';
import { ActivityPage } from '../admin/pages/Activity';
import { formatDate, formatDateTime } from '../lib/format';
import type { ActivityFeed } from '../admin/lib/types';

/**
 * The cross-entity activity feed (spec §65).
 *
 * A computed, newest-first stream — nothing is stored and it must say so. The
 * page only groups by day (never re-sorts) and must render a null `href` as
 * plain text, not a dead link.
 */
vi.mock('../admin/lib/api', () => ({
  getActivityFeed: vi.fn(),
}));

// StateBlock pulls `ApiError` from the base api module.
vi.mock('../lib/api', () => ({
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  ApiError: class ApiError extends Error {},
}));

const mockFeed = vi.mocked(getActivityFeed);

const NOW = Date.now();
const TODAY = new Date(NOW - 2 * 60_000).toISOString(); // ~2m ago
const YESTERDAY = new Date(NOW - 26 * 60 * 60_000).toISOString();

const FEED: ActivityFeed = {
  items: [
    {
      kind: 'NEW_USER',
      id: 'u1',
      label: 'New user @alice',
      detail: 'Signed up from the bot',
      href: '/admin/users/u1',
      createdAt: TODAY,
    },
    {
      kind: 'NEW_CHANNEL',
      id: 'ch1',
      label: 'Channel added',
      detail: null,
      href: null,
      createdAt: TODAY,
    },
    {
      kind: 'CAMPAIGN_CREATED',
      id: 'c1',
      label: 'Campaign created',
      detail: 'Launch push',
      href: '/admin/campaigns/c1',
      createdAt: YESTERDAY,
    },
  ],
  generatedAt: '2026-10-02T09:30:00.000Z',
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/activity']}>
        <ActivityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActivityPage — stream rendering', () => {
  it('renders label, detail and the kind as a chip in a newest-first stream', async () => {
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    expect(await screen.findByText('New user @alice')).toBeInTheDocument();
    expect(screen.getByText('Signed up from the bot')).toBeInTheDocument();
    expect(screen.getByText('NEW_USER')).toBeInTheDocument();
    expect(screen.getByText('CAMPAIGN_CREATED')).toBeInTheDocument();
    expect(mockFeed).toHaveBeenCalledWith(60);
  });

  it('links a row with an href and renders one without as plain text', async () => {
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    await screen.findByText('New user @alice');
    expect(screen.getByRole('link', { name: /New user @alice/ })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
    // The null-href item is not a dead link.
    expect(screen.queryByRole('link', { name: /Channel added/ })).not.toBeInTheDocument();
    expect(screen.getByText('Channel added')).toBeInTheDocument();
  });

  it('shows a relative timestamp with the absolute time on hover', async () => {
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    expect((await screen.findAllByText('2m ago')).length).toBeGreaterThan(0);
    expect(screen.getAllByTitle(formatDateTime(TODAY)).length).toBeGreaterThan(0);
  });

  it('groups the stream by day', async () => {
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    await screen.findByText('New user @alice');
    expect(screen.getByText(formatDate(TODAY))).toBeInTheDocument();
    expect(screen.getByText(formatDate(YESTERDAY))).toBeInTheDocument();
  });

  it('shows generatedAt and says this is a merged view, not a stored log', async () => {
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    const notice = await screen.findByText(/merged view of recent rows, not a stored event log/i);
    expect(notice).toBeInTheDocument();
    // Wait for the feed to resolve before reading generatedAt off the notice.
    await screen.findByText('New user @alice');
    // generatedAt is rendered inside the same paragraph — assert on its text
    // content rather than splitting the surrounding copy.
    expect(notice.textContent).toContain('Snapshot generated');
  });

  it('re-queries with the chosen limit', async () => {
    const user = userEvent.setup();
    mockFeed.mockResolvedValue(FEED);

    renderPage();

    await screen.findByText('New user @alice');
    await user.selectOptions(screen.getByLabelText('Rows'), '150');

    await waitFor(() => expect(mockFeed).toHaveBeenLastCalledWith(150));
  });

  it('shows the empty state when there is nothing in the window', async () => {
    mockFeed.mockResolvedValue({ items: [], generatedAt: FEED.generatedAt });

    renderPage();

    expect(await screen.findByText('No recent activity')).toBeInTheDocument();
  });
});
