/**
 * Generic admin table.
 *
 * A plain `<table>` inside a horizontally scrollable frame, deliberately: the
 * panel is opened both in a desktop browser and inside the Telegram WebView,
 * and a table that scrolls sideways degrades far more predictably at 380px than
 * a card-per-row list does at 1440px. Columns can drop out below a breakpoint
 * via `hideBelow`, so the important ones always survive on a phone.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { LoadingBlock } from './StateBlock';
import { EmptyState } from '../../components/ui/EmptyState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Fixed width utility, e.g. 'w-40'. */
  width?: string;
  /** Hide the column below this breakpoint. */
  hideBelow?: 'sm' | 'md' | 'lg';
  /** Keep the cell on one line. */
  nowrap?: boolean;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  /** Extra classes for the scroll frame. */
  className?: string;
}

const HIDE_BELOW: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  loading = false,
  emptyTitle = 'No rows',
  emptyMessage,
  className,
}: DataTableProps<T>) {
  if (loading) return <LoadingBlock />;

  return (
    <div className={cn('bg-surface border border-line rounded-2xl overflow-hidden', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-app/60 border-b border-line">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'px-3 py-2.5 text-left font-semibold text-[11px] uppercase tracking-wide text-mute whitespace-nowrap',
                    c.align === 'right' && 'text-right',
                    c.width,
                    c.hideBelow && HIDE_BELOW[c.hideBelow],
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <div className="py-6">
                    <EmptyState title={emptyTitle} message={emptyMessage} />
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-line/60 last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-app/60',
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-2.5 align-middle',
                        c.align === 'right' && 'text-right',
                        c.nowrap && 'whitespace-nowrap',
                        c.hideBelow && HIDE_BELOW[c.hideBelow],
                      )}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A subtle monospace cell for ids, hashes and references. */
export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="num text-xs text-mute" title={title}>
      {children}
    </span>
  );
}

/** Primary + secondary line inside one cell (e.g. name over @handle). */
export function TwoLine({
  primary,
  secondary,
  className,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="font-medium truncate">{primary}</div>
      {secondary ? <div className="text-xs text-mute truncate">{secondary}</div> : null}
    </div>
  );
}

/** Table footer used for "showing N of M" + paging controls. */
export function TableFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-3 text-xs text-mute">
      {children}
    </div>
  );
}
