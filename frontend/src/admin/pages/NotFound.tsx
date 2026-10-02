/**
 * Unknown admin route.
 *
 * Reached only inside `/admin/*`. The sidebar and a link back to the panel root
 * are both offered, because a mistyped URL is usually one the operator got from
 * somewhere else.
 */
import { Link } from 'react-router-dom';
import { Icon } from '../../components/ui/icons';
import { ADMIN_NAV } from '../lib/permissions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader } from '../components/Kpi';

export function AdminNotFoundPage() {
  const { canAny, isSuperAdmin } = useAdminSession();

  const reachable = ADMIN_NAV.flatMap((g) => g.items).filter((i) =>
    i.superAdminOnly ? isSuperAdmin : !i.permissions || canAny(i.permissions),
  );

  return (
    <>
      <AdminPageHeader
        title="Not found"
        description="This admin route does not exist. It may have been renamed, or the link came from an older build."
      />
      <div className="bg-surface border border-line rounded-2xl p-6">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-app border border-line flex items-center justify-center shrink-0">
            <Icon name="info" size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Screens you can open</p>
            <ul className="mt-2 space-y-1">
              {reachable.map((item) => (
                <li key={item.to}>
                  <Link to={item.to} className="text-sm text-link hover:underline">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              to="/admin"
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-link hover:underline"
            >
              <Icon name="back" size={13} />
              Back to the overview
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
