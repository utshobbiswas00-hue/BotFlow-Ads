# Publisher Guide

Earn from your Telegram channel by letting advertisers post sponsored messages
on it. This guide walks you through setup, delivery, withdrawals and the
bot permission model.

## 1. Add a channel

1. Open the Mini App and tap **Earn** in the bottom bar.
2. Tap **Add channel**.
3. Pick the Telegram chat you want to monetise. BotFlow will ask Telegram to
   add the BotFlow Bot as an **administrator** of that chat.

> You can stop monetising by removing BotFlow Bot from the channel's
> administrators. The channel will be marked INACTIVE on the next sync.

## 2. Grant the bot every permission

Once BotFlow Bot is added as an admin, you have to switch on the rights it
needs to post and edit messages on your behalf:

```
✓ Post messages     — required for sponsored delivery
✓ Edit messages     — required for the standard sponsor edit window
✓ Delete messages   — required for the deletion safety net
✓ Invite users      — required for trackable links
```

The Mini App shows a four-stage card under your channel — tap **Re-check
permissions** once you have saved the rights in Telegram.

## 3. Send the channel to moderation

When every permission is recorded, the card flips to **"You're on hold"**.
Tap **Send to moderation** and a human moderator reviews the channel:

- Channel name and topic fit the platform's content policy.
- Subscriber count is above the marketplace floor (500 by default; admins can
  change this in `/admin/settings`).
- The bot's permissions are still live.

Approval takes minutes-to-hours during business hours. You get a notification
when it goes live.

## 4. Approve ad requests

Advertisers pick your channel from search, and a request lands in the
**Requests** tab on your channel page. Each request shows the ad copy, the
budget and the advertiser's name.

- **Approve** to let the post run.
- **Reject** with a reason to refund the advertiser — the money is returned
  through the ledger, not moved manually.
- Use the **Auto-approve** toggle on your channel page to skip the review
  step (you take on the responsibility of filtering copy).

## 5. Earnings

Money earned from sponsored posts goes to your **Pending** balance for the
platform's holding period (default 7 days — this protects advertisers from
chargebacks). When the holding period elapses, the funds become
**Available** and you can withdraw them.

To see where each dollar came from, open **Wallet → Transactions**. Every
credit shows the post id and the advertiser.

## 6. Withdraw

1. Open **Wallet → Withdraw**.
2. Pick a method. Allowed methods and the per-method minimum are configured
   by admins — see `/admin/settings`.
3. Enter the destination (wallet address, account number, …). The platform
   stores a masked version; the full detail is encrypted at rest.
5. The amount is debited immediately. A moderator approves the request and
   marks it as paid once the off-platform transfer clears.
6. You get two notifications: **approved** and **paid**.

## 7. Premium

Premium publishers get:

- Lower withdrawal minimums
- Faster moderation (manual override path)
- Featured placement in marketplace search

Open **Settings → Premium** to see your tier and what it changes. Billing
runs through the same wallet — no second payment method needed.

## 8. Referrals

Open **Settings → Referral program**. Your code is shown at the top; share
it in your channel or your bio. You earn a flat fee on every verified
deposit the referred user makes, settled on the deposit's confirmation.

## 9. Common problems

**My channel is stuck on "On hold" with no moderator reply.** The Telegram
permissions you granted may have lapsed. Open Telegram, go to the channel's
administrator list, and re-check the four permissions. Then tap **Re-check**
in the Mini App.

**The bot is not in my channel.** You removed BotFlow Bot from the
administrators list. Re-add it and grant the four permissions above.

**I want to pause ads without removing the bot.** Set **Accept ads** to off
on the channel page. The channel stays approved but advertisers cannot book.

**My balance is negative.** A previously approved post was reversed. Check
the Transactions tab — the reversal will reference the original post id and
a reason. Contact support if the reversal looks wrong.