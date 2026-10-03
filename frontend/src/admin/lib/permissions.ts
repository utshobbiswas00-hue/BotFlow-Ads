/**
 * Permission keys and the navigation map.
 *
 * `ADMIN_PERMISSIONS` is a verbatim mirror of the 22 keys declared in
 * `backend/src/middleware/adminAuth.ts`. It is a mirror and not a source of
 * truth: the API stays authoritative, and the acting admin's REAL keys come
 * from `GET /api/admin/session`. This list is only used to (a) label keys in
 * the UI and (b) render "grant this permission" hints.
 *
 * There is deliberately no role -> permission table here. Roles in this system
 * do not imply permissions: `requirePermission` reads the `AdminUser.permissions`
 * JSON array, and only SUPER_ADMIN bypasses it. A hardcoded role map would
 * therefore show a button for an action that 403s, which is exactly the failure
 * mode the panel is supposed to eliminate.
 */
import type { IconName } from '../../components/ui/icons';

export const ADMIN_PERMISSIONS = [
  'dashboard.view',
  'users.view',
  'users.manage',
  'users.balance.adjust',
  'campaigns.view',
  'campaigns.manage',
  'channels.view',
  'channels.manage',
  'deposits.view',
  'deposits.manage',
  'withdrawals.view',
  'withdrawals.manage',
  'delivery.view',
  'delivery.manage',
  'fraud.view',
  'fraud.manage',
  'tickets.view',
  'tickets.manage',
  'settings.manage',
  'admins.manage',
  'audit.view',
  'broadcast.send',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Why this admin account must not be deactivated from here, or null when it can be.
 *
 * Mirrors `assertAdminAccessSurvives` on the server, which stays the authority: this only
 * keeps the operator from pressing a button that is certain to be refused, and explains
 * why. The two refusals are the ones that actually lock people out —
 *
 *   your own account, because you cannot undo it from a panel you no longer reach, and
 *   the last active SUPER_ADMIN, because nobody would be left who can manage admins and
 *   the only way back is a database write.
 *
 * Judged on the resulting state, like the server does: an account that is already inactive
 * is not being deactivated again.
 */
export function adminDeactivationBlockedReason(
  target: { id: string; role: string; isActive: boolean },
  me: { id: string } | null,
  all: readonly { id: string; role: string; isActive: boolean }[],
): string | null {
  if (!target.isActive) return null;

  if (me && target.id === me.id) {
    return 'This is your own account. Deactivating it would remove your access, and another admin has to do it.';
  }

  if (target.role === 'SUPER_ADMIN') {
    const otherSupers = all.filter(
      (a) => a.id !== target.id && a.role === 'SUPER_ADMIN' && a.isActive,
    ).length;
    if (otherSupers === 0) {
      return 'This is the only active SUPER_ADMIN. Deactivating it would lock everyone out of the panel, and the only way back is a database write.';
    }
  }

  return null;
}

/**
 * The same question for the edit dialog, where access can be lost by demotion as well as
 * by deactivation.
 */
export function adminAccessChangeBlockedReason(
  target: { id: string; role: string; isActive: boolean },
  me: { id: string } | null,
  all: readonly { id: string; role: string; isActive: boolean }[],
): string | null {
  const self = me && target.id === me.id;
  const lastSuper =
    target.role === 'SUPER_ADMIN' &&
    target.isActive &&
    all.filter((a) => a.id !== target.id && a.role === 'SUPER_ADMIN' && a.isActive).length === 0;

  if (!self && !lastSuper) return null;

  const who = self ? 'your own account' : 'the only active SUPER_ADMIN';
  return `Careful: this is ${who}. Moving it off SUPER_ADMIN, or marking it inactive, would remove access the panel cannot restore by itself — the server refuses that change.`;
}

export const ADMIN_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MODERATOR',
  'FINANCE_MANAGER',
  'SUPPORT_AGENT',
  'ANALYST',
] as const;

export type AdminRoleName = (typeof ADMIN_ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  MODERATOR: 'Moderator',
  FINANCE_MANAGER: 'Finance manager',
  SUPPORT_AGENT: 'Support agent',
  ANALYST: 'Analyst',
};

/** Permission keys grouped the way they are granted in practice. */
export const PERMISSION_GROUPS: { label: string; keys: AdminPermission[] }[] = [
  { label: 'Dashboard', keys: ['dashboard.view'] },
  { label: 'Users', keys: ['users.view', 'users.manage', 'users.balance.adjust'] },
  { label: 'Campaigns', keys: ['campaigns.view', 'campaigns.manage'] },
  { label: 'Channels', keys: ['channels.view', 'channels.manage'] },
  { label: 'Deposits', keys: ['deposits.view', 'deposits.manage'] },
  { label: 'Withdrawals', keys: ['withdrawals.view', 'withdrawals.manage'] },
  { label: 'Delivery', keys: ['delivery.view', 'delivery.manage'] },
  { label: 'Fraud & moderation', keys: ['fraud.view', 'fraud.manage'] },
  { label: 'Support', keys: ['tickets.view', 'tickets.manage'] },
  {
    label: 'Configuration',
    keys: ['settings.manage', 'admins.manage', 'audit.view', 'broadcast.send'],
  },
];

/**
 * `broadcast.send` is declared in `ADMIN_PERMISSIONS` but no route in the admin
 * router uses it — the only broadcast machinery is the
 * `broadcast-admin-alert` queue job, which is producer-side and has no HTTP
 * entry point. It is listed here so the key is not a mystery, but it is not
 * wired to a screen because there is nothing to call.
 */
export const UNWIRED_PERMISSIONS: AdminPermission[] = ['broadcast.send'];

export interface AdminNavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Exact match only (root-style entries with sub-routes). */
  end?: boolean;
  permissions?: AdminPermission[];
  superAdminOnly?: boolean;
  /**
   * Indented sub-entries (spec §8: `Users → All / Publishers / Advertisers /
   * Suspended / Banned`).
   *
   * Every child MUST be a URL the panel can actually serve with that filter
   * applied — a sub-item that lands on an unfiltered list is worse than no
   * sub-item, because it claims a view that does not exist. Each child below
   * therefore points at a filter the backend really accepts (verified against
   * `routes/admin/users.routes.ts`, `campaign.routes.ts` and `channel.routes.ts`).
   */
  children?: { to: string; label: string }[];
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/admin', label: 'Overview', icon: 'grid', end: true, permissions: ['dashboard.view'] },
    ],
  },
  {
    label: 'Ads',
    items: [
      {
        to: '/admin/campaigns',
        label: 'Campaigns',
        icon: 'megaphone',
        permissions: ['campaigns.view'],
        children: [
          { to: '/admin/campaigns', label: 'All campaigns' },
          { to: '/admin/campaigns?status=PENDING_REVIEW', label: 'Pending review' },
          { to: '/admin/campaigns?status=RUNNING', label: 'Running' },
          { to: '/admin/campaigns?status=SCHEDULED', label: 'Scheduled' },
          { to: '/admin/campaigns?status=COMPLETED', label: 'Completed' },
          { to: '/admin/campaigns?status=REJECTED', label: 'Rejected' },
        ],
      },
      {
        to: '/admin/channels',
        label: 'Channels',
        icon: 'channel',
        permissions: ['channels.view'],
        children: [
          { to: '/admin/channels', label: 'All channels' },
          { to: '/admin/channels?status=PENDING', label: 'Pending' },
          { to: '/admin/channels?status=APPROVED', label: 'Approved' },
          { to: '/admin/channels?status=ATTENTION_REQUIRED', label: 'Needs attention' },
          { to: '/admin/channels?status=SUSPENDED', label: 'Suspended' },
        ],
      },
      { to: '/admin/delivery', label: 'Delivery', icon: 'send', permissions: ['delivery.view'] },
    ],
  },
  {
    label: 'People',
    items: [
      {
        to: '/admin/users',
        label: 'Users',
        icon: 'user',
        permissions: ['users.view'],
        // Spec §8. Each child is a filter the API really accepts (`status` and the
        // relationship-derived `isPublisher` / `isAdvertiser`), so none of these
        // lands on an unfiltered list while claiming to be a filtered view.
        children: [
          { to: '/admin/users', label: 'All users' },
          { to: '/admin/publishers', label: 'Publishers' },
          { to: '/admin/advertisers', label: 'Advertisers' },
          { to: '/admin/users?status=SUSPENDED', label: 'Suspended' },
          { to: '/admin/users?status=BANNED', label: 'Banned' },
        ],
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      {
        to: '/admin/finance/deposits',
        label: 'Deposits',
        icon: 'arrowDown',
        permissions: ['deposits.view'],
        // Spec 30. Every child is a status the API really accepts.
        children: [
          { to: '/admin/finance/deposits', label: 'All deposits' },
          { to: '/admin/finance/deposits?status=PENDING', label: 'Pending' },
          { to: '/admin/finance/deposits?status=VERIFIED', label: 'Verified' },
          { to: '/admin/finance/deposits?status=REJECTED', label: 'Rejected' },
        ],
      },
      {
        to: '/admin/finance/withdrawals',
        label: 'Withdrawals',
        children: [
          { to: '/admin/finance/withdrawals', label: 'All withdrawals' },
          { to: '/admin/finance/withdrawals?status=PENDING', label: 'Pending' },
          { to: '/admin/finance/withdrawals?status=APPROVED', label: 'Approved' },
          { to: '/admin/finance/withdrawals?status=PAID', label: 'Paid' },
          { to: '/admin/finance/withdrawals?status=REJECTED', label: 'Rejected' },
        ],
        icon: 'arrowUp',
        permissions: ['withdrawals.view'],
      },
      {
        to: '/admin/finance/ledger',
        label: 'Ledger',
        icon: 'doc',
        permissions: ['deposits.view', 'withdrawals.view'],
      },
      {
        to: '/admin/finance/refunds',
        label: 'Refunds',
        icon: 'arrowUp',
        // A refund credits a balance, so it is money-in and sits with deposits.
        permissions: ['deposits.manage'],
      },
      {
        to: '/admin/crypto-addresses',
        label: 'Deposit addresses',
        icon: 'wallet',
        permissions: ['settings.manage'],
      },
      { to: '/admin/crypto-transfers', label: 'Crypto queue', icon: 'coin', permissions: ['deposits.manage'] },
    ],
  },
  {
    label: 'Trust & safety',
    items: [
      { to: '/admin/moderation', label: 'Moderation', icon: 'shield', permissions: ['fraud.view'] },
      {
        to: '/admin/blocked/channels',
        label: 'Blocked channels',
        icon: 'shield',
        permissions: ['fraud.manage'],
      },
      {
        to: '/admin/blocked/ads',
        label: 'Blocked ad posts',
        icon: 'x',
        permissions: ['fraud.manage'],
      },
      { to: '/admin/support', label: 'Support', icon: 'info', permissions: ['tickets.view'] },
    ],
  },
  {
    /*
     * The `/api/admin/ops` surface. It is a separate router from
     * `routes/admin/` — it lives in `routes/policy.routes.ts` — so it has its own
     * nav group rather than being folded into the screens above.
     */
    label: 'Operations',
    items: [
      { to: '/admin/ops', label: 'Ops dashboard', icon: 'target', permissions: ['dashboard.view'] },
      {
        to: '/admin/activity',
        label: 'Activity',
        icon: 'clock',
        permissions: ['dashboard.view'],
      },
      {
        to: '/admin/attention',
        label: 'Needs attention',
        icon: 'bell',
        permissions: ['dashboard.view'],
      },
      {
        to: '/admin/ops/creative',
        label: 'Creative review',
        icon: 'eye',
        permissions: ['campaigns.manage'],
      },
      {
        to: '/admin/settings',
        label: 'Settings',
        icon: 'settings',
        permissions: ['settings.manage'],
      },
      {
        to: '/admin/broadcast',
        label: 'Broadcast',
        icon: 'send',
        // The route that finally uses the long-declared `broadcast.send` key.
        permissions: ['broadcast.send'],
        children: [
          { to: '/admin/broadcast', label: 'Compose' },
          { to: '/admin/broadcast/report', label: 'Delivery report' },
        ],
      },
      {
        to: '/admin/notifications',
        label: 'Notifications',
        icon: 'bell',
        // The admin's own inbox — the same table as the user inbox, keyed on the
        // acting admin's user id.
        permissions: ['dashboard.view'],
      },
      {
        to: '/admin/ops/blocked-domains',
        label: 'Blocked domains',
        icon: 'shield',
        permissions: ['settings.manage'],
      },
      {
        to: '/admin/ops/category-policies',
        label: 'Category policies',
        icon: 'grid',
        permissions: ['settings.manage'],
      },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/admin/analytics', label: 'Revenue', icon: 'chart', permissions: ['dashboard.view'] },
      {
        to: '/admin/analytics/breakdown',
        label: 'Breakdowns',
        icon: 'chart',
        permissions: ['dashboard.view'],
      },
      {
        to: '/admin/system',
        label: 'System',
        icon: 'target',
        permissions: ['dashboard.view'],
        children: [
          { to: '/admin/system', label: 'Status board' },
          { to: '/admin/system/errors', label: 'Error log' },
          { to: '/admin/system/api-logs', label: 'API logs' },
        ],
      },
      { to: '/admin/plans', label: 'Premium plans', icon: 'star', permissions: ['settings.manage'] },
      { to: '/admin/settings', label: 'Settings', icon: 'settings', permissions: ['settings.manage'] },
      { to: '/admin/audit-logs', label: 'Audit log', icon: 'clock', permissions: ['audit.view'] },
      { to: '/admin/export', label: 'Export', icon: 'arrowDown', permissions: ['audit.view'] },
      { to: '/admin/admins', label: 'Admin accounts', icon: 'shield', superAdminOnly: true },
    ],
  },
];

/**
 * Roles allowed to trigger the two settlement sweeps.
 *
 * `/admin/ops/cpc/settle` and `/admin/ops/referrals/settle` are gated with
 * `requireRole('ADMIN','SUPER_ADMIN','FINANCE_MANAGER')` — NOT with a permission
 * key. So a MODERATOR holding every key in `ADMIN_PERMISSIONS` still cannot call
 * them, and the UI has to check the role as well as the permission.
 */
export const SETTLEMENT_ROLES: readonly string[] = ['ADMIN', 'SUPER_ADMIN', 'FINANCE_MANAGER'];

/**
 * The nav item a path belongs to, longest prefix first — used to highlight the
 * sidebar entry on detail routes such as `/admin/users/:id`.
 */
/**
 * The nav group a path belongs to, for the breadcrumb.
 *
 * A separate lookup rather than returning a tuple from `activeNavItem`, so the
 * existing call sites that only want the item are untouched.
 */
export function activeNavGroup(pathname: string): string | null {
  const item = activeNavItem(pathname);
  if (!item) return null;
  for (const group of ADMIN_NAV) {
    if (group.items.includes(item)) return group.label;
  }
  return null;
}

export function activeNavItem(pathname: string): AdminNavItem | null {
  const all = ADMIN_NAV.flatMap((g) => g.items);
  const exact = all.find((i) => i.end && i.to === pathname);
  if (exact) return exact;
  const matches = all
    .filter((i) => !i.end && (pathname === i.to || pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length);
  return matches[0] ?? null;
}
