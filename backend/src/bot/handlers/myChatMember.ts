import type { Context } from 'grammy';
import { logger } from '../../config/logger';
import { prisma } from '../../db/prisma';
import { createNotification } from '../../services/notification.service';

/**
 * my_chat_member — CRITICAL handler.
 *
 * Telegram tells us here whenever the bot's own membership in a chat changes
 * (added, promoted, demoted, rights changed, removed). We use it to keep the
 * Channel row's permission snapshot fresh in real time, instead of waiting
 * for the next delivery attempt to fail.
 *
 * State machine (only channels registered in BotFlow are affected):
 *   bot removed entirely          -> status = INACTIVE
 *   posting rights lost           -> status = ATTENTION_REQUIRED (+ notify owner)
 *   posting rights granted/restored -> status = APPROVED (+ notify owner)
 *
 * Admin-suspended channels are never auto-changed, and notifications are only
 * sent on actual status transitions so the owner is not spammed.
 */
export async function handleMyChatMember(ctx: Context): Promise<void> {
  try {
    const mcm = ctx.myChatMember;
    if (!mcm) return;

    // my_chat_member also fires for private chats (user blocks/unblocks the
    // bot) and for groups — only registered channels matter to us.
    const chat = mcm.chat;
    if (chat.type !== 'channel') return;

    const telegramChannelId = BigInt(chat.id);
    const log = logger.child({ ctx: 'bot:my_chat_member', channelId: telegramChannelId.toString() });

    const channel = await prisma.channel.findUnique({
      where: { telegramChannelId },
      select: { id: true, ownerId: true, title: true, username: true, status: true },
    });

    if (!channel) {
      log.info('membership change for an unregistered channel — ignoring');
      return;
    }

    log.info(
      {
        actor: mcm.from.username ?? String(mcm.from.id),
        oldStatus: mcm.old_chat_member.status,
        newStatus: mcm.new_chat_member.status,
        channelStatus: channel.status,
      },
      'bot membership changed',
    );

    const member = mcm.new_chat_member;
    const removed = member.status === 'left' || member.status === 'kicked';

    // ---- 1. Bot removed from the channel entirely -------------------------
    if (removed) {
      const wasActive = channel.status !== 'INACTIVE';

      await prisma.channel.update({
        where: { id: channel.id },
        data: {
          status: 'INACTIVE',
          botIsAdmin: false,
          canPostMessages: false,
          canEditMessages: false,
          canDeleteMessages: false,
          lastPermissionCheck: new Date(),
        },
      });
      log.warn('bot removed from channel → INACTIVE');

      if (wasActive) {
        await createNotification({
          userId: channel.ownerId,
          type: 'CHANNEL_PERMISSION_PROBLEM',
          title: 'Bot removed from your channel',
          body: `BotFlow Bot was removed from “${channel.title}”. The channel is now inactive. Re-add the bot as an administrator with the “Post Messages” permission to resume ad delivery.`,
          data: { channelId: channel.id },
        });
      }
      return;
    }

    // ---- 2. Refresh the permission snapshot ------------------------------
    // A creator implicitly has every right; an administrator's rights are the
    // flags Telegram reports. Anything else (member/restricted) means the bot
    // lost admin rights altogether.
    const isCreator = member.status === 'creator';
    const isAdmin = isCreator || member.status === 'administrator';
    const canPostMessages =
      isCreator || (member.status === 'administrator' && member.can_post_messages === true);
    const canEditMessages =
      isCreator || (member.status === 'administrator' && member.can_edit_messages === true);
    const canDeleteMessages =
      isCreator || (member.status === 'administrator' && member.can_delete_messages === true);

    // Decide the status transition (if any). SUSPENDED channels stay
    // suspended — restoring them is an explicit admin action.
    let statusChange: { status: 'APPROVED' | 'ATTENTION_REQUIRED' } | null = null;
    if (
      canPostMessages &&
      (channel.status === 'ATTENTION_REQUIRED' || channel.status === 'PENDING')
    ) {
      statusChange = { status: 'APPROVED' };
    } else if (
      !canPostMessages &&
      channel.status !== 'SUSPENDED' &&
      channel.status !== 'INACTIVE'
    ) {
      statusChange = { status: 'ATTENTION_REQUIRED' };
    }

    await prisma.channel.update({
      where: { id: channel.id },
      data: {
        botIsAdmin: isAdmin,
        canPostMessages,
        canEditMessages,
        canDeleteMessages,
        lastPermissionCheck: new Date(),
        ...(statusChange ? { status: statusChange.status } : {}),
        ...(canPostMessages ? { verifiedAt: new Date() } : {}),
        ...(statusChange?.status === 'APPROVED' && channel.status !== 'APPROVED'
          ? { approvedAt: new Date() }
          : {}),
      },
    });

    log.info(
      {
        botIsAdmin: isAdmin,
        canPostMessages,
        canEditMessages,
        canDeleteMessages,
        channelStatus: statusChange?.status ?? channel.status,
      },
      'channel permission snapshot refreshed',
    );

    // ---- 3. Notify the owner on transitions -------------------------------
    if (statusChange?.status === 'APPROVED') {
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_APPROVED',
        title: 'Channel approved automatically',
        body: `BotFlow Bot has administrator access with “Post messages” permission in “${channel.title}”. The channel is now approved automatically and sponsored posts can be delivered.`,
        data: { channelId: channel.id },
      });
      log.info('posting rights restored → APPROVED');
    } else if (statusChange?.status === 'ATTENTION_REQUIRED') {
      await createNotification({
        userId: channel.ownerId,
        type: 'CHANNEL_PERMISSION_PROBLEM',
        title: 'Channel needs attention',
        body: `BotFlow Bot lost the “Post Messages” permission in “${channel.title}”. Ads cannot be delivered until you re-enable it in the channel's administrator settings.`,
        data: { channelId: channel.id },
      });
      log.warn('posting rights lost → ATTENTION_REQUIRED');
    }
  } catch (err) {
    logger.error({ err }, 'my_chat_member handler failed');
  }
}
