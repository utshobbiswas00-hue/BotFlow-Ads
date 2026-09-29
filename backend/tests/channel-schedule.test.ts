import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import {
  MAX_WEEKLY_POSTS,
  postingScheduleSchema,
  weeklySlotCount,
  type PostingSchedule,
} from '@botflow/shared';
import { prisma } from '../src/db/prisma';
import { ValidationError } from '../src/utils/errors';

dayjs.extend(utc);
dayjs.extend(timezone);

// The stats refresh and the notification producers open a real Redis connection
// on import; none of that is what this file tests.
const queue = vi.hoisted(() => ({
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookDelivery: vi.fn(async () => undefined),
}));
vi.mock('../src/queues/producers', () => queue);

// Only the two Telegram LOOKUPS are stubbed. The permission decision itself
// (creator vs administrator, and the post rights) stays the real code, so the
// "no PENDING" rule is exercised against the logic production runs.
const tg = vi.hoisted(() => ({
  chat: null as unknown,
  perms: { botIsAdmin: false, canPostMessages: false, canEditMessages: false, canDeleteMessages: false },
}));
vi.mock('../src/utils/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/telegram')>();
  return {
    ...actual,
    getChatInfo: vi.fn(async () => tg.chat),
    checkBotPermissions: vi.fn(async () => tg.perms),
  };
});

const { addChannel, updateChannel } = await import('../src/services/channel.service');
const { checkChannelFrequency } = await import('../src/services/frequency.service');
const { msUntilAllowedSlot, platformTimeZone } = await import('../src/utils/postingSchedule');
const { resetDatabase, createUser, createChannel } = await import('./helpers/fixtures');

const NO_RIGHTS = { botIsAdmin: false, canPostMessages: false, canEditMessages: false, canDeleteMessages: false };
const POST_RIGHTS = { botIsAdmin: true, canPostMessages: true, canEditMessages: true, canDeleteMessages: true };

function chatInfo(id: number, title = 'A Real Channel') {
  return {
    id: BigInt(id),
    title,
    username: `chan${Math.abs(id)}`,
    type: 'channel',
    description: 'desc',
    inviteLink: 'https://t.me/+abc',
    photoUrl: null,
    memberCount: 12_345,
  };
}

/** The same local times on every day of the week. */
function everyDay(times: string[]): PostingSchedule {
  return Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [...times]]));
}

/** "HH:mm" in the platform timezone — the timezone the publisher picks times in. */
function localTime(instant: dayjs.Dayjs): string {
  return instant.format('HH:mm');
}

/** The gate's arguments, taken straight from a channel row. */
function gateArgs(channel: {
  id: string;
  maxPostsPerDay: number;
  minHoursBetweenAds: number;
  maxCampaignsPerHour: number | null;
  postingSchedule: unknown;
}) {
  return {
    id: channel.id,
    maxPostsPerDay: channel.maxPostsPerDay,
    minHoursBetweenAds: channel.minHoursBetweenAds,
    maxCampaignsPerHour: channel.maxCampaignsPerHour,
    postingSchedule: channel.postingSchedule as PostingSchedule | null,
  };
}

beforeEach(async () => {
  await resetDatabase();
  tg.chat = null;
  tg.perms = { ...NO_RIGHTS };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a channel is added when the bot has the rights — never left PENDING', () => {
  it('refuses the add while the bot is not an administrator, and stores nothing', async () => {
    const user = await createUser();
    tg.chat = chatInfo(-1_100_000_001);
    tg.perms = { ...NO_RIGHTS };

    await expect(addChannel(user.id, { channelUsername: 'chan1100000001' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // The point of the rule: no half-added row is left behind for the owner to
    // stare at while a permission that may never come is pending.
    expect(await prisma.channel.count()).toBe(0);
  });

  it('refuses when the bot is an administrator WITHOUT the post-messages right', async () => {
    const user = await createUser();
    tg.chat = chatInfo(-1_100_000_002);
    tg.perms = { botIsAdmin: true, canPostMessages: false, canEditMessages: false, canDeleteMessages: false };

    await expect(addChannel(user.id, { channelUsername: 'chan1100000002' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await prisma.channel.count()).toBe(0);
  });

  it('adds it as APPROVED, with the schedule, the moment the bot has the rights', async () => {
    const user = await createUser();
    tg.chat = chatInfo(-1_100_000_003, 'My News');
    tg.perms = { ...POST_RIGHTS };
    const schedule = everyDay(['09:00', '15:00', '21:00']);

    const channel = await addChannel(user.id, {
      channelUsername: 'chan1100000003',
      postingSchedule: schedule,
    });

    expect(channel.status).toBe('APPROVED');
    expect(channel.postingSchedule).toEqual(schedule);
    expect(channel.approvedAt).not.toBeNull();
    expect(channel.verifiedAt).not.toBeNull();
    expect(await prisma.channel.count({ where: { status: 'PENDING' } })).toBe(0);
  });
});

describe('the weekly schedule is validated in one place', () => {
  it('accepts a full week of exactly MAX_WEEKLY_POSTS slots', () => {
    const full = everyDay(['09:00', '15:00', '21:00']);
    expect(weeklySlotCount(full)).toBe(MAX_WEEKLY_POSTS);
    expect(postingScheduleSchema.safeParse(full).success).toBe(true);
  });

  it('refuses a schedule that goes over the weekly cap', () => {
    const over = everyDay(['01:00', '02:00', '03:00', '04:00']);
    expect(weeklySlotCount(over)).toBeGreaterThan(MAX_WEEKLY_POSTS);
    expect(postingScheduleSchema.safeParse(over).success).toBe(false);
  });

  it('refuses a duplicate time on the same day', () => {
    expect(postingScheduleSchema.safeParse({ '1': ['09:00', '09:00'] }).success).toBe(false);
    // The same time on DIFFERENT days is the normal case, not a duplicate.
    expect(postingScheduleSchema.safeParse({ '1': ['09:00'], '2': ['09:00'] }).success).toBe(true);
  });

  it('refuses a time that is not HH:mm', () => {
    expect(postingScheduleSchema.safeParse({ '1': ['9:00'] }).success).toBe(false);
    expect(postingScheduleSchema.safeParse({ '1': ['24:00'] }).success).toBe(false);
    expect(postingScheduleSchema.safeParse({ '1': ['09:60'] }).success).toBe(false);
  });

  it('refuses a week day that does not exist', () => {
    expect(postingScheduleSchema.safeParse({ '7': ['09:00'] }).success).toBe(false);
    expect(postingScheduleSchema.safeParse({ monday: ['09:00'] }).success).toBe(false);
  });
});

describe('msUntilAllowedSlot', () => {
  it('never holds back a channel with no schedule', () => {
    expect(msUntilAllowedSlot(null)).toBe(0);
    expect(msUntilAllowedSlot(undefined)).toBe(0);
    expect(msUntilAllowedSlot({})).toBe(0);
    expect(msUntilAllowedSlot({ '0': [] })).toBe(0);
  });

  it('returns 0 while a slot is open', () => {
    const now = dayjs().tz(platformTimeZone());
    expect(msUntilAllowedSlot(everyDay([localTime(now)]))).toBe(0);
  });

  it('returns the wait to the next slot when none is open', () => {
    const now = dayjs().tz(platformTimeZone());
    const wait = msUntilAllowedSlot(everyDay([localTime(now.add(6, 'hour'))]));
    expect(wait).toBeGreaterThan(5 * 3_600_000);
    expect(wait).toBeLessThanOrEqual(6 * 3_600_000);
  });
});

describe('delivery honours the publisher schedule', () => {
  it('holds a post that falls outside every slot, and says why', async () => {
    const user = await createUser();
    const now = dayjs().tz(platformTimeZone());
    const channel = await createChannel(user.id, {
      postingSchedule: everyDay([localTime(now.add(6, 'hour'))]),
    });

    const result = await checkChannelFrequency(gateArgs(channel));

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(5 * 3_600_000);
    expect(result.reason).toMatch(/scheduled/i);
  });

  it('lets a post through inside a slot', async () => {
    const user = await createUser();
    const now = dayjs().tz(platformTimeZone());
    const channel = await createChannel(user.id, { postingSchedule: everyDay([localTime(now)]) });

    const result = await checkChannelFrequency(gateArgs(channel));

    expect(result.allowed).toBe(true);
  });

  it('never holds back a channel that has not set a schedule', async () => {
    const user = await createUser();
    const channel = await createChannel(user.id);

    const result = await checkChannelFrequency(gateArgs(channel));

    expect(result.allowed).toBe(true);
  });
});

describe('editing an existing schedule', () => {
  it('replaces the schedule, and can clear it again', async () => {
    const user = await createUser();
    const channel = await createChannel(user.id);

    const next = everyDay(['08:00', '20:00']);
    const updated = await updateChannel(user.id, channel.id, { postingSchedule: next });
    expect(updated.postingSchedule).toEqual(next);

    const cleared = await updateChannel(user.id, channel.id, { postingSchedule: null });
    expect(cleared.postingSchedule).toBeNull();
  });
});
