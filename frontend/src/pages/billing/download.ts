import { api } from '../../lib/api';
import type { StatementResult } from './types';

/**
 * Statement downloads.
 *
 * A bare `<a href>` is NOT an option here: the API authenticates via the
 * `x-telegram-init-data` header that the axios instance injects on every
 * request (see lib/api.ts), which a plain link navigation cannot carry.
 * So both formats are fetched through `api.get` (same authenticated client)
 * and saved from a Blob + object URL:
 *
 *   - format=csv → the backend streams RAW RFC-4180 text (no JSON envelope).
 *     Axios's default transform leaves un-parseable strings as strings, so
 *     `api.get<string>` yields the CSV verbatim — we wrap it in a Blob.
 *   - format=json → the backend replies `{ ok: true, data: statement }`; the
 *     response interceptor unwraps it, so `api.get<StatementResult>` yields
 *     the statement object, which we serialize ourselves.
 *
 * The downloaded file contains exactly what the API sent — no field is
 * re-derived, recomputed or rounded in the UI.
 */

/** Mirrors the backend default when `from` is omitted: last 180 days. */
const DEFAULT_STATEMENT_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

/** Optional billing-period filter (`YYYY-MM-DD` values from date inputs). */
export interface StatementPeriod {
  from?: string;
  to?: string;
}

function buildParams(period: StatementPeriod, format: 'csv' | 'json') {
  return {
    format,
    role: 'advertiser',
    ...(period.from ? { from: period.from } : {}),
    ...(period.to ? { to: period.to } : {}),
  };
}

/**
 * The window the server will resolve when from/to are omitted
 * (`buildStatement`: to = now, from = to − 180d). Used only for the CSV
 * fallback filename, where the body is not available.
 */
function resolvedPeriod(period: StatementPeriod): { from: string; to: string } {
  const to = period.to ? new Date(period.to) : new Date();
  const from = period.from
    ? new Date(period.from)
    : new Date(to.getTime() - DEFAULT_STATEMENT_LOOKBACK_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** `YYYY-MM-DD` — same slice the backend uses in its filename. */
function stamp(iso: string): string {
  return iso.slice(0, 10);
}

/** Trigger a browser save of the given Blob (revoke happens after the click). */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download the statement as CSV — the exact RFC-4180 text the backend
 * streams, saved as `statement-advertiser-YYYY-MM-DD_YYYY-MM-DD.csv`
 * (the same naming scheme the server uses for its Content-Disposition).
 */
export async function downloadStatementCsv(period: StatementPeriod = {}): Promise<void> {
  const csv = await api.get<string>('/api/billing/statement', buildParams(period, 'csv'));
  const { from, to } = resolvedPeriod(period);
  saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `statement-advertiser-${stamp(from)}_${stamp(to)}.csv`);
}

/**
 * Download the statement as JSON — the `StatementResult` object exactly as
 * the API returns it (pretty-printed), saved as
 * `statement-advertiser-YYYY-MM-DD_YYYY-MM-DD.json` using the server's
 * resolved window.
 */
export async function downloadStatementJson(period: StatementPeriod = {}): Promise<void> {
  const statement = await api.get<StatementResult>('/api/billing/statement', buildParams(period, 'json'));
  const json = JSON.stringify(statement, null, 2);
  saveBlob(
    new Blob([json], { type: 'application/json;charset=utf-8' }),
    `statement-advertiser-${stamp(statement.from)}_${stamp(statement.to)}.json`,
  );
}
