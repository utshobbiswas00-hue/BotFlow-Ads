import { Bullets, LegalLayout, LegalLink, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function AdvertiserPolicyPage() {
  return (
    <LegalLayout title="Advertiser Policy" updated={UPDATED}>
      <P>
        This policy applies to every campaign you create on BotFlow. By submitting a campaign you accept it together
        with the <LegalLink to="/legal/terms">Terms of Service</LegalLink>, the{' '}
        <LegalLink to="/legal/refund">Refund Policy</LegalLink>, and the{' '}
        <LegalLink to="/legal/prohibited">Prohibited Content</LegalLink> rules.
      </P>

      <LegalSection n={1} title="Campaign review" />
      <P>
        Every campaign is reviewed by our team before delivery. We check the creatives, the destination link, and
        the targeting against the platform rules. We may reject a campaign for policy violations, unclear or
        misleading content, a broken destination link, or poor quality. A rejection decision comes with a reason in
        the app; you can edit and resubmit. We may also reject or pause a campaign after it starts if the content
        turns out to breach the rules.
      </P>

      <LegalSection n={2} title="What your budget buys" />
      <P>
        A campaign budget buys an <b>estimated reach across channels, not a single post</b>. With manual targeting,
        posts are published on the channels you selected, at each channel's own price, until the budget is used up.
        With automatic targeting, posts are published on the best-matching channels at delivery time, again until
        the budget is consumed. Because channels differ in size and price, the number of posts a budget produces
        depends on which channels are matched.
      </P>

      <LegalSection n={3} title="Delivery rules and frequency limits" />
      <Bullets
        items={[
          'You choose 1–3 posts per channel for a campaign; a channel will never receive more than that from one of your campaigns.',
          'Channels set a minimum interval between sponsored posts, and delivery respects it. A placement that cannot fit inside the window is expired and is never charged.',
          'Delivery may be delayed by campaign review, publisher approval queues, or channel capacity.',
          'Scheduled start and end times are respected; a campaign that is not approved in time starts as soon as it is approved, not at the original time.',
        ]}
      />

      <LegalSection n={4} title="Prices are set by publishers" />
      <P>
        Channel prices and any minimum order amounts are set by the channel owner and can change without notice.
        The price shown in the marketplace is the publisher's current price, not a fixed rate. When you create a
        campaign, the platform fee rate and the reach figures you see are <b>snapshotted at creation time</b>: later
        rate changes do not apply to that campaign.
      </P>

      <LegalSection n={5} title="Refunds on failure" />
      <P>
        You are only charged for posts that are actually published. A placement that fails or expires is never
        charged, and its reserved budget returns to your available balance. Cancellations refund the undelivered
        remainder. The full rules are in the <LegalLink to="/legal/refund">Refund Policy</LegalLink>.
      </P>

      <LegalSection n={6} title="Restricted content" />
      <P>
        Content in any category listed on the <LegalLink to="/legal/prohibited">Prohibited Content</LegalLink> page
        is not eligible for campaigns. This includes financial offers that promise fixed or risk-free returns,
        anything that impersonates another brand or person, and anything that breaks Telegram's rules.
      </P>

      <LegalSection n={7} title="Fraud rules" />
      <P>
        You must not buy traffic, generate clicks or views with bots or scripts, or ask anyone — including your own
        staff or a publisher's team — to click your ads. We monitor click patterns, duplicate clicks (using hashed
        click data, see the <LegalLink to="/legal/privacy">Privacy Policy</LegalLink>), and click-through rates for
        anomalies. Confirmed fraud leads to campaign cancellation, account suspension, and, where permitted by the
        Terms of Service, withholding of the funds involved.
      </P>

      <LegalSection n={8} title="No performance commitment" />
      <P>
        Reach and click figures shown while you build a campaign are estimates derived from channel history. We do
        not commit to specific view or click targets; actual results depend on channel activity, audience, and
        timing.
      </P>
    </LegalLayout>
  );
}
