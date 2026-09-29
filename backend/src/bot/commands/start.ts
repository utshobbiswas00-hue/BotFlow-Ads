import type { CommandContext, Context } from 'grammy';
import { env } from '../../config/env';
import { escapeHtml } from '../../utils/format';
import { miniAppKeyboard } from '../keyboards/inline';

/**
 * /start — greeting, with deep-link handling.
 *
 * Deep-link payloads (Telegram "start parameters"):
 *   ref_<code>  — the user arrived via a referral link; open the Mini App
 *                 with `?startapp=ref_<code>` so the app can bind the referral.
 *   ch_<name>   — the user arrived from one of our channels; show the channel
 *                 and an entry point into the app.
 */

const REF_PAYLOAD_RE = /^ref_([a-zA-Z0-9]{4,64})$/;
const CH_PAYLOAD_RE = /^ch_([a-zA-Z0-9_]{4,64})$/;

const WELCOME_INTRO =
  '👋 <b>Welcome to BotFlow Ads!</b>\n\n' +
  'BotFlow Ads is a sponsored-post network for Telegram:\n' +
  '• <b>Publishers</b> earn money from ads in their channels.\n' +
  '• <b>Advertisers</b> reach new audiences with tracked campaigns.\n';

/** Append `startapp=<payload>` to the Mini App URL without breaking existing query strings. */
function withStartApp(url: string, startApp: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('startapp', startApp);
    return u.toString();
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}startapp=${encodeURIComponent(startApp)}`;
  }
}

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const payload = typeof ctx.match === 'string' ? ctx.match.trim() : '';

  const ref = REF_PAYLOAD_RE.exec(payload);
  if (ref) {
    const startApp = `ref_${ref[1]}`;
    const appUrl = withStartApp(env.MINI_APP_URL, startApp);
    await ctx.reply(
      `${WELCOME_INTRO}\n` +
        `You were invited by a friend — open the Mini App to claim your referral:\n` +
        `<a href="${escapeHtml(appUrl)}">Open with your referral</a>`,
      { parse_mode: 'HTML', reply_markup: miniAppKeyboard() },
    );
    return;
  }

  const ch = CH_PAYLOAD_RE.exec(payload);
  if (ch) {
    const username = ch[1];
    const channelUrl = `https://t.me/${username}`;
    await ctx.reply(
      `${WELCOME_INTRO}\n` +
        `You opened BotFlow Ads from a channel:\n` +
        `📣 <a href="${escapeHtml(channelUrl)}">@${escapeHtml(username)}</a>\n\n` +
        `Tap the button below to publish there or run your own campaigns.`,
      { parse_mode: 'HTML', reply_markup: miniAppKeyboard() },
    );
    return;
  }

  await ctx.reply(
    `${WELCOME_INTRO}\nTap the button below to open the Mini App and get started.`,
    { parse_mode: 'HTML', reply_markup: miniAppKeyboard() },
  );
}
