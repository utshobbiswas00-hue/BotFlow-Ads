/**
 * Top-bar utilities: the cross-entity search box and the attention bell.
 *
 * Both live here rather than in `AdminShell` so the shell stays about layout and
 * authorisation, and these two can be reasoned about (and tested) on their own.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cn } from '../../lib/cn';
import { qk } from '../../lib/queryClient';
import { humanize } from '../../lib/format';
import { useDebounce } from '../../hooks/useDebounce';
import { Icon } from '../../components/ui/icons';
import { getAttentionFeed, getGlobalSearch } from '../lib/api';
import { useAdminSession } from '../lib/session';
import type { AttentionItem } from '../lib/types';

/* ------------------------------------------------------------------
 *  Attention bell
 * ------------------------------------------------------------------ */

/** Severities that should colour the bell and count toward its badge. */
const URGENT: AttentionItem['severity'][] = ['CRITICAL', 'HIGH'];

export function AttentionBell() {
  const { can } = useAdminSession();
  const allowed = can('dashboard.view');

  const query = useQuery({
    queryKey: qk.adminAttention,
    queryFn: getAttentionFeed,
    enabled: allowed,
    // Counts, not an inbox: they change as work arrives, and a stale badge is
    // worse than a slightly more frequent query.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!allowed) return null;

  const urgent = (query.data?.items ?? []).filter((i) => URGENT.includes(i.severity));
  const urgentCount = urgent.reduce((sum, i) => sum + i.count, 0);

  return (
    <Link
      to="/admin/attention"
      title={
        urgentCount > 0
          ? `${urgentCount} urgent item(s) need attention`
          : 'Nothing urgent — open the attention feed'
      }
      className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg border border-line bg-surface hover:bg-app"
    >
      <Icon name="bell" size={17} />
      {urgentCount > 0 ? (
        <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center num">
          {urgentCount > 99 ? '99+' : urgentCount}
        </span>
      ) : null}
      {/* A count is not a notification: say so, so nobody expects a read state. */}
      <span className="sr-only">
        Urgent items: {urgentCount}. This is a live count, not a message inbox.
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------
 *  Global search
 * ------------------------------------------------------------------ */

const TYPE_LABEL: Record<string, string> = {
  USER: 'User',
  CHANNEL: 'Channel',
  CAMPAIGN: 'Campaign',
  TRANSACTION: 'Transaction',
  TICKET: 'Ticket',
};

export function GlobalSearch() {
  const { can } = useAdminSession();
  const allowed = can('dashboard.view');
  const navigate = useNavigate();

  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const debounced = useDebounce(term, 300);

  // The server rejects queries shorter than 2 characters, so do not spend a
  // request discovering that.
  const query = useQuery({
    queryKey: ['admin', 'search', debounced.trim()],
    queryFn: () => getGlobalSearch(debounced.trim()),
    enabled: allowed && debounced.trim().length >= 2,
    staleTime: 30_000,
  });

  // Close on an outside click — a dropdown that survives a click elsewhere is how
  // a stale result list covers the page it navigated to.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!allowed) return null;

  const results = query.data?.results ?? [];
  const tooShort = term.trim().length > 0 && debounced.trim().length < 2;

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim().length >= 2) setOpen(true);
        }}
      >
        <div className="flex items-center gap-2 h-9 px-2.5 rounded-lg border border-line bg-surface w-56 lg:w-72">
          <Icon name="search" size={15} className="text-mute shrink-0" />
          <input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Search users, channels, campaigns…"
            aria-label="Global search"
            className="flex-1 bg-transparent outline-none text-sm min-w-0"
          />
          {term ? (
            <button
              type="button"
              onClick={() => {
                setTerm('');
                setOpen(false);
              }}
              aria-label="Clear search"
              className="text-mute hover:text-ink shrink-0"
            >
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </div>
      </form>

      {open && term.trim().length > 0 ? (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-surface border border-line rounded-xl shadow-lg z-50">
          {tooShort ? (
            <p className="px-3 py-3 text-xs text-mute">Type at least 2 characters.</p>
          ) : query.isPending ? (
            <p className="px-3 py-3 text-xs text-mute">Searching…</p>
          ) : query.isError ? (
            <p className="px-3 py-3 text-xs text-danger">Search failed. Try again.</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-3 text-xs text-mute">Nothing matches “{debounced.trim()}”.</p>
          ) : (
            <ul className="divide-y divide-line/60">
              {results.map((hit) => (
                <li key={`${hit.type}-${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setTerm('');
                      navigate(hit.href);
                    }}
                    className="w-full text-left px-3 py-2.5 hover:bg-app"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-mute font-semibold shrink-0">
                        {TYPE_LABEL[hit.type] ?? humanize(hit.type)}
                      </span>
                      <span className="text-sm font-medium truncate">{hit.label}</span>
                    </div>
                    {hit.sublabel ? (
                      <p className="num text-[11px] text-mute truncate">{hit.sublabel}</p>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------
 *  Breadcrumb
 * ------------------------------------------------------------------ */

export function Breadcrumb({ group, label }: { group: string | null; label: string | null }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn('flex items-center gap-1.5 text-[11px] text-mute min-w-0')}
    >
      <Link to="/admin" className="hover:text-ink shrink-0">
        Admin
      </Link>
      {group ? (
        <>
          <Icon name="chevronRight" size={11} className="shrink-0" />
          <span className="shrink-0">{group}</span>
        </>
      ) : null}
      {label ? (
        <>
          <Icon name="chevronRight" size={11} className="shrink-0" />
          <span className="text-ink font-medium truncate">{label}</span>
        </>
      ) : null}
    </nav>
  );
}
