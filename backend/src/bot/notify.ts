import { logger } from '../config/logger';
import { escapeHtml, truncate } from '../utils/format';
import { formatMoney } from '../utils/money';
import { sendUserMessage } from '../utils/telegram';
import { adRequestKeyboard } from './keyboards/inline';

/**
 * Outgoing bot notifications.
 *
 * These DMs are the "real-time" layer on top of the in-app notification
 * inbox: when a delivery job parks in AWAITING_APPROVAL the publisher gets a
 * direct message with approve/reject buttons, so they can act without
 * opening the Mini App.
 */

export interface AdRequestDMPayload {
  channelTitle: string;
  campaignName: string;
  adText: string;
  priceCents: number;
  deliveryJobId: string;
}

/**
 * DM a publisher about a new sponsored-post request, with inline
 * approve/reject buttons. Never throws — a blocked user or a Telegram
 * hiccup must not break the delivery pipeline.
 *
 * @returns true when the DM was delivered
 */
export async function notifyNewAdRequest(
  ownerTelegramId: bigint,
  payload: AdRequestDMPayload,
): Promise<boolean> {
  try {
    const text = [
      '📬 <b>New sponsored post request</b>',
      '',
      `Channel: <b>${escapeHtml(payload.channelTitle)}</b>`,
      `Campaign: ${escapeHtml(payload.campaignName)}`,
      `Ad text: ${escapeHtml(truncate(payload.adText, 300))}`,
      `Your payout: <b>${formatMoney(payload.priceCents)}</b>`,
      '',
      'Approve or reject the post:',
    ].join('\n');

    const delivered = await sendUserMessage(
      ownerTelegramId,
      text,
      adRequestKeyboard(payload.deliveryJobId),
    );

    if (!delivered) {
      logger.warn(
        { deliveryJobId: payload.deliveryJobId, ownerTelegramId: ownerTelegramId.toString() },
        'ad request DM not delivered (user may have blocked the bot)',
      );
    }
    return delivered;
  } catch (err) {
    logger.error({ err, deliveryJobId: payload.deliveryJobId }, 'notifyNewAdRequest failed');
    return false;
  }
}
