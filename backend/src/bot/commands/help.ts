import type { CommandContext, Context } from 'grammy';

/**
 * /help — a plain-language overview of both modes and the available commands.
 */
export async function handleHelp(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(
    [
      '<b>How BotFlow Ads works</b>',
      '',
      '📣 <b>Publisher mode</b> — you run a Telegram channel and earn from sponsored posts:',
      '1. Open the Mini App and add your channel.',
      '2. Make BotFlow Bot an administrator with the “Post Messages” permission.',
      '3. We review the channel, then ads start being delivered — you can require manual approval for every post.',
      '',
      '📢 <b>Advertiser mode</b> — you promote a product, service, channel or app:',
      '1. Open the Mini App and create a campaign with a budget.',
      '2. Pick channels yourself or let auto-targeting find the best match.',
      '3. We deliver the posts, track clicks and report performance.',
      '',
      '<b>Commands</b>',
      '/start — open BotFlow Ads',
      '/balance — show your wallet balance',
      '/link — how to open the Mini App',
      '/help — this message',
      '/support — contact support',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}
