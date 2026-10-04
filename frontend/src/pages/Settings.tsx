import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { setEmailSchema } from '@botflow/shared';
import { api, errMsg, baseURL } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { SettingsMap } from '../lib/contracts';
import { displayName, formatDate, formatDateTime, humanize } from '../lib/format';
import { useUserStore } from '../store/userStore';
import { Card, CardTitle } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon, type IconName } from '../components/ui/icons';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { LogoLockup } from '../components/ui/Logo';
import { showToast } from '../store/uiStore';

/* ===================================================================
 *  Settings — the user-facing hub
 *
 *  Sections (top to bottom):
 *   1. Profile               name, handle, ID (copy), joined, status
 *   2. Account               email + cross-links (channels, campaigns,
 *                            wallet, transactions, billing, referrals,
 *                            premium, benefits, support)
 *   3. Notifications         per-channel toggles (where we can reach you)
 *   4. Privacy               data export / account deletion entry points
 *   5. Staff                 (admin only) admin panel
 *   6. Platform              public settings + about + social
 * ================================================================== */

function SettingValue({ value }: { value: unknown }): JSX.Element {
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span>{value.toLocaleString()}</span>;
  if (typeof value === 'string') return <span>{value}</span>;
  return <span className="break-all">{JSON.stringify(value)}</span>;
}

export function SettingsPage(): JSX.Element {
  const user = useUserStore((s) => s.user);
  const isAdmin = useUserStore((s) => s.isAdmin);
  const adminRole = useUserStore((s) => s.adminRole);

  const settings = useQuery({
    queryKey: qk.settingsPublic,
    queryFn: (): Promise<SettingsMap> => api.get<SettingsMap>('/api/settings/public'),
  });

  /* Current Premium tier for the "Premium" row subtitle. A 404 (not deployed
     yet) simply leaves the subtitle empty. */
  const premium = useQuery({
    queryKey: ['premium', 'settings-tier'],
    queryFn: (): Promise<{ tier?: string | null }> =>
      api.get<{ tier?: string | null }>('/api/premium/me'),
    retry: false,
  });
  const premiumSubtitle = premium.data?.tier ? humanize(premium.data.tier) : undefined;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-mute mt-0.5">Your account, preferences and platform info.</p>
      </header>

      {/* 1. PROFILE */}
      <Section title="Profile" icon="user">
        <ProfileCard />
      </Section>

      {/* 2. ACCOUNT */}
      <Section title="Account" icon="wallet" hint="Reach, identity and where your money lives.">
        <EmailCard />

        <div className="rounded-2xl border border-line bg-card overflow-hidden divide-y divide-line">
          <SettingsLink to="/channels" icon="channel" label="My channels" />
          <SettingsLink to="/campaigns" icon="megaphone" label="My campaigns" />
          <SettingsLink to="/wallet" icon="wallet" label="Wallet" />
          <SettingsLink to="/transactions" icon="doc" label="Transactions" />
          <SettingsLink to="/billing" icon="doc" label="Billing & invoices" />
          <SettingsLink to="/referrals" icon="user" label="Referral program" />
          <SettingsLink to="/benefits" icon="coin" label="Benefits & earnings" />
          <SettingsLink to="/premium" icon="shield" label="Premium" subtitle={premiumSubtitle} />
          <SettingsLink to="/support" icon="doc" label="Support" />
        </div>
      </Section>

      {/* 3. NOTIFICATIONS */}
      <Section
        title="Notifications"
        icon="bell"
        hint="Where we can reach you for things that matter."
      >
        <NotificationPreferencesCard />
      </Section>

      {/* 4. PRIVACY */}
      <Section title="Privacy" icon="shield" hint="Your data, on your terms.">
        <PrivacyCard />
      </Section>

      {/* 5. STAFF */}
      {isAdmin ? (
        <Section title="Staff" icon="shield" hint={`You are signed in as ${adminRole ? humanize(adminRole) : 'an admin'}.`}>
          <div className="rounded-2xl border border-line bg-card overflow-hidden">
            <SettingsLink
              to="/admin"
              icon="shield"
              label="Admin panel"
              subtitle={adminRole ? humanize(adminRole) : undefined}
            />
          </div>
        </Section>
      ) : null}

      {/* 6. PLATFORM */}
      <Section title="Platform" icon="doc">
        <PlatformCard
          isLoading={settings.isLoading}
          isError={settings.isError}
          data={settings.data}
          onRetry={() => void settings.refetch()}
        />
      </Section>

      {/* ABOUT */}
      <Section title="About" icon="info">
        <AboutCard />
      </Section>
    </div>
  );
}

/* ============================================================
 *  Section header + body wrapper
 * ========================================================== */

function Section({
  title,
  icon,
  hint,
  children,
}: {
  title: string;
  icon: IconName;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1">
        <Icon name={icon} size={15} className="text-mute shrink-0 translate-y-0.5" />
        <CardTitle className="m-0">{title}</CardTitle>
      </div>
      {hint && <p className="text-xs text-mute px-1">{hint}</p>}
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/* ============================================================
 *  1. Profile card
 * ========================================================== */

function ProfileCard(): JSX.Element {
  const user = useUserStore((s) => s.user);
  const [copied, setCopied] = useState<'id' | 'username' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = (kind: 'id' | 'username', text: string | null): void => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    setCopied(kind);
  };

  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-full bg-accent/10 text-accent flex items-center justify-center font-bold text-lg overflow-hidden shrink-0">
          {user?.photoUrl ? (
            <img src={user.photoUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            (user?.firstName || '?').charAt(0).toUpperCase()
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold truncate">{user ? displayName(user) : '…'}</p>
          <p className="text-sm text-link truncate">
            {user?.username ? `@${user.username.replace(/^@/, '')}` : 'No Telegram username'}
          </p>
        </div>
        {user && <StatusBadge status={user.status} />}
      </div>

      {/* Detail rows — each tap-to-copy with its own feedback */}
      <div className="mt-4 pt-4 border-t border-line space-y-2.5 text-sm">
        <DetailRow label="Telegram ID" mono>
          <CopyableInline
            text={user?.telegramId != null ? String(user.telegramId) : null}
            placeholder="—"
            copied={copied === 'id'}
            onCopy={() => copy('id', user?.telegramId != null ? String(user.telegramId) : null)}
            ariaLabel="Copy Telegram ID"
          />
        </DetailRow>

        <DetailRow label="Username" mono>
          <CopyableInline
            text={user?.username ? `@${user.username.replace(/^@/, '')}` : null}
            placeholder="No username"
            copied={copied === 'username'}
            onCopy={() =>
              copy('username', user?.username ? `@${user.username.replace(/^@/, '')}` : null)
            }
            ariaLabel="Copy Telegram username"
          />
        </DetailRow>

        <DetailRow label="Joined">
          <span>{formatDateTime(user?.createdAt ?? null)}</span>
        </DetailRow>
      </div>
    </Card>
  );
}

function DetailRow({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-mute text-xs uppercase tracking-wide">{label}</span>
      <span className={`flex items-center gap-2 ${mono ? 'font-mono' : ''}`}>{children}</span>
    </div>
  );
}

function CopyableInline({
  text,
  placeholder,
  copied,
  onCopy,
  ariaLabel,
}: {
  text: string | null;
  placeholder: string;
  copied: boolean;
  onCopy: () => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={!text}
      aria-label={ariaLabel}
      title={text ? 'Tap to copy' : ''}
      className="text-text underline-offset-2 hover:underline active:scale-95 disabled:no-underline disabled:cursor-default flex items-center gap-1.5"
    >
      <span>{text ?? placeholder}</span>
      {text ? (
          <Icon
            name={copied ? 'check' : 'copy'}
            size={13}
            className={copied ? 'text-ok' : 'text-mute'}
          />
        ) : null}
      {copied && <span className="text-xs text-ok">Copied</span>}
    </button>
  );
}

/* ============================================================
 *  2. Account · Email card
 * ========================================================== */

interface MeEmailState {
  email: string | null;
  verified: boolean;
  verificationPending: boolean;
}

function EmailCard(): JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ['me', 'email'],
    queryFn: (): Promise<MeEmailState> => api.get<MeEmailState>('/api/me/email'),
  });

  const save = useMutation({
    mutationFn: (email: string): Promise<unknown> => api.post('/api/me/email', { email }),
    onSuccess: () => {
      setValue('');
      setError(null);
      showToast('success', 'Verification email sent — check your inbox');
      void state.refetch();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (resend: boolean): void => {
    const email = (resend ? (state.data?.email ?? '') : value).trim();
    const parsed = setEmailSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
      return;
    }
    setError(null);
    save.mutate(email);
  };

  const current = state.data?.email ?? null;
  const verified = state.data?.verified ?? false;

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="font-semibold">Email</p>
        {current ? (
          <span
            className={`inline-flex items-center gap-1 text-xs ${verified ? 'text-ok' : 'text-warn'}`}
          >
            <Icon name={verified ? 'check' : 'alert'} size={13} />
            {verified ? 'Verified' : state.data?.verificationPending ? 'Link sent' : 'Not verified'}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-mute mb-3">
        Invoices, security alerts and earnings notices — never marketing. Changing the address
        re-sends the verification link.
      </p>
      <Input
        type="email"
        placeholder={current ?? 'you@example.com'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (!value.trim()) {
            setError(null);
            return;
          }
          const parsed = setEmailSchema.safeParse({ email: value.trim() });
          setError(parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter a valid email address'));
        }}
        maxLength={200}
        error={error ?? undefined}
      />
      <div className="mt-3 flex gap-2">
        <Button full loading={save.isPending} onClick={() => submit(false)}>
          {current ? 'Update email' : 'Save email'}
        </Button>
        {current && !verified ? (
          <Button variant="secondary" icon={<Icon name="refresh" size={15} />} onClick={() => submit(true)}>
            Resend link
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/* ============================================================
 *  3. Notifications card — toggles for delivery channels
 * ========================================================== */

interface NotificationPrefs {
  telegram: boolean; // always true in-app, but still surfaceable
  email: boolean; // the email saved above must be verified
  push: boolean; // telegram mini-app push notifications
}

const PREFS_DEFAULT: NotificationPrefs = {
  telegram: true,
  email: true,
  push: false,
};

function NotificationPreferencesCard(): JSX.Element {
  const [prefs, setPrefs] = useState<NotificationPrefs>(PREFS_DEFAULT);

  const save = useMutation({
    mutationFn: (next: NotificationPrefs): Promise<unknown> =>
      api.post('/api/me/notification-prefs', next),
    onSuccess: () => showToast('success', 'Notification preferences saved'),
    onError: (e) => showToast('error', errMsg(e)),
  });

  const update = <K extends keyof NotificationPrefs>(
    key: K,
    value: NotificationPrefs[K],
  ): void => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    save.mutate(next);
  };

  return (
    <Card>
      <p className="text-sm text-mute mb-3">
        Pick how you want BotFlow to reach you. We never send anything that is not
        a transaction, an alert or a security notice.
      </p>
      <div className="space-y-1 divide-y divide-line">
        <Toggle
          icon="bell"
          label="In-app"
          subtitle="Telegram messages from BotFlow Bot"
          value={prefs.telegram}
          disabled
          onChange={() => undefined}
        />
        <Toggle
          icon="doc"
          label="Email"
          subtitle="Receipts, invoices and earnings"
          value={prefs.email}
          onChange={(v) => update('email', v)}
        />
        <Toggle
          icon="bell"
          label="Push notifications"
          subtitle="Telegram mini-app push notifications"
          value={prefs.push}
          onChange={(v) => update('push', v)}
        />
      </div>
    </Card>
  );
}

function Toggle({
  icon,
  label,
  subtitle,
  value,
  disabled,
  onChange,
}: {
  icon: IconName;
  label: string;
  subtitle?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label
      className={`flex items-center gap-3 py-2.5 ${disabled ? 'opacity-70' : 'cursor-pointer active:bg-app/40 rounded-lg'}`}
    >
      <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
        <Icon name={icon} size={16} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {subtitle && (
          <span className="block text-xs text-mute truncate mt-0.5">{subtitle}</span>
        )}
      </span>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 rounded-full transition-colors ${
          value ? 'bg-accent' : 'bg-line'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            value ? 'translate-x-5' : ''
          }`}
        />
      </span>
    </label>
  );
}

/* ============================================================
 *  4. Privacy card — data export + sign-out everywhere
 * ========================================================== */

function PrivacyCard(): JSX.Element {
  const export_ = useMutation({
    mutationFn: (): Promise<unknown> => api.post('/api/me/export', {}),
    onSuccess: () => showToast('success', 'Export started — you will get an email when ready'),
    onError: (e) => showToast('error', errMsg(e)),
  });

  const signOut = useMutation({
    mutationFn: (): Promise<unknown> => api.post('/api/auth/logout', {}),
    onSuccess: () => {
      showToast('success', 'Signed out everywhere');
      window.location.href = '/';
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  return (
    <div className="space-y-2">
      <Card>
        <p className="font-semibold mb-1">Data export</p>
        <p className="text-sm text-mute mb-3">
          Download a copy of your transactions, channels and settings. We email a
          signed link when the export is ready.
        </p>
        <Button
          variant="secondary"
          icon={<Icon name="doc" size={15} />}
          loading={export_.isPending}
          onClick={() => export_.mutate()}
        >
          Request export
        </Button>
      </Card>

      <Card>
        <p className="font-semibold mb-1">Sign out everywhere</p>
        <p className="text-sm text-mute mb-3">
          Ends every active session — you will need to sign in again from Telegram
          on this and any other device.
        </p>
        <Button
          variant="danger"
          icon={<Icon name="alert" size={15} />}
          loading={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out everywhere
        </Button>
      </Card>
    </div>
  );
}

/* ============================================================
 *  6. Platform card
 * ========================================================== */

function PlatformCard({
  isLoading,
  isError,
  data,
  onRetry,
}: {
  isLoading: boolean;
  isError: boolean;
  data: SettingsMap | undefined;
  onRetry: () => void;
}): JSX.Element {
  if (isLoading) return <Skeleton className="h-28 w-full rounded-2xl" />;
  if (isError) return <ErrorState message="Could not load platform info" onRetry={onRetry} />;
  const entries = Object.entries(data ?? {});
  return (
    <Card>
      {entries.length === 0 ? (
        <p className="text-sm text-mute">No public settings configured.</p>
      ) : (
        <div className="space-y-2.5">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 text-sm">
              <span className="text-mute shrink-0">{humanize(k)}</span>
              <span className="font-medium text-right">
                <SettingValue value={v} />
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ============================================================
 *  About card
 * ========================================================== */

function AboutCard(): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copyApi = (): void => {
    void navigator.clipboard.writeText(baseURL);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <Card>
      <div className="flex justify-center pb-4 mb-4 border-b border-line">
        <LogoLockup width={196} />
      </div>

      <div className="space-y-2.5 text-sm">
        <AboutRow label="App">BotFlow Ads v1.0.0</AboutRow>
        <AboutRow label="API">
          <button
            type="button"
            onClick={copyApi}
            className="font-medium text-right break-all max-w-[70%] underline-offset-2 hover:underline active:scale-95 inline-flex items-center gap-1.5"
            title="Copy API URL"
          >
            <span>{baseURL}</span>
            <Icon
              name={copied ? 'check' : 'copy'}
              size={13}
              className={copied ? 'text-ok' : 'text-mute'}
            />
            {copied && <span className="text-xs text-ok">Copied</span>}
          </button>
        </AboutRow>
        <AboutRow label="Payments">Crypto · Telegram Stars</AboutRow>
        <AboutRow label="Support">
          <a
            href="https://t.me/BotFlowSupport"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            @BotFlowSupport
          </a>
        </AboutRow>
      </div>

      <div className="mt-4 pt-4 border-t border-line text-xs text-mute text-center">
        <Link to="/legal/terms" className="hover:underline mx-1.5">
          Terms
        </Link>
        <span aria-hidden>·</span>
        <Link to="/legal/privacy" className="hover:underline mx-1.5">
          Privacy
        </Link>
        <span aria-hidden>·</span>
        <Link to="/legal/publisher-agreement" className="hover:underline mx-1.5">
          Publisher agreement
        </Link>
      </div>
    </Card>
  );
}

function AboutRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-mute">{label}</span>
      <span className="font-medium text-right">{children}</span>
    </div>
  );
}

/* ============================================================
 *  RowLink — used inside grouped cards
 * ========================================================== */

function SettingsLink({
  to,
  icon,
  label,
  subtitle,
}: {
  to: string;
  icon: IconName;
  label: string;
  subtitle?: string;
}): JSX.Element {
  return (
    <Link to={to} className="flex items-center gap-3 px-3.5 py-2.5 active:bg-app/60">
      <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
        <Icon name={icon} size={18} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {subtitle && (
          <span className="block text-xs text-mute truncate mt-0.5">{subtitle}</span>
        )}
      </span>
      <Icon name="chevronRight" size={17} className="text-mute shrink-0" />
    </Link>
  );
}