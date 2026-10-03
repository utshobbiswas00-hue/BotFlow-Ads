/**
 * Admin accounts — SUPER_ADMIN only (`adminUsersRouter.use(requireRole(...))`).
 *
 * Granting access and giving that grant meaning are two steps, and the second one
 * used to be impossible here: `PATCH /admin/admin-users/:id` has always accepted a
 * `permissions` array, but this screen only ever sent `role` and `isActive`, so
 * every non-SUPER_ADMIN account was created with an empty list — which
 * `requirePermission` reads as "denied", and only SUPER_ADMIN bypasses. The result
 * was an account that could not open a single screen, fixable only with a manual
 * database write. The edit dialog now carries a permission matrix.
 *
 * Deactivation is still not deletion: `DELETE /admin/admin-users/:id` sets
 * `isActive: false` so audit rows keep resolving to a real actor, and the row is
 * never removed. The button is worded accordingly.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import {
  createAdminAccount,
  deactivateAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
} from '../lib/api';
import {
  ADMIN_ROLES,
  adminAccessChangeBlockedReason,
  adminDeactivationBlockedReason,
  PERMISSION_GROUPS,
  ROLE_LABELS,
  UNWIRED_PERMISSIONS,
} from '../lib/permissions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { ConfirmDialog, type DialogField } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { AdminAccount } from '../lib/types';

const LIMIT = 20;

const ROLE_OPTIONS = ADMIN_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }));

function permissionKeys(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
}

export function AdminAdminsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminAccount | null>(null);
  const [deactivating, setDeactivating] = useState<AdminAccount | null>(null);
  // Who is signed in, so the screen can refuse to lock them out of it.
  const { session } = useAdminSession();
  const me = session?.admin ?? null;

  const query = useQuery({
    queryKey: [...qk.adminAccounts, page],
    queryFn: () => listAdminAccounts({ page, limit: LIMIT }),
  });
  const rows = query.data?.items ?? [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminAccounts });
  };

  const create = useMutation({
    mutationFn: ({ telegramId, role }: { telegramId: string; role: string }) =>
      createAdminAccount(telegramId, role),
    onSuccess: (acc) => {
      showToast('success', `${acc.userName} is now ${ROLE_LABELS[acc.role] ?? acc.role}`);
      setCreating(false);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const update = useMutation({
    mutationFn: ({
      id,
      role,
      isActive,
      permissions,
    }: {
      id: string;
      role: string;
      isActive: boolean;
      permissions: string[];
    }) =>
      updateAdminAccount(id, {
        role,
        isActive,
        // Not sent for SUPER_ADMIN: the API rejects the pair, and with good reason —
        // SUPER_ADMIN bypasses `requirePermission`, so a stored list would look like a
        // restriction that is never applied.
        ...(role === 'SUPER_ADMIN' ? {} : { permissions }),
      }),
    onSuccess: () => {
      showToast('success', 'Admin updated');
      setEditing(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => deactivateAdminAccount(id),
    onSuccess: (acc) => {
      showToast('success', `${acc.userName} can no longer use the panel`);
      setDeactivating(null);
      invalidate();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const columns: Column<AdminAccount>[] = [
    {
      key: 'user',
      header: 'Admin',
      render: (a) => (
        <TwoLine
          primary={a.userName}
          secondary={
            <Mono title={a.userId}>{a.username ? `@${a.username}` : a.userId.slice(0, 12)}</Mono>
          }
        />
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (a) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge status={a.role} />
          <span className="text-xs text-mute">{ROLE_LABELS[a.role] ?? humanize(a.role)}</span>
        </span>
      ),
    },
    {
      key: 'permissions',
      header: 'Permissions',
      hideBelow: 'md',
      render: (a) => {
        if (a.role === 'SUPER_ADMIN') {
          return <span className="text-xs text-mute">Full access (role bypass)</span>;
        }
        const keys = permissionKeys(a.permissions);
        return keys.length === 0 ? (
          <span className="text-xs text-warn">none — every screen will 403</span>
        ) : (
          <span className="num text-xs text-mute" title={keys.join(', ')}>
            {keys.length} key(s)
          </span>
        );
      },
    },
    {
      key: 'active',
      header: 'Status',
      render: (a) => <StatusBadge status={a.isActive ? 'ACTIVE' : 'INACTIVE'} />,
    },
    {
      key: 'login',
      header: 'Last sign-in',
      align: 'right',
      hideBelow: 'md',
      nowrap: true,
      render: (a) => (
        <span className="text-xs text-mute">
          {a.lastLoginAt ? formatDateTime(a.lastLoginAt) : 'Never'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => {
        // The whole list is needed to answer "is this the last active SUPER_ADMIN", and
        // `me` to answer "is this me" — the two changes the server refuses.
        const blockedReason = adminDeactivationBlockedReason(a, me, rows);
        return (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setEditing(a)}
            className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium"
          >
            Change role
          </button>
          {a.isActive ? (
            // Disabled rather than left to fail: the server refuses this exact change
            // (assertAdminAccessSurvives), and a 400 with no visible reason is worse than
            // a button that says why up front.
            <button
              type="button"
              disabled={blockedReason !== null}
              title={blockedReason ?? undefined}
              onClick={() => setDeactivating(a)}
              className="h-8 px-2.5 rounded-lg border border-danger/40 text-danger text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  id: a.id,
                  role: a.role,
                  isActive: true,
                  permissions: permissionKeys(a.permissions),
                })
              }
              className="h-8 px-2.5 rounded-lg border border-line bg-surface text-xs font-medium disabled:opacity-40"
            >
              Reactivate
            </button>
          )}
        </div>
        );
      },
    },
  ];

  const createFields: DialogField[] = [
    {
      name: 'telegramId',
      label: 'Telegram user id',
      required: true,
      mono: true,
      hint: 'Digits only. The user must already have opened the bot — an unregistered id comes back as a 404.',
    },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: ROLE_OPTIONS,
      initialValue: 'ADMIN',
      hint:
        'Anything other than SUPER_ADMIN grants no permissions on its own — tick them afterwards with Change role.',
    },
  ];

  const editFields: DialogField[] = [
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: ROLE_OPTIONS,
      initialValue: editing?.role ?? 'ADMIN',
    },
    {
      name: 'isActive',
      label: 'Active',
      type: 'select',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
      initialValue: editing ? String(editing.isActive) : 'true',
    },
    {
      name: 'permissions',
      label: 'Permissions',
      type: 'permissions',
      groups: PERMISSION_GROUPS,
      unwired: UNWIRED_PERMISSIONS,
      hint:
        'Checked keys are granted; this replaces the whole list. A role other than SUPER_ADMIN grants nothing on its own, so an account with nothing checked cannot open any screen.',
      initialValue:
        editing && editing.role !== 'SUPER_ADMIN'
          ? permissionKeys(editing.permissions).join(',')
          : '',
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Admin accounts"
        description="Who can open this panel. Visible to SUPER_ADMIN only — the API gates this router with requireRole('SUPER_ADMIN')."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={15} />}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
            <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setCreating(true)}>
              Grant access
            </Button>
          </div>
        }
      />

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(a) => a.id}
          emptyTitle="No admin accounts"
          emptyMessage="Nobody holds admin access yet."
        />
        {query.data ? (
          <TableFooter>
            <Pager
              page={query.data.page}
              limit={query.data.limit}
              total={query.data.total}
              hasMore={query.data.hasMore}
              busy={query.isFetching}
              onPage={setPage}
            />
          </TableFooter>
        ) : null}
      </QueryState>

      <Section className="mt-8" title="Available roles">
        <div className="bg-surface border border-line rounded-2xl p-4 space-y-2.5">
          {ADMIN_ROLES.map((r) => (
            <div key={r} className="flex flex-wrap items-center gap-2">
              <StatusBadge status={r} />
              <span className="text-sm">{ROLE_LABELS[r] ?? r}</span>
              <span className="text-xs text-mute">
                {r === 'SUPER_ADMIN'
                  ? 'Bypasses every permission check, and the only role that may manage admins.'
                  : 'Grants nothing on its own — requirePermission reads the permission list set in Change role.'}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <ConfirmDialog
        open={creating}
        title="Grant admin access"
        description="Upsert on the Telegram id: if the user already has an admin record this changes the role and reactivates it. A record granted here starts with an empty permission list, so a non-SUPER_ADMIN account cannot open a screen yet — open it with Change role and tick the permissions it should have."
        fields={createFields}
        confirmLabel="Grant access"
        pending={create.isPending}
        onCancel={() => setCreating(false)}
        onConfirm={(values) =>
          create.mutate({
            telegramId: (values.telegramId ?? '').trim(),
            role: values.role ?? 'ADMIN',
          })
        }
      />

      <ConfirmDialog
        open={editing !== null}
        title={`Change ${editing?.userName ?? ''}'s access`}
        description={[
          'The permission list is what a non-SUPER_ADMIN role actually grants — the role alone opens nothing.',
          // Demotion is the other way to lose access, and it is not visible as a button,
          // so the warning rides on the dialog that can cause it.
          editing ? adminAccessChangeBlockedReason(editing, me, rows) : null,
        ]
          .filter(Boolean)
          .join(' ')}
        fields={editFields}
        confirmLabel="Save"
        pending={update.isPending}
        onCancel={() => setEditing(null)}
        onConfirm={(values) => {
          if (!editing) return;
          update.mutate({
            id: editing.id,
            role: values.role ?? editing.role,
            isActive: values.isActive !== 'false',
            permissions: (values.permissions ?? '')
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean),
          });
        }}
      />

      <ConfirmDialog
        open={deactivating !== null}
        title={`Deactivate ${deactivating?.userName ?? ''}?`}
        description="The admin record is kept so audit entries still resolve to a real actor, but this account can no longer use the panel. Deleting never removes the row — reactivate from the list when needed."
        confirmLabel="Deactivate"
        danger
        pending={deactivate.isPending}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => {
          if (deactivating) deactivate.mutate(deactivating.id);
        }}
      />
    </>
  );
}
