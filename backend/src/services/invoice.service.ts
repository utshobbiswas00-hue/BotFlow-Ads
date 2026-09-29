import type { Invoice, Transaction, TransactionType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma, transaction } from '../db/prisma';
import { SETTING_KEYS } from '../config/constants';
import { getBoolSetting, getStringSetting } from './settings.service';
import { createNotification } from './notification.service';
import { recordAudit } from './audit.service';
import { buildPaginated, type Pagination } from '../utils/pagination';
import { formatMoney } from '../utils/money';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../config/logger';

/**
 * Advertiser invoicing and statements.
 *
 * MONEY RULE: the Transaction ledger is the only source of truth. An invoice
 * never charges, debits or recomputes anything — it is a DOCUMENT built from
 * a snapshot of the ledger rows inside one period:
 *
 *   - CAMPAIGN_CHARGE rows (amountCents negative)  -> charge lines
 *   - REFUND rows         (amountCents positive)   -> refund lines
 *
 *   subtotalCents = sum of charges (absolute values)
 *   refundCents   = sum of refunds (absolute values)
 *   totalCents    = subtotalCents - refundCents
 *
 * Guarantees:
 *   1. Nothing is charged twice and nothing is invented: every line maps 1:1
 *      to a real, COMPLETED ledger row inside the period.
 *   2. Idempotency: one non-VOID invoice per (userId, periodStart, periodEnd).
 *      A second generate for the same period returns the existing document.
 *   3. `lineItems` is a frozen snapshot — it is never recomputed after issue.
 *   4. Numbers are globally unique: `${prefix}-${yyyy}-${mm}-${seq:06d}`, with
 *      seq derived from the count of that year's invoices inside the same
 *      transaction, and the UNIQUE constraint on `number` as the backstop
 *      (a P2002 collision retries once with a fresh sequence).
 */

/* ------------------------------------------------------------------
 *  Types
 * ------------------------------------------------------------------ */

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  /** Per-unit price in cents (always positive; the sign lives in amountCents). */
  unitAmountCents: number;
  /** SIGNED: charge lines are positive, refund lines are negative. */
  amountCents: number;
  /** The ledger reference of the row this line was snapshotted from. */
  reference: string;
  /** ISO date of the ledger row. */
  occurredAt: string;
}

export type InvoiceStatusValue = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';

export interface InvoiceView {
  id: string;
  number: string;
  periodStart: string; // ISO
  periodEnd: string; // ISO
  currency: string;
  subtotalCents: number;
  refundCents: number;
  totalCents: number;
  status: InvoiceStatusValue;
  lineItems: InvoiceLineItem[];
  issuedAt: string; // ISO
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string; // ISO
}

export interface GenerateInvoiceResult extends InvoiceView {
  /** True when this call returned an already-issued invoice for the period. */
  existing: boolean;
}

export type StatementRole = 'advertiser' | 'publisher';

export interface StatementRow {
  /** ISO date of the ledger row. */
  date: string;
  kind: 'CHARGE' | 'REFUND' | 'EARNING';
  description: string;
  reference: string;
  /** SIGNED: money out of the advertiser's balance is negative, money in is positive. */
  amountCents: number;
}

export interface AdvertiserStatementTotals {
  chargesCents: number;
  refundsCents: number;
  netCents: number;
}

export interface PublisherStatementTotals {
  earnedCents: number;
  entries: number;
}

export interface StatementResult {
  role: StatementRole;
  from: string; // ISO
  to: string; // ISO
  rows: StatementRow[];
  totals: AdvertiserStatementTotals | PublisherStatementTotals;
}

/** Default statement window when the caller omits `from`: the last 180 days. */
const DEFAULT_STATEMENT_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
/** Safety cap so a statement can never load an unbounded ledger into memory. */
const MAX_STATEMENT_ROWS = 5_000;

/* ------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------ */

function toDate(value: unknown, label: string): Date {
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (!(value instanceof Date) || Number.isNaN(d.getTime())) {
    throw new ValidationError(`A valid \`${label}\` date is required`);
  }
  return d;
}

function normalizePeriod(from: unknown, to: unknown): { from: Date; to: Date } {
  const f = toDate(from, 'from');
  const t = toDate(to, 'to');
  if (f.getTime() > t.getTime()) {
    throw new ValidationError('`from` must be on or before `to`');
  }
  return { from: f, to: t };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function readLineItems(raw: Prisma.JsonValue): InvoiceLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw as unknown as InvoiceLineItem[];
}

export function toInvoiceView(invoice: Invoice): InvoiceView {
  return {
    id: invoice.id,
    number: invoice.number,
    periodStart: invoice.periodStart.toISOString(),
    periodEnd: invoice.periodEnd.toISOString(),
    currency: invoice.currency,
    subtotalCents: invoice.subtotalCents,
    refundCents: invoice.refundCents,
    totalCents: invoice.totalCents,
    status: invoice.status,
    lineItems: readLineItems(invoice.lineItems),
    issuedAt: invoice.issuedAt.toISOString(),
    sentAt: invoice.sentAt ? invoice.sentAt.toISOString() : null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    createdAt: invoice.createdAt.toISOString(),
  };
}

/** One line per real ledger row — the document must stay auditable to the ledger. */
function buildLineItems(rows: Transaction[]): InvoiceLineItem[] {
  return rows.map((row) => {
    const isCharge = row.type === 'CAMPAIGN_CHARGE';
    const amount = Math.abs(row.amountCents);
    return {
      description: row.description ?? (isCharge ? 'Campaign charge' : 'Refund'),
      quantity: 1,
      unitAmountCents: amount,
      // Charges are presented as positive amounts; refunds as negative, so the
      // lines sum exactly to totalCents.
      amountCents: isCharge ? amount : -amount,
      reference: row.reference,
      occurredAt: row.createdAt.toISOString(),
    };
  });
}

function computeTotals(rows: Transaction[]): { subtotalCents: number; refundCents: number; totalCents: number } {
  let subtotalCents = 0;
  let refundCents = 0;
  for (const row of rows) {
    if (row.type === 'CAMPAIGN_CHARGE') subtotalCents += Math.abs(row.amountCents);
    else if (row.type === 'REFUND') refundCents += Math.abs(row.amountCents);
  }
  return { subtotalCents, refundCents, totalCents: subtotalCents - refundCents };
}

/**
 * Fan an advertiser-visible event out to their webhook endpoints, best-effort.
 *
 * The fan-out lives in the queue producers; the export is being renamed in
 * flight between `emitWebhookEvent` and `enqueueWebhookEvent`, so accept
 * whichever name is live instead of pinning one. Must never fail the invoice.
 */
async function fanOutWebhook(userId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const producers = (await import('../queues/producers')) as unknown as {
      enqueueWebhookEvent?: (userId: string, event: string, payload: Record<string, unknown>) => Promise<unknown>;
      emitWebhookEvent?: (userId: string, event: string, payload: Record<string, unknown>) => Promise<unknown>;
    };
    const fn = producers.enqueueWebhookEvent ?? producers.emitWebhookEvent;
    if (typeof fn === 'function') {
      await fn.call(producers, userId, event, payload);
    }
  } catch (err) {
    logger.warn({ err, userId, event }, 'webhook fan-out for invoice failed');
  }
}

/* ------------------------------------------------------------------
 *  Generate
 * ------------------------------------------------------------------ */

/**
 * Build (or return) the invoice for exactly one billing period.
 *
 * Returns `existing: true` when a non-VOID invoice already covers that exact
 * (userId, from, to) — calling this twice never creates two invoices.
 *
 * A period with NO ledger activity is refused with a clear error (an invoice
 * is a document of real movement, not a placeholder). A period whose charges
 * and refunds net to zero still produces a document — explicitly labelled as
 * a zero-value period — with its (cancelling) line items intact.
 */
export async function generateInvoice(
  userId: string,
  input: { from: Date | string; to: Date | string },
): Promise<GenerateInvoiceResult> {
  const enabled = await getBoolSetting(SETTING_KEYS.INVOICE_ENABLED, true);
  if (!enabled) {
    throw new ValidationError(
      'Invoicing is currently disabled on this platform, so no invoice can be generated. Please contact support if you need a billing document for this period.',
    );
  }

  const { from, to } = normalizePeriod(input.from, input.to);

  // Fast path: a non-VOID invoice already covers exactly this period.
  const alreadyThere = await prisma.invoice.findFirst({
    where: { userId, periodStart: from, periodEnd: to, status: { not: 'VOID' } },
  });
  if (alreadyThere) return { ...toInvoiceView(alreadyThere), existing: true };

  // The real ledger rows for the period — the ONLY source of what is billed.
  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: { in: ['CAMPAIGN_CHARGE', 'REFUND'] },
      status: 'COMPLETED',
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) {
    throw new ValidationError(
      `There is no billable activity (campaign charges or refunds) between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}, so no invoice can be created for this period. Adjust the period.`,
    );
  }

  const lineItems = buildLineItems(rows);
  const { subtotalCents, refundCents, totalCents } = computeTotals(rows);
  const currency = rows[0].currency;
  const zeroValue = totalCents === 0;

  const prefix = (await getStringSetting(SETTING_KEYS.INVOICE_NUMBER_PREFIX, 'BFA')) || 'BFA';
  const yyyy = String(from.getUTCFullYear());
  const mm = String(from.getUTCMonth() + 1).padStart(2, '0');
  // All invoices issued in this year share the counter, so the sequence is
  // globally increasing (and therefore unique) across users and months.
  const yearPrefix = `${prefix}-${yyyy}-`;

  const attemptCreate = (): Promise<{ invoice: Invoice; preExisting: boolean }> =>
    transaction(
      async (tx) => {
        // Re-check INSIDE the transaction: a concurrent call for the same
        // period may have won the race after the fast path above.
        const existing = await tx.invoice.findFirst({
          where: { userId, periodStart: from, periodEnd: to, status: { not: 'VOID' } },
        });
        if (existing) return { invoice: existing, preExisting: true };

        const sequence = (await tx.invoice.count({ where: { number: { startsWith: yearPrefix } } })) + 1;
        const number = `${yearPrefix}${mm}-${String(sequence).padStart(6, '0')}`;

        const invoice = await tx.invoice.create({
          data: {
            userId,
            number,
            periodStart: from,
            periodEnd: to,
            currency,
            subtotalCents,
            refundCents,
            totalCents,
            status: 'ISSUED',
            lineItems: lineItems as unknown as Prisma.InputJsonValue,
            issuedAt: new Date(),
          },
        });
        return { invoice, preExisting: false };
      },
      { retries: 0 },
    );

  let outcome: { invoice: Invoice; preExisting: boolean };
  try {
    outcome = await attemptCreate();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two issuers raced on the same year counter. The UNIQUE constraint on
    // `number` caught it — retry ONCE with a freshly derived sequence. The
    // in-transaction idempotency re-check at the top of attemptCreate() also
    // turns a same-period race into "return the winner" rather than a second row.
    logger.warn({ err, userId, numberPrefix: yearPrefix }, 'invoice number collision — retrying with fresh sequence');
    outcome = await attemptCreate();
  }

  if (outcome.preExisting) {
    return { ...toInvoiceView(outcome.invoice), existing: true };
  }

  const invoice = outcome.invoice;

  // Side effects — all best-effort, none may roll back the document.
  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'INVOICE_CREATED',
    targetType: 'INVOICE',
    targetId: invoice.id,
    newValue: {
      number: invoice.number,
      periodStart: from.toISOString(),
      periodEnd: to.toISOString(),
      subtotalCents,
      refundCents,
      totalCents,
      zeroValue,
    },
  });

  const periodLabel = `${from.toISOString().slice(0, 10)} – ${to.toISOString().slice(0, 10)}`;
  await createNotification({
    userId,
    type: 'INVOICE_READY',
    title: `Invoice ${invoice.number} is ready`,
    body: zeroValue
      ? `Your invoice ${invoice.number} for ${periodLabel} has been issued. This is a ZERO-VALUE period: the charges and refunds in it cancel each other out, so the total is ${formatMoney(0, currency)}.`
      : `Your invoice ${invoice.number} for ${periodLabel} has been issued for ${formatMoney(totalCents, currency)} (${formatMoney(subtotalCents, currency)} in charges, ${formatMoney(refundCents, currency)} in refunds).`,
    data: {
      invoiceId: invoice.id,
      number: invoice.number,
      periodStart: from.toISOString(),
      periodEnd: to.toISOString(),
      totalCents,
      zeroValue,
    },
  });

  await fanOutWebhook(userId, 'INVOICE_ISSUED', {
    invoiceId: invoice.id,
    number: invoice.number,
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
    subtotalCents,
    refundCents,
    totalCents,
    currency,
    zeroValue,
  });

  return { ...toInvoiceView(invoice), existing: false };
}

/* ------------------------------------------------------------------
 *  Read
 * ------------------------------------------------------------------ */

export async function listInvoices(userId: string, p: Pagination) {
  const where: Prisma.InvoiceWhereInput = { userId };

  const [total, items] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      skip: p.skip,
      take: p.take,
    }),
  ]);

  return buildPaginated(items.map(toInvoiceView), total, p);
}

/**
 * One invoice, or 404. A foreign user's invoice is indistinguishable from a
 * missing one — it is never leaked.
 */
export async function getInvoice(userId: string, id: string): Promise<InvoiceView> {
  const invoice = await prisma.invoice.findFirst({ where: { id, userId } });
  if (!invoice) throw new NotFoundError('Invoice');
  return toInvoiceView(invoice);
}

/* ------------------------------------------------------------------
 *  Status
 * ------------------------------------------------------------------ */

/**
 * Mark an invoice PAID.
 *
 * The transition is a CONDITIONAL updateMany claim (same pattern as
 * withdrawal.status claims): two concurrent callers cannot both perform the
 * transition — exactly one writes `paidAt`, the other sees the row already
 * PAID and reports a conflict instead of clobbering it. An already-PAID
 * invoice is returned as-is (idempotent read); a VOID one can never be paid.
 */
export async function markInvoicePaid(userId: string, id: string): Promise<InvoiceView> {
  const current = await prisma.invoice.findFirst({ where: { id, userId } });
  if (!current) throw new NotFoundError('Invoice');
  if (current.status === 'PAID') return toInvoiceView(current);
  if (current.status === 'VOID') {
    throw new ConflictError('A void invoice cannot be marked as paid');
  }

  const claimed = await prisma.invoice.updateMany({
    where: { id, userId, status: { in: ['DRAFT', 'ISSUED'] } },
    data: { status: 'PAID', paidAt: new Date() },
  });
  if (claimed.count === 0) {
    // Zero rows claimed means the conditional UPDATE matched nothing — another
    // caller completed the SAME transition in the window between our read and
    // our claim, or the invoice was voided.
    //
    // "Make this invoice paid" is idempotent, so losing that race is SUCCESS,
    // not an error: the caller asked for the invoice to be paid and it is paid.
    // Re-reading lets both callers report the winner's single `paidAt` stamp
    // rather than one of them failing on a bookkeeping detail — and it is what
    // stops this path from being a coin flip under concurrency.
    const settled = await prisma.invoice.findFirst({ where: { id, userId } });
    if (!settled) throw new NotFoundError('Invoice');
    if (settled.status === 'PAID') return toInvoiceView(settled);

    // Genuinely closed by something else (voided), which the caller cannot undo.
    throw new ConflictError('This invoice has already been paid or closed by someone else');
  }

  const updated = await prisma.invoice.findFirstOrThrow({ where: { id, userId } });

  await recordAudit({
    actorId: userId,
    actorType: 'USER',
    action: 'INVOICE_PAID',
    targetType: 'INVOICE',
    targetId: id,
    oldValue: { status: current.status },
    newValue: { status: 'PAID' },
  });

  return toInvoiceView(updated);
}

/* ------------------------------------------------------------------
 *  Statements
 * ------------------------------------------------------------------ */

/**
 * A statement is the raw ledger for a period, per role:
 *
 *   - advertiser: CAMPAIGN_CHARGE (money out) and REFUND (money back) rows
 *   - publisher:  PUBLISHER_EARNING rows (money in, net of platform fee)
 *
 * Only COMPLETED rows count — a REVERSED or PENDING movement is not money.
 */
export async function buildStatement(
  userId: string,
  input: { from?: Date | string; to?: Date | string; role: StatementRole },
): Promise<StatementResult> {
  const to = input.to ? toDate(input.to, 'to') : new Date();
  const from = input.from ? toDate(input.from, 'from') : new Date(to.getTime() - DEFAULT_STATEMENT_LOOKBACK_MS);
  if (from.getTime() > to.getTime()) {
    throw new ValidationError('`from` must be on or before `to`');
  }

  const types: TransactionType[] =
    input.role === 'advertiser' ? ['CAMPAIGN_CHARGE', 'REFUND'] : ['PUBLISHER_EARNING'];

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      type: { in: types },
      status: 'COMPLETED',
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_STATEMENT_ROWS,
  });

  const statementRows: StatementRow[] = rows.map((row) => ({
    date: row.createdAt.toISOString(),
    kind: row.type === 'PUBLISHER_EARNING' ? 'EARNING' : row.type === 'REFUND' ? 'REFUND' : 'CHARGE',
    description: row.description ?? (row.type === 'PUBLISHER_EARNING' ? 'Earning' : row.type === 'REFUND' ? 'Refund' : 'Campaign charge'),
    reference: row.reference,
    amountCents: row.amountCents,
  }));

  const totals =
    input.role === 'advertiser'
      ? (() => {
          const chargesCents = statementRows.reduce((sum, r) => (r.kind === 'CHARGE' ? sum + Math.abs(r.amountCents) : sum), 0);
          const refundsCents = statementRows.reduce((sum, r) => (r.kind === 'REFUND' ? sum + Math.abs(r.amountCents) : sum), 0);
          return { chargesCents, refundsCents, netCents: chargesCents - refundsCents };
        })()
      : (() => {
          const earnedCents = statementRows.reduce((sum, r) => (r.kind === 'EARNING' ? sum + r.amountCents : sum), 0);
          return { earnedCents, entries: statementRows.length };
        })();

  return {
    role: input.role,
    from: from.toISOString(),
    to: to.toISOString(),
    rows: statementRows,
    totals,
  };
}

/* ------------------------------------------------------------------
 *  CSV
 * ------------------------------------------------------------------ */

/**
 * RFC-4180 field escaping: wrap in double quotes when the field contains a
 * comma, a double quote, CR or LF; an embedded quote is escaped by doubling.
 */
function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise statement rows to CSV (RFC 4180: CRLF record separator, quoted
 * fields where needed). Money is written as an exact 2-decimal major unit —
 * cents are integers, so no precision is lost.
 */
export function toCsv(rows: StatementRow[]): string {
  const header = ['date', 'kind', 'description', 'reference', 'amount'];
  const lines = rows.map((r) =>
    [r.date, r.kind, r.description, r.reference, (r.amountCents / 100).toFixed(2)]
      .map((v) => escapeCsvField(String(v)))
      .join(','),
  );
  return [header.map(escapeCsvField).join(','), ...lines].join('\r\n') + '\r\n';
}
