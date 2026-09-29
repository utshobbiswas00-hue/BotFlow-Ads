import { Router } from 'express';
import { TicketStatus } from '@prisma/client';
import { paginationSchema } from '@botflow/shared';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { adminReplyTicket, listTicketsAdmin, setTicketStatus } from '../../services/ticket.service';
import { requirePermission } from '../../middleware/adminAuth';
import { adminId, idParams, respondOk } from './common';
import { getPagination } from '../../utils/pagination';

export const supportRouter = Router();

const ticketsQuery = paginationSchema.extend({
  status: z.nativeEnum(TicketStatus).optional(),
});

const ticketReplySchema = z.object({
  body: z
    .string()
    .min(1)
    .max(4000)
    .trim()
    .refine((v) => v.length > 0, { message: 'Reply cannot be empty' }),
});

const ticketStatusSchema = z.object({
  status: z.nativeEnum(TicketStatus),
});

/** All tickets (any user), most recently active first, optionally by status. */
supportRouter.get('/tickets', requirePermission('tickets.view'), validate({ query: ticketsQuery }), async (req, res, next) => {
  try {
    const query = req.query as unknown as z.infer<typeof ticketsQuery>;
    const data = await listTicketsAdmin({ status: query.status }, getPagination(query));
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Append an admin message to the thread; reopens CLOSED/RESOLVED tickets. */
supportRouter.post('/tickets/:id/reply', requirePermission('tickets.manage'), validate({ params: idParams, body: ticketReplySchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof ticketReplySchema>;
    const data = await adminReplyTicket(adminId(req), req.params.id, body.body);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});

/** Move a ticket between statuses; closing/resolving stamps closedAt. */
supportRouter.post('/tickets/:id/status', requirePermission('tickets.manage'), validate({ params: idParams, body: ticketStatusSchema }), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof ticketStatusSchema>;
    const data = await setTicketStatus(adminId(req), req.params.id, body.status);
    respondOk(res, data);
  } catch (err) {
    next(err);
  }
});
