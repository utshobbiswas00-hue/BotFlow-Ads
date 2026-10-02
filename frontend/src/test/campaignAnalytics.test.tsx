/**
 * Per-campaign analytics (§40) — client contract.
 *
 * The screen is read-only; the parts worth pinning are the ones a naive
 * implementation gets wrong:
 *  - the headline metrics and the identity block render from the payload;
 *  - a nullable metric (`successRatePct` / `ctrPct`) is shown as
 *    "Not measurable" in words, never as "0%" — null is not a measurement;
 *  - a 404 renders the dedicated "not found" state, not a generic error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignAnalyticsPage } from '../admin/pages/CampaignAnalytics';
import { getCampaignAnalyticsDetail } from '../admin/lib/api';

vi.mock('../admin/lib/api', () => ({
  getCampaignAnalyticsDetail: vi.fn(),
}));

const mockDetail = vi.mocked(getCampaignAnalyticsDetail);

const DETAIL = {
  campaign: {
    id: 'camp-1',
    name: 'Spring Launch',
    status: 'RUNNING',
    advertiserName: 'Acme Ads',
    createdAt: '2026-09-01T00:00:00.000Z',
    startAt: '2026-09-02T00:00:00.000Z',
    endAt: '2026-09-30T00:00:00.000Z',
  },
  budget: { totalCents: 500000, spentCents: 125000, reservedCents: 5000, remainingCents: 370000 },
  delivery: { scheduled: 10, published: 9, failed: 1, cancelled: 0, successRatePct: 90 },
  reach: { channels: 4, impressions: 100000, clicks: 2500, ctrPct: 2.5 },
};

function renderAt(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/admin/campaigns/${id}/analytics`]}>
        <Routes>
          <Route path="/admin/campaigns/:campaignId/analytics" element={<CampaignAnalyticsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CampaignAnalyticsPage', () => {
  it('renders the campaign identity and headline metrics from the payload', async () => {
    mockDetail.mockResolvedValue(DETAIL);

    renderAt('camp-1');

    // Identity, including the advertiser.
    expect(await screen.findByText('Spring Launch')).toBeInTheDocument();
    expect(screen.getByText(/Acme Ads/)).toBeInTheDocument();

    // Headline numbers: spend, success rate and CTR. Each is shown both as a
    // KPI tile and in its breakdown table, hence getAllByText.
    expect(screen.getAllByText('$1,250.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('90.00%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.50%').length).toBeGreaterThan(0);

    // Impressions and clicks are shown and labelled separately.
    expect(screen.getByText('100,000')).toBeInTheDocument();
    expect(screen.getByText(/Impressions \(CPM-measured\)/)).toBeInTheDocument();

    expect(mockDetail).toHaveBeenCalledWith('camp-1');
  });

  it('renders a null metric as "Not measurable", not as 0%', async () => {
    mockDetail.mockResolvedValue({
      ...DETAIL,
      delivery: { ...DETAIL.delivery, successRatePct: null },
      reach: { ...DETAIL.reach, impressions: 0, clicks: 0, ctrPct: null },
    });

    renderAt('camp-1');

    // Both the success rate and the CTR are unmeasured.
    expect((await screen.findAllByText('Not measurable')).length).toBeGreaterThanOrEqual(2);

    // Nothing claims a 0% measurement.
    expect(screen.queryByText('0.00%')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows the not-found state on a 404', async () => {
    mockDetail.mockRejectedValue(
      Object.assign(new Error('Campaign not found'), { code: 'NOT_FOUND', status: 404 }),
    );

    renderAt('missing');

    expect(await screen.findByText('Campaign not found')).toBeInTheDocument();
    expect(screen.getByText(/No campaign exists with id/)).toBeInTheDocument();
    // It is the specific not-found state, not the generic failure block.
    expect(screen.queryByText('Could not load this')).toBeNull();
  });
});
