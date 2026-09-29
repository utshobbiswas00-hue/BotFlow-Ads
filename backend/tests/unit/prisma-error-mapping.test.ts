import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { mapPrismaError } from '../../src/middleware/errorHandler';

/**
 * A deploy that ships code ahead of its migrations queries columns the database
 * does not have yet. Before this mapping that arrived as a bare "Database
 * error" — indistinguishable from a bug in the code — which is exactly how a
 * missing `posting_schedule` column read on the publisher's screen.
 */
function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: '5.22.0', meta });
}

describe('mapPrismaError', () => {
  it('points at the migrations when the database is behind the code', () => {
    for (const code of ['P2021', 'P2022']) {
      const mapped = mapPrismaError(known(code));
      expect(mapped.status).toBe(503);
      expect(mapped.code).toBe('SCHEMA_OUT_OF_DATE');
      // The client is told to retry; the tooling hint belongs in the log, not
      // on the screen of whoever is holding the phone.
      expect(mapped.message).toMatch(/try again/i);
      expect(mapped.message).not.toMatch(/prisma|migrate/i);
    }
  });

  it('keeps the mappings that already existed', () => {
    expect(mapPrismaError(known('P2002', { target: ['username'] }))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
    expect(mapPrismaError(known('P2003'))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(mapPrismaError(known('P2025'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(mapPrismaError(known('P2034'))).toMatchObject({ status: 409, code: 'CONFLICT' });
    // An unrecognised code is still a 500 rather than a guess.
    expect(mapPrismaError(known('P9999'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});
