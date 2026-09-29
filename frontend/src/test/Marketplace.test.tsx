import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MarketplacePage } from '../pages/Marketplace';
import { api } from '../lib/api';
import type { MarketplaceChannelRow } from '../lib/contracts';

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
  useParams: () => ({}),
  useNavigate: () => () => {},
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a href={to}>{children}</a>,
}));

const mockApi = vi.mocked(api);

function makeRow(overrides: Partial<MarketplaceChannelRow> = {}): MarketplaceChannelRow {
  return {
    id: 'ch-1',
    title: 'Demo Channel',
    username: 'demochannel',
    photoUrl: null,
    category: 'NEWS',
    country: 'BD',
    language: 'en',
    subscriberCount: 12_000,
    avgViews: 900,
    adPriceCents: 1_000,
    pricingModel: 'FIXED',
    healthStatus: 'HEALTHY',
    healthScore: 100,
    ...overrides,
  };
}

function renderMarketplace(rows: MarketplaceChannelRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/marketplace') {
      return Promise.resolve({ items: rows, page: 1, limit: 15, total: rows.length, hasMore: false });
    }
    if (url === '/api/categories/policies') return Promise.resolve([]);
    return Promise.resolve({});
  });
  return render(
    <QueryClientProvider client={qc}>
      <MarketplacePage />
    </QueryClientProvider>,
  );
}

/** Params of every /api/marketplace request issued so far. */
function marketplaceCalls(): Array<Record<string, string | number | boolean | undefined>> {
  return mockApi.get.mock.calls
    .filter((c) => c[0] === '/api/marketplace')
    .map((c) => c[1] ?? {});
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Marketplace — request params', () => {
  // Only the params the backend GET /api/marketplace actually accepts are
  // offered; price range / pricing model / sort are stripped server-side, so
  // the UI no longer sends (or shows) them.

  it('sends the subscriber filter as a request param', async () => {
    const user = userEvent.setup();
    renderMarketplace([makeRow()]);
    await screen.findByText('Demo Channel');

    await user.type(screen.getByLabelText('Min subscribers'), '5000');
    await waitFor(() => expect(marketplaceCalls().at(-1)).toMatchObject({ minSubs: 5000 }));
  });

  it('does not send filters the API ignores', async () => {
    renderMarketplace([makeRow()]);
    await screen.findByText('Demo Channel');

    const params = marketplaceCalls().at(-1) ?? {};
    expect(params).not.toHaveProperty('sort');
    expect(params).not.toHaveProperty('minPriceCents');
    expect(params).not.toHaveProperty('maxPriceCents');
    expect(params).not.toHaveProperty('pricingModel');
  });
});

describe('Marketplace — quality indicator', () => {
  it('renders a warning chip for a low-health channel and a healthy chip for a good one', async () => {
    renderMarketplace([
      makeRow({ id: 'ch-bad', title: 'Risky Channel', healthStatus: 'RESTRICTED', healthScore: 35 }),
      makeRow({ id: 'ch-good', title: 'Solid Channel', healthStatus: 'HEALTHY', healthScore: 100 }),
    ]);
    await screen.findByText('Risky Channel');

    // The warning is a labelled chip (not a bare dot) with a tooltip that
    // explains the delivery problem in advertiser terms.
    //
    // The attribute is read and matched explicitly rather than passed to
    // `toHaveAttribute` as a RegExp: this version of jest-dom compares the raw
    // attribute value instead of applying the RegExp as a matcher, so passing
    // one fails even when the text plainly matches.
    const warning = screen.getByText('Restricted');
    expect(warning.getAttribute('title')).toMatch(/delivery failures/i);

    const healthy = screen.getByText('Healthy');
    expect(healthy.getAttribute('title')).toMatch(/reliably/i);
  });

  it('renders a neutral pending chip when the channel has no health data yet', async () => {
    renderMarketplace([
      makeRow({ id: 'ch-new', title: 'Fresh Channel', healthStatus: undefined, healthScore: undefined }),
    ]);
    await screen.findByText('Fresh Channel');

    const pending = screen.getByText('Quality pending');
    expect(pending.getAttribute('title')).toMatch(/being checked/i);
  });
});
