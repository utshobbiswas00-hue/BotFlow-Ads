import { NavLink } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { hapticTap } from '../../lib/telegram';
import { Icon, type IconName } from '../ui/icons';

interface Tab {
  to: string;
  label: string;
  icon: IconName;
  /** Match only the exact tab root (not child routes) — set for tabs with sub-pages. */
  end?: boolean;
}

const TABS: Tab[] = [
  { to: '/', label: 'Dashboard', icon: 'home', end: true },
  { to: '/advertise', label: 'Advertise', icon: 'megaphone' },
  { to: '/earn', label: 'Earn', icon: 'coin' },
  { to: '/channels', label: 'Channel', icon: 'channel' },
  { to: '/wallet', label: 'Wallet', icon: 'wallet' },
];

/** 5-tab bottom navigation for the Telegram mini app. Fixed to the viewport
 *  bottom — it must never scroll with the page content (see AppShell, which
 *  has no scroll container of its own, so the whole page scrolls as one). */
export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 bg-surface/95 backdrop-blur border-t border-line pb-[env(safe-area-inset-bottom)]">
      <div className="flex max-w-app mx-auto">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            onClick={() => hapticTap()}
            className={({ isActive }) =>
              cn(
                'flex-1 flex flex-col items-center gap-0.5 py-2 pt-2.5 text-[10px] font-medium transition-colors',
                isActive ? 'text-accent' : 'text-mute',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'p-1 rounded-xl transition-colors',
                    isActive ? 'bg-accent/10' : 'bg-transparent',
                  )}
                >
                  <Icon name={t.icon} size={21} />
                </span>
                {t.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
