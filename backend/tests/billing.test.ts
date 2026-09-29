import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/errors';
import { getPagination } from '../src/utils/pagination';
import type { TestUser } from './helpers/fixtures';

// The queue producers are not under test here, and importing them would open a
// real Redis connection during the suite (same reason as the other money tests).
const queue = vi.hoisted(() => ({
  enqueuePublishAd: vi.fn(async () => 'queued' as string | null),
  enqueueNotification: vi.fn(async () => undefined),
  enqueueChannelStatsRefresh: vi.fn(async () => undefined),
  enqueueEmail: vi.fn(async () => undefined),
  enqueueWebhookEvent: vi.fn(async () => undefined),
  emitWebhookEvent: vi.fn(async () => 0),
}));
vi.mock('../src/queues/producers', () => queue);

const { generateInvoice, listInvoices, getInvoice, markInvoicePaid, buildStatement, toCsv } =
  await import('../src/services/invoice.service');
const { resetDatabase, createUser, setTestSettings } = await import('./helpers/fixtures');
import type { StatementRow } from '../src/services/invoice.service';

/**
 * ADVERTISER BILLING — invoices are DOCUMENTS of the ledger, never money movement.
 *
 *   - an invoice is built 1:1 from the real COMPLETED ledger rows in a period
 *   - nothing is charged twice and nothing is invented
 *   - one non-VOID invoice per exact (user, period): re-generating returns it
 *   - numbers are unique (UNIQUE backstop + one P2002 retry) and global per year
 *   - a user can never read or pay another user's invoice
 *   - statements are the raw ledger per role; CSV is RFC-4180 safe
 */

const JAN_1 = new Date('2026-01-01T00:00:00.000Z');
const JAN_31 = new Date('2026-01-31T23:59:59.999Z');
const FEB_1 = new Date('2026-02-01T00:00:00.000Z');
const FEB_28 = new Date('2026-02-28T23:59:59.999Z');
const MAR_1 = new Date('2026-03-01T00:00:00.000Z');
const MAR_31 = new Date('2026-03-31T23:59:59.999Z');

/**
 * Insert a real ledger row (the tests seed the append-only ledger directly;
 * the service under test only READS it and writes the invoice document).
 */
async function insertTx(
  user: TestUser,
  data: {
    type: 'CAMPAIGN_CHARGE' | 'REFUND' | 'PUBLISHER_EARNING' | 'DEPOSIT';
    amountCents: number;
    reference: string;
    createdAt: Date;
    status?: 'COMPLETED' | 'PENDING' | 'FAILED' | 'REVERSED';
    description?: string | null;
    campaignId?: string | null;
  },
): Promise<void> {
  await prisma.transaction.create({
    data: {
      userId: user.id,
      type: data.type,
      status: data.status ?? 'COMPLETED',
      amountCents: data.amountCents,
      reference: data.reference,
      campaignId: data.campaignId ?? null,
      description: data.description ?? null,
      createdAt: data.createdAt,
    },
  });
}

/** A one-charge period, so a generate call always has real activity. */
async function seedChargePeriod(user: TestUser, at: Date, amountCents = 1_000, suffix = 'x'): Promise<void> {
  await insertTx(user, {
    type: 'CAMPAIGN_CHARGE',
    amountCents: -amountCents,
    reference: `charge:seed-${suffix}-${at.getTime()}`,
    createdAt: at,
    description: `Sponsored post ${suffix}`,
  });
}

/** Tiny RFC-4180 record parser — only as strict as the escaping contract. */
function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\r' && csv[i + 1] === '\n') {
      pushRecord();
      i++;
    } else if (c === '\n') {
      pushRecord();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) pushRecord();
  return records;
}

describe('invoice generation — built from the real ledger', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sums charges and refunds from real ledger rows into subtotal/refund/total', async () => {
    const advertiser = await createUser();

    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -5_000,
      reference: 'charge:post-1',
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
      description: 'Sponsored post, channel A',
    });
    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -2_500,
      reference: 'charge:post-2',
      createdAt: new Date('2026-01-12T09:30:00.000Z'),
      description: 'Sponsored post, channel B',
    });
    await insertTx(advertiser, {
      type: 'REFUND',
      amountCents: 1_500,
      reference: 'refund:camp-1:cancel',
      createdAt: new Date('2026-01-20T12:00:00.000Z'),
      description: 'Campaign cancelled',
    });
    // All of these must NOT appear on the invoice:
    await insertTx(advertiser, {
      type: 'DEPOSIT',
      amountCents: 100_000,
      reference: 'deposit:d-1',
      createdAt: new Date('2026-01-02T08:00:00.000Z'),
    });
    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -999,
      reference: 'charge:outside-period',
      createdAt: new Date('2025-12-28T08:00:00.000Z'),
    });
    await insertTx(advertiser, {
      type: 'REFUND',
      amountCents: 500,
      reference: 'refund:reversed',
      createdAt: new Date('2026-01-22T08:00:00.000Z'),
      status: 'REVERSED',
    });

    const result = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });

    expect(result.existing).toBe(false);
    expect(result.subtotalCents).toBe(7_500);
    expect(result.refundCents).toBe(1_500);
    expect(result.totalCents).toBe(6_000);
    expect(result.status).toBe('ISSUED');
    expect(result.currency).toBe('USD');

    // One line per real ledger row — deposits, out-of-period rows and
    // REVERSED rows are all excluded (no invention, no double-counting).
    expect(result.lineItems).toHaveLength(3);
    expect(result.lineItems.map((l) => l.reference).sort()).toEqual(
      ['charge:post-1', 'charge:post-2', 'refund:camp-1:cancel'].sort(),
    );
    // Charges are presented with their absolute value; refunds as negatives.
    expect(result.lineItems.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0)).toBe(7_500);
    expect(result.lineItems.filter((l) => l.amountCents < 0).reduce((s, l) => s - l.amountCents, 0)).toBe(1_500);
  });

  it('snapshots every line to its ledger row (reference + absolute amount)', async () => {
    const advertiser = await createUser();

    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -5_000,
      reference: 'charge:post-1',
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
      description: 'Sponsored post, channel A',
    });
    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -2_500,
      reference: 'charge:post-2',
      createdAt: new Date('2026-01-12T09:30:00.000Z'),
      description: null,
    });
    await insertTx(advertiser, {
      type: 'REFUND',
      amountCents: 1_500,
      reference: 'refund:camp-1:cancel',
      createdAt: new Date('2026-01-20T12:00:00.000Z'),
      description: 'Campaign cancelled',
    });

    const result = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });

    expect(result.subtotalCents).toBe(7_500);
    expect(result.refundCents).toBe(1_500);
    expect(result.totalCents).toBe(6_000);

    expect(result.lineItems).toEqual([
      {
        description: 'Sponsored post, channel A',
        quantity: 1,
        unitAmountCents: 5_000,
        amountCents: 5_000,
        reference: 'charge:post-1',
        occurredAt: '2026-01-05T10:00:00.000Z',
      },
      {
        description: 'Campaign charge',
        quantity: 1,
        unitAmountCents: 2_500,
        amountCents: 2_500,
        reference: 'charge:post-2',
        occurredAt: '2026-01-12T09:30:00.000Z',
      },
      {
        description: 'Campaign cancelled',
        quantity: 1,
        unitAmountCents: 1_500,
        amountCents: -1_500,
        reference: 'refund:camp-1:cancel',
        occurredAt: '2026-01-20T12:00:00.000Z',
      },
    ]);

    // The lines sum to the total exactly.
    const sum = result.lineItems.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(result.totalCents);

    // Notification + audit + webhook fan-out all fired for the new document.
    const notification = await prisma.notification.findFirst({
      where: { userId: advertiser.id, type: 'INVOICE_READY' },
    });
    expect(notification).not.toBeNull();
    expect(notification?.body).toContain(result.number);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'INVOICE_CREATED', targetId: result.id },
    });
    expect(audit).not.toBeNull();

    expect(queue.enqueueWebhookEvent).toHaveBeenCalledTimes(1);
    expect(queue.enqueueWebhookEvent).toHaveBeenCalledWith(
      advertiser.id,
      'INVOICE_ISSUED',
      expect.objectContaining({ invoiceId: result.id, number: result.number, totalCents: 6_000 }),
    );
  });

  it('returns the SAME invoice for a second generate of the same period — no duplicate row', async () => {
    const advertiser = await createUser();
    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'a');

    const first = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });
    const second = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });

    expect(second.existing).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
    expect(await prisma.invoice.count({ where: { userId: advertiser.id } })).toBe(1);

    // Even two truly concurrent calls must converge on one document.
    const advertiser2 = await createUser();
    await seedChargePeriod(advertiser2, new Date('2026-01-05T10:00:00.000Z'), 2_000, 'b');
    const [r1, r2] = await Promise.all([
      generateInvoice(advertiser2.id, { from: JAN_1, to: JAN_31 }),
      generateInvoice(advertiser2.id, { from: JAN_1, to: JAN_31 }),
    ]);
    expect(r1.id).toBe(r2.id);
    expect(await prisma.invoice.count({ where: { userId: advertiser2.id } })).toBe(1);
  });

  it('numbers invoices prefix-year-month-sequence, globally increasing and collision-free', async () => {
    const advertiser = await createUser();
    const other = await createUser();

    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'p1');
    await seedChargePeriod(advertiser, new Date('2026-01-15T10:00:00.000Z'), 1_000, 'p2');
    await seedChargePeriod(advertiser, new Date('2026-02-10T10:00:00.000Z'), 1_000, 'p3');
    await seedChargePeriod(other, new Date('2026-02-20T10:00:00.000Z'), 1_000, 'p4');

    const a = await generateInvoice(advertiser.id, { from: JAN_1, to: new Date('2026-01-10T00:00:00.000Z') });
    const b = await generateInvoice(advertiser.id, { from: new Date('2026-01-11T00:00:00.000Z'), to: JAN_31 });
    const c = await generateInvoice(advertiser.id, { from: FEB_1, to: new Date('2026-02-15T00:00:00.000Z') });
    const d = await generateInvoice(other.id, { from: new Date('2026-02-16T00:00:00.000Z'), to: FEB_28 });

    // The counter is global across users and months within the year.
    expect(a.number).toBe('BFA-2026-01-000001');
    expect(b.number).toBe('BFA-2026-01-000002');
    expect(c.number).toBe('BFA-2026-02-000003');
    expect(d.number).toBe('BFA-2026-02-000004');
    for (const inv of [a, b, c, d]) {
      expect(inv.number).toMatch(/^[A-Z]+-\d{4}-\d{2}-\d{6}$/);
    }
    expect(new Set([a.number, b.number, c.number, d.number]).size).toBe(4);

    // A configured prefix is honoured (its own counter starts at 1).
    await setTestSettings({ invoice_number_prefix: 'INV' });
    await seedChargePeriod(advertiser, new Date('2026-03-05T10:00:00.000Z'), 1_000, 'p5');
    const e = await generateInvoice(advertiser.id, { from: MAR_1, to: MAR_31 });
    expect(e.number).toBe('INV-2026-03-000001');
  });

  it('still issues a document for a zero-value period, explicitly labelled as such', async () => {
    const advertiser = await createUser();
    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'z1');
    await insertTx(advertiser, {
      type: 'REFUND',
      amountCents: 1_000,
      reference: 'refund:camp-z:full',
      createdAt: new Date('2026-01-15T10:00:00.000Z'),
      description: 'Full refund',
    });

    const result = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });

    expect(result.subtotalCents).toBe(1_000);
    expect(result.refundCents).toBe(1_000);
    expect(result.totalCents).toBe(0);
    expect(result.lineItems).toHaveLength(2); // not an empty document

    const notification = await prisma.notification.findFirst({
      where: { userId: advertiser.id, type: 'INVOICE_READY' },
    });
    expect(notification?.body).toMatch(/zero-value/i);
  });

  it('refuses a period with no billable activity and creates nothing', async () => {
    const advertiser = await createUser();
    await insertTx(advertiser, {
      type: 'DEPOSIT',
      amountCents: 50_000,
      reference: 'deposit:d-2',
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
    });

    await expect(generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it('refuses to generate at all while INVOICE_ENABLED is false', async () => {
    await setTestSettings({ invoice_enabled: false });
    const advertiser = await createUser();
    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'off');

    await expect(generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 })).rejects.toMatchObject({
      name: 'ValidationError',
    });
    const err = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/disabled/i);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it('line items are a frozen snapshot: later ledger rows never rewrite an issued invoice', async () => {
    const advertiser = await createUser();
    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'snap');

    const issued = await generateInvoice(advertiser.id, { from: JAN_1, to: JAN_31 });
    expect(issued.lineItems).toHaveLength(1);

    // A new charge lands INSIDE the already-issued period.
    await insertTx(advertiser, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -4_000,
      reference: 'charge:late',
      createdAt: new Date('2026-01-25T10:00:00.000Z'),
      description: 'Late charge after issue',
    });

    const reread = await getInvoice(advertiser.id, issued.id);
    expect(reread.lineItems).toHaveLength(1);
    expect(reread.totalCents).toBe(1_000);
    expect(reread.lineItems[0].reference).toMatch(/^charge:seed-snap-/);
  });

  it('lists the caller invoices newest period first, with pagination totals', async () => {
    const advertiser = await createUser();
    await seedChargePeriod(advertiser, new Date('2026-01-05T10:00:00.000Z'), 100, 'l1');
    await seedChargePeriod(advertiser, new Date('2026-02-05T10:00:00.000Z'), 200, 'l2');
    await seedChargePeriod(advertiser, new Date('2026-03-05T10:00:00.000Z'), 300, 'l3');

    await generateInvoice(advertiser.id, { from: JAN_1, to: new Date('2026-01-10T00:00:00.000Z') });
    await generateInvoice(advertiser.id, { from: FEB_1, to: new Date('2026-02-10T00:00:00.000Z') });
    await generateInvoice(advertiser.id, { from: MAR_1, to: new Date('2026-03-10T00:00:00.000Z') });

    const page1 = await listInvoices(advertiser.id, getPagination({ page: 1, limit: 2 }));
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.items[0].totalCents).toBe(300); // March first
    expect(page1.items[1].totalCents).toBe(200);

    const page2 = await listInvoices(advertiser.id, getPagination({ page: 2, limit: 2 }));
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].totalCents).toBe(100);
    expect(page2.hasMore).toBe(false);
  });
});

describe('invoice access & status — per-user, claimed once', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
  });

  it('getInvoice never leaks another user\'s invoice (404, not 403)', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await seedChargePeriod(owner, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'own');
    const invoice = await generateInvoice(owner.id, { from: JAN_1, to: JAN_31 });

    await expect(getInvoice(stranger.id, invoice.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getInvoice(stranger.id, 'does-not-exist')).rejects.toBeInstanceOf(NotFoundError);

    const mine = await getInvoice(owner.id, invoice.id);
    expect(mine.id).toBe(invoice.id);
  });

  it('markInvoicePaid refuses another user\'s invoice', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await seedChargePeriod(owner, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'own2');
    const invoice = await generateInvoice(owner.id, { from: JAN_1, to: JAN_31 });

    await expect(markInvoicePaid(stranger.id, invoice.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe('ISSUED');
  });

  it('two concurrent markInvoicePaid calls cannot both claim the transition', async () => {
    const owner = await createUser();
    await seedChargePeriod(owner, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'conc');
    const invoice = await generateInvoice(owner.id, { from: JAN_1, to: JAN_31 });

    const [r1, r2] = await Promise.all([markInvoicePaid(owner.id, invoice.id), markInvoicePaid(owner.id, invoice.id)]);

    // Exactly one performed the write; both callers end at the same PAID row
    // with ONE paidAt stamp (the winner's) — the loser did not re-stamp it.
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();
    // Captured ONCE: every caller must report this exact stamp, never re-stamp it.
    const paidAtIso = paid.paidAt!.toISOString();

    expect(r1.status).toBe('PAID');
    expect(r2.status).toBe('PAID');
    expect(r1.paidAt).toBe(paidAtIso);
    expect(r2.paidAt).toBe(paidAtIso);
    expect(r1.paidAt).not.toBeNull();

    // A third call is an idempotent read, not a second transition.
    const r3 = await markInvoicePaid(owner.id, invoice.id);
    expect(r3.paidAt).toBe(paidAtIso);
  });

  it('refuses to pay a VOID invoice', async () => {
    const owner = await createUser();
    await seedChargePeriod(owner, new Date('2026-01-05T10:00:00.000Z'), 1_000, 'void');
    const invoice = await generateInvoice(owner.id, { from: JAN_1, to: JAN_31 });

    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'VOID' } });
    await expect(markInvoicePaid(owner.id, invoice.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('statements — per-role views of the ledger', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('the advertiser statement returns spend lines (charges + refunds) with net totals', async () => {
    const user = await createUser();
    await insertTx(user, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -5_000,
      reference: 'charge:s1',
      createdAt: new Date('2026-01-05T10:00:00.000Z'),
      description: 'Post 1',
    });
    await insertTx(user, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -2_500,
      reference: 'charge:s2',
      createdAt: new Date('2026-01-12T10:00:00.000Z'),
      description: 'Post 2',
    });
    await insertTx(user, {
      type: 'REFUND',
      amountCents: 1_500,
      reference: 'refund:s1:cancel',
      createdAt: new Date('2026-01-20T10:00:00.000Z'),
      description: 'Cancelled',
    });
    // Must be excluded from the advertiser statement:
    await insertTx(user, {
      type: 'DEPOSIT',
      amountCents: 99_000,
      reference: 'deposit:s9',
      createdAt: new Date('2026-01-03T10:00:00.000Z'),
    });
    await insertTx(user, {
      type: 'PUBLISHER_EARNING',
      amountCents: 3_000,
      reference: 'earning:s3',
      createdAt: new Date('2026-01-18T10:00:00.000Z'),
    });

    const statement = await buildStatement(user.id, { from: JAN_1, to: JAN_31, role: 'advertiser' });

    expect(statement.role).toBe('advertiser');
    expect(statement.rows).toHaveLength(3);
    expect(statement.rows.map((r) => r.kind)).toEqual(['CHARGE', 'CHARGE', 'REFUND']);
    expect(statement.rows[0]).toMatchObject({ reference: 'charge:s1', amountCents: -5_000 });
    expect(statement.totals).toEqual({ chargesCents: 7_500, refundsCents: 1_500, netCents: 6_000 });
  });

  it('the publisher statement returns earning lines with earned totals', async () => {
    const user = await createUser();
    await insertTx(user, {
      type: 'PUBLISHER_EARNING',
      amountCents: 2_000,
      reference: 'earning:p1',
      createdAt: new Date('2026-01-06T10:00:00.000Z'),
      description: 'Earning from sponsored post',
    });
    await insertTx(user, {
      type: 'PUBLISHER_EARNING',
      amountCents: 3_000,
      reference: 'earning:p2',
      createdAt: new Date('2026-01-19T10:00:00.000Z'),
      description: 'CPM earning',
    });
    // Must be excluded from the publisher statement:
    await insertTx(user, {
      type: 'CAMPAIGN_CHARGE',
      amountCents: -5_000,
      reference: 'charge:p9',
      createdAt: new Date('2026-01-10T10:00:00.000Z'),
    });

    const statement = await buildStatement(user.id, { from: JAN_1, to: JAN_31, role: 'publisher' });

    expect(statement.role).toBe('publisher');
    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.every((r) => r.kind === 'EARNING')).toBe(true);
    expect(statement.rows.map((r) => r.reference)).toEqual(['earning:p1', 'earning:p2']);
    expect(statement.totals).toEqual({ earnedCents: 5_000, entries: 2 });
  });
});

describe('toCsv — RFC 4180', () => {
  it('escapes a description containing a comma and a double quote without shifting columns', () => {
    const rows: StatementRow[] = [
      {
        date: '2026-01-05T10:00:00.000Z',
        kind: 'CHARGE',
        description: 'Sponsored post, channel A',
        reference: 'charge:post-1',
        amountCents: -5_000,
      },
      {
        date: '2026-01-06T10:00:00.000Z',
        kind: 'CHARGE',
        description: 'He said "hi", loudly',
        reference: 'charge:post-2',
        amountCents: -2_500,
      },
      {
        date: '2026-01-07T10:00:00.000Z',
        kind: 'REFUND',
        description: 'Plain refund',
        reference: 'refund:1',
        amountCents: 1_500,
      },
    ];

    const csv = toCsv(rows);

    expect(csv).toBe(
      [
        'date,kind,description,reference,amount',
        '2026-01-05T10:00:00.000Z,CHARGE,"Sponsored post, channel A",charge:post-1,-50.00',
        '2026-01-06T10:00:00.000Z,CHARGE,"He said ""hi"", loudly",charge:post-2,-25.00',
        '2026-01-07T10:00:00.000Z,REFUND,Plain refund,refund:1,15.00',
        '',
      ].join('\r\n'),
    );

    // And a strict parser reads every record back as exactly five fields.
    const records = parseCsvRecords(csv);
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record).toHaveLength(5);
    }
    expect(records[1][2]).toBe('Sponsored post, channel A');
    expect(records[2][2]).toBe('He said "hi", loudly');
    expect(records[3][2]).toBe('Plain refund');
  });

  it('emits no body rows (only the header) for an empty statement', () => {
    expect(toCsv([])).toBe('date,kind,description,reference,amount\r\n');
  });
});
