import type { CommandContext, Context } from 'grammy';
import { prisma } from '../../db/prisma';
import { formatMoney } from '../../utils/money';
import { getWallet } from '../../services/wallet.service';
import { miniAppKeyboard } from '../keyboards/inline';

/**
 * /balance — show the caller's wallet.
 *
 * The Telegram id is resolved to a User row first; the wallet is read
 * through getWallet (which lazily creates the wallet row).
 */
export async function handleBalance(ctx: CommandContext<Context>): Promise<void> {
  if (!ctx.from) return;

  const telegramId = BigInt(ctx.from.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (!user) {
    await ctx.reply(
      [
        'You don’t have a BotFlow Ads account linked to this Telegram yet.',
        '',
        'Open the Mini App first to create your account — your balance will show up here.',
      ].join('\n'),
      { reply_markup: miniAppKeyboard() },
    );
    return;
  }

  const wallet = await getWallet(user.id);

  await ctx.reply(
    [
      '💰 <b>Your wallet</b>',
      '',
      `Available: <b>${formatMoney(wallet.availableCents, wallet.currency)}</b>`,
      `Pending (hold period): ${formatMoney(wallet.pendingCents, wallet.currency)}`,
      `Reserved (active campaigns): ${formatMoney(wallet.reservedCents, wallet.currency)}`,
      '',
      `Total earned: ${formatMoney(wallet.totalEarnedCents, wallet.currency)}`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}
