import { DeliveryErrorCode } from '@prisma/client';
import { SUPPORT_USERNAME } from '@botflow/shared';

/**
 * User-friendly error messages.
 *
 * Spec requirement: a technical code such as `TELEGRAM_API_403` must never be
 * shown to an advertiser or a publisher. Every message below answers two
 * questions in plain language:
 *   1. What happened?
 *   2. What happens to my money / what should I do now?
 *
 * Messages are written for a non-technical channel owner or advertiser, in
 * English, and are safe to reuse in notifications, toasts and API responses.
 */

export interface UserErrorPayload {
  code: string;
  message: string;
  /** true when the user can actually do something about it. */
  actionable: boolean;
}

const MESSAGES: Record<string, Omit<UserErrorPayload, 'code'>> = {
  // ---- Delivery --------------------------------------------------------
  BOT_NOT_ADMIN: {
    message:
      'The BotFlow bot is no longer an administrator of this channel, so the post could not be published. The channel owner has been notified.',
    actionable: false,
  },
  MISSING_POST_PERMISSION: {
    message:
      'The BotFlow bot does not have permission to post in this channel. The channel owner has been asked to enable it. You were not charged for this post.',
    actionable: false,
  },
  CHANNEL_NOT_FOUND: {
    message:
      'This channel could not be reached. It may have been deleted, renamed to a private channel, or its username changed. You were not charged for this post.',
    actionable: false,
  },
  CHANNEL_UNAVAILABLE: {
    message:
      'This channel is temporarily unavailable, so the post could not be published. You were not charged, and we will try again shortly.',
    actionable: false,
  },
  CHAT_WRITE_FORBIDDEN: {
    message:
      'The BotFlow bot was removed from this channel, so the post could not be published. The channel owner has been notified.',
    actionable: false,
  },
  CHANNEL_SUSPENDED: {
    message:
      'This channel is suspended and cannot receive sponsored posts right now. You were not charged for this post.',
    actionable: false,
  },
  TELEGRAM_API_ERROR: {
    message:
      'Telegram returned an error while publishing. This is usually temporary — we will retry automatically.',
    actionable: false,
  },
  RATE_LIMITED: {
    message:
      'Telegram is rate-limiting us right now. Your post has been queued and will be published shortly.',
    actionable: false,
  },
  BUDGET_EXHAUSTED: {
    message:
      "This campaign's reserved budget is fully used, so the post was not published. Any unused amount has been returned to your available balance.",
    actionable: true,
  },
  PUBLISHER_REJECTED: {
    message:
      'The channel owner declined this sponsored post. You were not charged, and your reserved budget for it has been returned.',
    actionable: true,
  },
  UNKNOWN: {
    message:
      'Something unexpected happened while publishing this post. Your reserved budget for it has been returned to your available balance.',
    actionable: true,
  },

  // ---- Account / auth --------------------------------------------------
  INVALID_TELEGRAM_AUTH: {
    message: 'We could not verify your Telegram session. Please close the app and open it again from the bot.',
    actionable: true,
  },
  UNAUTHORIZED: {
    message: 'Please open BotFlow Ads from the Telegram bot to continue.',
    actionable: true,
  },
  FORBIDDEN: {
    message: `You do not have access to this. If you think this is a mistake, please contact support (@${SUPPORT_USERNAME}).`,
    actionable: false,
  },

  // ---- Money -----------------------------------------------------------
  INSUFFICIENT_BALANCE: {
    message:
      'Your available balance is not enough for this. Reserved budget for running campaigns cannot be used — please add funds.',
    actionable: true,
  },
  PAYMENT_DUPLICATE: {
    message: 'This payment has already been processed, so it was not credited twice.',
    actionable: false,
  },
  MAINTENANCE: {
    message: 'BotFlow Ads is temporarily under maintenance. Please try again in a few minutes.',
    actionable: false,
  },

  // ---- Channels --------------------------------------------------------
  BOT_PERMISSION_MISSING: {
    message:
      'Add @BotflowadsBot as an administrator of your channel and enable "Post Messages", then try again.',
    actionable: true,
  },
  CHANNEL_NOT_ELIGIBLE: {
    message: 'This channel is not currently eligible for ad delivery. Check the channel status and bot permissions.',
    actionable: true,
  },

  // ---- Validation ------------------------------------------------------
  VALIDATION_ERROR: {
    message: 'Some of the details you entered are not valid. Please check the highlighted fields and try again.',
    actionable: true,
  },
  NOT_FOUND: {
    message: 'We could not find what you were looking for. It may have been removed.',
    actionable: false,
  },
  CONFLICT: {
    message: 'This already exists, so the action was not repeated.',
    actionable: false,
  },
  RATE_LIMITED_REQUEST: {
    message: 'You are doing that too quickly. Please wait a moment and try again.',
    actionable: true,
  },
  INTERNAL_ERROR: {
    message: `Something went wrong on our side. Please try again — if it keeps happening, contact support (@${SUPPORT_USERNAME}).`,
    actionable: false,
  },
};

const FALLBACK: Omit<UserErrorPayload, 'code'> = {
  message: `Something went wrong. Please try again — if it keeps happening, contact support (@${SUPPORT_USERNAME}).`,
  actionable: false,
};

/** Plain-language sentence for a technical code. Always returns something usable. */
export function userMessage(code: DeliveryErrorCode | string): string {
  return MESSAGES[String(code)]?.message ?? FALLBACK.message;
}

/** Full payload for API responses and toasts. */
export function userErrorPayload(code: DeliveryErrorCode | string, fallback?: string): UserErrorPayload {
  const found = MESSAGES[String(code)];
  return {
    code: String(code),
    message: found?.message ?? fallback ?? FALLBACK.message,
    actionable: found?.actionable ?? FALLBACK.actionable,
  };
}

/** True when we have a hand-written message for this code. */
export function hasUserMessage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code);
}

export function listUserMessages(): Array<UserErrorPayload & { code: string }> {
  return Object.entries(MESSAGES).map(([code, v]) => ({ code, ...v }));
}
