import { describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the broadcast audience→where builder and the
 * recipient-limit rule (spec §52).
 *
 * `broadcast.routes.ts` pulls in Prisma, the audit service and the queue
 * producers at import time, so all three are mocked here — no PostgreSQL and no
 * Redis are touched. The two things under test are pure functions, which is
 * exactly why they were separated from the handlers.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    user: { count: vi.fn(), findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock('../../../services/audit.service', () => ({
  recordAudit: vi.fn(async () => undefined),
}));

vi.mock('../../../queues/producers', () => ({
  enqueueBroadcast: vi.fn(async () => 'broadcast:test'),
}));

import {
  BROADCAST_MAX_RECIPIENTS,
  broadcastAudienceWhere,
  exceedsRecipientLimit,
  recipientLimitError,
} from '../broadcast.routes';

describe('broadcastAudienceWhere', () => {
  it('ALL is unfiltered — every user is a recipient', () => {
    expect(broadcastAudienceWhere('ALL')).toEqual({});
  });

  it('PUBLISHERS derives from the channel RELATIONSHIP, not the cached flag', () => {
    expect(broadcastAudienceWhere('PUBLISHERS')).toEqual({ channels: { some: {} } });
  });

  it('ADVERTISERS derives from the campaign RELATIONSHIP, not the cached flag', () => {
    expect(broadcastAudienceWhere('ADVERTISERS')).toEqual({ campaigns: { some: {} } });
  });

  it('never references the cached isPublisher / isAdvertiser columns', () => {
    for (const audience of ['ALL', 'PUBLISHERS', 'ADVERTISERS'] as const) {
      const where = JSON.stringify(broadcastAudienceWhere(audience));
      expect(where).not.toContain('isPublisher');
      expect(where).not.toContain('isAdvertiser');
    }
  });
});

describe('recipient limit', () => {
  it('is 100, server-side', () => {
    expect(BROADCAST_MAX_RECIPIENTS).toBe(100);
  });

  it('allows an empty audience and every count up to and including the limit', () => {
    for (const n of [0, 1, 99, 100]) {
      expect(exceedsRecipientLimit(n)).toBe(false);
    }
  });

  it('rejects the first count above the limit', () => {
    expect(exceedsRecipientLimit(101)).toBe(true);
    expect(exceedsRecipientLimit(1000)).toBe(true);
  });

  it('the 400 names BOTH the actual count and the limit', () => {
    const err = recipientLimitError(250);
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('250');
    expect(err.message).toContain('100');
  });
});
