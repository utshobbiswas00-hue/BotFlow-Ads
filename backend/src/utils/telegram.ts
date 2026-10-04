import { Api, GrammyError, HttpError } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { DeliveryErrorCode } from '@prisma/client';

/**
 * Low-level Telegram Bot API client.
 *
 * Workers import this directly (they do not spin up the full grammY Bot).
 * The bot process uses `bot.api` from ./bot/bot.ts, which is the same
 * underlying HTTP client.
 */
export const tgApi = new Api(env.TELEGRAM_BOT_TOKEN || '0:MISSING_TOKEN', {
  // grammY defaults to a 500 s request timeout — longer than the delivery
  // worker's 300 s BullMQ lock. A hung call would let the broker consider the
  // job stalled and re-run it, so bound every call made through this shared
  // client. 30 s is far more than any single Bot API call here needs.
  timeoutSeconds: 30,
});

/* ------------------------------------------------------------------
 *  Identity / chat inspection
 * ------------------------------------------------------------------ */

export interface TelegramChatInfo {
  id: bigint;
  title: string;
  username: string | null;
  type: string;
  description?: string;
  inviteLink?: string;
  photoUrl?: string | null;
  memberCount?: number;
}

export async function getChatInfo(chatId: string | number | bigint): Promise<TelegramChatInfo | null> {
  try {
    const chat = await tgApi.getChat(chatId as never);
    const anyChat = chat as unknown as {
      id: number;
      title?: string;
      username?: string;
      type: string;
      description?: string;
      invite_link?: string;
      photo?: { small_file_id?: string };
    };

    let memberCount: number | undefined;
    try {
      memberCount = await tgApi.getChatMemberCount(chatId as never);
    } catch {
      memberCount = undefined;
    }

    let photoUrl: string | null = null;
    if (anyChat.photo?.small_file_id) {
      photoUrl = await getFileUrl(anyChat.photo.small_file_id);
    }

    return {
      id: BigInt(anyChat.id),
      title: anyChat.title ?? 'Untitled',
      username: anyChat.username ?? null,
      type: anyChat.type,
      description: anyChat.description,
      inviteLink: anyChat.invite_link,
      photoUrl,
      memberCount,
    };
  } catch (err) {
    logger.warn({ code: describeTelegramError(err), chatId: String(chatId) }, 'getChatInfo failed');
    return null;
  }
}

export async function getFileUrl(fileId: string): Promise<string | null> {
  try {
    const file = await tgApi.getFile(fileId);
    if (!file.file_path) return null;
    return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  } catch {
    return null;
  }
}

let cachedBotId: string | null = null;

export async function getBotId(): Promise<string | null> {
  if (cachedBotId) return cachedBotId;
  try {
    const me = await tgApi.getMe();
    cachedBotId = String(me.id);
    return cachedBotId;
  } catch (err) {
    logger.error({ err: describeTelegramError(err) }, 'getMe failed');
    return null;
  }
}

/* ------------------------------------------------------------------
 *  Bot permission checks
 * ------------------------------------------------------------------ */

export interface BotPermissionSnapshot {
  botIsAdmin: boolean;
  canPostMessages: boolean;
  canEditMessages: boolean;
  canDeleteMessages: boolean;
  canInviteUsers: boolean;
  /** Populated when the check could not complete. */
  errorCode?: DeliveryErrorCode;
  errorMessage?: string;
}

const ADMIN_STATUSES = new Set(['administrator', 'creator']);

export async function checkBotPermissions(chatId: string | number | bigint): Promise<BotPermissionSnapshot> {
  const botId = await getBotId();
  if (!botId) {
    return {
      botIsAdmin: false,
      canPostMessages: false,
      canEditMessages: false,
      canDeleteMessages: false,
      canInviteUsers: false,
      errorCode: DeliveryErrorCode.TELEGRAM_API_ERROR,
      errorMessage: 'Could not resolve bot identity (getMe failed)',
    };
  }

  try {
    const member = await tgApi.getChatMember(chatId as never, botId as never);
    const m = member as unknown as {
      status: string;
      can_post_messages?: boolean;
      can_edit_messages?: boolean;
      can_delete_messages?: boolean;
    };

    const isAdmin = ADMIN_STATUSES.has(m.status);
    return {
      botIsAdmin: isAdmin,
      // A channel creator implicitly has every right.
      canPostMessages: isAdmin && (m.status === 'creator' || m.can_post_messages === true),
      canEditMessages: isAdmin && (m.status === 'creator' || m.can_edit_messages === true),
      canDeleteMessages: isAdmin && (m.status === 'creator' || m.can_delete_messages === true),
      // Telegram returns boolean | null for invite; treat null the same as false.
      canInviteUsers: isAdmin && (m.status === 'creator' || (m as { can_invite_users?: boolean | null }).can_invite_users === true),
      ...(isAdmin ? {} : { errorCode: DeliveryErrorCode.BOT_NOT_ADMIN, errorMessage: 'Bot is not an administrator of this channel' }),
    };
  } catch (err) {
    const code = describeTelegramError(err);
    return {
      botIsAdmin: false,
      canPostMessages: false,
      canEditMessages: false,
      canDeleteMessages: false,
      canInviteUsers: false,
      errorCode: code,
      errorMessage: messageOf(err),
    };
  }
}

/* ------------------------------------------------------------------
 *  Posting
 * ------------------------------------------------------------------ */

export interface SendPostInput {
  chatId: string | number | bigint;
  text: string;
  imageUrl?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  disablePreview?: boolean;
}

export interface SendPostResult {
  messageId: bigint;
  chatId: string;
}

/**
 * Publish a sponsored post into a channel.
 * Throws on failure — the caller (delivery worker) is responsible for
 * translating the error into a DeliveryErrorCode and scheduling a retry.
 */
export async function sendChannelPost(input: SendPostInput): Promise<SendPostResult> {
  const replyMarkup = buildKeyboard(input.buttonText, input.buttonUrl);

  const payload = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: input.disablePreview ?? !input.buttonUrl },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  const msg =
    input.imageUrl && input.text.length <= 1024
      ? await tgApi.sendPhoto(input.chatId as never, input.imageUrl, {
          caption: input.text,
          ...payload,
        })
      : await tgApi.sendMessage(input.chatId as never, truncateForTelegram(input.text), payload);

  return { messageId: BigInt(msg.message_id), chatId: String(msg.chat.id) };
}

export async function editChannelPost(
  chatId: string | number | bigint,
  messageId: number | bigint,
  text: string,
): Promise<void> {
  await tgApi.editMessageText(chatId as never, Number(messageId), text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function deleteChannelPost(
  chatId: string | number | bigint,
  messageId: number | bigint,
): Promise<void> {
  await tgApi.deleteMessage(chatId as never, Number(messageId));
}

/** How many times a flood-wait is honoured before a send is reported as failed. */
const MAX_FLOOD_WAITS = 2;

/**
 * Telegram `retry_after` (seconds) on a 429, clamped to a sane window.
 * Returns null for any error that is not a rate limit.
 */
function floodWaitMs(err: unknown): number | null {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return null;
  const seconds = err.parameters.retry_after;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.max(seconds * 1000, 1_000), 60_000);
  }
  return 5_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Outcome of one user-message attempt, including the message id and reason. */
export interface UserMessageSendResult {
  ok: boolean;
  messageId: bigint | null;
  /** Telegram's own description (or our message) when `ok` is false. */
  error: string | null;
  /**
   * True when Telegram refused permanently — the chat can never receive this
   * message (blocked, kicked, deactivated, gone). Retrying is pointless.
   */
  permanent: boolean;
}

/**
 * Classify a Telegram failure as permanent (unreachable recipient) or transient.
 *
 * 403 means the bot is blocked/kicked, and a 400 "chat not found" / "user is
 * deactivated" means the account is gone. Those never succeed on retry, so they
 * are reported as SKIPPED rather than FAILED — the difference matters in the
 * delivery report (a blocked user is not a platform failure).
 */
export function isPermanentDeliveryFailure(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  if (err.error_code === 403) return true;
  const desc = err.description.toLowerCase();
  if (
    err.error_code === 400 &&
    (desc.includes('chat not found') ||
      desc.includes('user is deactivated') ||
      desc.includes('bot was blocked') ||
      desc.includes('user not found'))
  ) {
    return true;
  }
  return false;
}

/**
 * Send a DM and report WHAT happened — the message id on success, Telegram's
 * description on failure, and whether the failure is permanent.
 *
 * Same flood-wait handling as `sendUserMessage` (which now delegates here), but
 * with the detail the broadcast delivery report needs. Never throws.
 */
export async function sendUserMessageDetailed(
  telegramId: string | number | bigint,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<UserMessageSendResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const msg = await tgApi.sendMessage(telegramId as never, truncateForTelegram(text), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return { ok: true, messageId: BigInt(msg.message_id), error: null, permanent: false };
    } catch (err) {
      const waitMs = floodWaitMs(err);
      if (waitMs !== null && attempt < MAX_FLOOD_WAITS) {
        logger.warn(
          { telegramId: String(telegramId), waitMs, attempt: attempt + 1 },
          'sendUserMessage rate-limited by Telegram — honouring retry_after',
        );
        await sleep(waitMs);
        continue;
      }
      logger.debug(
        { telegramId: String(telegramId), err: messageOf(err) },
        'sendUserMessage failed (user may have blocked the bot)',
      );
      return {
        ok: false,
        messageId: null,
        error: messageOf(err),
        permanent: isPermanentDeliveryFailure(err),
      };
    }
  }
}

/** Send a DM to a user. Never throws — notification failures must not break flows. */
export async function sendUserMessage(
  telegramId: string | number | bigint,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<boolean> {
  // A 429 means "retry after N seconds", not "delivery failed". Previously the
  // flood-wait was swallowed and reported as `false`, so every notification
  // caught in a burst was dropped for good. Honour `retry_after` (bounded) and
  // retry before reporting failure — the boolean contract is unchanged, so
  // existing callers keep working.
  const result = await sendUserMessageDetailed(telegramId, text, replyMarkup);
  return result.ok;
}

export async function answerCallbackQuery(id: string, text?: string, alert = false): Promise<void> {
  try {
    await tgApi.answerCallbackQuery(id, { text, show_alert: alert });
  } catch {
    /* non-fatal */
  }
}

/* ------------------------------------------------------------------
 *  Error mapping
 * ------------------------------------------------------------------ */

export function describeTelegramError(err: unknown): DeliveryErrorCode {
  if (err instanceof GrammyError) {
    const desc = err.description.toLowerCase();
    if (err.error_code === 403) {
      if (desc.includes('not enough rights') || desc.includes('not enough rights to send')) {
        return DeliveryErrorCode.MISSING_POST_PERMISSION;
      }
      if (desc.includes('chat write forbidden') || desc.includes('bot was kicked')) {
        return DeliveryErrorCode.CHAT_WRITE_FORBIDDEN;
      }
      return DeliveryErrorCode.BOT_NOT_ADMIN;
    }
    if (err.error_code === 400) {
      if (desc.includes('chat not found')) return DeliveryErrorCode.CHANNEL_NOT_FOUND;
      if (desc.includes('not enough rights')) return DeliveryErrorCode.MISSING_POST_PERMISSION;
      return DeliveryErrorCode.TELEGRAM_API_ERROR;
    }
    if (err.error_code === 429) return DeliveryErrorCode.RATE_LIMITED;
    return DeliveryErrorCode.TELEGRAM_API_ERROR;
  }

  if (err instanceof HttpError) return DeliveryErrorCode.TELEGRAM_API_ERROR;
  return DeliveryErrorCode.UNKNOWN;
}

/** Human-readable reason stored on the delivery job for admin visibility. */
export function messageOf(err: unknown): string {
  if (err instanceof GrammyError) return `${err.error_code}: ${err.description}`;
  if (err instanceof HttpError) return `HTTP error: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------ */

export function buildKeyboard(
  buttonText?: string | null,
  buttonUrl?: string | null,
): InlineKeyboardMarkup | undefined {
  if (!buttonText || !buttonUrl) return undefined;
  return { inline_keyboard: [[{ text: buttonText.slice(0, 64), url: buttonUrl }]] };
}

/** Telegram hard-caps sendMessage text at 4096 characters. */
export function truncateForTelegram(text: string, limit = 4096): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);

  // Never cut inside an HTML tag (`<...>`) or entity (`&...;`). We send with
  // parse_mode:'HTML', and a half-written tag/entity (e.g. "&am") makes
  // Telegram reject the ENTIRE message with "can't parse entities". Back off to
  // the start of the unfinished construct.
  const lastOpen = Math.max(cut.lastIndexOf('<'), cut.lastIndexOf('&'));
  const lastClose = Math.max(cut.lastIndexOf('>'), cut.lastIndexOf(';'));
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);

  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > limit * 0.6 ? cut.slice(0, lastNewline) : cut;
}

/** Run tasks with a concurrency cap — Telegram rate-limits bursts. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
