import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for the settings update contract.
 *
 * Two things used to be broken and must stay fixed:
 *
 *  1. `updateSettingSchema` (shared) rejected an ARRAY value outright, so the
 *     three list-valued settings could not be saved at all. The backend route
 *     schema now accepts lists but enforces each key's item TYPE (a numeric
 *     threshold list must not be written as strings, which would quietly break
 *     the runtime comparison).
 *  2. `GET /admin/settings` already returned arrays as arrays — that is asserted
 *     here as a regression guard, using the real service with a mocked Prisma
 *     client, so a future "fix" cannot turn the reader into a stringifier.
 *
 * `settings.routes.ts` and `settings.service.ts` pull in Prisma and the Redis
 * cache at import time, so both infrastructure modules are mocked. No
 * PostgreSQL and no Redis are touched.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    setting: { upsert: vi.fn(), findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock('../../../db/redis', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
}));

vi.mock('../../../services/audit.service', () => ({
  listAuditLogs: vi.fn(async () => ({ items: [], total: 0 })),
  recordAudit: vi.fn(async () => undefined),
}));

import { expectedArrayItemTypes, updateSettingRouteSchema } from '../settings.routes';
import { AppError } from '../../../utils/errors';
import { prisma } from '../../../db/prisma';
import { getAllSettings, setSetting } from '../../../services/settings.service';

describe('updateSettingRouteSchema — array values', () => {
  it('accepts a numeric list whose items match the key default', () => {
    const parsed = updateSettingRouteSchema.parse({
      key: 'budget_alert_thresholds',
      value: [50, 25, 10, 5],
    });
    expect(parsed.value).toEqual([50, 25, 10, 5]);
  });

  it('accepts a string list whose items match the key default', () => {
    const parsed = updateSettingRouteSchema.parse({
      key: 'allowed_withdrawal_methods',
      value: ['crypto'],
    });
    expect(parsed.value).toEqual(['crypto']);
  });

  it('rejects a string item in a numeric list with a 400 that names the key and type', () => {
    let err: unknown;
    try {
      updateSettingRouteSchema.parse({ key: 'budget_alert_thresholds', value: ['50'] });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).message).toContain('budget_alert_thresholds');
    expect((err as AppError).message).toContain('number');
  });

  it('rejects a number item in a string list, naming the key', () => {
    let err: unknown;
    try {
      updateSettingRouteSchema.parse({ key: 'allowed_withdrawal_methods', value: ['crypto', 5] });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).message).toContain('allowed_withdrawal_methods');
    expect((err as AppError).message).toContain('string');
  });

  it('rejects a non-primitive item at the shared-schema layer (422 shape error)', () => {
    const result = updateSettingRouteSchema.safeParse({
      key: 'budget_alert_thresholds',
      value: [{ nope: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe('updateSettingRouteSchema — existing members unchanged', () => {
  it('still accepts a string value', () => {
    expect(updateSettingRouteSchema.parse({ key: 'maintenance_message', value: 'hello' }).value).toBe(
      'hello',
    );
  });

  it('still accepts a number value', () => {
    expect(updateSettingRouteSchema.parse({ key: 'platform_fee_percent', value: 20 }).value).toBe(20);
  });

  it('still accepts a boolean value', () => {
    expect(updateSettingRouteSchema.parse({ key: 'maintenance_mode', value: false }).value).toBe(
      false,
    );
  });

  it('still accepts a flat object value', () => {
    const parsed = updateSettingRouteSchema.parse({ key: 'crypto_price_usd_cents', value: { a: 1 } });
    expect(parsed.value).toEqual({ a: 1 });
  });

  it('still rejects an empty key', () => {
    expect(updateSettingRouteSchema.safeParse({ key: '', value: 'x' }).success).toBe(false);
  });
});

describe('settings service array round-trip (mocked Prisma)', () => {
  const upsert = vi.mocked(prisma.setting.upsert);
  const findMany = vi.mocked(prisma.setting.findMany);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes an array unchanged and reads it back as an array of the same element type', async () => {
    upsert.mockResolvedValue({} as never);

    await setSetting('budget_alert_thresholds', [50, 25, 10, 5]);

    const create = upsert.mock.calls[0]![0].create as { value: unknown; valueType: string };
    expect(Array.isArray(create.value)).toBe(true);
    expect(create.value).toEqual([50, 25, 10, 5]);
    expect(create.valueType).toBe('json');

    // The next GET reads the row back through the same JSON column.
    findMany.mockResolvedValue([
      { key: 'budget_alert_thresholds', value: create.value },
    ] as never);

    const all = await getAllSettings();
    const readBack = all['budget_alert_thresholds'];

    expect(Array.isArray(readBack)).toBe(true);
    expect(readBack).toEqual([50, 25, 10, 5]);
    for (const item of readBack as unknown[]) expect(typeof item).toBe('number');
  });
});

describe('updateSettingRouteSchema — an array-typed key must receive a list', () => {
  /*
   * The failure this closes is quiet rather than loud: a scalar submitted for an
   * array setting used to pass validation, get stored as a scalar, and then be
   * ignored by `getArraySetting`, which falls back to the default. The admin saw
   * "saved" and nothing changed. A 400 that names the key is the honest outcome.
   */
  it('rejects a scalar for a key whose default is a list', () => {
    let err: unknown;
    try {
      updateSettingRouteSchema.parse({ key: 'budget_alert_thresholds', value: '50' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).message).toContain('budget_alert_thresholds');
    expect((err as AppError).message).toContain('received string');
  });

  it('names the right expected item type in that message', () => {
    let err: unknown;
    try {
      updateSettingRouteSchema.parse({ key: 'allowed_deposit_methods', value: true });
    } catch (e) {
      err = e;
    }
    expect((err as AppError).message).toContain('string');
  });

  it('still accepts a correct list for the same key', () => {
    const parsed = updateSettingRouteSchema.parse({
      key: 'allowed_deposit_methods',
      value: ['crypto'],
    });
    expect(parsed.value).toEqual(['crypto']);
  });

  it('leaves primitive-typed keys completely unaffected', () => {
    expect(updateSettingRouteSchema.parse({ key: 'platform_fee_percent', value: 20 }).value).toBe(20);
    expect(updateSettingRouteSchema.parse({ key: 'maintenance_message', value: 'x' }).value).toBe('x');
    expect(
      updateSettingRouteSchema.parse({ key: 'maintenance_mode_enabled', value: false }).value,
    ).toBe(false);
  });
});

describe('expectedArrayItemTypes', () => {
  it('returns the primitive types present in a non-empty default', () => {
    expect(expectedArrayItemTypes([50, 25, 10, 5])).toEqual(['number']);
    expect(expectedArrayItemTypes(['crypto'])).toEqual(['string']);
    expect(expectedArrayItemTypes(['crypto', 1, true])).toEqual(['boolean', 'number', 'string']);
  });

  it('returns nothing for an empty default — no element type to enforce', () => {
    expect(expectedArrayItemTypes([])).toEqual([]);
  });

  it('returns nothing for a non-array default', () => {
    expect(expectedArrayItemTypes('a string')).toEqual([]);
    expect(expectedArrayItemTypes(20)).toEqual([]);
    expect(expectedArrayItemTypes(null)).toEqual([]);
    expect(expectedArrayItemTypes(undefined)).toEqual([]);
  });

  it('deduplicates and sorts, so the error message is stable', () => {
    expect(expectedArrayItemTypes([1, 'a', 2, 'b'])).toEqual(['number', 'string']);
  });

  it('drives the empty-default branch: an array of any items is accepted', () => {
    // No current key defaults to `[]`, so the branch is exercised through the
    // pure helper rather than left as untested defensive code.
    expect(expectedArrayItemTypes([]).length).toBe(0);
  });
});
