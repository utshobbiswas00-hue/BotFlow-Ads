import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { telegramWebhook } from '../bot/webhook';
import { limiters } from '../middleware/rateLimit';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { hmacSha256, timingSafeEqual } from '../utils/crypto';
import { prisma } from '../db/prisma';
import { verifyDeposit } from '../services/deposit.service';
import { alertAdmins } from '../services/notification.service';

/**
 * Webhook endpoints (NO Telegram auth — they are called by external systems).
 *
 * ── MOUNTING ORDER (see app.ts) ─────────────────────────────────────────
 * This router MUST be mounted on the app BEFORE `express.json()` /
 * `express.urlencoded()`:
 *
 *   - POST /webhook/telegram: grammy's express adapter reads `req.body`, so
 *     the route parses its own JSON body with the local parser below. If the
 *     app-level parser ran first the behaviour would be the same, but keeping
 *     the router ahead of every parser guarantees grammy always sees a usable
 *     body (the secret-token check then happens inside grammy).
 *
 *   - POST /webhook/payment: the payment gateway signs the RAW request body,
 *     so the HMAC check needs the raw stream. A body parser running first
 *     would consume the stream and make signature verification impossible.
 *
 * Telegram also authenticates its own webhook via the
 * X-Telegram-Bot-Api-Secret-Token header (verified inside grammy,
 * see bot/webhook.ts) — random traffic cannot forge updates.
 * ────────────────────────────────────────────────────────────────────────
 */

export const webhookRouter = Router();

/** Local JSON parser for the Telegram route (grammy reads req.body). */
const telegramJson = express.json({ limit: '1mb' });

/** POST /webhook/telegram — grammy update ingress. */
webhookRouter.post('/telegram', limiters.webhook, telegramJson, (req, res) => {
  // Fail closed when no secret is configured. grammY compares the presented
  // header byte-for-byte against the expected value, so an empty secret would
  // match an empty `X-Telegram-Bot-Api-Secret-Token` and accept forged updates.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    logger.error('telegram webhook rejected: TELEGRAM_WEBHOOK_SECRET is not configured');
    res.status(503).end();
    return;
  }
  telegramWebhook(req, res).catch((err) => {
    logger.error({ err }, 'telegram webhook handler failed');
    if (!res.headersSent) res.status(500).end();
  });
});

/** Hard cap on raw webhook bodies — an attack must not be able to fill memory. */
const MAX_PAYMENT_BODY_BYTES = 1_000_000;

/**
 * The gateway callback, in the shape THIS platform defines.
 *
 * At least one real gateway must be configured before this is live, and its
 * field names are mapped onto this contract at the edge — the credit logic
 * below reads one vocabulary rather than branching per provider.
 *
 * `amountCents` is in minor units (integer cents), matching the ledger. A
 * gateway that reports major units must convert upstream, not here: silently
 * guessing the unit is how a 100x over-credit happens.
 */
const gatewayPayloadSchema = z.object({
  /** The reference we stored on the deposit (`Deposit.gatewayRef`). */
  gatewayReference: z.string().min(1).max(128),
  /** Minor units. Must equal the deposit's own amount or the credit is refused. */
  amountCents: z.number().int().positive(),
  /** Gateway's own transaction id, kept for reconciliation. */
  transactionId: z.string().max(128).optional(),
  currency: z.string().length(3).optional(),
  /** Defaults to a success: a signed callback is by contract a payment event. */
  status: z.string().max(40).optional(),
  event: z.string().max(60).optional(),
});

/** Gateway spellings of "the money is with us". Anything else is not credited. */
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'paid', 'completed', 'captured', 'approved']);

/**
 * `x-payment-signature` is computed over the RAW body, so the schema is parsed
 * from the same string the HMAC covered — never from a re-serialized object.
 */
async function handleVerifiedPayment(rawBody: string, ip: string | undefined): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    logger.warn({ ip }, 'payment webhook rejected: body is not valid JSON');
    return { status: 400, body: { received: false, error: 'body is not valid JSON' } };
  }

  const parsed = gatewayPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.warn({ ip, issues: parsed.error.issues }, 'payment webhook rejected: unrecognised payload');
    return { status: 400, body: { received: false, error: 'unrecognised payment payload' } };
  }
  const payload = parsed.data;

  if (payload.status && !SUCCESS_STATUSES.has(payload.status.toLowerCase())) {
    // A failed/cancelled payment is a real event we acknowledge but must not
    // credit. 200 so the gateway stops retrying.
    logger.info({ ip, status: payload.status }, 'payment webhook: non-success status, not crediting');
    return { status: 200, body: { received: true, credited: false, reason: `status ${payload.status}` } };
  }

  // The unique `gatewayRef` is what ties a callback to a deposit, and it is
  // also the replay guard: a retried callback finds the same row.
  const deposit = await prisma.deposit.findUnique({ where: { gatewayRef: payload.gatewayReference } });
  if (!deposit) {
    // Do NOT 404: a gateway retrying forever on a configuration mistake is
    // worse than one clear page to the operators. Nothing is credited.
    logger.error(
      { ip, gatewayReference: payload.gatewayReference },
      'payment webhook references an unknown deposit — no credit applied',
    );
    await alertAdmins(
      `A verified payment callback referenced an unknown deposit (gatewayReference=${payload.gatewayReference}, amountCents=${payload.amountCents}). No money was credited. Check the gateway integration before it retries.`,
    );
    return { status: 200, body: { received: true, credited: false, reason: 'unknown deposit reference' } };
  }

  // Already settled? Answer exactly as the first delivery did — the gateway's
  // retry must be a no-op, not a second credit.
  if (deposit.status === 'VERIFIED') {
    return { status: 200, body: { received: true, credited: true, duplicate: true } };
  }
  if (deposit.status !== 'PENDING') {
    logger.error(
      { ip, depositId: deposit.id, status: deposit.status },
      'payment webhook arrived for a non-pending deposit — no credit applied',
    );
    await alertAdmins(
      `A verified payment callback arrived for deposit ${deposit.id}, which is ${deposit.status}. No money was credited — manual review required.`,
    );
    return { status: 200, body: { received: true, credited: false, reason: `deposit is ${deposit.status}` } };
  }

  // The amount must match the deposit the advertiser created. A mismatch is
  // either a tampered callback or a unit error — both are refused loudly.
  if (payload.amountCents !== deposit.amountCents) {
    logger.error(
      { ip, depositId: deposit.id, expected: deposit.amountCents, received: payload.amountCents },
      'payment webhook amount mismatch — no credit applied',
    );
    await alertAdmins(
      `Payment amount mismatch on deposit ${deposit.id}: deposit is ${deposit.amountCents} cents but the gateway reported ${payload.amountCents}. No money was credited.`,
    );
    return { status: 200, body: { received: true, credited: false, reason: 'amount mismatch' } };
  }

  /**
   * Idempotency is the DATABASE's job here, deliberately.
   *
   * `verifyDeposit` re-reads the row inside one transaction and credits only
   * while it is PENDING, and the ledger insert carries the unique reference
   * `deposit:<id>`. Those two survive a Redis flush, a restart mid-request and
   * two workers racing — none of which `withIdempotency` (Redis SET NX) can
   * promise. Redis is a fast path, not a money guarantee, so it is not the
   * primary defence for a credit.
   */
  await verifyDeposit('payment-gateway', deposit.id, `Credited by payment gateway webhook (${payload.event ?? 'payment'})`, {
    gatewayTxnId: payload.transactionId ?? null,
    rawPayload: parsedJson,
  });

  logger.info(
    { ip, depositId: deposit.id, amountCents: deposit.amountCents },
    'payment webhook credited a deposit',
  );
  return { status: 200, body: { received: true, credited: true, duplicate: false } };
}

/**
 * Collect the raw request body, enforcing a hard cap.
 *
 * The parser is deliberately hand-rolled and not `express.json()`: the HMAC is
 * computed over the exact bytes the gateway sent, and a parse-then-reserialize
 * round trip is not guaranteed to reproduce them.
 */
type RawBodyResult =
  | { ok: true; rawBody: string; bytes: number }
  | { ok: false; status: number; error: string };

function readRawBody(req: Request, maxBytes: number): Promise<RawBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: RawBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, status: 413, error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => finish({ ok: false, status: 400, error: 'malformed request' }));

    req.on('end', () =>
      finish({ ok: true, rawBody: Buffer.concat(chunks).toString('utf8'), bytes: total }),
    );
  });
}

/**
 * POST /webhook/payment — payment-gateway webhook.
 *
 * Verifies `x-payment-signature` = HMAC_SHA256(rawBody, PAYMENT_WEBHOOK_SECRET)
 * in hex, in constant time, and only then gets anywhere near the ledger.
 *
 * Four responses, and the difference between them matters:
 *   401 / 503  we could not authenticate the call — nothing touched
 *   400        authenticated but unintelligible — nothing touched
 *   200 + credited:true            money moved (or was already there)
 *   200 + credited:false + reason  acknowledged, deliberately NOT credited
 *
 * Operationally: always 200 once the signature is valid, because a gateway
 * retrying forever on a case we have deliberately declined is worse than one
 * clear answer plus an operator page.
 */
async function handlePaymentWebhook(req: Request, res: Response): Promise<void> {
  const read = await readRawBody(req, MAX_PAYMENT_BODY_BYTES);
  if (!read.ok) {
    logger.warn({ ip: req.ctx?.ip, error: read.error }, 'payment webhook rejected');
    res.status(read.status).json({ received: false, error: read.error });
    return;
  }

  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('payment webhook received but PAYMENT_WEBHOOK_SECRET is not configured — rejecting');
    res.status(503).json({ received: false, error: 'payment webhook not configured' });
    return;
  }

  const signature = req.header('x-payment-signature');
  if (!signature) {
    logger.warn({ ip: req.ctx?.ip }, 'payment webhook rejected: missing x-payment-signature');
    res.status(401).json({ received: false, error: 'missing signature' });
    return;
  }

  const expected = hmacSha256(read.rawBody, secret).toString('hex');
  if (!timingSafeEqual(expected, signature.toLowerCase())) {
    logger.warn({ ip: req.ctx?.ip }, 'payment webhook rejected: signature mismatch');
    res.status(401).json({ received: false, error: 'invalid signature' });
    return;
  }

  logger.info({ ip: req.ctx?.ip, bodyBytes: read.bytes }, 'payment webhook signature verified');

  try {
    const outcome = await handleVerifiedPayment(read.rawBody, req.ctx?.ip);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    // The signature was valid, so the gateway did pay. A 500 makes it retry,
    // which is exactly what we want: the credit is idempotent, so the retry
    // either completes it or is recognised as a duplicate.
    logger.error({ err, ip: req.ctx?.ip }, 'payment webhook: credit failed, asking the gateway to retry');
    res.status(500).json({ received: false, error: 'temporary failure, please retry' });
  }
}

webhookRouter.post('/payment', limiters.webhook, (req, res) => {
  void handlePaymentWebhook(req, res);
});
