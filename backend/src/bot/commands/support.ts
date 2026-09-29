import type { CommandContext, Context } from 'grammy';
import { supportKeyboard } from '../keyboards/inline';
import { SUPPORT_USERNAME } from '@botflow/shared';

/**
 * /support — support tickets live inside the Mini App, not in chat.
 */
export async function handleSupport(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    [
      '🛟 <b>Support</b>',
      '',
      'To open a support ticket, go into the Mini App and use the <b>Support</b> section —',
      'your history and attachments are kept with your account.',
      '',
      'Prefer to talk to someone? Message us directly at <b>@' + SUPPORT_USERNAME + '</b>.',
      '',
      'For urgent payment or delivery issues, mention your campaign or channel name in the ticket.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: supportKeyboard() },
  );
}
