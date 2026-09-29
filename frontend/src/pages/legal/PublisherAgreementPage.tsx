import { Bullets, LegalLayout, LegalLink, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function PublisherAgreementPage() {
  return (
    <LegalLayout title="Publisher Agreement" updated={UPDATED}>
      <P>
        This agreement applies to every channel you add to BotFlow for monetization. By submitting a channel you
        accept it, together with the <LegalLink to="/legal/terms">Terms of Service</LegalLink> and the{' '}
        <LegalLink to="/legal/prohibited">Prohibited Content</LegalLink> rules.
      </P>

      <LegalSection n={1} title="Eligibility and setup" />
      <Bullets
        items={[
          'The channel must be a public Telegram channel.',
          'A channel needs at least 500 subscribers to monetize. If your channel is below the threshold when you add it, we may approve it but hold it inactive until it reaches 500.',
          'You must be an administrator of the channel.',
          'You must add the BotFlow bot as an administrator with the "Post Messages" permission. The bot cannot publish sponsored posts without it.',
        ]}
      />
      <P>
        If you remove the bot or take away its posting permission, delivery to that channel stops immediately, the
        channel is flagged in the app as needing attention, and any pending placements are cancelled without charge
        to advertisers.
      </P>

      <LegalSection n={2} title="Sponsored posts and the sponsored label" />
      <P>
        Approved advertiser posts are delivered to your channel by the BotFlow bot. You may reject any post you do
        not want to publish — requests appear in your channel's inbox, and rejecting a request has no penalty.
        Every sponsored post carries a visible sponsored label. You may not remove, hide, or reposition that label,
        and you must not publish sponsored content through your channel outside BotFlow in a way that imitates its
        format.
      </P>

      <LegalSection n={3} title="Earnings" />
      <P>
        Earnings are calculated at <b>$1.80 per 1,000 measured views</b> on your published sponsored posts. We may
        change the rate with advance notice inside the app. Earnings are first recorded as <b>pending</b> and stay
        pending for a hold period — the hold exists so that reversals and fraud reviews can be completed before the
        money becomes yours. After the hold, earnings move to your available balance.
      </P>

      <LegalSection n={4} title="Withdrawals" />
      <P>
        Withdrawals are subject to a minimum amount, shown in the app at the time you request one. Every withdrawal
        is manually reviewed before it is paid, and we may reject a withdrawal for incomplete account details or
        fraud concerns; you can resubmit after correcting the details. Payout methods and any method-specific fees
        are shown on the withdrawal screen.
      </P>

      <LegalSection n={5} title="Your channel, your responsibility" />
      <P>
        You remain the owner of your channel and of its non-sponsored content, and you remain responsible for
        complying with Telegram's terms for it. Keep the channel's category and metadata accurate; targeting
        depends on it. You grant BotFlow the limited right to publish approved sponsored posts on the channel for as
        long as this agreement is in force.
      </P>

      <LegalSection n={6} title="Suspension" />
      <P>
        We may suspend a channel from monetization, with notice where possible, for any of the following:
      </P>
      <Bullets
        items={[
          'Fraud or traffic manipulation, including inflated subscriber counts or fake views on sponsored posts.',
          'Publishing content that falls under the Prohibited Content rules.',
          'The bot losing administrator or Post Messages permission.',
          'Repeated delivery failures or a pattern of rejecting every request while keeping the channel listed.',
          "A breach of Telegram's rules that makes the channel ineligible for paid promotion.",
        ]}
      />
      <P>
        While a channel is suspended, its pending earnings are withheld until the suspension is resolved, and no
        new placements are accepted. You can appeal a suspension through a support ticket.
      </P>
    </LegalLayout>
  );
}
