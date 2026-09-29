import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTelegramUser } from '../../hooks/useTelegramUser';
import { BottomNav } from './BottomNav';
import { ToastContainer } from '../ui/Toast';
import { PageSkeleton } from '../ui/Skeleton';
import { ErrorState } from '../ui/EmptyState';
import { humanError } from '../../lib/errors';

/**
 * Root shell for user-facing pages: 390px-first column, bottom nav,
 * session bootstrap (GET /api/me) and the global toast host.
 */
export function AppShell() {
  const { data: me, isPending, isError, error, refetch } = useTelegramUser();
  const location = useLocation();

  // Scroll to top on route change (mini-app feel).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="min-h-dvh bg-app">
      <ToastContainer />
      <div className="max-w-app mx-auto min-h-dvh flex flex-col">
        <main className="flex-1 pb-24 px-4 pt-4">
          {isPending ? (
            <PageSkeleton />
          ) : isError ? (
            <div className="pt-16">
              <ErrorState
                message={humanError(error)}
                onRetry={() => void refetch()}
              />
            </div>
          ) : (
            <Outlet context={{ me }} />
          )}
        </main>
        {!isPending && !isError && <BottomNav />}
      </div>
    </div>
  );
}
