/**
 * Billing response types — mirror the shapes served by
 * `backend/src/services/invoice.service.ts` (InvoiceView / StatementResult)
 * exactly as returned by:
 *
 *   GET /api/billing/invoices        → Paginated<InvoiceView>
 *   GET /api/billing/invoices/:id    → InvoiceView
 *   GET /api/billing/statement       → raw CSV text (format=csv)
 *                                      or { ok, data: StatementResult } (format=json)
 *
 * Money is integer cents. Totals (subtotalCents / refundCents / totalCents)
 * are computed by the backend from the transaction ledger — the UI displays
 * them verbatim and never recomputes them.
 */

/** One invoice line — a frozen 1:1 snapshot of a single COMPLETED ledger row. */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  /** Per-unit price in cents (always positive; the sign lives in amountCents). */
  unitAmountCents: number;
  /** SIGNED: charge lines are positive, refund lines are negative. */
  amountCents: number;
  /** Ledger reference of the row this line was snapshotted from. */
  reference: string;
  /** ISO date of the ledger row. */
  occurredAt: string;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';

/** Invoice document as returned by the API (list items and detail). */
export interface InvoiceView {
  id: string;
  /** Globally unique number, e.g. `BFA-2026-09-000001`. */
  number: string;
  /** ISO. */
  periodStart: string;
  /** ISO. */
  periodEnd: string;
  currency: string;
  /** Sum of charges (absolute values), in cents. */
  subtotalCents: number;
  /** Sum of refunds (absolute values), in cents. */
  refundCents: number;
  /** subtotalCents - refundCents, in cents. */
  totalCents: number;
  status: InvoiceStatus;
  lineItems: InvoiceLineItem[];
  /** ISO. */
  issuedAt: string;
  /** ISO or null. */
  sentAt: string | null;
  /** ISO or null. */
  paidAt: string | null;
  /** ISO. */
  createdAt: string;
}

export type StatementRole = 'advertiser' | 'publisher';

export type StatementRowKind = 'CHARGE' | 'REFUND' | 'EARNING';

/** One row of a statement — the raw ledger for a period. */
export interface StatementRow {
  /** ISO date of the ledger row. */
  date: string;
  kind: StatementRowKind;
  description: string;
  reference: string;
  /** SIGNED: money out of the advertiser's balance is negative, money in positive. */
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

export type StatementTotals = AdvertiserStatementTotals | PublisherStatementTotals;

/** Statement as returned by `GET /api/billing/statement?format=json`. */
export interface StatementResult {
  role: StatementRole;
  /** ISO (the window the server actually used). */
  from: string;
  /** ISO (the window the server actually used). */
  to: string;
  rows: StatementRow[];
  totals: StatementTotals;
}
