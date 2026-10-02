import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { listUsers } from '../admin/lib/api';
import { AdvertisersPage } from '../admin/pages/Advertisers';
import { PublishersPage } from '../admin/pages/Publishers';

/**
 * The two role-scoped list screens (spec §11, §12).
 *
 * Both are driven by the SAME endpoint (`GET /admin/users`), disambiguated by a
 * boolean role filter. The role is derived server-side from the relationships,
 * so what matters on the client is (a) that the correct flag is sent and (b) that
 * the screen TELLS the operator membership is derived — otherwise an account
 * silently entering or leaving the list looks like a bug.
 */
vi.mock('../admin/lib/api', () => ({
  listUsers: vi.fn(),
}));

const mockListUsers = vi.mocked(listUsers);

const EMPTY_PAGE = { items: [], page: 1, limit: 20, total: 0, hasMore: false };

function renderPage(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin']}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PublishersPage — role-scoped list', () => {
  it('requests isPublisher: true and states membership is derived from channels', async () => {
    mockListUsers.mockResolvedValue(EMPTY_PAGE);

    renderPage(<PublishersPage />);

    expect(
      await screen.findByText(/a publisher is a user with at least one channel/i),
    ).toBeInTheDocument();
    expect(mockListUsers).toHaveBeenCalledWith(expect.objectContaining({ isPublisher: true }));
  });
});

describe('AdvertisersPage — role-scoped list', () => {
  it('requests isAdvertiser: true and states membership is derived from campaigns', async () => {
    mockListUsers.mockResolvedValue(EMPTY_PAGE);

    renderPage(<AdvertisersPage />);

    expect(
      await screen.findByText(/an advertiser is a user with at least one campaign/i),
    ).toBeInTheDocument();
    expect(mockListUsers).toHaveBeenCalledWith(expect.objectContaining({ isAdvertiser: true }));
  });
});
