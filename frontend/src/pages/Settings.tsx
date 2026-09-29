import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { setEmailSchema } from '@botflow/shared';
import { api, errMsg, baseURL } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { SettingsMap } from '../lib/contracts';
import { displayName, formatDate, humanize } from '../lib/format';
import { useUserStore } from '../store/userStore';
import { Card, CardTitle } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { LogoLockup } from '../components/ui/Logo';
import { showToast } from '../store/uiStore';

function SettingValue({ value }: { value: unknown }) {
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span>{value}</span>;
  if (typeof value === 'string') return <span>{value}</span>;
  return <span className="break-all">{JSON.stringify(value)}</span>;
}

export function SettingsPage() {
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
    queryFn: (): Promise<{ tier?: string | null }> => api.get<{ tier?: string | null }>('/api/premium/me'),
  });
  const premiumSubtitle = premium.data?.tier ? humanize(premium.data.tier) : undefined;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-mute">Account, preferences and about.</p>
      </div>

      {/* Profile */}
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
            <p className="text-sm text-link truncate">{user?.username ? `@${user.username.replace(/^@/, '')}` : 'No username'}</p>
            <p className="text-xs text-mute mt-0.5">
              Telegram ID {user?.telegramId} · joined {formatDate(user?.createdAt ?? null)}
            </p>
          </div>
          {user && <StatusBadge status={user.status} />}
        </div>
      </Card>

       {/* Email — the channel that reaches a user who blocks the bot */}
       <div>
         <CardTitle>Email</CardTitle>
         <Card>
           <EmailSettings />
         </Card>
       </div>

       {/* Account links */}
       <div>
         <CardTitle>Account</CardTitle>
         <Card padded={false} className="divide-y divide-line">
           <SettingsLink to="/channels" icon="channel" label="My channels" />
           <SettingsLink to="/campaigns" icon="megaphone" label="My campaigns" />
           <SettingsLink to="/transactions" icon="wallet" label="Transactions" />
           <SettingsLink to="/billing" icon="doc" label="Billing & invoices" />
           <SettingsLink to="/referrals" icon="user" label="Referral program" />
          <SettingsLink to="/benefits" icon="coin" label="Benefits & earnings" />
          <SettingsLink to="/premium" icon="shield" label="Premium" subtitle={premiumSubtitle} />
          <SettingsLink to="/support" icon="doc" label="Support" />
        </Card>
      </div>

      {/* Platform info */}
      <div>
        <CardTitle>Platform</CardTitle>
        {settings.isLoading ? (
          <Skeleton className="h-28 w-full rounded-2xl" />
        ) : settings.isError ? (
          <ErrorState message={errMsg(settings.error)} onRetry={() => void settings.refetch()} />
        ) : (
          <Card>
            {Object.entries(settings.data ?? {}).length === 0 ? (
              <p className="text-sm text-mute">No public settings configured.</p>
            ) : (
              <div className="space-y-2.5">
                {Object.entries(settings.data ?? {}).map(([k, v]) => (
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
        )}
      </div>

      {/* About */}
      <Card>
        {/* Full brand lockup. It carries its own dark plate, which is why it
            only appears here and never on a plain light surface. */}
        <div className="flex justify-center pb-4 mb-4 border-b border-line">
          <LogoLockup width={196} />
        </div>
        <div className="space-y-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-mute">App</span>
            <span className="font-medium">BotFlow Ads v1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-mute">API</span>
            <span className="font-medium text-right break-all max-w-[55%]">{baseURL}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-mute">Payments</span>
            <span className="font-medium">Crypto · Telegram Stars</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

interface MeEmailState {
  email: string | null;
  verified: boolean;
  verificationPending: boolean;
}

/**
 * Email address card. The address is the fallback channel for anything
 * Telegram cannot deliver (a blocked bot, invoices, security alerts), so the
 * page shows exactly where things stand: saved, verified, or awaiting the
 * link in the user's inbox.
 */
function EmailSettings() {
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
    <div className="space-y-3">
      <p className="text-sm text-mute">
        Invoices, security alerts and earnings notices go here — never marketing. Changing the address
        re-sends the verification link.
      </p>
      <Input
        label="Email address"
        type="email"
        placeholder="you@example.com"
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
      {current && (
        <p className={`flex items-center gap-1.5 text-sm ${verified ? 'text-ok' : 'text-warn'}`}>
          <Icon name={verified ? 'check' : 'alert'} size={15} />
          {verified ? 'Verified' : state.data?.verificationPending ? 'Not verified — link sent' : 'Not verified'}
        </p>
      )}
      <div className="flex gap-2">
        <Button full loading={save.isPending} onClick={() => submit(false)}>
          {current ? 'Update email' : 'Save email'}
        </Button>
        {current && !verified && (
          <Button variant="secondary" icon={<Icon name="refresh" size={15} />} onClick={() => submit(true)}>
            Resend
          </Button>
        )}
      </div>
    </div>
  );
}

function SettingsLink({
  to,
  icon,
  label,
  subtitle,
}: {
  to: string;
  icon: 'channel' | 'megaphone' | 'wallet' | 'user' | 'doc' | 'coin' | 'shield';
  label: string;
  subtitle?: string;
}) {
  return (
    <Link to={to} className="flex items-center gap-3 p-3.5 active:bg-app/60">
      <span className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
        <Icon name={icon} size={18} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {subtitle && <span className="block text-xs text-mute truncate mt-0.5">{subtitle}</span>}
      </span>
      <Icon name="chevronRight" size={17} className="text-mute shrink-0" />
    </Link>
  );
}
