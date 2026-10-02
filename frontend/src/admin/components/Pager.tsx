/**
 * Offset paging controls for the panel's paginated lists.
 *
 * The API returns `{ items, page, limit, total, hasMore }`; these controls read
 * the same numbers the backend used (`getPagination` clamps `limit` to
 * `PAGINATION.MAX_LIMIT`), so "showing X–Y of Z" is always honest rather than
 * computed from a page size the server may have adjusted.
 */
import { cn } from '../../lib/cn';
import { Icon } from '../../components/ui/icons';

export interface PagerProps {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  onPage: (page: number) => void;
  /** Disable while a fetch is in flight. */
  busy?: boolean;
}

export function Pager({ page, limit, total, hasMore, onPage, busy = false }: PagerProps) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const lastPage = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
      <span className="text-xs text-mute num">
        {total === 0 ? 'No results' : `Showing ${from}–${to} of ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1 || busy}
          onClick={() => onPage(page - 1)}
          className={cn(
            'h-8 px-3 rounded-lg border border-line bg-surface text-xs font-medium inline-flex items-center gap-1',
            'disabled:opacity-40 disabled:pointer-events-none',
          )}
        >
          <Icon name="back" size={14} />
          Prev
        </button>
        <span className="text-xs text-mute num">
          {page} / {lastPage}
        </span>
        <button
          type="button"
          disabled={!hasMore || busy}
          onClick={() => onPage(page + 1)}
          className={cn(
            'h-8 px-3 rounded-lg border border-line bg-surface text-xs font-medium inline-flex items-center gap-1',
            'disabled:opacity-40 disabled:pointer-events-none',
          )}
        >
          Next
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}
