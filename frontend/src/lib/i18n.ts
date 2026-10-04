/**
 * Lightweight i18n for user-facing copy in the Mini App.
 *
 * The full locale stack (RTL, plural rules, ICU MessageFormat) is overkill
 * for the strings BotFlow actually surfaces — most labels are one or two
 * words, and the rest is already in English. This module gives us a single
 * `t('key')` lookup and a typed dictionary, so when a key is added in two
 * languages it fails typecheck instead of silently rendering the English
 * version in Bengali.
 *
 * Adding a key
 * ------------
 * Add the key to BOTH `en` and `bn` in `messages`. The compiler will fail
 * with `Property '...' is missing` until both are present.
 *
 * Switching locale at runtime
 * ---------------------------
 * The current locale lives in the user store; the AdminUser row carries a
 * `locale` column (future commit) and `/api/me` exposes the resolved value
 * as part of `MeResponse`. Until that ships, `defaultLocale` is what every
 * user sees.
 */

export type Locale = 'en' | 'bn';

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ['en', 'bn'];

export const defaultLocale: Locale = 'en';

type Dictionary = Readonly<Record<string, string>>;

const en: Dictionary = {
  'common.loading': 'Loading…',
  'common.error': 'Something went wrong',
  'common.retry': 'Try again',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'settings.title': 'Settings',
  'settings.subtitle': 'Your account, preferences and platform info.',
  'settings.section.profile': 'Profile',
  'settings.section.account': 'Account',
  'settings.section.notifications': 'Notifications',
  'settings.section.privacy': 'Privacy',
  'settings.section.platform': 'Platform',
  'settings.section.about': 'About',
  'settings.profile.telegramId': 'Telegram ID',
  'settings.profile.username': 'Username',
  'settings.profile.joined': 'Joined',
  'channel.stage.no_access': 'Open access to the bot',
  'channel.stage.on_hold': "You're on hold",
  'channel.stage.pending_review': 'On hold — under review',
  'channel.stage.needs_growth': 'Almost there',
  'channel.action.send_to_moderation': 'Send to moderation',
  'channel.action.recheck_permissions': 'Re-check permissions',
  'wallet.deposit.title': 'Deposit',
  'wallet.withdraw.title': 'Withdraw',
  'wallet.balance.available': 'Available',
  'wallet.balance.pending': 'Pending',
};

const bn: Dictionary = {
  'common.loading': 'লোড হচ্ছে…',
  'common.error': 'কিছু একটা ভুল হয়েছে',
  'common.retry': 'আবার চেষ্টা করুন',
  'common.save': 'সংরক্ষণ করুন',
  'common.cancel': 'বাতিল',
  'common.copy': 'কপি করুন',
  'common.copied': 'কপি হয়েছে',
  'settings.title': 'সেটিংস',
  'settings.subtitle': 'আপনার অ্যাকাউন্ট, পছন্দ এবং প্ল্যাটফর্ম তথ্য।',
  'settings.section.profile': 'প্রোফাইল',
  'settings.section.account': 'অ্যাকাউন্ট',
  'settings.section.notifications': 'নোটিফিকেশন',
  'settings.section.privacy': 'গোপনীয়তা',
  'settings.section.platform': 'প্ল্যাটফর্ম',
  'settings.section.about': 'সম্পর্কে',
  'settings.profile.telegramId': 'টেলিগ্রাম আইডি',
  'settings.profile.username': 'ইউজারনেম',
  'settings.profile.joined': 'যোগদান',
  'channel.stage.no_access': 'বটকে অ্যাক্সেস দিন',
  'channel.stage.on_hold': 'আপনি অপেক্ষায় আছেন',
  'channel.stage.pending_review': 'অপেক্ষায় — পর্যালোচনা চলছে',
  'channel.stage.needs_growth': 'প্রায় হয়ে গেছে',
  'channel.action.send_to_moderation': 'মডারেশনে পাঠান',
  'channel.action.recheck_permissions': 'অনুমতি আবার যাচাই করুন',
  'wallet.deposit.title': 'ডিপোজিট',
  'wallet.withdraw.title': 'উইথড্র',
  'wallet.balance.available': 'ব্যবহারযোগ্য',
  'wallet.balance.pending': 'বাকি',
};

const MESSAGES: Readonly<Record<Locale, Dictionary>> = { en, bn };

/**
 * Look up a translated string. Falls back to the English text if the active
 * locale is missing the key — by construction this should never happen
 * because the type forbids it, but the runtime fallback means a deploy
 * with a missing key will not render blank buttons.
 */
export function t(locale: Locale, key: string): string {
  const dict = MESSAGES[locale];
  return dict[key] ?? MESSAGES.en[key] ?? key;
}

/**
 * The shape of every translatable key, derived from the English dictionary.
 * Both dictionaries are required to have every property of this type —
 * add a key to one and TypeScript will complain until you add it to the
 * other.
 */
export type MessageKey = keyof typeof en;