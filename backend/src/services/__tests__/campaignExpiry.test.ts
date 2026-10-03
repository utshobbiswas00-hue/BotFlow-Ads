import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ending a campaign whose window has closed.
 *
 * The expiry sweep used to cancel the campaign's queued jobs and hand it to
 * `maybeCompleteCampaign`, which writes COMPLETED. `EXPIRED` — a state the enum declares
 * and every status filter and report understands — was never written once, so a campaign
 * the deadline had cut short was reported as having completed, everywhere.
 *
 * The state machine itself is exercised for real (not mocked): that it permits
 * `APPROVED → EXPIRED` is part of the fix, because the sweep selects APPROVED campaigns
 * too and `assertTransition` would otherwise refuse every pass.
 *
 * No database is touched.
 */
const mocks = vi.hoisted(() => ({
  deliveryJobCount: vi.fn(),
  campaignFindUnique: vi.fn(),
  transaction: vi.fn(),
  txCampaignFindUnique: vi.fn(),
  txCampaignUpdate: vi.fn(),
  txAuditCreate: vi.fn(),
  releaseCampaignBudget: vi.fn(async () => 0),
  holdCampaignBudget: vi.fn(async () => undefined),
}));

vi.mock('../../db/prisma', () => ({
  prisma: {
    deliveryJob: { count: mocks.deliveryJobCount },
    campaign: { findUnique: mocks.campaignFindUnique },
  },
  transaction: mocks.transaction,
}));

vi.mock('../escrow.service', () => ({
  holdCampaignBudget: mocks.holdCampaignBudget,
  releaseCampaignBudget: mocks.releaseCampaignBudget,
}));

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Everything else campaign.service imports at load time; none of it is exercised here.
vi.mock('../urlSecurity.service', () => ({ validateDestinationUrl: vi.fn() }));
vi.mock('../categoryPolicy.service', () => ({ evaluateCampaignCategory: vi.fn() }));
vi.mock('../duplicate.service', () => ({ detectDuplicateCampaign: vi.fn() }));
vi.mock('../creative.service', () => ({ createCreativeVersions: vi.fn() }));
vi.mock('../blocklist.service', () => ({ blockedChannelIdsForCampaign: vi.fn(async () => []) }));
vi.mock('../reachEstimator.service', () => ({ computeReachPlan: vi.fn() }));
vi.mock('../settings.service', () => ({ businessRules: vi.fn(async () => ({})) }));
vi.mock('../premium.service', () => ({
  FREE_ENTITLEMENTS: {},
  checkQuota: vi.fn(),
  entitlementsFor: vi.fn(),
}));
vi.mock('../audit.service', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../targeting.service', () => ({
  resolveTargets: vi.fn(),
  snapshotPriceCents: vi.fn(),
}));
vi.mock('../../queues/producers', () => ({
  cancelDeliveryJob: vi.fn(async () => true),
  enqueuePublishAd: vi.fn(async () => 'job'),
  emitWebhookEvent: vi.fn(async () => undefined),
}));

import { finaliseExpiredCampaign, maybeCompleteCampaign } from '../campaign.service';
import { ALLOWED_TRANSITIONS, canTransition } from '../campaignStateMachine';

const tx = {
  campaign: { findUnique: mocks.txCampaignFindUnique, update: mocks.txCampaignUpdate },
  auditLog: { create: mocks.txAuditCreate },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  mocks.txCampaignFindUnique.mockResolvedValue({ id: 'cmp_1', status: 'RUNNING' });
  mocks.txCampaignUpdate.mockResolvedValue({ id: 'cmp_1' });
  mocks.txAuditCreate.mockResolvedValue({ id: 'audit_1' });
});

/** `deliveryJob.count` is asked twice with distinguishable filters. */
function counts(inFlight: number, cancelled: number): void {
  mocks.deliveryJobCount.mockImplementation(async ({ where }: { where: { status: unknown } }) => {
    const status = where.status;
    return Array.isArray((status as { in?: unknown[] } | undefined)?.in) ? inFlight : cancelled;
  });
}

describe('the transition table', () => {
  it('allows a campaign that ran out of time to expire from every pre-terminal state', () => {
    for (const from of ['APPROVED', 'SCHEDULED', 'RUNNING', 'PAUSED'] as const) {
      expect(canTransition(from, 'EXPIRED')).toBe(true);
    }
  });

  it('keeps EXPIRED terminal', () => {
    expect(ALLOWED_TRANSITIONS.EXPIRED).toEqual([]);
  });

  it('does not allow an expired campaign to become completed', () => {
    expect(canTransition('EXPIRED', 'COMPLETED')).toBe(false);
  });
});

describe('finaliseExpiredCampaign', () => {
  it('writes EXPIRED when the deadline cost the campaign a slot, and releases the escrow', async () => {
    counts(0, 2);
    mocks.campaignFindUnique.mockResolvedValue({
      id: 'cmp_1',
      status: 'RUNNING',
      advertiserId: 'adv_1',
    });

    expect(await finaliseExpiredCampaign('cmp_1')).toBe(true);

    expect(mocks.txCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cmp_1' },
        data: expect.objectContaining({ status: 'EXPIRED' }),
      }),
    );
    // The status change is audited inside the same transaction.
    expect(mocks.txAuditCreate).toHaveBeenCalledTimes(1);
    // ...and the unused escrow goes back.
    expect(mocks.releaseCampaignBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ campaignId: 'cmp_1', advertiserId: 'adv_1', reason: 'expired' }),
    );
  });

  it('writes COMPLETED when everything was delivered before the end time', async () => {
    counts(0, 0);
    mocks.campaignFindUnique.mockResolvedValue({
      id: 'cmp_1',
      status: 'RUNNING',
      advertiserId: 'adv_1',
    });

    expect(await finaliseExpiredCampaign('cmp_1')).toBe(true);

    expect(mocks.txCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
    expect(mocks.releaseCampaignBudget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'completed' }),
    );
  });

  it('leaves a campaign alone while any slot is still in flight', async () => {
    counts(1, 0);

    expect(await finaliseExpiredCampaign('cmp_1')).toBe(false);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.releaseCampaignBudget).not.toHaveBeenCalled();
  });

  it('is a no-op for a campaign that has already ended', async () => {
    counts(0, 3);
    mocks.campaignFindUnique.mockResolvedValue({
      id: 'cmp_1',
      status: 'EXPIRED',
      advertiserId: 'adv_1',
    });

    expect(await finaliseExpiredCampaign('cmp_1')).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown campaign', async () => {
    counts(0, 0);
    mocks.campaignFindUnique.mockResolvedValue(null);
    expect(await finaliseExpiredCampaign('nope')).toBe(false);
  });
});

describe('maybeCompleteCampaign', () => {
  it('does not resurrect an expired campaign as completed', async () => {
    // The delivery worker calls this after every terminal job, so a job finishing just
    // after the campaign expired used to flip EXPIRED back to COMPLETED.
    counts(0, 0);
    mocks.campaignFindUnique.mockResolvedValue({
      id: 'cmp_1',
      status: 'EXPIRED',
      advertiserId: 'adv_1',
    });

    expect(await maybeCompleteCampaign('cmp_1')).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('still completes a running campaign whose slots all reached a terminal state', async () => {
    counts(0, 0);
    mocks.campaignFindUnique.mockResolvedValue({
      id: 'cmp_1',
      status: 'RUNNING',
      advertiserId: 'adv_1',
    });

    expect(await maybeCompleteCampaign('cmp_1')).toBe(true);
    expect(mocks.txCampaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
  });
});
