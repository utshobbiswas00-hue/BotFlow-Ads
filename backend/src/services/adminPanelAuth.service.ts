import type { AdminRole } from '@prisma/client';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../db/prisma';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import { safeEqual, verifyPassword } from '../utils/password';

/**
 * Staff panel login (username + password).
 *
 * Scope, as specified: username + password only. No 2FA, no server-side session
 * store, no CSRF token. Each of those omissions is deliberate and has a
 * consequence worth stating plainly:
 *
 *  - No session store: the credential is exchanged once for a signed,
 *    self-expiring token. There is no session table to revoke, so revocation
 *    works the other way round — `requireAdmin` re-reads the AdminUser row on
 *    EVERY request, so deactivating an admin ends their access immediately even
 *    though the token is still technically valid. That is a stronger property
 *    than a revocable session, not a weaker one.
 *  - No CSRF token: CSRF exists to stop another site from riding a cookie the
 *    browser attaches automatically. This panel sends the token in an explicit
 *    `x-admin-token` header and sets no cookie, so a cross-site form post cannot
 *    carry it. The protection is architectural; there is nothing to add.
 *  - No 2FA: a single factor. The password therefore lives only in an
 *    environment variable on the server — never in the repository, never in the
 *    database — because a committed password is a published password.
 *
 * This is an ADDITIONAL door. Telegram initData still works exactly as before,
 * so breaking this login cannot lock an operator out of the panel.
 */

/* ------------------------------------------------------------------
 *  Credentials
 * ------------------------------------------------------------------ */

export interface PanelIdentity {
  adminId: string;
  adminUserId: string;
  telegramId: string;
  name: string;
  role: AdminRole;
  permissions: string[];
}

/**
 * True when a panel login is configured at all. All three values are required:
 * a username with no hash would be a login nobody can pass, and a login with no
 * linked Telegram id would have no actor to attribute an action to — and every
 * admin route writes audit rows against a real `AdminUser`.
 */
export function isPanelLoginEnabled(): boolean {
  return Boolean(
    env.ADMIN_PANEL_USERNAME && env.ADMIN_PANEL_PASSWORD_HASH && env.ADMIN_PANEL_ADMIN_TELEGRAM_ID,
  );
}

/**
 * Exchange a username + password for an admin identity.
 *
 * Failure modes are deliberately indistinguishable to the caller: a wrong
 * username, a wrong password and an unlinked Telegram id all produce the same
 * 401. The server log says which, because the operator needs to be able to fix
 * a misconfiguration.
 */
/**
 * Say at boot when the password door cannot be completed, instead of leaving it to be
 * discovered one failed login at a time.
 *
 * The door needs a `users` row behind `ADMIN_PANEL_ADMIN_TELEGRAM_ID`: the row is
 * created when that Telegram account first opens the bot, every panel action is
 * attributed to it, and without it every login returns the same
 * `401 Invalid username or password` as a wrong password. An operator with correct
 * credentials therefore has no way to tell the two apart from the login form, and
 * nothing in the deploy log mentioned it either.
 *
 * Deliberately a warning, not a refusal: the row may legitimately not exist yet — the
 * operator has to send /start to the bot first — and refusing to boot would take away
 * the very deployment they need in order to do that.
 */
export async function warnIfPanelAdminHasNoUser(): Promise<void> {
  if (!isPanelLoginEnabled()) return;

  const telegramId = env.ADMIN_PANEL_ADMIN_TELEGRAM_ID;
  // A non-numeric id is reported by the login path already; saying it twice helps nobody.
  if (!/^\d+$/.test(telegramId)) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  });
  if (user) return;

  logger.warn(
    { telegramId, appUrl: env.APP_URL },
    'panel login cannot be completed yet: ADMIN_PANEL_ADMIN_TELEGRAM_ID has no user row — ' +
      'open the bot with that Telegram account and send /start once. Until then every login ' +
      'returns "Invalid username or password" even when the credentials are correct.',
  );
}

export async function loginWithPassword(username: string, password: string): Promise<PanelIdentity> {
  if (!isPanelLoginEnabled()) {
    throw new ForbiddenError(
      'Panel login is not configured on this server. Set ADMIN_PANEL_USERNAME, ' +
        'ADMIN_PANEL_PASSWORD_HASH and ADMIN_PANEL_ADMIN_TELEGRAM_ID.',
    );
  }

  // Minimal floor: every non-Telegram door into the panel needs an identifier
  // and a secret. The strength of the secret is the operator's call, but its
  // presence is not optional.
  if (!username || username.length < 3 || !password || password.length < 8) {
    // Logged, though the caller learns nothing. This path used to be silent, which
    // made it the worst kind of misconfiguration: a correct username and a correct
    // hash with a 7-character password produced "Invalid username or password", no
    // log line anywhere, and nothing to search for. Lengths only — never the values.
    logger.warn(
      {
        username,
        usernameLength: username.length,
        passwordLength: password.length,
        minimums: { username: 3, password: 8 },
      },
      'admin panel login rejected: below the minimum credential length',
    );
    throw new UnauthorizedError('Invalid username or password');
  }

  const usernameOk = safeEqual(username, env.ADMIN_PANEL_USERNAME);
  const passwordOk = verifyPassword(password, env.ADMIN_PANEL_PASSWORD_HASH);

  // Both checks always run (no short-circuit) so the response time does not
  // reveal which half was wrong.
  if (!usernameOk || !passwordOk) {
    // The comment above promises the log says which half failed, and the operator
    // needs exactly that: "bad credentials" alone cannot distinguish a typo from a
    // hash that was truncated when it was pasted into a dashboard field. Booleans and
    // lengths only — the password and the hash are never logged.
    logger.warn(
      {
        username,
        usernameMatch: usernameOk,
        passwordMatch: passwordOk,
        configuredUsernameLength: env.ADMIN_PANEL_USERNAME.length,
        configuredHashLength: env.ADMIN_PANEL_PASSWORD_HASH.length,
        configuredHashIsScrypt: env.ADMIN_PANEL_PASSWORD_HASH.startsWith('scrypt$'),
        ip: 'route-logged',
      },
      'admin panel login rejected: bad credentials',
    );
    throw new UnauthorizedError('Invalid username or password');
  }

  const telegramId = env.ADMIN_PANEL_ADMIN_TELEGRAM_ID;
  if (!/^\d+$/.test(telegramId)) {
    logger.error({ telegramId }, 'ADMIN_PANEL_ADMIN_TELEGRAM_ID is not a numeric Telegram id');
    throw new ForbiddenError('Panel login is misconfigured on this server');
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, telegramId: true, firstName: true, lastName: true, username: true, status: true },
  });

  if (!user) {
    logger.error(
      { telegramId },
      'admin panel login: the configured Telegram id has no user row — open the bot with that account once',
    );
    throw new UnauthorizedError('Invalid username or password');
  }

  if (user.status === 'BANNED' || user.status === 'SUSPENDED') {
    throw new ForbiddenError(`This account is ${user.status.toLowerCase()} and cannot use the panel`);
  }

  let admin = await prisma.adminUser.findUnique({ where: { userId: user.id } });

  // Bootstrap. Nothing in the codebase creates an AdminUser — `TELEGRAM_ADMIN_IDS`
  // only decides where alerts are sent — so on a fresh deployment there is no
  // admin row and the panel would be unreachable by anyone. Reaching this line
  // already required the operator-set username AND the operator-set password
  // hash, which is the same trust level as the deployment's other secrets.
  if (!admin) {
    admin = await prisma.adminUser.create({
      data: { userId: user.id, role: 'SUPER_ADMIN', isActive: true },
    });
    logger.warn(
      { adminId: admin.id, telegramId },
      'admin panel login: created the first AdminUser as SUPER_ADMIN from ADMIN_PANEL_ADMIN_TELEGRAM_ID — ' +
        'this happens once per deployment; revoke or lower the role from the panel if that is not intended',
    );
  }

  if (!admin.isActive) {
    throw new ForbiddenError('This admin account is deactivated');
  }

  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  const permissions = Array.isArray(admin.permissions)
    ? (admin.permissions as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  return {
    adminId: admin.id,
    adminUserId: user.id,
    telegramId: user.telegramId.toString(),
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Admin',
    role: admin.role,
    permissions,
  };
}

/**
 * Resolve the acting identity for an AdminUser id.
 *
 * The id comes from a server-side session record, but it is still re-read from
 * the database on every request rather than trusted: a session created while an
 * admin was active must stop working the moment they are deactivated, and the
 * re-read is what makes that immediate instead of "when the session expires".
 */
export async function identityFromAdminId(adminUserId: string): Promise<PanelIdentity> {
  const admin = await prisma.adminUser.findUnique({
    where: { id: adminUserId },
    select: {
      id: true,
      role: true,
      permissions: true,
      isActive: true,
      user: {
        select: { id: true, telegramId: true, firstName: true, lastName: true, username: true, status: true },
      },
    },
  });

  // An admin deactivated a second ago is out now, even though their session is
  // still in the store and not yet expired.
  if (!admin || !admin.isActive) throw new UnauthorizedError('This admin account is no longer active');
  if (admin.user.status === 'BANNED' || admin.user.status === 'SUSPENDED') {
    throw new UnauthorizedError('This admin account is no longer active');
  }

  const permissions = Array.isArray(admin.permissions)
    ? (admin.permissions as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  return {
    adminId: admin.id,
    adminUserId: admin.user.id,
    telegramId: admin.user.telegramId.toString(),
    name:
      [admin.user.firstName, admin.user.lastName].filter(Boolean).join(' ') ||
      admin.user.username ||
      'Admin',
    role: admin.role,
    permissions,
  };
}
