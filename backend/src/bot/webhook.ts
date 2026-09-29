import { webhookCallback } from 'grammy';
import { env } from '../config/env';
import { bot } from './bot';

/**
 * Webhook wiring for production.
 *
 * Mount in the Express app:
 *   app.post('/webhook/telegram', telegramWebhook)
 *
 * When TELEGRAM_WEBHOOK_SECRET is set, grammY verifies the
 * X-Telegram-Bot-Api-Secret-Token header on every update and drops
 * anything that does not match, so random traffic cannot forge updates.
 */
export const telegramWebhook = webhookCallback(bot, 'express', {
  secretToken: env.TELEGRAM_WEBHOOK_SECRET,
});

/** Register the webhook with Telegram. Call once at boot (after the HTTP server can serve it). */
export async function setupWebhook(): Promise<true> {
  return bot.api.setWebhook(`${env.APP_URL}/webhook/telegram`, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    /**
     * `pre_checkout_query` is a SEPARATE update type. Telegram only delivers the
     * updates listed here, so without it the bot is never asked to approve a
     * Stars charge — every Stars checkout simply fails, with no error on either
     * side and nothing in the logs to explain it.
     *
     * `successful_payment` needs no entry: it arrives inside a `message`.
     *
     * Changing this list only takes effect once setWebhook runs again (at boot).
     */
    allowed_updates: [
      'message',
      'callback_query',
      'my_chat_member',
      'channel_post',
      'pre_checkout_query',
    ],
  });
}

/** Remove the webhook (e.g. when switching back to long polling). */
export async function deleteWebhook(): Promise<true> {
  return bot.api.deleteWebhook();
}

/** Current webhook state — useful for ops/debugging. */
export async function getWebhookInfo() {
  return bot.api.getWebhookInfo();
}
