import type { Context } from 'grammy';
import { logger } from '../../config/logger';
import { completeStarsPayment, reviewPreCheckout } from '../../services/stars.service';
import { alertAdmins } from '../../services/notification.service';

/**
 * Telegram Stars callbacks.
 *
 * These two handlers are the whole reason a Stars payment works or does not:
 *
 *   pre_checkout_query  — asked BEFORE Telegram charges. Telegram cancels the
 *                         order if it is not answered within 10 seconds, so this
 *                         must be fast and must never throw unanswered.
 *   successful_payment  — arrives AFTER the Stars are taken, inside a `message`
 *                         update. Anything not credited here is money the
 *                         advertiser paid and did not receive.
 *
 * Both are registered in bot.ts, and `pre_checkout_query` must ALSO be listed in
 * the webhook's `allowed_updates` (bot/webhook.ts) — otherwise Telegram never
 * delivers the update and every checkout fails with no error anywhere.
 */

/**
 * Approve or refuse the pending charge.
 *
 * A refusal carries a human-readable reason: Telegram shows it to the buyer, and
 * "nothing happened" is the worst possible outcome for someone trying to pay.
 */
export async function handlePreCheckoutQuery(ctx: Context): Promise<void> {
  const query = ctx.preCheckoutQuery;
  if (!query) return;

  try {
    const review = await reviewPreCheckout({
      payload: query.invoice_payload,
      totalAmountStars: query.total_amount,
    });

    await ctx.answerPreCheckoutQuery(
      review.ok,
      review.ok ? undefined : { error_message: review.reason ?? 'This top up could not be verified.' },
    );
  } catch (err) {
    logger.error({ err, payload: query.invoice_payload }, 'pre_checkout_query review failed');
    // The 10-second clock is still running, so refuse loudly rather than leave
    // Telegram waiting — an unanswered query is cancelled with no explanation.
    await ctx
      .answerPreCheckoutQuery(false, {
        error_message: 'We could not verify this top up. Please try again in a moment.',
      })
      .catch(() => undefined);
  }
}

/**
 * Credit the advertiser.
 *
 * Telegram redelivers updates, so this path must tolerate being called twice —
 * `completeStarsPayment` delegates to the ledger's PENDING guard, which turns a
 * replay into a no-op.
 */
export async function handleSuccessfulPayment(ctx: Context): Promise<void> {
  // grammY exposes the raw Bot API field name here, unlike its own camelCase
  // convenience accessors elsewhere.
  const payment = ctx.message?.successful_payment;
  if (!payment) return;

  try {
    const result = await completeStarsPayment({
      payload: payment.invoice_payload,
      totalAmountStars: payment.total_amount,
      chargeId: payment.telegram_payment_charge_id,
    });

    if (!result) {
      // Stars were taken but no deposit could be credited. This is the one
      // outcome an operator MUST hear about, because the advertiser has paid
      // and has nothing to show for it.
      await alertAdmins(
        `Telegram Stars payment could not be credited.\npayload: ${payment.invoice_payload}\nstars: ${payment.total_amount}\ncharge: ${payment.telegram_payment_charge_id}`,
      );
      await ctx
        .reply('Your payment went through but we could not top up automatically. Support has been notified.')
        .catch(() => undefined);
      return;
    }

    // On a replay, stay quiet — the balance message was already sent once, and
    // repeating it makes the advertiser think they were charged twice.
    if (result.alreadyCredited) return;

    await ctx
      .reply(
        `Added $${(result.creditedCents / 100).toFixed(2)} to your ad balance. ` +
          `Telegram keeps its commission from the Stars, so the amount is less than the Stars you sent.`,
      )
      .catch(() => undefined);
  } catch (err) {
    logger.error({ err, payload: payment.invoice_payload }, 'failed to credit a stars payment');
    await alertAdmins(
      `Telegram Stars payment FAILED to credit.\npayload: ${payment.invoice_payload}\nstars: ${payment.total_amount}\ncharge: ${payment.telegram_payment_charge_id}`,
    ).catch(() => undefined);
  }
}
