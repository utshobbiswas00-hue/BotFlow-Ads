/**
 * Staff panel sign-in (username + password).
 *
 * This is an ADDITIONAL door, not a replacement. Telegram initData still works,
 * so an operator who has a Mini App session never needs this screen — and if the
 * password login is unconfigured or broken on the server, nobody is locked out.
 *
 * Two states the screen has to handle honestly, because both are configuration
 * problems the person at the keyboard cannot fix by typing:
 *
 *  - `passwordLoginEnabled: false` (from `GET /api/admin/auth/config`) — no panel
 *    login is configured on this deployment. Say so, and offer the Telegram route
 *    instead of showing a form that can only ever fail.
 *  - 403 with "Panel login is not configured" — same situation reached by a direct
 *    POST. The message from the server is shown verbatim.
 *
 * The password is never persisted anywhere; only the signed token it returns.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errMsg } from '../../lib/api';
import { setCsrfToken } from '../../lib/adminSession';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { ToastContainer } from '../../components/ui/Toast';
import { showToast } from '../../store/uiStore';
import { getAuthConfig, loginWithPassword } from '../lib/api';
import { qk } from '../../lib/queryClient';

export function AdminLoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const config = useQuery({
    queryKey: ['admin', 'auth', 'config'],
    queryFn: getAuthConfig,
    staleTime: 60_000,
  });

  const login = useMutation({
    mutationFn: () => loginWithPassword(username, password),
    onSuccess: async (res) => {
      // Only the CSRF value is kept client-side. The session is an HttpOnly
      // cookie the server just set, which no script — including an injected one —
      // can read.
      setCsrfToken(res.csrf);
      // Drop any cached 401 from the pre-login attempt, then mount the panel
      // against a fresh session query.
      await queryClient.invalidateQueries({ queryKey: qk.adminSession });
      showToast('success', `Signed in as ${res.admin.role}`);
      navigate('/admin', { replace: true });
    },
    onError: (e) => {
      // Never echo the password back, and never say which half was wrong.
      showToast('error', errMsg(e));
      setPassword('');
    },
  });

  const disabled = login.isPending || !username.trim() || !password;

  return (
    <div className="min-h-dvh bg-app flex items-center justify-center p-4">
      <ToastContainer />
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-5">
          <span className="w-10 h-10 rounded-xl bg-ink text-app flex items-center justify-center">
            <Icon name="grid" size={20} />
          </span>
          <div>
            <p className="font-bold leading-tight">BotFlow Admin</p>
            <p className="text-[11px] text-mute leading-tight">Staff sign-in</p>
          </div>
        </div>

        {config.isSuccess && !config.data.passwordLoginEnabled ? (
          <div className="bg-surface border border-warn/40 rounded-2xl p-4">
            <div className="flex items-start gap-2.5">
              <Icon name="alert" size={18} className="text-warn shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">Password login is not enabled here</p>
                <p className="text-xs text-mute mt-1">
                  This deployment has no panel username configured, so there is nothing to sign in
                  with. Set <code className="num">ADMIN_PANEL_USERNAME</code>,{' '}
                  <code className="num">ADMIN_PANEL_PASSWORD_HASH</code> and{' '}
                  <code className="num">ADMIN_PANEL_ADMIN_TELEGRAM_ID</code> on the server — all
                  three, or none.
                </p>
                <p className="text-xs text-mute mt-2">
                  Telelgram authentication is unaffected. Open the Mini App from the BotFlow bot and
                  the panel will recognise an admin account directly.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <form
            className="bg-surface border border-line rounded-2xl p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!disabled) login.mutate();
            }}
          >
            <Input
              label="Username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {login.isError ? (
              <p className="text-xs text-danger">
                {login.error instanceof ApiError && login.error.status === 429
                  ? 'Too many attempts. Wait 15 minutes and try again.'
                  : errMsg(login.error)}
              </p>
            ) : null}

            <Button type="submit" full loading={login.isPending} disabled={disabled}>
              Sign in
            </Button>

            <p className="text-[11px] text-mute">
              Ten attempts per 15 minutes. Your password is checked against a hash on the server and
              never stored in this browser — only the signed token it returns is.
            </p>
          </form>
        )}

        <div className="mt-4 flex flex-col gap-2 text-xs">
          <Link to="/" className="inline-flex items-center gap-1.5 text-link hover:underline">
            <Icon name="back" size={13} />
            Back to the Mini App
          </Link>
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 text-link hover:underline"
          >
            <Icon name="shield" size={13} />
            Continue with Telegram authentication
          </Link>
        </div>
      </div>
    </div>
  );
}
