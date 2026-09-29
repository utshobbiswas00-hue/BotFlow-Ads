import { Bot } from 'grammy';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { handleBalance } from './commands/balance';
import { handleHelp } from './commands/help';
import { handleLink } from './commands/link';
import { handleStart } from './commands/start';
import { handleSupport } from './commands/support';
import { handleTerms } from './commands/terms';
import { handleChannelPost } from './handlers/channelPost';
import { handleCallbackQuery } from './handlers/callbackQuery';
import { handleMyChatMember } from './handlers/myChatMember';
import { handlePreCheckoutQuery, handleSuccessfulPayment } from './handlers/stars';

/**
 * BotFlow Ads Telegram bot.
 *
 * One bot instance per process. Two ways to feed it updates:
 *   - local dev:  startBotPolling()            (long polling)
 *   - production: mount `telegramWebhook` from ./webhook on the Express app
 *
 * Handlers are registered in a strict order: commands first, then the
 * structural updates (my_chat_member, channel_post) and finally inline
 * button callbacks. The global error handler is attached last so it sees
 * everything above it.
 */

/**
 * grammY throws "Empty token!" on construction, which would crash the whole
 * API process at import time. We use an obviously invalid placeholder instead
 * so the HTTP API can still boot and serve health checks while the operator
 * finishes configuring the bot. Every outbound Telegram call will fail loudly,
 * which is the correct behaviour — better than a silent no-op.
 */
export const BOT_TOKEN_CONFIGURED = env.TELEGRAM_BOT_TOKEN.trim().length > 0;
const BOT_TOKEN = BOT_TOKEN_CONFIGURED ? env.TELEGRAM_BOT_TOKEN : '0:BOTFLOW_BOT_TOKEN_NOT_CONFIGURED';

if (!BOT_TOKEN_CONFIGURED) {
  logger.warn(
    'TELEGRAM_BOT_TOKEN is not set — the bot will not receive updates and all Telegram API calls will fail. Set it in the environment and redeploy.',
  );
}

export const bot = new Bot(BOT_TOKEN);

/* ------------------------------------------------------------------ *
 *  Command handlers
 * ------------------------------------------------------------------ */
bot.command('start', handleStart);
bot.command('balance', handleBalance);
bot.command('help', handleHelp);
bot.command('link', handleLink);
bot.command('support', handleSupport);
// Required by Telegram's live checklist for selling digital goods for Stars.
bot.command('terms', handleTerms);
// Telegram asks for a payment-dispute route specifically, and `/paysupport` is
// the name it looks for. Pointed at the same handler as /support: a second
// support inbox nobody reads is worse than one that is actually monitored.
bot.command('paysupport', handleSupport);

/* ------------------------------------------------------------------ *
 *  Structural updates
 * ------------------------------------------------------------------ */
bot.on('my_chat_member', handleMyChatMember);
bot.on('channel_post', handleChannelPost);
bot.on('callback_query:data', handleCallbackQuery);

/* ------------------------------------------------------------------ *
 *  Telegram Stars payments
 *
 *  Both are needed: the first approves the charge before it happens, the
 *  second credits it afterwards. `pre_checkout_query` must also be listed in
 *  the webhook's allowed_updates (./webhook.ts) or Telegram never delivers it.
 * ------------------------------------------------------------------ */
bot.on('pre_checkout_query', handlePreCheckoutQuery);
bot.on('message:successful_payment', handleSuccessfulPayment);

/* ------------------------------------------------------------------ *
 *  Global error handling
 * ------------------------------------------------------------------ */
const GENERIC_ERROR = 'Something went wrong. Please try again or contact support.';

bot.catch((err) => {
  const ctx = err.ctx;
  const updateType = ctx.update ? Object.keys(ctx.update).find((k) => k !== 'update_id') : undefined;

  logger.error(
    { err: err.error, updateType, chatId: ctx.chat ? String(ctx.chat.id) : undefined },
    'bot handler error',
  );

  // Reply when the update gives us a target. The handler itself may have
  // failed because Telegram was unreachable, so swallow the second failure.
  void (async () => {
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery(GENERIC_ERROR);
      } else if (ctx.message || ctx.editedMessage || ctx.channelPost || ctx.editedChannelPost) {
        await ctx.reply(GENERIC_ERROR);
      }
    } catch {
      /* nothing more we can do — already logged above */
    }
  })();
});

/* ------------------------------------------------------------------ *
 *  Lifecycle helpers
 * ------------------------------------------------------------------ */

/** Publish the command menu shown by Telegram under "/". */
export async function configureBotCommands(): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Open BotFlow Ads' },
    { command: 'balance', description: 'Show your wallet balance' },
    { command: 'help', description: 'How BotFlow Ads works' },
    { command: 'support', description: 'Contact support' },
    { command: 'terms', description: 'Terms and payment fees' },
    { command: 'paysupport', description: 'Help with a payment' },
  ]);
}

/** Long polling for local development. Do NOT call this in production — the webhook serves updates there. */
export function startBotPolling(): Promise<void> {
  return bot.start({
    onStart: (info) => {
      logger.info(
        { botId: String(info.id), username: info.username ?? null },
        'Telegram bot started (long polling)',
      );
    },
  });
}
