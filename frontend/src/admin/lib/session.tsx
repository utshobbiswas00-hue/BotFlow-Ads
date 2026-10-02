/**
 * Admin session context.
 *
 * Resolves `GET /api/admin/session` once per session and answers the only
 * question the UI needs: "may this admin do X?". The answer comes from the
 * server's own permission array, so the panel and `requirePermission` cannot
 * disagree about which actions exist.
 *
 * Scope note: this gates RENDERING only. It is not a security boundary — the
 * API re-checks every request, and a hidden button is a convenience, not a
 * control.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '../../lib/queryClient';
import { setCsrfToken } from '../../lib/adminSession';
import { getSession } from './api';
import type { AdminPermission } from './permissions';
import type { AdminSession } from './types';

export interface AdminSessionValue {
  session: AdminSession | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** True when the server said the caller is SUPER_ADMIN. */
  isSuperAdmin: boolean;
  /** A cookie session is in play, so offering a sign-out control makes sense. */
  sessionActive: boolean;
  role: string | null;
  /** The keys the server reported for this admin. */
  permissions: string[];
  /** True when the admin may perform `permission`. */
  can: (permission: AdminPermission) => boolean;
  /** True when the admin holds at least one of `permissions`. */
  canAny: (permissions: AdminPermission[]) => boolean;
}

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: qk.adminSession,
    queryFn: async () => {
      const fresh = await getSession();
      // Bootstrap the CSRF value from the same response so a reloaded tab can
      // issue unsafe requests without a second round-trip. The authoritative copy
      // lives in the session record; this is only the value to echo back.
      setCsrfToken(fresh.session?.csrf ?? null);
      return fresh;
    },
    // The permission set changes only when someone edits the admin row, so a
    // long stale time avoids re-authorising on every navigation.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const value = useMemo<AdminSessionValue>(() => {
    const session = query.data ?? null;
    const isSuperAdmin = session?.admin.isSuperAdmin ?? false;
    const permissions = session?.admin.permissions ?? [];

    const can = (permission: AdminPermission): boolean => {
      if (!session) return false;
      if (isSuperAdmin) return true;
      return permissions.includes(permission);
    };

    return {
      session,
      isPending: query.isPending,
      isError: query.isError,
      error: query.error,
      refetch: () => void query.refetch(),
      isSuperAdmin,
      sessionActive: session?.session?.active ?? false,
      role: session?.admin.role ?? null,
      permissions,
      can,
      canAny: (list) => list.some(can),
    };
  }, [query.data, query.isPending, query.isError, query.error, query.refetch]);

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession(): AdminSessionValue {
  const ctx = useContext(AdminSessionContext);
  if (!ctx) throw new Error('useAdminSession must be used inside <AdminSessionProvider>');
  return ctx;
}
