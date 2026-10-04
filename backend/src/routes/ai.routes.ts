import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { chat, getAiHistory } from '../services/aiAssistant.service';

/**
 * AI Assistant routes. Mounted behind `telegramAuth` at the `/api` router level
 * (see routes/index.ts), so `req.user` is always set.
 *
 * There is no LLM key in this deployment: `chat()` runs the deterministic
 * tool-calling stub. These routes only own the transport (validation, history
 * loading, the admin flag) — the answering logic lives in the service.
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const chatBody = z.object({
  message: z.string().min(1).max(2000),
});

/** How many prior turns the assistant is given / returns. */
const CHAT_HISTORY_LIMIT = 10;
const HISTORY_LIMIT = 50;

/** True when the user has an AdminUser row (drives the admin-only tool). */
async function isAdminUser(userId: string): Promise<boolean> {
  const admin = await prisma.adminUser.findUnique({
    where: { userId },
    select: { id: true, isActive: true },
  });
  return Boolean(admin?.isActive);
}

export const aiRouter = Router();

/** POST /api/ai/chat — one turn. `chat()` persists the turn on success. */
aiRouter.post('/ai/chat', validate({ body: chatBody }), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { message } = req.body as z.infer<typeof chatBody>;

    const isAdmin = await isAdminUser(user.id);
    const history = await getAiHistory(user.id, CHAT_HISTORY_LIMIT);

    // chat() appends the user message + assistant reply to AiConversation, so
    // the transcript is persisted by the time this resolves.
    const { reply, toolCalls } = await chat(user.id, isAdmin, history, message);

    res.json({ ok: true, data: { reply, toolCalls } });
  } catch (err) {
    next(err);
  }
});

/** GET /api/ai/history — the last 50 persisted turns. */
aiRouter.get('/ai/history', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const messages = await getAiHistory(user.id, HISTORY_LIMIT);
    res.json({ ok: true, data: { messages } });
  } catch (err) {
    next(err);
  }
});
