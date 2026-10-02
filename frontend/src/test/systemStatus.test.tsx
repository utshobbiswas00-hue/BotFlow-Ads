import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SystemStatusPage } from '../admin/pages/SystemStatus';
import { getSystemStatus } from '../admin/lib/api';
import type { SubsystemHealth } from '../admin/lib/types';

/**
 * The status board's load-bearing guarantee: every SubsystemStatus renders as an
 * explicit WORD, never as colour alone. UNKNOWN in particular has to be shown as
 * UNKNOWN rather than hidden — a cold Telegram-bot cache is information about the
 * system, not an error to swallow.
 *
 * DB-free and network-free: the whole `../admin/lib/api` module is mocked, so no
 * axios instance is ever exercised.
 */
vi.mock('../admin/lib/api', () => ({
  getSystemStatus: vi.fn(),
}));

const getSystemStatusMock = vi.mocked(getSystemStatus);

const SUBSYSTEMS: SubsystemHealth[] = [
  {
    name: 'api',
    status: 'ONLINE',
    detail: 'API process is answering admin requests.',
    checkedAt: '2026-10-01T10:00:00.000Z',
  },
  {
    name: 'database',
    status: 'DEGRADED',
    detail: 'Database is answering slowly.',
    checkedAt: '2026-10-01T10:00:00.000Z',
  },
  {
    name: 'redis',
    status: 'OFFLINE',
    detail: 'Redis did not answer a PING.',
    checkedAt: '2026-10-01T10:00:00.000Z',
  },
  {
    name: 'telegramBot',
    status: 'UNKNOWN',
    detail: 'Telegram bot identity is not cached; no live probe performed.',
    checkedAt: '2026-10-01T10:00:00.000Z',
  },
];

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SystemStatusPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SystemStatusPage — status is always a word', () => {
  it('renders all four status values as distinct, visible labels', async () => {
    getSystemStatusMock.mockResolvedValue(SUBSYSTEMS);

    renderPage();

    expect(await screen.findByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('DEGRADED')).toBeInTheDocument();
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('renders UNKNOWN as UNKNOWN rather than hiding the telegram bot tile', async () => {
    getSystemStatusMock.mockResolvedValue(SUBSYSTEMS);

    renderPage();

    const tiles = await screen.findAllByTestId('subsystem-tile');
    expect(tiles).toHaveLength(4);

    const unknown = tiles.find((tile) => tile.getAttribute('data-status') === 'UNKNOWN');
    expect(unknown).toBeDefined();
    expect(unknown).toHaveTextContent('UNKNOWN');
  });

  it('states the 30-second auto-refresh interval out loud', async () => {
    getSystemStatusMock.mockResolvedValue(SUBSYSTEMS);

    renderPage();

    expect(await screen.findByText(/Auto-refreshes every 30 seconds/)).toBeInTheDocument();
  });
});
