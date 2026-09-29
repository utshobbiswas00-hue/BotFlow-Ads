import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  className?: string;
  onClick?: () => void;
}

/** Small KPI tile used on dashboards. */
export function StatCard({ label, value, sub, icon, className, onClick }: StatCardProps) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'bg-surface border border-line rounded-2xl p-3.5 text-left w-full',
        onClick && 'active:opacity-80 transition-opacity',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium text-mute truncate">{label}</span>
        {icon && <span className="text-mute shrink-0">{icon}</span>}
      </div>
      <div className="text-lg font-bold leading-tight truncate">{value}</div>
      {sub && <div className="text-xs text-mute mt-0.5 truncate">{sub}</div>}
    </Comp>
  );
}
