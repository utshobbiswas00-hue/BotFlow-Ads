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

/**
 * Missing bot rights decide the channel's STATUS, not whether the add succeeds.
 *
 * These two cases used to assert that the add was refused and nothing was stored.
 * That stopped being the contract: the service now records the rights it found and
 * stores the channel as PENDING, so the owner can add the channel before sorting
 * the bot out in Telegram, and `my_chat_member` promotes it to APPROVED the moment
 * the bot really does get the rights. Refusing the add would have made that whole
 * flow — and the channel page's "Open access" banner — unreachable, which is why
 * the rule moved rather than the code being changed back.
 *
 * The property worth protecting is unchanged and is what these tests now assert:
 * a channel is **never APPROVED without the rights**. PENDING channels cannot take
 * an ad, so nothing can be delivered through a channel the bot cannot post to.
 * `botReady = perms.botIsAdmin && perms.canPostMessages` is the single place that
 * decides it.
 */
describe('adding a channel: missing rights change the status, never the outcome', () => {
  it('stores it as PENDING when the bot is not an administrator, and approves nothing', async () => {
    const user = await createUser();
    tg.chat = chatInfo(-1_100_000_001);
    tg.perms = { ...NO_RIGHTS };

    const channel = await addChannel(user.id, { channelUsername: 'chan1100000001' });

    // Stored — the owner's work is not thrown away, and a row exists to promote later.
    expect(await prisma.channel.count()).toBe(1);
    // But inert: not approved, so no ad can be delivered through it.
    expect(channel.status).toBe('PENDING');
    expect(channel.approvedAt).toBeNull();
    // And the rights that were actually observed are recorded, not assumed.
    expect(channel.botIsAdmin).toBe(false);
    expect(channel.canPostMessages).toBe(false);
  });

  it('stores it as PENDING when the bot is an administrator WITHOUT the post-messages right', async () => {
    const user = await createUser();
    tg.chat = chatInfo(-1_100_000_002);
    tg.perms = { botIsAdmin: true, canPostMessages: false, canEditMessages: false, canDeleteMessages: false };

    const channel = await addChannel(user.id, { channelUsername: 'chan1100000002' });

    // Being an administrator is not enough — posting needs can_post_messages.
    expect(channel.status).toBe('PENDING');
    expect(channel.approvedAt).toBeNull();
    expect(channel.botIsAdmin).toBe(true);
    expect(channel.canPostMessages).toBe(false);
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
