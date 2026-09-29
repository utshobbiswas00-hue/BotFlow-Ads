import type { CommandContext, Context } from 'grammy';
import { env } from '../../config/env';
import { escapeHtml } from '../../utils/format';
import { miniAppKeyboard } from '../keyboards/inline';

/**
 * /link — how to open the Mini App.
 */
export async function handleLink(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    [
      '🔗 <b>Open BotFlow Ads</b>',
      '',
      'The full experience — your channels, campaigns, wallet and support — lives in the Telegram Mini App.',
      '',
      `• Tap the button below, or visit <a href="${escapeHtml(env.MINI_APP_URL)}">${escapeHtml(env.MINI_APP_URL)}</a>`,
      '• In the app: add a channel to start earning, or create a campaign to start advertising.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: miniAppKeyboard() },
  );
}
