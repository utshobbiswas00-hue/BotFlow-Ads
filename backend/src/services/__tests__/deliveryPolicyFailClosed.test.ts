import { describe, expect, it, vi } from 'vitest';
import { DeliveryErrorCode } from '@prisma/client';

/**
 * A post-guarding policy check that cannot be evaluated must not publish.
 *
 * The blocklist re-check at publish time used to `.catch()` into `{ blocked: false }`, so a
 * database or lookup failure published the ad — every time the check was broken, which is
 * exactly when the publisher's refusal could not be evaluated.
 *
 * This covers the piece that decides what happens next: with `POLICY_CHECK_UNAVAILABLE` in
 * the retryable set, `fail()` schedules the bounded retry (nothing has been published yet,
 * so retrying is safe) instead of ending the job terminally on the first hiccup.
 */
vi.mock('../../db/prisma', () => ({
  prisma: { deliveryJob: { findUnique: vi.fn(), update: vi.fn() } },
  transaction: vi.fn(),
}));
vi.mock('../escrow.service', () => ({
  chargeDelivery: vi.fn(),
  releaseJobReservation: vi.fn(),
}));
vi.mock('../settings.service', () => ({ businessRules: vi.fn(async () => ({})) }));
vi.mock('../frequency.service', () => ({
  checkChannelFrequency: vi.fn(),
  checkAdvertiserChannelCooldown: vi.fn(),
}));
vi.mock('../deliveryEvent.service', () => ({ recordDeliveryEvent: vi.fn(async () => undefined) }));
vi.mock('../campaign.service', () => ({ maybeCompleteCampaign: vi.fn(async () => false) }));
vi.mock('../notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
  alertAdmins: vi.fn(async () => undefined),
}));
vi.mock('../blocklist.service', () => ({ isBlocked: vi.fn() }));
vi.mock('../transaction.service', () => ({ ref: { manual: vi.fn(() => 'ref') } }));
vi.mock('../../queues/producers', () => ({ enqueuePublishAd: vi.fn(async () => 'job') }));
vi.mock('../../utils/telegram', () => ({
  describeTelegramError: vi.fn(),
  messageOf: vi.fn(),
  sendChannelPost: vi.fn(),
  truncateForTelegram: (v: string) => v,
}));
vi.mock('../../templates/adPost.template', () => ({ buildSponsoredPostText: vi.fn(() => '') }));

import { isRetryable } from '../delivery.service';

describe('POLICY_CHECK_UNAVAILABLE', () => {
  it('exists on the generated enum, so the schema and the migration agree', () => {
    // A code the code writes but the database enum does not carry would fail at insert
    // time, on the path whose whole purpose is to fail safe.
    expect(DeliveryErrorCode.POLICY_CHECK_UNAVAILABLE).toBe('POLICY_CHECK_UNAVAILABLE');
  });

  it('is retryable', () => {
    expect(isRetryable('POLICY_CHECK_UNAVAILABLE')).toBe(true);
  });

  it('is not treated as a permanent failure', () => {
    // The codes that must never be retried are the ones that either cannot be fixed by
    // retrying (a revoked permission) or might double-publish.
    for (const terminal of [
      'BOT_NOT_ADMIN',
      'MISSING_POST_PERMISSION',
      'PUBLISHER_REJECTED',
      'BUDGET_EXHAUSTED',
      'UNKNOWN',
    ] as const) {
      expect(isRetryable(terminal)).toBe(false);
      expect(isRetryable(terminal)).not.toBe(isRetryable('POLICY_CHECK_UNAVAILABLE'));
    }
  });

  it('sits alongside the other transport-level retries', () => {
    expect(isRetryable('TELEGRAM_API_ERROR')).toBe(true);
    expect(isRetryable('RATE_LIMITED')).toBe(true);
  });
});
