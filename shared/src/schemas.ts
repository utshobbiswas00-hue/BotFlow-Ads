import { z } from 'zod';
import { CHANNEL_CATEGORIES, PAYMENT_METHODS } from './enums';

/* ---------------------------------------------------------------
 *  Shared zod schemas — used by the backend to validate requests
 *  and by the frontend to validate forms. One source of truth.
 * --------------------------------------------------------------- */

export const telegramAuthSchema = z.object({
  initData: z.string().min(1, 'Telegram initData is required'),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const channelCategorySchema = z.enum(CHANNEL_CATEGORIES);

/* ---------- Channel ---------- */

/* ---------------------------------------------------------------
 *  Channel posting schedule
 * --------------------------------------------------------------- */

/** How many sponsored posts a channel may accept in a week. */
export const MAX_WEEKLY_POSTS = 21;

/** 0 = Sunday … 6 = Saturday, matching JavaScript's day numbering. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Weekday key ("0" = Sunday) -> the channel-local times a post may go out at. */
export type PostingSchedule = Record<string, string[]>;

/** Slots across the whole week — the figure the cap is measured against. */
export function weeklySlotCount(schedule: PostingSchedule | null | undefined): number {
  if (!schedule) return 0;
  return Object.values(schedule).reduce((n, times) => n + (Array.isArray(times) ? times.length : 0), 0);
}

/** "HH:mm", 24-hour, zero-padded — the only shape a slot time may take. */
export const postingTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:30');

/**
 * A publisher's weekly posting schedule.
 *
 * Enforced here — not only in the form — so the form and the API can never
 * disagree about what a valid schedule is:
 *   - at most MAX_WEEKLY_POSTS slots across the week
 *   - no duplicate time within a day
 *   - every time is HH:mm
 *   - every key is a real weekday
 */
export const postingScheduleSchema = z
  .record(z.string(), z.array(postingTimeSchema))
  .superRefine((schedule, ctx) => {
    const total = weeklySlotCount(schedule);
    if (total > MAX_WEEKLY_POSTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A channel can accept at most ${MAX_WEEKLY_POSTS} posts a week (you picked ${total}).`,
      });
    }
    for (const [day, times] of Object.entries(schedule)) {
      if (!(WEEKDAYS as readonly number[]).map(String).includes(day)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown weekday "${day}".` });
      }
      if (new Set(times).size !== times.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate posting time on ${WEEKDAY_LABELS[Number(day)] ?? day}.`,
        });
      }
    }
  });


export const addChannelSchema = z.object({
  channelUsername: z
    .string()
    .min(4)
    .max(64)
    .transform((v) => v.replace(/^@/, '').trim()),
  category: channelCategorySchema.default('OTHER'),
  language: z.string().min(2).max(8).default('en'),
  country: z.string().length(2).default('BD'),
  /** The publisher's weekly posting schedule. Optional: a channel with none
   *  falls back to `maxPostsPerDay` + `minHoursBetweenAds` alone. */
  postingSchedule: postingScheduleSchema.optional(),
});

export const updateChannelSchema = z.object({
  channelId: z.string().min(1),
  category: channelCategorySchema.optional(),
  language: z.string().min(2).max(8).optional(),
  country: z.string().length(2).optional(),
  adPriceCents: z.number().int().min(0).optional(),
  pricingModel: z.enum(['FIXED', 'CPM', 'CPC', 'HYBRID']).optional(),
  autoApprovePosts: z.boolean().optional(),
  maxPostsPerDay: z.number().int().min(1).max(20).optional(),
  minHoursBetweenAds: z.number().int().min(1).max(72).optional(),
  // Publisher switches. `acceptAds: false` pauses new sponsored delivery while
  // keeping the channel listed; `minAdPriceCents` is the publisher's floor.
  acceptAds: z.boolean().optional(),
  minAdPriceCents: z.number().int().min(0).optional(),
  /** Replace the weekly posting schedule. Send `null` to clear it. */
  postingSchedule: postingScheduleSchema.nullable().optional(),
});

/* ---------- Campaign ---------- */

export const campaignTargetingSchema = z.object({
  categories: z.array(channelCategorySchema).default([]),
  countries: z.array(z.string().length(2)).default([]),
  languages: z.array(z.string().min(2).max(8)).default([]),
  subscriberMin: z.number().int().min(0).default(0),
  subscriberMax: z.number().int().min(0).default(0),
  avgViewsMin: z.number().int().min(0).default(0),
  avgViewsMax: z.number().int().min(0).default(0),
});

export const adCreativeSchema = z.object({
  format: z.enum(['TEXT', 'IMAGE', 'IMAGE_TEXT', 'BUTTON']).default('TEXT'),
  text: z.string().min(1).max(2000),
  imageUrl: z.string().url().optional().nullable(),
  buttonText: z.string().max(64).optional().nullable(),
  buttonUrl: z.string().url().optional().nullable(),
  destinationUrl: z.string().url().optional().nullable(),
  weight: z.number().int().min(1).max(10).default(1),
});

export const createCampaignSchema = z
  .object({
    name: z.string().min(3).max(120),
    promotionTarget: z
      .enum(['CHANNEL', 'GROUP', 'BOT', 'WEBSITE', 'PRODUCT', 'SERVICE', 'APP', 'BRAND'])
      .default('CHANNEL'),
    pricingModel: z.enum(['FIXED', 'CPM', 'CPC', 'HYBRID']).default('FIXED'),
    budgetCents: z.number().int().min(500),
    frequencyPerChannel: z.number().int().min(1).max(3).default(1),
    isAutoTargeting: z.boolean().default(false),
    targeting: campaignTargetingSchema.default({} as never),
    channelIds: z.array(z.string()).default([]),
    startAt: z.coerce.date().optional().nullable(),
    endAt: z.coerce.date().optional().nullable(),
    creatives: z.array(adCreativeSchema).min(1).max(5),
  })
  .refine((d) => d.isAutoTargeting || d.channelIds.length > 0, {
    message: 'Select at least one channel or enable automatic targeting',
    path: ['channelIds'],
  })
  .refine((d) => !d.startAt || !d.endAt || d.endAt > d.startAt, {
    message: 'End time must be after start time',
    path: ['endAt'],
  });

/* ---------- Wallet ---------- */

export const createDepositSchema = z.object({
  amountCents: z.number().int().min(100),
  /**
   * The closed payment-method list, so a method we have no fee rate for can
   * never be recorded. An unknown rail silently booked at 0 cost would make
   * every margin report wrong.
   */
  method: z.enum(PAYMENT_METHODS),
  proofUrl: z.string().url().optional().nullable(),
  senderInfo: z.string().max(255).optional().nullable(),
  gatewayRef: z.string().max(128).optional().nullable(),
});

export const createWithdrawalSchema = z.object({
  amountCents: z.number().int().min(100),
  method: z.literal('crypto'),
  accountDetails: z.record(z.string(), z.string()),
});

/* ---------- Admin ---------- */

export const adminCampaignActionSchema = z.object({
  campaignId: z.string().min(1),
  action: z.enum(['APPROVE', 'REJECT', 'PAUSE', 'RESUME', 'CANCEL', 'SUSPEND']),
  note: z.string().max(500).optional().nullable(),
});

export const adminChannelActionSchema = z.object({
  channelId: z.string().min(1),
  action: z.enum(['APPROVE', 'REJECT', 'SUSPEND', 'REACTIVATE']),
  note: z.string().max(500).optional().nullable(),
});

export const adminWithdrawalActionSchema = z.object({
  withdrawalId: z.string().min(1),
  action: z.enum(['APPROVE', 'REJECT', 'MARK_PAID']),
  txRef: z.string().max(128).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
});

export const updateSettingSchema = z.object({
  key: z.string().min(1),
  // A setting value is a primitive, a flat object, or a list of primitives.
  // The array member is deliberately the LAST branch with the other members
  // untouched, so an existing string/number/boolean/object value parses exactly
  // as before. Per-key item TYPES (e.g. numbers for `budget_alert_thresholds`)
  // are enforced by the backend route, which is the only layer that knows the
  // keys — see backend/src/routes/admin/settings.routes.ts.
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.record(z.string(), z.unknown()),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]),
});

/* ---------- Support / reports ---------- */

export const createTicketSchema = z.object({
  subject: z.string().min(3).max(150),
  category: z.string().max(40).default('general'),
  message: z.string().min(1).max(4000),
});

export const createReportSchema = z.object({
  adPostId: z.string().min(1),
  reason: z.enum(['SCAM', 'SPAM', 'MISLEADING', 'BROKEN_LINK', 'INAPPROPRIATE', 'OTHER']),
  details: z.string().max(1000).optional().nullable(),
});

/* ---------------------------------------------------------------
 *  Advertiser programmatic access
 * --------------------------------------------------------------- */

export const API_KEY_LABEL_MAX = 60;

export const createApiKeySchema = z.object({
  label: z.string().min(1, 'Give the key a name so you can recognise it later').max(API_KEY_LABEL_MAX),
  scopes: z.array(z.enum(['READ', 'WRITE'])).min(1, 'Pick at least one scope').default(['READ']),
  /** Optional expiry, in days from now. Omitted = never expires. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const apiKeyIdSchema = z.object({
  id: z.string().min(1),
});

/* ---- Webhook endpoints ---- */

export const webhookEventsSchema = z
  .array(
    z.enum([
      'CAMPAIGN_APPROVED',
      'CAMPAIGN_REJECTED',
      'CAMPAIGN_STARTED',
      'CAMPAIGN_COMPLETED',
      'POST_PUBLISHED',
      'POST_FAILED',
      'BUDGET_LOW',
      'CONVERSION_RECORDED',
      'INVOICE_ISSUED',
      'EARNINGS_SETTLED',
      'CHANNEL_APPROVED',
      'CHANNEL_REJECTED',
      'TEST',
    ]),
  )
  .min(1, 'Pick at least one event');

/**
 * Subscriber endpoints must be HTTPS. An HTTP endpoint would ship campaign,
 * creative and earnings data over plaintext, and would let anyone on the path
 * read our HMAC signature.
 */
export const webhookUrlSchema = z
  .string()
  .url('Enter a valid URL')
  .refine((u) => u.startsWith('https://'), 'The endpoint must use https://');

export const createWebhookEndpointSchema = z.object({
  url: webhookUrlSchema,
  description: z.string().max(120).optional().nullable(),
  events: webhookEventsSchema,
});

export const updateWebhookEndpointSchema = z.object({
  url: webhookUrlSchema.optional(),
  description: z.string().max(120).optional().nullable(),
  events: webhookEventsSchema.optional(),
  isActive: z.boolean().optional(),
});

/* ---- Conversions ---- */

/**
 * A conversion reported back by the advertiser.
 *
 * Attribution is by `clickId` when the advertiser kept it, or by `trackingSlug`
 * when they only kept the landing URL. `dedupeKey` makes retries safe — every
 * sensible integrator retries, and a double-counted conversion inflates the
 * advertiser's own reported performance.
 */
export const conversionIngestSchema = z
  .object({
    clickId: z.string().min(1).max(120).optional(),
    /** The slug from the `/c/:slug` landing URL, when clickId was not retained. */
    trackingSlug: z.string().min(1).max(120).optional(),
    eventName: z.string().min(1).max(80).default('conversion'),
    valueCents: z.number().int().min(0).optional(),
    currency: z.string().length(3).default('USD'),
    occurredAt: z.coerce.date().optional(),
    /** Caller-supplied idempotency key. Derived from the fields above if absent. */
    dedupeKey: z.string().min(1).max(200).optional(),
    /** Free-form context kept for audit. */
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.clickId ?? v.trackingSlug), {
    message: 'Provide either clickId or trackingSlug so the conversion can be attributed',
    path: ['clickId'],
  });

/* ---------------------------------------------------------------
 *  Billing documents
 * --------------------------------------------------------------- */

export const invoicePeriodQuerySchema = z.object({
  /** Inclusive ISO date. Defaults to the first day of the previous month. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const statementQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Server-side CSV download rather than JSON. */
  format: z.enum(['json', 'csv']).default('json'),
});

/* ---------------------------------------------------------------
 *  Email
 * --------------------------------------------------------------- */

export const setEmailSchema = z.object({
  email: z.string().email('Enter a valid email address').max(200),
});

/* ---------------------------------------------------------------
 *  Marketplace filters (extended)
 * --------------------------------------------------------------- */

export const marketplaceFilterSchema = z.object({
  category: channelCategorySchema.optional(),
  country: z.string().length(2).optional(),
  language: z.string().max(8).optional(),
  minSubs: z.coerce.number().int().min(0).optional(),
  maxSubs: z.coerce.number().int().min(0).optional(),
  minViews: z.coerce.number().int().min(0).optional(),
  search: z.string().max(120).optional(),
  /** Price range on the channel's fixed post price. */
  minPriceCents: z.coerce.number().int().min(0).optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  pricingModel: z.enum(['FIXED', 'CPM', 'CPC', 'HYBRID']).optional(),
  sort: z.enum(['reach_desc', 'subscribers_desc', 'price_asc', 'price_desc', 'quality_desc']).default('reach_desc'),
});
