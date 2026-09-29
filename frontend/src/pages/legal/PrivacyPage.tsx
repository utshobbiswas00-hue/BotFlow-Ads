import { Bullets, LegalLayout, LegalSection, P } from './LegalLayout';

const UPDATED = 'September 2026';

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated={UPDATED}>
      <P>
        This policy explains exactly what BotFlow stores about you, why we store it, and how long we keep it. It
        applies to your account, your wallet, your channels, and the click tracking that powers our ad metrics.
      </P>

      <LegalSection n={1} title="What we store" />
      <P>When you open the app inside Telegram, we receive and store the following about your Telegram account:</P>
      <Bullets
        items={[
          'Your Telegram user ID and @username',
          'Your first name, last name, and profile photo',
          'Your interface language',
        ]}
      />
      <P>
        We do not ask for your Telegram password and we cannot log in to Telegram as you; we only work with the
        profile data Telegram hands to the app.
      </P>
      <P>We also store, because the product is a marketplace with a wallet:</P>
      <Bullets
        items={[
          'Wallet and ledger records — every deposit, withdrawal, campaign charge, publisher earning, refund, and platform fee, with amount, currency, status, reference, and timestamp.',
          'Channel data for channels you add — username, title, photo, subscriber count, average views, delivery history, and per-post earnings.',
          'Campaign data you create — names, ad creatives (text and image URLs), targeting settings, budgets, and delivery status.',
          'Support tickets and the messages you send us.',
        ]}
      />

      <LegalSection n={2} title="Click tracking: hashes only, never raw data" />
      <P>
        When someone clicks a destination link in a sponsored post, we need to count the click and detect
        duplicates and fraud. For that we store a <b>salted hash of the clicker's IP address</b> and a{' '}
        <b>hash of their user-agent string</b>. We never store the raw IP address or the raw user-agent text, and
        we never try to resolve either one back into an individual person. The hashes let us recognize that the
        same device clicked the same post more than once; they are not a profile of the clicker.
      </P>

      <LegalSection n={3} title="What we do not do" />
      <Bullets
        items={[
          'We do not sell your personal data to anyone.',
          'We do not use your data for advertising outside BotFlow.',
          'We do not store clicker IPs or user agents in raw form.',
        ]}
      />

      <LegalSection n={4} title="How long we keep data" />
      <Bullets
        items={[
          'Telegram profile data: while your account is active, and within 90 days after you request deletion (subject to section 5).',
          'Wallet and ledger records: for as long as tax, audit, and payment-provider obligations require — in practice at least five years. We keep these even after an account is closed.',
          'Click-tracking hashes: 12 months, then deleted.',
          'Channel and campaign data: while the account is active and for a reasonable period afterwards to support disputes.',
        ]}
      />

      <LegalSection n={5} title="Your rights" />
      <P>
        You may ask us for a copy of the data we hold about you, or for deletion of your non-financial data, by
        opening a support ticket. We will honor a deletion request within 90 days, with one exception: ledger rows
        (deposits, withdrawals, charges, earnings, refunds) are retained for audit and legal compliance reasons even
        after your account is deleted. Those rows are not shown to anyone outside your own account and are not used
        for marketing.
      </P>

      <LegalSection n={6} title="Security" />
      <P>
        Traffic between the app and our servers is encrypted in transit. Click data is stored hashed, as described
        above. Wallet operations are reviewed manually before funds move, and access to financial records is
        restricted to the small team that processes them.
      </P>

      <LegalSection n={7} title="Third parties" />
      <Bullets
        items={[
          'Telegram — authenticates you and hosts the channels where ads are published.',
          'Payment providers (Telegram Stars and the crypto transfer services) — receive the transaction details needed to process your deposits and withdrawals.',
          'Channel owners — see the sponsored posts we deliver to their channels and the delivery status of those posts.',
        ]}
      />

      <LegalSection n={8} title="Questions" />
      <P>Open a support ticket from the app and choose the privacy category. We answer in the order tickets arrive.</P>
    </LegalLayout>
  );
}
