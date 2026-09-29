import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { createTicketSchema } from '@botflow/shared';
import { validate } from '../middleware/validate';
import { limiters } from '../middleware/rateLimit';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import type { AuthUser } from '../types/auth';
import { createTicket, listTickets, getTicket, addMessage } from '../services/ticket.service';

/**
 * User-facing support tickets. All sit behind `telegramAuth`
 * (applied once at the /api router level, see routes/index.ts).
 */

function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

const messageBody = z.object({
  message: z.string().min(1).max(4000),
});

export const supportRouter = Router();

/** GET /api/support/tickets — the user's tickets, most recently active first. */
supportRouter.get('/support/tickets', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listTickets(user.id, getPagination(req.query)) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/support/tickets — open a new ticket with the first message. */
supportRouter.post(
  '/support/tickets',
  limiters.support,
  validate({ body: createTicketSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      res.json({ ok: true, data: await createTicket(user.id, req.body) });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/support/tickets/:id — ticket plus its full message thread. */
supportRouter.get('/support/tickets/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await getTicket(user.id, req.params.id) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/support/tickets/:id/messages — append the user's reply. */
supportRouter.post(
  '/support/tickets/:id/messages',
  validate({ body: messageBody }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { message } = req.body as z.infer<typeof messageBody>;
      res.json({ ok: true, data: await addMessage(user.id, req.params.id, message) });
    } catch (err) {
      next(err);
    }
  },
);
