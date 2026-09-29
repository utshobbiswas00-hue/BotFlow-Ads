import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { backButtonHide, backButtonShow } from '../../lib/telegram';
import { cn } from '../../lib/cn';
import { Icon } from '../ui/icons';
import { LogoMark } from '../ui/Logo';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** When false, no back button (top-level pages). */
  back?: boolean;
  actions?: ReactNode;
}

/**
 * Sticky page header with optional back button. When running inside Telegram,
 * the native BackButton is wired to navigate() automatically.
 */
export function PageHeader({ title, subtitle, back = false, actions }: PageHeaderProps) {
  const navigate = useNavigate();

  useEffect(() => {
    if (back) {
      backButtonShow(() => {
        if (window.history.length > 2) navigate(-1);
        else navigate('/');
      });
      return () => backButtonHide();
    }
    backButtonHide();
    return undefined;
  }, [back, navigate]);

  return (
    <header className="sticky top-0 z-30 bg-app/90 backdrop-blur border-b border-line">
      <div className="max-w-app mx-auto flex items-center gap-2 px-4 h-14">
        {back && (
          <button
            onClick={() => (window.history.length > 2 ? navigate(-1) : navigate('/'))}
            className="p-2 -ml-2 text-ink rounded-full active:bg-surface"
            aria-label="Back"
          >
            <Icon name="back" size={22} />
          </button>
        )}
        {/* Top-level pages carry the brand mark; sub-pages show a back button
            instead, so the header never gets crowded. */}
        {!back && <LogoMark size={22} />}
        <div className="flex-1 min-w-0">
          <h1 className="text-[17px] font-bold leading-tight truncate">{title}</h1>
          {subtitle && <p className="text-xs text-mute truncate">{subtitle}</p>}
        </div>
        {actions && <div className={cn('flex items-center gap-2')}>{actions}</div>}
      </div>
    </header>
  );
}
