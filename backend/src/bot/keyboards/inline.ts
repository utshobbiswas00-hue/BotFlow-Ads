import type { InlineKeyboardMarkup } from 'grammy/types';
import { env } from '../../config/env';
import { SUPPORT_URL } from '@botflow/shared';

/**
 * Inline keyboard builders for bot messages.
 *
 * Every button that leads into the app is a `web_app` button so Telegram
 * opens the Mini App in place (init data arrives with `startapp` when a
 * deep-link payload was used).
 */

/** Single button that opens the BotFlow Ads Mini App. */
export function miniAppKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '🚀 Open BotFlow Ads', web_app: { url: env.MINI_APP_URL } }]],
  };
}

/**
 * Approve / reject buttons for a pending sponsored-post request.
 * The callback data embeds the delivery job id so the handler can act on it.
 * (callback_data is limited to 64 bytes — cuid job ids fit comfortably.)
 */
export function adRequestKeyboard(deliveryJobId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `adreq:approve:${deliveryJobId}` },
        { text: '❌ Reject', callback_data: `adreq:reject:${deliveryJobId}` },
      ],
    ],
  };
}

/** Button that opens a Telegram channel (e.g. the one a deep link came from). */
export function channelButton(url: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: '📣 Open Channel', url }]],
  };
}

/**
 * Entry point for support.
 *
 * Two routes on purpose: the ticket system keeps history attached to the
 * account, while the direct handle is for someone who would rather just talk to
 * a human. Both are offered rather than forcing a ticket.
 */
export function supportKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '📝 Open Mini App — Support', web_app: { url: env.MINI_APP_URL } }],
      [{ text: '💬 Chat with Support', url: SUPPORT_URL }],
    ],
  };
}
