import { Bullets, LegalLayout, LegalLink, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function ProhibitedContentPage() {
  return (
    <LegalLayout title="Prohibited Content" updated={UPDATED}>
      <P>
        BotFlow carries sponsored posts on Telegram channels. We will not run campaigns, publish creatives, or
        monetize channels that promote any of the following. These rules apply to advertisers and publishers alike,
        and they are enforced during campaign review, at delivery time, and after delivery.
      </P>

      <LegalSection n={1} title="Illegal goods and services" />
      <P>
        Anything that is illegal to sell, buy, or advertise. This includes controlled drugs and their precursors,
        weapons and ammunition where sale is unlawful, stolen goods, counterfeit documents, and anything connected
        to human trafficking or exploitation. It also covers anything that is unlawful in the jurisdiction where a
        channel's audience is located.
      </P>

      <LegalSection n={2} title="Financial scams and returns-promising offers" />
      <P>
        Pyramid and Ponzi schemes, "get rich quick" plans, investment or trading offers that promise fixed or
        risk-free returns, and anything that misrepresents the return, fee, or risk of a financial product. Crypto
        and trading content is reviewed closely because it is where these patterns appear most.
      </P>

      <LegalSection n={3} title="Phishing and credential harvesting" />
      <P>
        Fake login pages, messages that impersonate banks, Telegram, or other platforms, and any content designed
        to collect passwords, one-time codes, wallet seeds, or other credentials.
      </P>

      <LegalSection n={4} title="Malware" />
      <P>
        Links to files or pages that install unwanted or harmful software, exploit the reader's device, or request
        dangerous permissions in order to "work".
      </P>

      <LegalSection n={5} title="Adult content" />
      <P>
        Explicit sexual material, and any content that sexualizes minors or is directed at them. This is a
        hard block with no exceptions.
      </P>

      <LegalSection n={6} title="Unlawful gambling" />
      <P>
        Betting, lottery, or casino services that are not licensed in the jurisdiction where the channel's
        audience is located.
      </P>

      <LegalSection n={7} title="Counterfeits and fakes" />
      <P>
        Replicas of branded products, fake luxury goods, unauthorized merchandise, and anything that passes
        itself off as another company's product or service.
      </P>

      <LegalSection n={8} title="Hate, harassment, and discrimination" />
      <P>
        Content that promotes hatred or violence against people because of who they are, or that harasses,
        threatens, doxxes, or dehumanizes individuals or groups.
      </P>

      <LegalSection n={9} title="Anything that breaks third-party rules" />
      <P>
        Even where something is not listed above, we will not run it if it violates:
      </P>
      <Bullets
        items={[
          "Telegram's Terms of Service or rules for ads and channels, or",
          'the rules of the payment providers we work with — Telegram Stars and the crypto transfer services used on the deposit and withdrawal screens.',
        ]}
      />

      <LegalSection n={10} title="What happens when content is rejected" />
      <P>
        Content in these categories is rejected at review. If it is only discovered after a post has been
        published, we delete the post, cancel the affected campaign, and may suspend the channel or account under
        the <LegalLink to="/legal/terms">Terms of Service</LegalLink>. You can report content you believe is
        prohibited from the app; we review reports in the order they arrive and act on the ones that hold up to
        review.
      </P>
    </LegalLayout>
  );
}
