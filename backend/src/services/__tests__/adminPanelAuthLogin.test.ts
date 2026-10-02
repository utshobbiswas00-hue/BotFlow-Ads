import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The username + password door into the panel, on its rejection paths.
 *
 * This file exists because nothing tested `loginWithPassword` at all, and that is how
 * a trap survived: every rejection returns the same `401 Invalid username or password`
 * (deliberately — the caller must not learn which half was wrong), but the operator
 * has to be able to fix their own deployment. Three different causes produced that one
 * message:
 *
 *   1. a username shorter than 3 or a password shorter than 8 — silently, with no log
 *      line anywhere, so a correct username and a correct hash still failed from every
 *      browser and left nothing to search the logs for;
 *   2. a username or password that does not match the configured value;
 *   3. an `ADMIN_PANEL_ADMIN_TELEGRAM_ID` with no `users` row behind it.
 *
 * The fix was to make the server log say which, and these tests hold it there. What is
 * asserted about the logging is only ever shape and booleans: the password and the
 * configured hash must never reach a log record.
 */
vi.mock('../../config/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/env', () => ({
  env: {
    ADMIN_PANEL_USERNAME: 'operator',
    // Replaced per-test with a real scrypt hash of the test password.
    ADMIN_PANEL_PASSWORD_HASH: '',
    ADMIN_PANEL_ADMIN_TELEGRAM_ID: '900000001',
    NODE_ENV: 'test',
  },
}));

vi.mock('../../db/prisma', () => ({
  prisma: { user: { findUnique: vi.fn(async () => null) } },
}));

const GOOD_PASSWORD = 'TheRealPassword123';

let svc: typeof import('../adminPanelAuth.service');
let envMod: { env: Record<string, string> };
let loggerMod: { logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } };
let prismaMod: { prisma: { user: { findUnique: ReturnType<typeof vi.fn> } } };

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.JWT_SECRET = 'test-secret-do-not-use';
});

beforeEach(async () => {
  vi.resetModules();
  svc = await import('../adminPanelAuth.service');
  envMod = (await import('../../config/env')) as never;
  loggerMod = (await import('../../config/logger')) as never;
  prismaMod = (await import('../../db/prisma')) as never;
  const { hashPassword } = await import('../../utils/password');
  envMod.env.ADMIN_PANEL_USERNAME = 'operator';
  envMod.env.ADMIN_PANEL_PASSWORD_HASH = hashPassword(GOOD_PASSWORD);
  envMod.env.ADMIN_PANEL_ADMIN_TELEGRAM_ID = '900000001';
  loggerMod.logger.warn.mockClear();
  loggerMod.logger.error.mockClear();
  prismaMod.prisma.user.findUnique.mockClear();
});

describe('credentials below the minimum length', () => {
  it('rejects a 7-character password and says so in the log', async () => {
    await expect(svc.loginWithPassword('operator', 'short12')).rejects.toThrow(
      /Invalid username or password/,
    );

    // The log is the whole point: this branch used to be silent, so an operator with a
    // correct username and a correct hash had nothing to go on. Lengths, not values.
    expect(loggerMod.logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerMod.logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/minimum credential length/i);
    expect(fields).toMatchObject({ passwordLength: 7, usernameLength: 8 });
    expect(fields).not.toHaveProperty('password');
  });

  it('rejects a 2-character username before it ever compares anything', async () => {
    await expect(svc.loginWithPassword('op', GOOD_PASSWORD)).rejects.toThrow(
      /Invalid username or password/,
    );
    expect(loggerMod.logger.warn.mock.calls[0]?.[1]).toMatch(/minimum credential length/i);
    // Nothing was compared, so nothing was looked up.
    expect(prismaMod.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('mismatched credentials', () => {
  it('logs that the username was the wrong half, and that the hash looked intact', async () => {
    await expect(svc.loginWithPassword('operatr', GOOD_PASSWORD)).rejects.toThrow(
      /Invalid username or password/,
    );

    const [fields, message] = loggerMod.logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/bad credentials/i);
    expect(fields).toMatchObject({ usernameMatch: false, passwordMatch: true });
    // Distinguishes "you typed the wrong thing" from "the hash was truncated on paste".
    expect(fields).toMatchObject({ configuredHashIsScrypt: true, configuredHashLength: 178 });
    expect(fields).not.toHaveProperty('password');
    expect(fields).not.toHaveProperty('configuredHash');
  });

  it('logs that the password was the wrong half', async () => {
    await expect(svc.loginWithPassword('operator', 'TheRealPassword124')).rejects.toThrow(
      /Invalid username or password/,
    );

    const [fields, message] = loggerMod.logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/bad credentials/i);
    expect(fields).toMatchObject({ usernameMatch: true, passwordMatch: false });
  });

  it('flags a hash that is not a scrypt hash at all', async () => {
    envMod.env.ADMIN_PANEL_PASSWORD_HASH = 'MyPlainPassword123';

    await expect(svc.loginWithPassword('operator', GOOD_PASSWORD)).rejects.toThrow(
      /Invalid username or password/,
    );

    const [fields] = loggerMod.logger.warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ passwordMatch: false, configuredHashIsScrypt: false });
  });
});

describe('the configured Telegram id', () => {
  it('says plainly that the id has no user row behind it', async () => {
    prismaMod.prisma.user.findUnique.mockResolvedValue(null);

    await expect(svc.loginWithPassword('operator', GOOD_PASSWORD)).rejects.toThrow(
      /Invalid username or password/,
    );

    // Correct credentials got past both checks, so the failure is the third cause.
    expect(prismaMod.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMod.prisma.user.findUnique.mock.calls[0][0]).toMatchObject({
      where: { telegramId: 900000001n },
    });
    const [fields, message] = loggerMod.logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/no user row/i);
    expect(fields).toMatchObject({ telegramId: '900000001' });
  });
});

describe('the boot-time warning', () => {
  it('warns with the fix when the configured Telegram id has no user row', async () => {
    prismaMod.prisma.user.findUnique.mockResolvedValue(null);

    await svc.warnIfPanelAdminHasNoUser();

    // The point is the deploy log: an operator who never sent /start to the bot gets
    // told that here, instead of inferring it from a generic 401 at the login form.
    expect(loggerMod.logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = loggerMod.logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toMatch(/no user row/i);
    expect(message).toMatch(/\/start/);
    expect(fields).toMatchObject({ telegramId: '900000001' });
    // Nothing fatal: the deployment has to stay up so the operator can fix it.
    expect(loggerMod.logger.error).not.toHaveBeenCalled();
  });

  it('stays quiet when the row exists', async () => {
    prismaMod.prisma.user.findUnique.mockResolvedValue({ id: 'usr_1' });

    await svc.warnIfPanelAdminHasNoUser();

    expect(loggerMod.logger.warn).not.toHaveBeenCalled();
  });

  it('does not touch the database when the password door is not configured', async () => {
    envMod.env.ADMIN_PANEL_PASSWORD_HASH = '';

    await svc.warnIfPanelAdminHasNoUser();

    expect(prismaMod.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(loggerMod.logger.warn).not.toHaveBeenCalled();
  });
});
