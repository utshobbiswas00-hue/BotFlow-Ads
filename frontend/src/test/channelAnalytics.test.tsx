/**
 * Per-channel analytics (§41) — client contract.
 *
 * The parts worth pinning:
 *  - the identity block (title, owner, subscribers) and headline metrics render;
 *  - the channel's own average view figure and the delivery-recorded impression
 *    figure are both shown and labelled — never presented as each other;
 *  - a nullable metric (`successRatePct` / `ctrPct`) is shown as
 *    "Not measurable" in words, never as "0%";
 *  - a 404 renders the dedicated "not found" state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChannelAnalyticsPage } from '../admin/pages/ChannelAnalytics';
import { getChannelAnalyticsDetail } from '../admin/lib/api';

vi.mock('../admin/lib/api', () => ({
  getChannelAnalyticsDetail: vi.fn(),
}));

const mockDetail = vi.mocked(getChannelAnalyticsDetail);

const DETAIL = {
  channel: {
    id: 'ch-1',
    title: 'Demo Channel',
    username: 'demo_channel',
    status: 'APPROVED',
    ownerName: 'Ada Lovelace',
    subscriberCount: 12500,
    avgViews: 830,
  },
  delivery: { scheduled: 6, published: 5, failed: 1, successRatePct: 83.33 },
  performance: { posts: 5, grossCents: 25000, netCents: 20000, platformFeeCents: 5000 },
  reach: { impressions: 4200, clicks: 120, ctrPct: 2.86 },
};

function renderAt(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/admin/channels/${id}/analytics`]}>
        <Routes>
          <Route path="/admin/channels/:channelId/analytics" element={<ChannelAnalyticsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChannelAnalyticsPage', () => {
  it('renders the channel identity and headline metrics from the payload', async () => {
    mockDetail.mockResolvedValue(DETAIL);

    renderAt('ch-1');

    // Identity, including the owner and subscriber count.
    expect(await screen.findByText('Demo Channel')).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    // Subscribers appear in both the header description and a KPI tile.
    expect(screen.getAllByText('12,500').length).toBeGreaterThan(0);

    // The channel's reported average views AND delivery's measured impressions
    // are both shown, each under its own label.
    expect(screen.getAllByText('830').length).toBeGreaterThan(0);
    expect(screen.getByText('Channel average views')).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
    expect(screen.getByText('Measured impressions')).toBeInTheDocument();

    // Success rate and CTR render.
    expect(screen.getAllByText('83.33%').length).toBeGreaterThan(0);
    expect(screen.getByText('2.86%')).toBeInTheDocument();

    expect(mockDetail).toHaveBeenCalledWith('ch-1');
  });

  it('renders a null metric as "Not measurable", not as 0%', async () => {
    mockDetail.mockResolvedValue({
      ...DETAIL,
      delivery: { ...DETAIL.delivery, successRatePct: null },
      reach: { ...DETAIL.reach, impressions: 0, clicks: 0, ctrPct: null },
    });

    renderAt('ch-1');

    expect((await screen.findAllByText('Not measurable')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('0.00%')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows the not-found state on a 404', async () => {
    mockDetail.mockRejectedValue(
      Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND', status: 404 }),
    );

    renderAt('missing');

    expect(await screen.findByText('Channel not found')).toBeInTheDocument();
    expect(screen.getByText(/No channel exists with id/)).toBeInTheDocument();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });
});
