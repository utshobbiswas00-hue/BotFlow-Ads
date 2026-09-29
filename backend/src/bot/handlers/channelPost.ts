import type { Context } from 'grammy';
import { logger } from '../../config/logger';
import { prisma } from '../../db/prisma';

/**
 * channel_post — light handler.
 *
 * Telegram delivers `channel_post` updates for every post in channels where
 * the bot is present (with allowed_updates). Almost all of them are the
 * channel's own content, which we ignore. The one case we care about:
 *
 *   a post is DELETED  -> Telegram sends the message again with `delete_date`
 *   set. If that message was one of our sponsored posts, mark the AdPost
 *   as DELETED so stats and the publisher dashboard stay truthful.
 *
 * grammy's typed Message does not include `delete_date`, so we read it via a
 * narrow cast instead of widening the whole type.
 */
export async function handleChannelPost(ctx: Context): Promise<void> {
  try {
    const msg = ctx.channelPost;
    if (!msg) return;

    const deleteDate = (msg as unknown as { delete_date?: number }).delete_date;
    if (!deleteDate) return; // regular post — nothing to do

    const telegramChannelId = BigInt(msg.chat.id);
    const telegramMessageId = BigInt(msg.message_id);

    const channel = await prisma.channel.findUnique({
      where: { telegramChannelId },
      select: { id: true, title: true },
    });
    if (!channel) return; // not our channel

    const adPost = await prisma.adPost.findFirst({
      where: { channelId: channel.id, telegramMessageId },
      select: { id: true, status: true },
    });
    if (!adPost) return; // not one of our sponsored posts

    if (adPost.status !== 'PUBLISHED') return; // already terminal — keep it

    await prisma.adPost.update({
      where: { id: adPost.id },
      data: { status: 'DELETED', deletedAt: new Date() },
    });

    logger.info(
      {
        channelId: channel.id,
        channelTitle: channel.title,
        adPostId: adPost.id,
        telegramMessageId: telegramMessageId.toString(),
      },
      'sponsored post deleted in channel → AdPost marked DELETED',
    );
  } catch (err) {
    logger.error({ err }, 'channel_post handler failed');
  }
}
