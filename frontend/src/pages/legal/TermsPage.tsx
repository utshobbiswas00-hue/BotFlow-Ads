import { Bullets, LegalLayout, LegalLink, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated={UPDATED}>
      <LegalSection n={1} title="What BotFlow is" />
      <P>
        BotFlow is a Telegram-based advertising marketplace. Advertisers use it to buy sponsored posts, and
        publishers use it to monetize their public Telegram channels. We operate the platform, the wallet, and the
        delivery bot that posts approved ads to channels. When you create a campaign you enter into this agreement
        and the <LegalLink to="/legal/advertiser-policy">Advertiser Policy</LegalLink>; when you add a channel you
        enter into this agreement and the <LegalLink to="/legal/publisher-agreement">Publisher Agreement</LegalLink>.
      </P>

      <LegalSection n={2} title="Telegram account required" />
      <P>
        You must have a Telegram account to use BotFlow — the app authenticates you through Telegram and will not
        accept any other login. By creating an account you confirm that you are at least 18 years old (or the age of
        legal majority in your jurisdiction) and that you are allowed to enter into this agreement. You are
        responsible for keeping your Telegram account secure. Because we authenticate through Telegram, we cannot
        verify your identity independently, so you must not let anyone else use your account.
      </P>

      <LegalSection n={3} title="We are a marketplace, not the publisher" />
      <P>
        Sponsored posts are published on channels owned by other BotFlow users, using their Telegram accounts. We do
        not own those channels, we do not control who follows them, and we are not the publisher of the ads you buy
        or of the content a channel otherwise carries. You select channels (or we match them automatically) and the
        channel owner is responsible for publishing on their own channel, including complying with Telegram's rules.
        If a channel's owner removes our bot or revokes its posting permission, delivery to that channel stops and
        no charge is made for the undelivered placements.
      </P>

      <LegalSection n={4} title="Wallet, payments and platform fee" />
      <P>
        Your BotFlow wallet is denominated in the currency shown in the app (US dollars by default). A platform fee
        is applied to transactions at the rate displayed in the app at the time you make them; the fee rate in
        effect when you create a campaign or request a withdrawal is the one that applies to that transaction.
        Deposits are manually verified before funds are credited to your available balance. Withdrawals are subject
        to a minimum amount, and every withdrawal is reviewed before it is paid. You are responsible for any taxes
        that apply to your use of BotFlow in your jurisdiction.
      </P>

      <LegalSection n={5} title="Your conduct" />
      <P>
        You must not use BotFlow to do anything unlawful, or in a way that infringes the rights of others, or that is
        fraudulent or misleading. The <LegalLink to="/legal/prohibited">Prohibited Content</LegalLink> page lists the
        categories of content we will not carry. You must not buy traffic, click your own ads, or use bots or other
        automation to interact with the platform.
      </P>

      <LegalSection n={6} title="Suspension and termination" />
      <P>
        We may suspend, restrict, or terminate your account, an individual campaign, or an individual channel at
        any time, with or without prior notice, if you breach these terms, if we reasonably suspect fraud, or if
        required by Telegram, a payment provider, or the law. On suspension we will tell you the reason through the
        app where possible. The following apply when an account or campaign is suspended or cancelled:
      </P>
      <Bullets
        items={[
          'Reserved budget for cancelled campaigns that has not been charged for published posts is returned to your available balance.',
          'Earnings on a suspended channel stay pending and are not withdrawable until the suspension is resolved.',
          'Where funds are withheld for a fraud review or a legal requirement, we are not obliged to return them, and we will say so in our decision.',
        ]}
      />

      <LegalSection n={7} title="No promised results" />
      <P>
        Reach, view, and click figures shown before you create a campaign are estimates derived from channel
        history. They are planning figures, not commitments. Actual results vary with channel activity, audience,
        and timing, and we do not promise any specific performance for a campaign.
      </P>

      <LegalSection n={8} title="Limitation of liability" />
      <P>
        BotFlow is provided "as is". To the maximum extent permitted by law, we are not liable for any indirect,
        incidental, special, or consequential loss, including lost revenue or lost data, even where we have been
        told such loss was possible. Our total liability to you for any claim is limited to the amount you paid to
        us in the three months before the event that gave rise to the claim. Nothing in these terms limits
        liability that cannot be limited under applicable law.
      </P>

      <LegalSection n={9} title="Changes to these terms" />
      <P>
        We may update these terms from time to time. When a change is material we will notify you inside the app and
        ask you to re-acknowledge where the flow requires it. If you continue to use BotFlow after a change takes
        effect, you are bound by the updated terms. You can always read the current version from this page.
      </P>

      <LegalSection n={10} title="Questions" />
      <P>
        Use the Support section of the app to open a ticket about these terms, a suspension decision, or a refund
        request (see the <LegalLink to="/legal/refund">Refund Policy</LegalLink>). We answer support tickets in the
        order they arrive.
      </P>
    </LegalLayout>
  );
}
