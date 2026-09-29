import type {
  Ad,
  Campaign,
  Channel,
  DeliveryJob,
  HouseAd,
  User,
  Wallet,
} from '@prisma/client';
import type { PostingSchedule } from '@botflow/shared';
import { Prisma, prisma } from '../../src/db/prisma';

/**
 * Test fixtures.
 *
 * Every helper returns the row it created and uses unique identifiers, so a
 * test can build only the state it needs without a shared "global seed".
 * `resetDatabase()` runs before each test to guarantee isolation.
 */

let sequence = Date.now() % 1_000_000_000;

function nextId(): number {
  sequence += 1;
  return sequence;
}

/**
 * Empty every table. TRUNCATE (not DELETE) because it resets sequences and,
 * with CASCADE, does not care about foreign-key ordering.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

  // Settings are read through a Redis cache keyed 'settings:all'. Emptying the
  // `settings` table is not enough: without this, a value written by one test
  // (say `invoice_enabled: false`) stays in the cache and silently applies to
  // every later test in the file — which looks like a product bug, not a leak.
  const { invalidateSettingsCache } = await import('../../src/services/settings.service');
  await invalidateSettingsCache();
}

/* ------------------------------------------------------------------
 *  Users & wallets
 * ------------------------------------------------------------------ */

export interface TestUser extends User {
  wallet: Wallet | null;
}

export async function createUser(
  options: {
    availableCents?: number;
    pendingCents?: number;
    reservedCents?: number;
    status?: 'ACTIVE' | 'PENDING_REVIEW' | 'SUSPENDED' | 'BANNED';
    createdAt?: Date;
    firstName?: string;
  } = {},
): Promise<TestUser> {
  const telegramId = BigInt(nextId());

  return prisma.user.create({
    data: {
      telegramId,
      firstName: options.firstName ?? 'Test User',
      referralCode: `REF${telegramId}`,
      ...(options.status ? { status: options.status } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      wallet: {
        create: {
          availableCents: options.availableCents ?? 0,
          pendingCents: options.pendingCents ?? 0,
          reservedCents: options.reservedCents ?? 0,
        },
      },
    },
    include: { wallet: true },
  });
}

export async function walletOf(userId: string): Promise<Wallet> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error(`No wallet for user ${userId}`);
  return wallet;
}

/** Credit a user's spendable balance directly, bypassing the ledger. */
export async function fundWallet(userId: string, cents: number): Promise<void> {
  await prisma.wallet.update({
    where: { userId },
    data: { availableCents: { increment: cents } },
  });
}

/* ------------------------------------------------------------------
 *  Channels
 * ------------------------------------------------------------------ */

export async function createChannel(
  ownerId: string,
  options: {
    subscriberCount?: number;
    // Mirrors the ChannelStatus enum in schema.prisma exactly — there is no
    // 'PAUSED' channel status; a publisher pauses ads with `acceptAds: false`.
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'ATTENTION_REQUIRED';
    botIsAdmin?: boolean;
    canPostMessages?: boolean;
    acceptAds?: boolean;
    autoApprovePosts?: boolean;
    adPriceCents?: number;
    minAdPriceCents?: number;
    pricingModel?: 'FIXED' | 'CPM' | 'CPC' | 'HYBRID';
    maxPostsPerDay?: number;
    minHoursBetweenAds?: number;
    maxCampaignsPerHour?: number;
    language?: string;
    title?: string;

    postingSchedule?: PostingSchedule | null;
  } = {},
): Promise<Channel> {
  const telegramChannelId = BigInt(-1_000_000_000 - nextId());

  return prisma.channel.create({
    data: {
      ownerId,
      telegramChannelId,
      title: options.title ?? `Test Channel ${telegramChannelId}`,
      status: options.status ?? 'APPROVED',
      subscriberCount: options.subscriberCount ?? 10_000,
      botIsAdmin: options.botIsAdmin ?? true,
      canPostMessages: options.canPostMessages ?? true,
      acceptAds: options.acceptAds ?? true,
      autoApprovePosts: options.autoApprovePosts ?? true,
      adPriceCents: options.adPriceCents ?? 1_000,
      minAdPriceCents: options.minAdPriceCents ?? 0,
      pricingModel: options.pricingModel ?? 'FIXED',
      maxPostsPerDay: options.maxPostsPerDay ?? 100,
      minHoursBetweenAds: options.minHoursBetweenAds ?? 0,
      maxCampaignsPerHour: options.maxCampaignsPerHour ?? 100,
      language: options.language ?? 'en',
      ...(options.postingSchedule !== undefined
        ? { postingSchedule: options.postingSchedule ?? Prisma.DbNull }
        : {}),
    },
  });
}

/* ------------------------------------------------------------------
 *  Campaigns, creatives and delivery jobs
 * ------------------------------------------------------------------ */

export async function createCampaign(
  advertiserId: string,
  options: {
    budgetTotalCents?: number;
    budgetSpentCents?: number;
    budgetReservedCents?: number;
    status?: 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'REJECTED';
    platformFeePercent?: number;
    language?: string;
    name?: string;
  } = {},
): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      advertiserId,
      name: options.name ?? `Test Campaign ${nextId()}`,
      status: options.status ?? 'RUNNING',
      budgetTotalCents: options.budgetTotalCents ?? 10_000,
      budgetSpentCents: options.budgetSpentCents ?? 0,
      budgetReservedCents: options.budgetReservedCents ?? 0,
      platformFeePercent: options.platformFeePercent ?? 20,
      language: options.language ?? 'en',
    },
  });
}

export async function createAd(
  campaignId: string,
  options: { text?: string; destinationUrl?: string } = {},
): Promise<Ad> {
  const slug = `test-${nextId()}`;

  return prisma.ad.create({
    data: {
      campaignId,
      text: options.text ?? 'A sponsored message from our test advertiser.',
      destinationUrl: options.destinationUrl ?? 'https://example.com/offer',
      buttonText: 'Learn more',
      buttonUrl: options.destinationUrl ?? 'https://example.com/offer',
      trackingSlug: slug,
    },
  });
}

export async function createDeliveryJob(
  campaignId: string,
  channelId: string,
  options: {
    adId?: string | null;
    priceCents?: number;
    status?: 'PENDING' | 'SCHEDULED' | 'PROCESSING' | 'AWAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RETRYING';
    platformFeePercent?: number;
    slotType?: 'PAID' | 'HOUSE';
    scheduledAt?: Date;
  } = {},
): Promise<DeliveryJob> {
  return prisma.deliveryJob.create({
    data: {
      campaignId,
      channelId,
      adId: options.adId ?? null,
      priceCents: options.priceCents ?? 1_000,
      status: options.status ?? 'SCHEDULED',
      platformFeePercent: options.platformFeePercent ?? 20,
      slotType: options.slotType ?? 'PAID',
      ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
    },
  });
}

export async function createHouseAd(
  options: { title?: string; body?: string; isActive?: boolean; weight?: number; code?: string } = {},
): Promise<HouseAd> {
  return prisma.houseAd.create({
    data: {
      code: options.code ?? `TEST_${nextId()}`,
      title: options.title ?? 'Grow your Telegram channel with BotFlow Ads',
      body: options.body ?? 'Advertise. Monetize. Grow.',
      language: 'en',
      weight: options.weight ?? 1,
      isActive: options.isActive ?? true,
    },
  });
}

/* ------------------------------------------------------------------
 *  Settings
 * ------------------------------------------------------------------ */

/**
 * Override platform settings for one test. Written straight to the table (the
 * service layer would audit every change), then the cache is invalidated so a
 * run with Redis available reads the new value immediately.
 */
export async function setTestSettings(entries: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never, valueType: typeof value === 'number' ? 'int' : 'json' },
      update: { value: value as never },
    });
  }

  const { invalidateSettingsCache } = await import('../../src/services/settings.service');
  await invalidateSettingsCache();
}

/* ------------------------------------------------------------------
 *  Assertions helpers
 * ------------------------------------------------------------------ */

export async function countLedgerEntries(reference: string): Promise<number> {
  return prisma.transaction.count({ where: { reference } });
}

export async function ledgerTotalForUser(
  userId: string,
  where: Prisma.TransactionWhereInput = {},
): Promise<number> {
  const rows = await prisma.transaction.findMany({
    where: { userId, status: 'COMPLETED', ...where },
    select: { amountCents: true },
  });
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}
