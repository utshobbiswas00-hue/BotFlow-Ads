/**
 * Admin panel shell: session gate, sidebar, top bar, toast host.
 *
 * Structure notes:
 *  - The Mini App's own `AppShell` (430px column + bottom nav) is deliberately
 *    NOT reused. Operations work needs width and a persistent nav, so this is a
 *    sidebar layout that collapses to a drawer on narrow viewports. It is still
 *    reachable inside Telegram, because it rides the same initData session.
 *  - Auth is not re-implemented: `telegramAuth` on the API already owns the
 *    session, and `GET /api/admin/session` is the only new call. There is no
 *    login screen to get wrong.
 *  - A non-admin, or an admin whose permission array is empty, gets an explicit
 *    explanation instead of an empty shell where every screen 403s.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '../../lib/cn';
import { ApiError } from '../../lib/api';
import { clearAdminSession } from '../../lib/adminSession';
import { humanError } from '../../lib/errors';
import { logoutAdmin } from '../lib/api';
import { Icon } from '../../components/ui/icons';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { ToastContainer } from '../../components/ui/Toast';
import { FloatingChatWidget } from '../../components/ai/FloatingChatWidget';
import { Skeleton } from '../../components/ui/Skeleton';
import { ADMIN_NAV, ROLE_LABELS, activeNavGroup, activeNavItem } from '../lib/permissions';
import { AdminSessionProvider, useAdminSession } from '../lib/session';
import { AttentionBell, Breadcrumb, GlobalSearch } from './TopBarTools';

export function AdminShell() {
  return (
    <AdminSessionProvider>
      <AdminLayout />
    </AdminSessionProvider>
  );
}

function AdminLayout() {
  const {
    session,
    isPending,
    isError,
    error,
    refetch,
    isSuperAdmin,
    sessionActive,
    canAny,
    permissions,
  } = useAdminSession();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Close the drawer on navigation — otherwise it stays over the new page.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  const current = activeNavItem(location.pathname);
  const navGroup = activeNavGroup(location.pathname);

  const groups = useMemo(
    () =>
      ADMIN_NAV.map((g) => ({
        label: g.label,
        items: g.items.filter((i) =>
          i.superAdminOnly ? isSuperAdmin : !i.permissions || canAny(i.permissions),
        ),
      })).filter((g) => g.items.length > 0),
    [canAny, isSuperAdmin],
  );

  if (isPending) {
    return (
      <div className="min-h-dvh bg-app p-6">
        <div className="max-w-3xl mx-auto space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </div>
    );
  }

  if (isError || !session) {
    return <AccessGate error={error} onRetry={refetch} />;
  }

  const noPermissions = !isSuperAdmin && permissions.length === 0;

  return (
    <div className="min-h-dvh bg-app">
      <ToastContainer />

      {navOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <div className="lg:flex lg:min-h-dvh">
        <aside
          className={cn(
            'fixed z-50 inset-y-0 left-0 w-64 bg-surface border-r border-line flex flex-col',
            'transition-transform lg:translate-x-0 lg:static lg:shrink-0',
            navOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="p-4 border-b border-line flex items-center gap-2">
            <span className="w-8 h-8 rounded-xl bg-ink text-app flex items-center justify-center shrink-0">
              <Icon name="grid" size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-tight">BotFlow Admin</p>
              <p className="text-[11px] text-mute leading-tight">Operations console</p>
            </div>
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              className="lg:hidden p-1.5 -m-1.5 text-mute"
              aria-label="Close navigation"
            >
              <Icon name="x" size={18} />
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto p-3 space-y-4 no-scrollbar">
            {noPermissions ? (
              <p className="text-[11px] text-warn bg-warn/10 border border-warn/30 rounded-lg p-2">
                No permissions granted on this account.
              </p>
            ) : null}
            {groups.map((g) => (
              <div key={g.label}>
                <p className="px-2 mb-1.5 text-[10px] uppercase tracking-wider text-mute font-semibold">
                  {g.label}
                </p>
                <ul className="space-y-0.5">
                   {g.items.map((item) => (
                     <li key={item.to}>
                       <NavLink
                         to={item.to}
                         end={item.end}
                         className={({ isActive }) =>
                           cn(
                             'flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-sm transition-colors',
                             isActive
                               ? 'bg-ink text-app font-medium'
                               : 'text-ink/80 hover:bg-app',
                           )
                         }
                       >
                         <Icon name={item.icon} size={16} />
                         <span className="truncate">{item.label}</span>
                       </NavLink>

                       {/*
                         Nested entries (spec §8). These are LINKS, not NavLinks,
                         because several of them differ only by query string
                         (`/admin/users?status=BANNED` vs `/admin/users`) and
                         NavLink's `isActive` ignores the search string entirely —
                         using it would light up every sibling at once.
                       */}
                       {item.children ? (
                         <ul className="mt-1 ml-4 pl-2.5 border-l border-line space-y-0.5">
                           {item.children.map((child) => {
                             const current = `${location.pathname}${location.search}`;
                             const childActive = current === child.to;
                             return (
                               <li key={child.to}>
                                 <Link
                                   to={child.to}
                                   className={cn(
                                     'block px-2 py-1 rounded-md text-xs transition-colors',
                                     childActive
                                       ? 'text-ink font-medium bg-app'
                                       : 'text-mute hover:text-ink',
                                   )}
                                 >
                                   {child.label}
                                 </Link>
                               </li>
                             );
                           })}
                         </ul>
                       ) : null}
                     </li>
                   ))}
                </ul>
              </div>
            ))}
          </nav>

          <div className="p-3 border-t border-line space-y-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-full bg-app border border-line flex items-center justify-center overflow-hidden shrink-0">
                {session.user.photoUrl ? (
                  <img src={session.user.photoUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Icon name="user" size={16} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{session.user.name}</p>
                <p className="text-[11px] text-mute truncate num">ID {session.user.telegramId}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusBadge status={session.admin.role} />
              <span className="text-[11px] text-mute">
                {ROLE_LABELS[session.admin.role] ?? session.admin.role}
              </span>
            </div>
            <Link to="/" className="flex items-center gap-1.5 text-[11px] text-link hover:underline">
              <Icon name="back" size={13} />
              Back to the Mini App
            </Link>
            {sessionActive ? (
              <button
                type="button"
                onClick={() => {
                  // Destroy the session server-side first (it is a real record in
                  // Redis, so this is what actually ends the session), then drop
                  // the local CSRF copy and every cached admin response, so
                  // nothing survives for the next person at this browser.
                  void logoutAdmin()
                    .catch(() => undefined)
                    .finally(() => {
                      clearAdminSession();
                      queryClient.clear();
                      navigate('/admin/login', { replace: true });
                    });
                }}
                className="flex items-center gap-1.5 text-[11px] text-mute hover:text-ink"
              >
                <Icon name="logout" size={13} />
                Sign out of the panel
              </button>
            ) : null}
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="sticky top-0 z-30 bg-app/95 backdrop-blur border-b border-line">
            <div className="flex items-center gap-3 px-4 h-14">
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                className="lg:hidden p-2 -m-2 text-ink"
                aria-label="Open navigation"
              >
                <Icon name="filter" size={20} />
              </button>
              <div className="min-w-0 flex-1">
                <Breadcrumb group={navGroup} label={current?.label ?? null} />
              </div>
              <GlobalSearch />
              <AttentionBell />
              <span
                className="hidden lg:inline-flex items-center gap-1.5 text-[11px] text-mute"
                title={`Last sign-in ${session.admin.lastLoginAt ?? 'unknown'}`}
              >
                <Icon name="clock" size={13} />
                {session.admin.lastLoginAt
                  ? new Date(session.admin.lastLoginAt).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'First session'}
              </span>
            </div>
          </header>

          <main className="flex-1 p-4 lg:p-6">
            <div className="max-w-[1200px]">
              {noPermissions ? <NoPermissions /> : <Outlet />}
            </div>
          </main>

        {/* Same widget as the publisher shell — admins also need it. */}
        <FloatingChatWidget />
        </div>
      </div>
    </div>
  );
}

/** 401 / 403 / network gate — explains what is wrong and how to fix it. */
function AccessGate({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : undefined;
  const unauthorized = status === 401;

  return (
    <div className="min-h-dvh bg-app flex items-center justify-center p-6">
      <ToastContainer />
      <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-6 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-danger/10 text-danger flex items-center justify-center mb-4">
          <Icon name="shield" size={26} />
        </div>
        <h1 className="text-lg font-bold">
          {unauthorized ? 'Not signed in' : 'Admin access required'}
        </h1>
        <p className="text-sm text-mute mt-2">{humanError(error)}</p>
        <p className="text-xs text-mute mt-3">
          {unauthorized
            ? 'Either sign in below, or open the Mini App from the BotFlow bot so Telegram can sign the session.'
            : 'This account has no active admin record. Ask a super admin to grant access from Admin accounts, or check that the record is still active.'}
        </p>

        {/* A 401 has two possible fixes and they are different actions, so both
            doors are offered rather than guessing which one this operator
            arrived through. */}
        <div className="flex flex-col gap-2 mt-5 sm:flex-row">
          {unauthorized ? (
            <Link
              to="/admin/login"
              className="flex-1 inline-flex items-center justify-center gap-1.5 h-11 rounded-xl bg-ink text-app text-sm font-medium"
            >
              <Icon name="shield" size={15} />
              Sign in
            </Link>
          ) : null}
          <Link
            to="/"
            className="flex-1 inline-flex items-center justify-center h-11 rounded-xl border border-line bg-surface text-sm font-medium"
          >
            Open the Mini App
          </Link>
          <button
            type="button"
            onClick={onRetry}
            className="flex-1 inline-flex items-center justify-center gap-1.5 h-11 rounded-xl border border-line bg-surface text-sm font-medium"
          >
            <Icon name="refresh" size={15} />
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * An admin row can exist with an empty permission array — `requirePermission`
 * then rejects every call, and only SUPER_ADMIN bypasses it. Say so plainly
 * rather than rendering a shell in which every screen 403s.
 */
function NoPermissions() {
  return (
    <div className="bg-surface border border-warn/40 rounded-2xl p-6">
      <div className="flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-warn/10 text-warn flex items-center justify-center shrink-0">
          <Icon name="alert" size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold">No permissions granted</h2>
          <p className="text-sm text-mute mt-1">
            Your admin record is active but its permission list is empty, so every panel action would
            be rejected by the API. A super admin has to grant at least{' '}
            <code className="num">dashboard.view</code> to get you started.
          </p>
          <p className="text-xs text-mute mt-3">
            Note: the API can set a role but exposes no way to set individual permission keys — only{' '}
            <code className="num">role</code> and <code className="num">isActive</code> are writable
            on <code className="num">/api/admin/admin-users</code>. The permission array itself has to
            be written on the admin row directly.
          </p>
        </div>
      </div>
    </div>
  );
}
