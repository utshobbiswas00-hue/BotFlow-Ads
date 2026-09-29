import type { Context } from 'grammy';
import { logger } from '../../config/logger';
import { prisma } from '../../db/prisma';
import { approveAdRequest, rejectAdRequest } from '../../services/delivery.service';
import { messageOf, truncateForTelegram } from '../../utils/telegram';

/**
 * callback_query:data — inline-button actions.
 *
 * Currently the bot sends exactly one kind of actionable button: the
 * approve/reject pair on pending sponsored-post requests, encoded as
 * `adreq:<approve|reject>:<deliveryJobId>`. Unknown callback data is
 * ignored so future button families can be added without breaking this
 * handler.
 */
const AD_REQUEST_RE = /^adreq:(approve|reject):([a-zA-Z0-9_-]+)$/;

export async function handleCallbackQuery(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const match = AD_REQUEST_RE.exec(data);
  if (!match) return; // not one of our buttons

  const approved = match[1] === 'approve';
  const deliveryJobId = match[2];
  const log = logger.child({ ctx: 'bot:callback_query', deliveryJobId });

  try {
    if (!ctx.from) {
      await ctx.answerCallbackQuery({ text: 'Unknown caller — open the Mini App first.', show_alert: true });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    });
    if (!user) {
      throw new Error('Open the Mini App first to link your account, then try again.');
    }

    if (approved) {
      await approveAdRequest(user.id, deliveryJobId);
    } else {
      await rejectAdRequest(user.id, deliveryJobId);
    }

    await ctx.answerCallbackQuery(
      approved
        ? '✅ Approved — the post is being published.'
        : '❌ Rejected — the advertiser will be notified.',
    );

    // Record the decision on the original message (and clear the buttons so
    // it cannot be clicked twice by another device). Edit failures are
    // non-fatal — the decision itself has already been applied.
    try {
      await ctx.editMessageText(
        approved
          ? '✅ <b>Approved</b> by the publisher. The post will be published shortly.'
          : '❌ <b>Rejected</b> by the publisher.',
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (editErr) {
      log.warn({ err: messageOf(editErr) }, 'could not update the ad-request message');
    }

    log.info({ approved }, 'ad request decided via Telegram');
  } catch (err) {
    log.warn({ err: messageOf(err) }, 'ad request decision failed');
    // answerCallbackQuery caps `text` at 200 characters; a longer reason (e.g. a
    // raw GrammyError description) would make the answer call itself fail and
    // the publisher would see nothing at all.
    await ctx.answerCallbackQuery({
      text: truncateForTelegram(messageOf(err), 200),
      show_alert: true,
    });
  }
}
