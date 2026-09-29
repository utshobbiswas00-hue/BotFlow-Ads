import { cn } from '../../lib/cn';

export interface TabItem {
  value: string;
  label: string;
  /** Optional badge count. */
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Horizontally scrollable segmented tab bar (mobile friendly). */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div
      className={cn(
        'flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 py-1',
        className,
      )}
      role="tablist"
    >
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'shrink-0 h-9 px-3.5 rounded-full text-sm font-medium transition-colors',
              active ? 'bg-accent text-accentink' : 'bg-surface border border-line text-mute',
            )}
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span
                className={cn(
                  'ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full text-[11px]',
                  active ? 'bg-white/25' : 'bg-app text-mute',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
