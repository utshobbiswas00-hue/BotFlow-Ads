/**
 * BOTFLOW ADS — idempotent seed.
 *
 * Run it with:
 *   cd backend && npx tsx prisma/seed.ts
 * or from the repo root:
 *   npm run db:seed
 *
 * Idempotency rules (safe to run on every deploy):
 *   - settings: `upsert` with an EMPTY `update` — a value an admin edited
 *     in the Admin Panel is NEVER overwritten by re-seeding.
 *   - users / wallets / admin rows: `upsert` on the natural unique keys
 *     (telegramId, userId), with empty updates where no default is owed.
 *   - the only deliberate re-assertion is `AdminUser.isActive = true`, so
 *     the seeded admin account can never be left deactivated by the seed.
 *     The admin's ROLE is set at creation and never forced on re-runs, so
 *     a later demotion/role change survives re-seeding.
 *
 * Exits 0 on success, 1 on any error (Render/CI can gate on this).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma';
import { env } from '../src/config/env';
import { SETTING_DEFAULTS } from '../src/config/constants';
import { referralCode } from '../src/utils/crypto';

const created: string[] = [];
const skipped: string[] = [];

function log(kind: 'created' | 'skipped', line: string): void {
  (kind === 'created' ? created : skipped).push(line);
  console.log(`[seed]   ${kind === 'created' ? 'created' : 'skipped '} ${line}`);
}

/** Match the Setting.valueType convention: int | bool | json | string. */
function valueTypeOf(value: unknown): string {
  if (typeof value === 'number') return 'int';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'json';
  return 'string';
}

/** Generate a referral code that does not collide with an existing one. */
async function uniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 8; i += 1) {
    const code = referralCode(8);
    const clash = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return referralCode(12);
}

/** 1. Business defaults — insert once, never touch again. */
async function seedSettings(): Promise<void> {
  console.log(`[seed] settings: ${Object.keys(SETTING_DEFAULTS).length} key(s) from SETTING_DEFAULTS`);

  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) {
      log('skipped', `setting "${key}" (already present — existing value preserved)`);
      continue;
    }
    // upsert with empty update: even under a race (two seeds at once) the
    // second run cannot clobber the first row's value.
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, valueType: valueTypeOf(value) },
      update: {},
    });
    log('created', `setting "${key}" = ${JSON.stringify(value)}`);
  }
}

/** 2. Admin users — one SUPER_ADMIN per id in TELEGRAM_ADMIN_IDS. */
async function seedAdmins(): Promise<void> {
  const ids = env.TELEGRAM_ADMIN_IDS;

  if (ids.length === 0) {
    console.log('[seed] TELEGRAM_ADMIN_IDS is empty — no admin users to seed');
    return;
  }

  for (const rawId of ids) {
    let telegramId: bigint;
    try {
      telegramId = BigInt(rawId);
    } catch {
      log('skipped', `admin "${rawId}" is not a valid Telegram user id — skipped`);
      continue;
    }

    const key = `admin telegramId=${telegramId}`;
    const existing = await prisma.user.findUnique({
      where: { telegramId },
      include: { wallet: true, adminUser: true },
    });

    // 2a. User (telegramId is unique) — empty update keeps the real profile.
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: {},
      create: {
        telegramId,
        firstName: 'Admin',
        referralCode: await uniqueReferralCode(),
      },
    });
    log(existing ? 'skipped' : 'created', `${key} user${existing ? ' (already present)' : ''}`);

    // 2b. Wallet — one per user, zeroed balances.
    const wallet = await prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
    log(existing?.wallet ? 'skipped' : 'created', `${key} wallet${existing?.wallet ? ' (already present)' : ''}`);

    // 2c. Admin row — SUPER_ADMIN + active at creation; on re-runs we only
    //     re-assert isActive so the seeded admin stays usable, without
    //     forcing the role back if an admin changed it later.
    const admin = await prisma.adminUser.upsert({
      where: { userId: user.id },
      update: { isActive: true },
      create: { userId: user.id, role: 'SUPER_ADMIN', isActive: true },
    });
    log(
      existing?.adminUser ? 'skipped' : 'created',
      `${key} adminUser role=${admin.role} isActive=${admin.isActive}${existing?.adminUser ? ' (already present)' : ''}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('[seed] === BotFlow Ads idempotent seed ===');

  await seedSettings();
  await seedAdmins();

  // Premium plans. Idempotent: an admin-edited plan is never overwritten.
  try {
    const { seedDefaultPlans } = await import('../src/services/premium.service');
    const plansCreated = await seedDefaultPlans();
    if (plansCreated > 0) {
      created.push(`${plansCreated} premium plan(s)`);
    } else {
      skipped.push('premium plans (already present)');
    }
  } catch (err) {
    console.warn('[seed] could not seed premium plans:', err instanceof Error ? err.message : err);
  }

  // BotFlow's own promotion creatives. Always English; idempotent.
  try {
    const { seedDefaultHouseAds } = await import('../src/services/houseAd.service');
    const adsCreated = await seedDefaultHouseAds();
    if (adsCreated > 0) {
      created.push(`${adsCreated} house ad creative(s)`);
    } else {
      skipped.push('house ads (already present)');
    }
  } catch (err) {
    console.warn('[seed] could not seed house ads:', err instanceof Error ? err.message : err);
  }

  console.log('[seed] --------------------------------------------------');
  console.log(`[seed] summary: ${created.length} created, ${skipped.length} skipped`);
  if (created.length) {
    console.log('[seed] created:');
    for (const line of created) console.log(`[seed]   + ${line}`);
  }
  if (skipped.length) {
    console.log('[seed] skipped:');
    for (const line of skipped) console.log(`[seed]   = ${line}`);
  }
  console.log('[seed] done.');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed] FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore — we are already failing */
  }
  process.exit(1);
});
