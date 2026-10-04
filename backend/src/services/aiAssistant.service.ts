import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getWallet } from './wallet.service';
import { getChannelOnboardingStatus } from './channel.service';
import { ForbiddenError, NotFoundError } from '../utils/errors';

/**
 * AI Assistant.
 *
 * A small, deterministic assistant that answers questions by CALLING BACKEND
 * SERVICES — never by inventing data. There is deliberately no LLM dependency
 * in this file: with no key in the environment the module still works, matching
 * the user's message against intents, running the matching tool(s) against the
 * real database, and synthesising a reply from the tool results.
 *
 * A future commit adds a real LLM client on top of the same tool registry: the
 * model will receive `listTools()` (name/description/parameters only — never
 * the `run` function) and call back into `registry`. That is why tools are
 * registered in a singleton and why `run` is intentionally not serialisable.
 */

/* ------------------------------------------------------------------
 *  Types
 * ------------------------------------------------------------------ */

export interface AiMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
  ts: number;
}

export interface AiToolContext {
  userId: string;
  isAdmin: boolean;
}

export interface AiTool {
  name: string;
  description: string;
  /** JSON schema of the arguments the tool accepts (for the LLM). */
  parameters: object;
  /** `self` = any authenticated user; `admin` = staff only. */
  requiresScope: 'self' | 'admin';
  run: (args: any, ctx: AiToolContext) => Promise<string>;
}

export interface AiToolCall {
  name: string;
  args: unknown;
  result: string;
}

export interface AiChatResult {
  reply: string;
  toolCalls: AiToolCall[];
}

/** How many turns of one conversation are kept in the persisted transcript. */
const MAX_STORED_MESSAGES = 200;

/* ------------------------------------------------------------------
 *  Registry (singleton)
 * ------------------------------------------------------------------ */

const registry = new Map<string, AiTool>();

/** Register (or replace) a tool. Later registration of a name wins. */
export function registerAiTool(tool: AiTool): void {
  registry.set(tool.name, tool);
}

/**
 * The tool catalogue exposed to the LLM. Carries `name` / `description` /
 * `parameters` ONLY — the `run` function is deliberately omitted so the schema
 * can be serialised into a prompt, and so a caller can never reach the
 * implementation through the list.
 */
export function listTools(): Array<Pick<AiTool, 'name' | 'description' | 'parameters'>> {
  return [...registry.values()].map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

/** Internal: fetch a registered tool by name. */
function getTool(name: string): AiTool | undefined {
  return registry.get(name);
}

/* ------------------------------------------------------------------
 *  Built-in tools — each backed by a real query
 * ------------------------------------------------------------------ */

const getWalletTool: AiTool = {
  name: 'get_wallet',
  description: "Read the caller's wallet balances (available and pending) and currency.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresScope: 'self',
  run: async (_args, ctx) => {
    const wallet = await getWallet(ctx.userId);
    return JSON.stringify({
      availableCents: wallet.availableCents,
      pendingCents: wallet.pendingCents,
      currency: wallet.currency,
    });
  },
};

const listMyChannelsTool: AiTool = {
  name: 'list_my_channels',
  description: "List the channels owned by the caller with their review status and size.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresScope: 'self',
  run: async (_args, ctx) => {
    const rows = await prisma.channel.findMany({
      where: { ownerId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, subscriberCount: true },
    });
    return JSON.stringify(rows);
  },
};

const getEarnings30dTool: AiTool = {
  name: 'get_earnings_30d',
  description: 'Total publisher earnings released to the caller in the last 30 days.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresScope: 'self',
  run: async (_args, ctx) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // A released earning is a COMPLETED ledger row whose referenceType is
    // EARNING_RELEASE (written by escrow.service.releaseEarning).
    const where: Prisma.TransactionWhereInput = {
      userId: ctx.userId,
      status: 'COMPLETED',
      type: 'ESCROW_RELEASE',
      referenceType: 'EARNING_RELEASE',
      createdAt: { gte: since },
    };
    const [agg, count] = await Promise.all([
      prisma.transaction.aggregate({ where, _sum: { amountCents: true } }),
      prisma.transaction.count({ where }),
    ]);
    return JSON.stringify({ totalCents: agg._sum.amountCents ?? 0, count, since: since.toISOString() });
  },
};

const listRecentNotificationsTool: AiTool = {
  name: 'list_recent_notifications',
  description: 'The caller\u2019s 10 most recent notifications.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresScope: 'self',
  run: async (_args, ctx) => {
    const rows = await prisma.notification.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, type: true, title: true, body: true, isRead: true, createdAt: true },
    });
    return JSON.stringify(rows);
  },
};

const explainChannelStatusTool: AiTool = {
  name: 'explain_channel_status',
  description: "Explain one of the caller's channels' onboarding status. Owner (or admin) only.",
  parameters: {
    type: 'object',
    properties: { channelId: { type: 'string', description: 'The channel id to explain.' } },
    required: ['channelId'],
    additionalProperties: false,
  },
  requiresScope: 'self',
  run: async (args, ctx) => {
    const channelId = String(args?.channelId ?? '').trim();
    if (!channelId) return JSON.stringify({ error: 'channelId is required' });

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, ownerId: true, title: true },
    });
    if (!channel) throw new NotFoundError('Channel');
    if (channel.ownerId !== ctx.userId && !ctx.isAdmin) {
      throw new ForbiddenError('Not the channel owner');
    }

    const status = await getChannelOnboardingStatus(channelId);
    return JSON.stringify({ channelId, title: channel.title, ...status });
  },
};

const getAdminQueueCountsTool: AiTool = {
  name: 'get_admin_queue_counts',
  description: 'Admin only: counts of PENDING deposits, withdrawals and channels awaiting review.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresScope: 'admin',
  run: async (_args, ctx) => {
    if (!ctx.isAdmin) throw new ForbiddenError('Admin access required');
    const [pendingDeposits, pendingWithdrawals, pendingChannels] = await Promise.all([
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.withdrawal.count({ where: { status: 'PENDING' } }),
      prisma.channel.count({ where: { status: 'PENDING' } }),
    ]);
    return JSON.stringify({ pendingDeposits, pendingWithdrawals, pendingChannels });
  },
};

/** The built-in catalogue, registered into the singleton at the bottom. */
export const aiTools: AiTool[] = [
  getWalletTool,
  listMyChannelsTool,
  getEarnings30dTool,
  listRecentNotificationsTool,
  explainChannelStatusTool,
  getAdminQueueCountsTool,
];

/* ------------------------------------------------------------------
 *  Deterministic intent matching
 * ------------------------------------------------------------------ */

const RE = {
  balance: /\b(balance|wallet|funds|money|how much (?:do i|i) (?:have|own))\b/i,
  channels: /\b(?:my )?channels?\b/i,
  channelStatus: /\bstatus\b/i,
  earnings: /\b(?:earn|earnings|income|revenue|30 ?days?|last month)\b/i,
  notifications: /\b(?:notifications?|alerts?|inbox)\b/i,
  admin: /\b(?:admin|queues?|pending (?:deposits?|withdrawals?|channels?)|moderation queue)\b/i,
} as const;

interface PlannedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Pull a cuid-like token out of the message (channel ids are cuids). */
function extractChannelId(message: string): string | null {
  const match = message.match(/\b([a-z0-9]{20,})\b/i);
  return match ? match[1] : null;
}

/**
 * Map a message to the tool calls it clearly needs. Returns `null` when nothing
 * matches, which lets `chat` fall back to the "no LLM key" explanation.
 */
function planCalls(message: string, isAdmin: boolean): PlannedCall[] {
  const calls: PlannedCall[] = [];
  const seen = new Set<string>();
  const add = (name: string, args: Record<string, unknown> = {}): void => {
    if (seen.has(name)) return;
    seen.add(name);
    calls.push({ name, args });
  };

  if (RE.admin.test(message) && isAdmin) add('get_admin_queue_counts');

  const mentionsChannel = RE.channels.test(message);
  const mentionsStatus = RE.channelStatus.test(message);
  if (mentionsChannel && mentionsStatus) {
    const channelId = extractChannelId(message);
    if (channelId) add('explain_channel_status', { channelId });
  }

  if (RE.balance.test(message)) add('get_wallet');
  if (RE.earnings.test(message)) add('get_earnings_30d');
  if (RE.notifications.test(message)) add('list_recent_notifications');
  // A bare mention of "channels" lists them, but not when the user was asking
  // about one channel's status.
  if (mentionsChannel && !mentionsStatus) add('list_my_channels');

  return calls;
}

/* ------------------------------------------------------------------
 *  Reply synthesis
 * ------------------------------------------------------------------ */

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fallbackReply(): string {
  const names = listTools()
    .map((t) => t.name)
    .join(', ');
  return (
    'I am the BotFlow Assistant running locally with no LLM key, so I rely on tool results ' +
    `— point me at something. I can look up: ${names}.`
  );
}

function synthesize(planned: PlannedCall[], results: AiToolCall[]): string {
  const parts: string[] = [];

  for (const call of results) {
    const data = safeParse(call.result);

    switch (call.name) {
      case 'get_wallet': {
        const w = (data ?? {}) as { availableCents?: number; pendingCents?: number; currency?: string };
        const available = w.availableCents ?? 0;
        const pending = w.pendingCents ?? 0;
        parts.push(
          `Your available balance is ${available} cents (${w.currency ?? 'USD'})` +
            (pending ? `, plus ${pending} cents pending` : '') +
            '.',
        );
        break;
      }
      case 'list_my_channels': {
        const rows = (Array.isArray(data) ? data : []) as Array<{
          title?: string;
          status?: string;
          subscriberCount?: number;
        }>;
        parts.push(
          rows.length === 0
            ? 'You have no channels yet.'
            : `You own ${rows.length} channel(s): ` +
                rows
                  .slice(0, 8)
                  .map((r) => `${r.title} (${r.status}, ${r.subscriberCount ?? 0} subs)`)
                  .join('; ') +
                '.',
        );
        break;
      }
      case 'get_earnings_30d': {
        const e = (data ?? {}) as { totalCents?: number; count?: number };
        parts.push(
          `You earned ${e.totalCents ?? 0} cents from ${e.count ?? 0} release(s) in the last 30 days.`,
        );
        break;
      }
      case 'list_recent_notifications': {
        const rows = (Array.isArray(data) ? data : []) as Array<{ title?: string }>;
        if (rows.length === 0) {
          parts.push('You have no notifications.');
        } else {
          const head = rows
            .slice(0, 5)
            .map((r) => r.title)
            .join('; ');
          const more = rows.length > 5 ? ` (+${rows.length - 5} more)` : '';
          parts.push(`Your latest notifications: ${head}${more}.`);
        }
        break;
      }
      case 'explain_channel_status': {
        const s = (data ?? {}) as {
          error?: string;
          title?: string;
          publisherStage?: string;
          subscribers?: number;
        };
        if (s.error) parts.push(s.error);
        else
          parts.push(
            `Channel "${s.title ?? ''}" is at stage ${s.publisherStage ?? 'UNKNOWN'} ` +
              `with ${s.subscribers ?? 0} subscribers.`,
          );
        break;
      }
      case 'get_admin_queue_counts': {
        const q = (data ?? {}) as {
          pendingDeposits?: number;
          pendingWithdrawals?: number;
          pendingChannels?: number;
        };
        parts.push(
          `Admin queues — pending deposits ${q.pendingDeposits ?? 0}, pending withdrawals ` +
            `${q.pendingWithdrawals ?? 0}, pending channels ${q.pendingChannels ?? 0}.`,
        );
        break;
      }
      default:
        parts.push(call.result);
    }
  }

  // If every planned tool was skipped (e.g. an admin tool attempted by a
  // non-admin), fall through to the generic explanation.
  if (parts.length === 0) return fallbackReply();
  return parts.join(' ');
}

/* ------------------------------------------------------------------
 *  Persistence — the AiConversation row
 * ------------------------------------------------------------------ */

/** The persisted transcript for a user, oldest first (last `limit` turns). */
export async function getAiHistory(userId: string, limit = 50): Promise<AiMessage[]> {
  const row = await prisma.aiConversation.findUnique({ where: { userId } });
  const messages = ((row?.messages ?? []) as unknown) as AiMessage[];
  if (!Array.isArray(messages)) return [];
  return limit > 0 ? messages.slice(-limit) : messages;
}

/**
 * Append turns to the user's transcript, creating the row on first use via an
 * upsert, and trimming to the last MAX_STORED_MESSAGES so the JSON column can
 * never grow without bound.
 */
export async function appendAiTurns(userId: string, ...turns: AiMessage[]): Promise<AiMessage[]> {
  const row = await prisma.aiConversation.findUnique({ where: { userId } });
  const prior = ((row?.messages ?? []) as unknown) as AiMessage[];
  const next = [...(Array.isArray(prior) ? prior : []), ...turns].slice(-MAX_STORED_MESSAGES);
  const payload = next as unknown as Prisma.InputJsonValue;

  const saved = await prisma.aiConversation.upsert({
    where: { userId },
    create: { userId, messages: payload },
    update: { messages: payload },
  });
  return ((saved.messages ?? []) as unknown) as AiMessage[];
}

/* ------------------------------------------------------------------
 *  chat
 * ------------------------------------------------------------------ */

/**
 * Answer one message.
 *
 * `history` is the prior transcript (the caller supplies it so this function
 * stays pure with respect to reads); the CURRENT turn is appended to the
 * persisted conversation before returning, so a reload sees it. The
 * deterministic stub never throws when an LLM key is missing — there is no key
 * to miss.
 */
export async function chat(
  userId: string,
  isAdmin: boolean,
  history: AiMessage[],
  message: string,
): Promise<AiChatResult> {
  const ctx: AiToolContext = { userId, isAdmin };
  const trimmed = message.trim();

  const planned = planCalls(trimmed, isAdmin);
  const toolCalls: AiToolCall[] = [];

  for (const call of planned) {
    const tool = getTool(call.name);
    if (!tool) continue;
    // Scope guard: never run an admin tool for a non-admin, whatever the intent
    // matcher decided. (The tool also self-checks — defence in depth.)
    if (tool.requiresScope === 'admin' && !isAdmin) continue;
    const result = await tool.run(call.args, ctx);
    toolCalls.push({ name: tool.name, args: call.args, result });
  }

  const reply = toolCalls.length > 0 ? synthesize(planned, toolCalls) : fallbackReply();

  // Persist the turn (user message + assistant reply) atomically as one write.
  const now = Date.now();
  const userTurn: AiMessage = { role: 'user', content: message, ts: now };
  const assistantTurn: AiMessage = {
    role: 'assistant',
    content: reply,
    ts: now + 1,
    ...(toolCalls.length > 0 ? { name: toolCalls.map((c) => c.name).join(',') } : {}),
  };
  await appendAiTurns(userId, userTurn, assistantTurn);

  return { reply, toolCalls };
}

/* ------------------------------------------------------------------
 *  Registration — MUST stay at the bottom, after every def above.
 * ------------------------------------------------------------------ */

for (const tool of aiTools) registerAiTool(tool);
