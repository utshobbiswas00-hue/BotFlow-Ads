import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-FREE unit tests for `alertAdmins` persistence.
 *
 * `alertAdmins` pages the Telegram admin ids AND writes one `AdminNotification`
 * row per ACTIVE admin — into the SEPARATE admin table keyed to the `AdminUser`
 * (the ROLE), never the recipient's personal `Notification` inbox.
 *
 * The Telegram behaviour must be exactly as it always was, and the persistence
 * must never throw into its alert-path callers.
 *
 * Prisma, Telegram and the queue producers are mocked — nothing connects.
 */

vi.mock('../../db/prisma', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    adminUser: { findMany: vi.fn() },
    notification: { createMany: vi.fn(), updateMany: vi.fn() },
    adminNotification: { createMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock('../../utils/telegram', () => ({
  sendUserMessage: vi.fn(async () => true),
  sendUserMessageDetailed: vi.fn(async () => ({
    ok: true,
    messageId: 1n,
    error: null,
    permanent: false,
  })),
}));

vi.mock('../../queues/producers', () => ({
  enqueueNotification: vi.fn(async () => undefined),
}));

vi.mock('../../utils/mailer', () => ({
  notificationEmailHtml: vi.fn(() => ''),
  sendMail: vi.fn(async () => undefined),
}));

vi.mock('../../services/email.service', () => ({
  sendTransactionalEmail: vi.fn(async () => undefined),
}));

import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { sendUserMessage } from '../../utils/telegram';
import { enqueueNotification } from '../../queues/producers';
import { alertAdmins } from '../notification.service';

const userFindMany = vi.mocked(prisma.user.findMany);
const adminUserFindMany = vi.mocked(prisma.adminUser.findMany);
const notificationCreateMany = vi.mocked(prisma.notification.createMany);
const notificationUpdateMany = vi.mocked(prisma.notification.updateMany);
const adminNotificationCreateMany = vi.mocked(prisma.adminNotification.createMany);
const sendUserMessageMock = vi.mocked(sendUserMessage);
const enqueueNotificationMock = vi.mocked(enqueueNotification);

const mutableEnv = env as unknown as { TELEGRAM_ADMIN_IDS: string[] };
const ORIGINAL_ADMIN_IDS = mutableEnv.TELEGRAM_ADMIN_IDS;

function activeAdminRows(...adminIds: string[]) {
  return adminIds.map((id) => ({ id })) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.TELEGRAM_ADMIN_IDS = ORIGINAL_ADMIN_IDS;
  userFindMany.mockResolvedValue([{ telegramId: 111n }, { telegramId: 222n }] as never);
  adminUserFindMany.mockResolvedValue(activeAdminRows('a1', 'a2'));
  notificationCreateMany.mockResolvedValue({ count: 2 } as never);
  adminNotificationCreateMany.mockResolvedValue({ count: 2 } as never);
  sendUserMessageMock.mockResolvedValue(true as never);
});

afterEach(() => {
  mutableEnv.TELEGRAM_ADMIN_IDS = ORIGINAL_ADMIN_IDS;
});

describe('alertAdmins — persistence', () => {
  it('creates one SYSTEM AdminNotification row per ACTIVE admin, scoped to their admin ids', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];

    await alertAdmins('Duplicate charge detected');

    expect(adminUserFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
    expect(adminNotificationCreateMany).toHaveBeenCalledTimes(1);
    const data = adminNotificationCreateMany.mock.calls[0][0]?.data as unknown as Array<
      Record<string, unknown>
    >;
    expect(data).toHaveLength(2);
    expect(data).toEqual([
      {
        adminId: 'a1',
        type: 'SYSTEM',
        title: 'Admin alert',
        body: 'Duplicate charge detected',
        data: { source: 'alertAdmins' },
      },
      {
        adminId: 'a2',
        type: 'SYSTEM',
        title: 'Admin alert',
        body: 'Duplicate charge detected',
        data: { source: 'alertAdmins' },
      },
    ]);
  });

  it('an admin’s alerts are independent of their personal Notification inbox', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];

    await alertAdmins('Independence check');

    // The durable copy lands in the admin table…
    expect(adminNotificationCreateMany).toHaveBeenCalledTimes(1);
    // …and writing an alert creates NO row in the personal inbox.
    expect(notificationCreateMany).not.toHaveBeenCalled();
    expect(notificationUpdateMany).not.toHaveBeenCalled();
  });

  it('a deactivated admin (isActive false) receives no alert row', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];
    // The query filters isActive: true, so a deactivated admin is simply not
    // returned — only the active admin gets a row.
    adminUserFindMany.mockResolvedValue([{ id: 'admin-active' }] as never);

    await alertAdmins('Ops note');

    expect(adminUserFindMany).toHaveBeenCalledWith({
      where: { isActive: true },
      select: { id: true },
    });
    const data = adminNotificationCreateMany.mock.calls[0][0]?.data as unknown as Array<
      Record<string, unknown>
    >;
    expect(data).toHaveLength(1);
    expect(data.map((d) => d.adminId)).toEqual(['admin-active']);
    expect(data.some((d) => d.adminId === 'admin-inactive')).toBe(false);
  });

  it('still sends the Telegram page exactly as before', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];

    await alertAdmins('Withdrawal needs review');

    expect(sendUserMessageMock).toHaveBeenCalledTimes(2);
    const [chatId, text] = sendUserMessageMock.mock.calls[0];
    expect(chatId).toBe(111n);
    expect(text).toContain('Admin Alert');
    expect(text).toContain('Withdrawal needs review');
  });

  it('does NOT enqueue a second Telegram push (silent persistence)', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];

    await alertAdmins('Delivery failures spiking');

    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it('is non-throwing when the admin lookup fails, and Telegram still goes out', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];
    adminUserFindMany.mockRejectedValue(new Error('db down') as never);

    await expect(alertAdmins('Fraud scan found issues')).resolves.toBeUndefined();
    expect(sendUserMessageMock).toHaveBeenCalledTimes(2);
  });

  it('is non-throwing when the admin insert fails, and Telegram still goes out', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];
    adminNotificationCreateMany.mockRejectedValue(new Error('insert failed') as never);

    await expect(alertAdmins('Blocked deposit')).resolves.toBeUndefined();
    expect(sendUserMessageMock).toHaveBeenCalledTimes(2);
  });

  it('still persists the durable rows when TELEGRAM_ADMIN_IDS is empty', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = [];

    await expect(alertAdmins('Silent-deployment alert')).resolves.toBeUndefined();

    // No chat recipients → no Telegram push…
    expect(sendUserMessageMock).not.toHaveBeenCalled();
    // …but the admin inbox is not empty: the row survives in-app.
    expect(adminNotificationCreateMany).toHaveBeenCalledTimes(1);
    expect(
      (adminNotificationCreateMany.mock.calls[0][0]?.data as unknown as unknown[]).length,
    ).toBe(2);
  });

  it('persists nothing when there are no active admins, but still pages Telegram', async () => {
    mutableEnv.TELEGRAM_ADMIN_IDS = ['111', '222'];
    adminUserFindMany.mockResolvedValue([] as never);

    await alertAdmins('No active admins');

    expect(adminNotificationCreateMany).not.toHaveBeenCalled();
    expect(sendUserMessageMock).toHaveBeenCalledTimes(2);
  });
});
