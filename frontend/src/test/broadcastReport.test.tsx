/**
 * Broadcast delivery report (§52) — client contract.
 *
 * The report screen is read-only and its job is to show what the backend
 * recorded: the history list, the aggregate counts, and the per-recipient rows.
 * These tests pin the parts that would be easy to get wrong:
 *  - a row opens the detail and pulls counts + recipients for that job;
 *  - the status filter is passed to the API;
 *  - the pager passes the next page through;
 *  - a BigInt `telegramMessageId` is rendered as its STRING, never a number.
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { BroadcastReportPage } from '../admin/pages/BroadcastReport';
import { getBroadcastJob, listBroadcastHistory, listBroadcastRecipients } from '../admin/lib/api';

vi.mock('../admin/lib/api', () => ({
  getBroadcastJob: vi.fn(),
  listBroadcastHistory: vi.fn(),
  listBroadcastRecipients: vi.fn(),
}));

const mockHistory = vi.mocked(listBroadcastHistory);
const mockJob = vi.mocked(getBroadcastJob);
const mockRecipients = vi.mocked(listBroadcastRecipients);

const JOB = {
  id: 'job-1',
  status: 'COMPLETED' as const,
  audience: 'ALL' as const,
  title: 'Launch note',
  totalRecipients: 3,
  sentCount: 2,
  failedCount: 1,
  createdById: 'admin-1',
  createdAt: '2026-10-02T00:00:00.000Z',
  completedAt: '2026-10-02T00:05:00.000Z',
};

function renderPage(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/broadcast/report']}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BroadcastReportPage — history', () => {
  it('lists broadcasts and opens a job, showing counts and recipients', async () => {
    mockHistory.mockResolvedValue({
      items: [JOB],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });
    mockJob.mockResolvedValue({
      job: { ...JOB, body: 'We will be down at 22:00' },
      counts: { total: 3, pending: 0, sent: 2, failed: 1, skipped: 0 },
    });
    mockRecipients.mockResolvedValue({
      items: [
        {
          id: 'rec-1',
          userId: 'user-abcdef123456',
          status: 'SENT',
          telegramMessageId: '740000000000000123',
          error: null,
          sentAt: '2026-10-02T00:02:00.000Z',
          createdAt: '2026-10-02T00:00:00.000Z',
          userName: 'Ada Lovelace',
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
      hasMore: false,
    });

    renderPage(<BroadcastReportPage />);

    // History row renders with its title and delivery ratio.
    const title = await screen.findByText('Launch note');
    expect(title).toBeInTheDocument();

    // Open the detail by clicking the row.
    fireEvent.click(title);

    await waitFor(() => expect(mockJob).toHaveBeenCalledWith('job-1'));
    // Recipients were fetched for this job.
    await waitFor(() =>
      expect(mockRecipients).toHaveBeenCalledWith('job-1', expect.objectContaining({ page: 1 })),
    );

    expect(await screen.findByText('Delivery summary')).toBeInTheDocument();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

    // The BigInt id is shown as a STRING — never a rounded number.
    expect(screen.getByText('740000000000000123')).toBeInTheDocument();
  });

  it('passes the next page to the history query', async () => {
    mockHistory.mockResolvedValue({ items: [JOB], page: 1, limit: 20, total: 40, hasMore: true });

    renderPage(<BroadcastReportPage />);

    await screen.findByText('Launch note');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(mockHistory).toHaveBeenCalledWith({ page: 2, limit: 20 }));
  });
});

describe('BroadcastReportPage — recipient status filter', () => {
  it('re-queries recipients with the chosen status', async () => {
    mockHistory.mockResolvedValue({ items: [JOB], page: 1, limit: 20, total: 1, hasMore: false });
    mockJob.mockResolvedValue({
      job: { ...JOB, body: 'body' },
      counts: { total: 3, pending: 0, sent: 2, failed: 1, skipped: 0 },
    });
    mockRecipients.mockResolvedValue({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      hasMore: false,
    });

    renderPage(<BroadcastReportPage />);

    fireEvent.click(await screen.findByText('Launch note'));
    const select = await screen.findByLabelText('Status');

    fireEvent.change(select, { target: { value: 'FAILED' } });

    await waitFor(() =>
      expect(mockRecipients).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'FAILED', page: 1 }),
      ),
    );
  });
});
