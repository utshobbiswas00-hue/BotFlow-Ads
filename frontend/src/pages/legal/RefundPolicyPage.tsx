import { Bullets, LegalLayout, LegalLink, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function RefundPolicyPage() {
  return (
    <LegalLayout title="Refund Policy" updated={UPDATED}>
      <P>
        This policy explains when money moves out of your wallet, when it comes back, and what is not refundable.
        All amounts below refer to your BotFlow wallet balance in the currency shown in the app.
      </P>

      <LegalSection n={1} title="How campaign budget is reserved and charged" />
      <P>
        When you create a campaign, the full campaign budget is <b>reserved</b> from your available balance the
        moment the campaign is approved for delivery. A reservation is not a charge — it is money set aside so the
        campaign can be paid for as posts are published.
      </P>
      <P>
        We then <b>charge per published post</b>. Each time a sponsored post is actually published on a channel, the
        cost of that post (the channel's price, plus any applicable platform fee) moves from reserved to spent.
        Posts that are still pending or scheduled are not charged until they are published.
      </P>

      <LegalSection n={2} title="Failed or expired placements are never charged" />
      <P>
        If a placement fails to publish — for example the channel's bot lost permission, the post was rejected by
        the publisher, or the delivery attempt exhausted its retries — we do not charge you for it. The reservation
        that was set aside for that placement is returned to your <b>available balance</b>. The same is true of a
        placement that passes its scheduled window without being published (an expired placement): no charge, and
        the reserved amount returns to your available balance automatically.
      </P>

      <LegalSection n={3} title="Cancelling a campaign" />
      <P>
        You can cancel a campaign at any time before it completes. On cancellation we refund the{' '}
        <b>undelivered remainder</b>: the difference between what was reserved and what was actually charged for
        posts that were published. The refund is credited to your available balance and can be used for new
        campaigns or withdrawn subject to the normal withdrawal rules. Posts that were already published before you
        cancelled are not refunded, because that service was delivered.
      </P>

      <LegalSection n={4} title="Deposits" />
      <P>
        A deposit, once it has been verified and credited to your wallet, is <b>non-refundable</b> as a deposit
        transaction, except where the law requires a refund (for example a chargeback or a regulatory order from a
        payment provider). Your deposited funds are yours to use: spend them on campaigns, or withdraw them back out
        through the normal withdrawal flow, which carries its own minimums and review.
      </P>

      <LegalSection n={5} title="Publisher earnings" />
      <P>
        If you are a publisher, earnings are recorded as <b>pending</b> and sit pending for a hold period before
        they become available to withdraw. This hold lets us reverse earnings if a post is deleted or if a fraud
        review changes the result. If a post you were paid for is later reversed, the corresponding earning is
        reversed too. See the <LegalLink to="/legal/publisher-agreement">Publisher Agreement</LegalLink> for the
        earning rate and hold details.
      </P>

      <LegalSection n={6} title="How to request a review" />
      <P>
        If you believe a charge is wrong, open a support ticket from the app and include the campaign or
        transaction reference. We check the ledger against the delivery records and respond with our decision and
        the reasoning.
      </P>
      <Bullets
        items={[
          'We correct clear ledger or delivery errors at no cost to you.',
          'We do not refund for posts that were published, for changes of mind about targeting, or for performance that was lower than the pre-campaign estimate.',
        ]}
      />
    </LegalLayout>
  );
}
