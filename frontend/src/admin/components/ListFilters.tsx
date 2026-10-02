/**
 * Shared date-range + sort control for the panel's big tables (spec §79).
 *
 * One row, not two bars: the page's own status / search control is rendered
 * through the `children` slot, so a table has a single coherent filter row.
 *
 * ── Date boundaries (the part that is easy to get wrong) ──────────────────
 * The API treats `from` as INCLUSIVE and `to` as EXCLUSIVE, and a bare
 * `YYYY-MM-DD` is parsed as midnight UTC. So if the operator picks `to = 5 Oct`
 * and we forwarded the bare date, the range would stop at 00:00 on 5 Oct and
 * silently drop the whole of 5 Oct. We therefore keep the operator's calendar
 * days in the URL (what the pickers show) and, at the call site, send the
 * EXCLUSIVE upper bound shifted one day forward (`to = 5 Oct` → `2026-10-06`),
 * so the selected end day is fully included. `from` is forwarded unchanged
 * (midnight UTC, inclusive). See `dateRangeParams` below.
 *
 * ── Why `type="date"` and not `datetime-local` ────────────────────────────
 * Admin triage works at day granularity and `<input type="date">` yields an
 * unambiguous calendar day that we then pin to explicit UTC boundaries. A
 * `datetime-local` value carries no timezone, so "midnight" would depend on the
 * operator's machine — different admins would get different windows for the
 * same URL.
 *
 * ── Validation is fast feedback, not the boundary ─────────────────────────
 * The server independently rejects `from > to` with a 400 (see
 * `assertDateRange` in the admin routes). We guard on the client only so the
 * operator sees the mistake inline instead of as a failed request; the client
 * is not, and must not be, the enforcement point.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { SORT_KEYS, sortKeyLabel, type SortableList } from '../lib/types';

export interface ListFiltersValue {
  /** Calendar day from `<input type="date">`, `YYYY-MM-DD`, or ''. */
  from: string;
  /** Calendar day from `<input type="date">`, `YYYY-MM-DD`, or ''. */
  to: string;
  /** A key from `SORT_KEYS[sortable]`, or '' for the list's default order. */
  sort: string;
}

export interface ListFiltersProps {
  /** Which `SORT_KEYS` set to offer, e.g. 'users'. */
  sortable: SortableList;
  value: ListFiltersValue;
  onChange: (next: ListFiltersValue) => void;
  /** Extra controls (a status `<Select>` etc.) rendered inline. */
  children?: ReactNode;
  /** True while a fetch is in flight. */
  busy?: boolean;
  /**
   * Clears ONLY the three params this control owns (from / to / sort). The
   * page's own status / search filter is left untouched — that control has its
   * own reset, and one "Clear" wiping a filter the user did not touch here
   * would be surprising.
   */
  onReset: () => void;
}

/** Parse a `YYYY-MM-DD` day to a UTC midnight timestamp, or null when empty. */
function parseDay(day: string): number | null {
  if (!day) return null;
  const t = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(t) ? null : t;
}

/** `2026-10-05` → `2026-10-06`, in UTC (day arithmetic, no timezone drift). */
function addOneUtcDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Map the pickers' calendar days to the API's half-open window.
 *
 * The API's `to` is exclusive and a bare date is midnight UTC, so we push the
 * exclusive bound one day past the operator's `to` — "1 Oct → 5 Oct" then
 * means `[1 Oct 00:00Z, 6 Oct 00:00Z)`, i.e. every instant on 1–5 Oct
 * inclusive. Pages must build their list call with this, not with the raw days.
 */
export function dateRangeParams(from: string, to: string): { from?: string; to?: string } {
  return {
    from: from || undefined,
    to: to ? addOneUtcDay(to) : undefined,
  };
}

export function ListFilters({ sortable, value, onChange, children, busy, onReset }: ListFiltersProps) {
  // Local draft so an invalid pair can be shown and corrected without ever
  // reaching the URL (the source of truth) or firing a request.
  const [draft, setDraft] = useState<ListFiltersValue>(value);

  // Re-sync when the URL changes underneath us (back/forward, a shared link, a
  // page's own reset). Keyed on the primitives so a new-but-equal object from
  // the parent does not clobber what the operator is editing.
  useEffect(() => {
    setDraft(value);
  }, [value.from, value.to, value.sort]);

  const fromTime = parseDay(draft.from);
  const toTime = parseDay(draft.to);
  const invalidRange = fromTime !== null && toTime !== null && fromTime > toTime;

  const update = (next: Partial<ListFiltersValue>): void => {
    const merged: ListFiltersValue = { ...draft, ...next };
    setDraft(merged);

    const nf = parseDay(merged.from);
    const nt = parseDay(merged.to);
    // A backwards window never commits. The API would 400 it anyway; we hold it
    // back here so the operator gets the explanation next to the fields.
    if (nf !== null && nt !== null && nf > nt) return;

    onChange(merged);
  };

  const dirty = Boolean(draft.from || draft.to || draft.sort);

  const sortOptions = SORT_KEYS[sortable].map((key) => ({
    value: key as string,
    label: sortKeyLabel(key),
  }));

  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <Input
        label="From"
        type="date"
        className="max-w-44"
        value={draft.from}
        onChange={(e) => update({ from: e.target.value })}
      />
      <Input
        label="To"
        type="date"
        className="max-w-44"
        value={draft.to}
        error={invalidRange ? 'Invalid range: “From” must be on or before “To”.' : undefined}
        onChange={(e) => update({ to: e.target.value })}
      />

      {children}

      <Select
        label="Sort"
        className="max-w-56"
        placeholder="Default order"
        value={draft.sort}
        onChange={(e) => update({ sort: e.target.value })}
        options={sortOptions}
      />

      {busy ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-mute mb-2.5" aria-live="polite">
          <Spinner size={14} />
          Updating…
        </span>
      ) : null}

      <Button variant="ghost" size="sm" disabled={!dirty || Boolean(busy)} onClick={onReset}>
        Clear
      </Button>
    </div>
  );
}
