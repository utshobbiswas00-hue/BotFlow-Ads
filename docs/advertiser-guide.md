# Advertiser Guide

Buy sponsored posts on Telegram channels that match your audience. This
guide covers search, campaign creation, payment, delivery and measurement.

## 1. Find channels

The **Marketplace** tab lists every approved channel on the platform. Each
card shows:

- **Title and handle** with a category chip
- **Subscriber count** and average views
- **Price per post** in USD-equivalent
- **Quality score** — a 0-100 metric derived from view-to-delivery ratio

Tap a card to open the channel's full profile, including sample posts and
audience breakdown.

## 2. Filter and target

Use the filter rail on the left to narrow by category, language, country,
subscriber range and price band. Saved filters appear in the **Saved
searches** section of the dashboard.

## 3. Create a campaign

1. Tap **Advertise** → **New campaign**.
2. Pick a goal:
   - **Awareness** — straight post delivery.
   - **Conversion** — post + tracking link + conversion pixel.
3. Select one or more channels. The right panel shows the combined reach
   and your total budget.
4. Write the ad copy. Plain text or HTML; the Mini App previews how it will
   look in each picked channel.
5. Set your budget. The platform charges a flat 5% processing fee.
6. Pick delivery mode:
   - **Immediate** — the post goes out within minutes.
   - **Scheduled** — pick a date and time. Good for launches.

## 4. Pay for the campaign

The platform takes crypto (TRC20 / ERC20 / BTC / ETH / LTC / SOL) and
Telegram Stars. Cards cannot be combined with Stars.

The deposit flow:

1. **Save your wallet** — `/api/me/wallet` returns your deposit address.
   Verify the network matches what your wallet supports.
2. **Send the exact amount** — under-payments credit after 6 confirmations
   on the relevant network; over-payments get a manual refund.
3. **Watch the deposit land** — the page polls and shows confirmations in
   real time. You get a notification when the deposit is verified.

## 5. Delivery

Once your campaign is funded, the platform queues a post for every channel on
the schedule you picked. The mini app shows the delivery state per channel:

- **QUEUED** — waiting for the publisher's auto-approval or manual review.
- **APPROVED** — the publisher said yes.
- **SCHEDULED** — the post is on the queue, ready at its scheduled time.
- **DELIVERED** — the post is live in the channel.
- **DELIVERED + EDITED** — the post was edited (trackable edits stay
  readable; the edit is logged with timestamp).
- **REJECTED** — the publisher said no. Funds for that channel are returned
  to your wallet.

## 6. Measure results

Open the campaign and tap **Analytics**:

- **Views and clicks** — recorded from the tracking link.
- **Conversions** — for conversion campaigns, attributed back to clicks
  within the configured lookback window.
- **Cost per result** — budget / conversions.
- **Quality score** — how the channel's audience engaged vs. the average
  (so you can compare like for like).

## 7. Disputes and refunds

If a post was delivered but the publisher edited it in a way that violates
the ad policy, open **Support** from the campaign page. Refunds are
processed by an admin — the platform never moves money from the publisher's
wallet without an admin action.

## 8. API access

Power advertisers can use the REST API instead of the Mini App — the
**Advertiser API** section under **Settings** shows your token, base URL
and the OpenAPI reference. The token is single-purpose and can be revoked
from the same page.