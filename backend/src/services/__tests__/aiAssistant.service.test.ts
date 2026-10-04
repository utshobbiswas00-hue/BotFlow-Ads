import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, resetDatabase } from '../../../tests/helpers/fixtures';
import { ForbiddenError } from '../../utils/errors';
import { aiTools, chat, getAiHistory, listTools } from '../aiAssistant.service';

/**
 * AI Assistant.
 *
 * These drive the REAL Prisma client against the migrated test database (the
 * same pattern the rest of the backend suite uses — see tests/helpers/fixtures)
 * because the point of the assistant is that it answers from real rows, never
 * mock data. No LLM key exists: `chat()` is the deterministic tool-calling stub
 * and that is exactly what is under test.
 */

beforeEach(async () => {
  await resetDatabase();
});

describe('aiAssistant — tool registry', () => {
  it('registers the six built-in tools and lists schemas without the run function', () => {
    const names = listTools()
      .map((t) => t.name)
      .sort();

    expect(names).toEqual(
      [
        'explain_channel_status',
        'get_admin_queue_counts',
        'get_earnings_30d',
        'get_wallet',
        'list_my_channels',
        'list_recent_notifications',
      ].sort(),
    );

    // The catalogue handed to the LLM must never leak the implementation.
    for (const tool of listTools()) {
      expect(tool).not.toHaveProperty('run');
      expect(tool).toHaveProperty('parameters');
    }
  });
});

describe('aiAssistant — get_wallet', () => {
  it('reflects the seeded user balance', async () => {
    const user = await createUser({ availableCents: 4321, pendingCents: 250 });

    const tool = aiTools.find((t) => t.name === 'get_wallet');
    expect(tool).toBeDefined();

    const raw = await tool!.run({}, { userId: user.id, isAdmin: false });
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed).toMatchObject({ availableCents: 4321, pendingCents: 250, currency: 'USD' });
  });
});

describe('aiAssistant — admin scope', () => {
  it('get_admin_queue_counts throws when called by a non-admin', async () => {
    const tool = aiTools.find((t) => t.name === 'get_admin_queue_counts');
    expect(tool).toBeDefined();

    await expect(tool!.run({}, { userId: 'not-an-admin', isAdmin: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('aiAssistant — chat()', () => {
  it("answers 'what's my balance' by running get_wallet and mentioning the number", async () => {
    const user = await createUser({ availableCents: 12345 });

    const { reply, toolCalls } = await chat(user.id, false, [], "what's my balance?");

    expect(toolCalls.map((t) => t.name)).toContain('get_wallet');
    expect(reply).toContain('12345');
  });

  it('persists the conversation after a chat turn', async () => {
    const user = await createUser({ availableCents: 10 });

    await chat(user.id, false, [], 'hello there');

    const history = await getAiHistory(user.id, 50);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hello there' });
    expect(history[1].role).toBe('assistant');
    expect(history[1].content.length).toBeGreaterThan(0);
  });

  it('falls back to a tool list (no LLM key) when nothing matches', async () => {
    const user = await createUser();

    const { reply, toolCalls } = await chat(user.id, false, [], 'tell me a joke');

    expect(toolCalls).toHaveLength(0);
    expect(reply).toMatch(/no LLM key/i);
    expect(reply).toContain('get_wallet');
  });
});
