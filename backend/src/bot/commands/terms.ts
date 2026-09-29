import type { Context } from 'grammy';

/**
 * `/terms` — required before a bot may take Stars for digital goods.
 *
 * Telegram's live checklist asks for a bot that can show its terms and for a
 * way to reach support, and it requires the user to have agreed to them. Both
 * `/terms` and `/support` therefore exist as commands; the support address comes
 * from the environment so it cannot drift out of sync with the real inbox.
 *
 * The Stars-specific line is deliberate: 48% is taken before the balance is
 * credited, and that has to be stated up front rather than discovered after
 * paying.
 */
export async function handleTerms(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      'BotFlow Ads — terms summary',
      '',
      '• Ad credit is prepaid and is spent on delivered advertising, not refundable once spent.',
      '• Payments by Telegram Stars are final. Telegram keeps a 48% commission, so the credit added to your balance is 52% of the Stars you send.',
      '• Crypto deposits are credited in full — no payment fee is taken on that rail.',
      '• Ad credit is a service balance, not a deposit account, and carries no interest.',
      '• Fraudulent clicks and self-clicks are filtered and are not billed.',
      '',
      'Telegram support cannot help with purchases made through this bot — contact us with /support.',
    ].join('\n'),
  );
}
