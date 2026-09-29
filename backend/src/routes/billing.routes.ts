import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { getPagination } from '../utils/pagination';
import { UnauthorizedError } from '../utils/errors';
import { generateInvoice, listInvoices, getInvoice, buildStatement, toCsv } from '../services/invoice.service';

/**
 * Billing endpoints — advertiser invoices and data exports (statements).
 *
 * Mounted under `/api` like every other user router; the router-level
 * `telegramAuth()` in routes/index.ts sets `req.user` before any handler runs.
 */

export const billingRouter = Router();

function requireUser(req: { user?: { id: string } }) {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

/**
 * These mirror the canonical shared schemas in shared/src/schemas.ts, but are
 * inlined so this router does not depend on the package dist having been built.
 * Note that the inlined statement query carries `role`, which the shared
 * `statementQuerySchema` does not — swapping in the import without adding it
 * would silently drop the parameter.
 */
const generateInvoiceBody = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

const statementQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  role: z.enum(['advertiser', 'publisher']).default('advertiser'),
});

/** GET /api/billing/invoices — paginated list of the caller's invoices. */
billingRouter.get('/billing/invoices', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await listInvoices(user.id, getPagination(req.query as never)) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/billing/invoices/:id — one of the caller's invoices (404 otherwise). */
billingRouter.get('/billing/invoices/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await getInvoice(user.id, req.params.id as string) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/billing/invoices/generate — build (or return) the invoice for an exact period. */
billingRouter.post(
  '/billing/invoices/generate',
  validate({ body: generateInvoiceBody }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { from, to } = req.body as { from: Date; to: Date };
      res.json({ ok: true, data: await generateInvoice(user.id, { from, to }) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/billing/statement?format=json|csv&role=advertiser|publisher&from=&to=
 *
 * `format=csv` streams an RFC-4180 file with the period in the filename, so
 * downloading two different periods does not overwrite the first.
 */
billingRouter.get(
  '/billing/statement',
  validate({ query: statementQuery }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { from, to, format, role } = req.query as unknown as {
        from?: Date;
        to?: Date;
        format: 'json' | 'csv';
        role: 'advertiser' | 'publisher';
      };

      const statement = await buildStatement(user.id, { from, to, role });

      if (format === 'csv') {
        const csv = toCsv(statement.rows);
        const stamp = (iso: string) => iso.slice(0, 10);
        const filename = `statement-${role}-${stamp(statement.from)}_${stamp(statement.to)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
        return;
      }

      res.json({ ok: true, data: statement });
    } catch (err) {
      next(err);
    }
  },
);
