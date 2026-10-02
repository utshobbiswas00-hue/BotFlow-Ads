import type { Response } from 'express';

/**
 * CSV primitives shared by every admin export.
 *
 * Two things make a "works on my machine" CSV export dangerous, and both are
 * handled here rather than at each call site:
 *
 *  1. Spreadsheet formula injection. Excel/Google Sheets execute a cell whose
 *     first character is `=`, `+`, `-`, `@`, TAB or CR, even when the cell is
 *     quoted — so an attacker-controlled username like `=HYPERLINK(...)` runs
 *     when an admin opens the file. `safeCell()` neutralises that.
 *  2. RFC 4180 quoting. A value containing a comma, a quote or a line break
 *     must be wrapped in double quotes with inner quotes doubled, or the row
 *     count and column alignment silently break.
 */

/** RFC 4180 record separator. */
export const CSV_RECORD_SEPARATOR = '\r\n';

/**
 * Hard ceiling on data rows in a single export. Anything beyond this is not
 * emitted and the file ends with an explicit truncation notice — an export
 * must never silently drop rows, because the admin has no way to know.
 */
export const EXPORT_MAX_ROWS = 50_000;

/** Rows pulled from the database per iteration of the streaming loop. */
export const EXPORT_BATCH_SIZE = 1_000;

/**
 * UTF-8 byte order mark, prepended to every download.
 *
 * Justification: these exports are opened in Excel, which without a BOM
 * decodes a `.csv` using the machine's ANSI codepage. Admin data here is
 * routinely non-ASCII (Bangla/Arabic/Cyrillic display names, emoji in channel
 * titles), and the mismatch turns it into mojibake. The BOM is the only signal
 * that makes Excel read the file as UTF-8; every other parser ignores the
 * leading `\uFEFF`, so the cost is a single harmless byte.
 */
export const CSV_UTF8_BOM = '\uFEFF';

/**
 * Convert an arbitrary Prisma/service value to its raw text form.
 *
 * Prisma `BigInt` columns (telegramId, telegramChannelId, blockNumber, …)
 * cannot be used in a template literal — `String(1n)` works but `+`/`${}`
 * coercion of a bigint throws — so they are stringified explicitly. Dates
 * become ISO-8601 strings (never locale-dependent `toString()`).
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // Nested JSON (e.g. metadata) still serialises deterministically; the
    // replacer keeps a bigint buried inside from throwing.
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
  }
  return String(value);
}

/**
 * Neutralise a spreadsheet formula-injection attempt by prefixing a single
 * quote. This is applied to EVERY cell, before RFC 4180 quoting, so a cell
 * such as `=cmd|' /C calc'!A0` is exported as `'=cmd|' /C calc'!A0` and Excel
 * shows it as text instead of executing it.
 */
export function safeCell(value: unknown): string {
  const text = cellToString(value);
  if (text.length === 0) return text;
  const first = text[0];
  if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
    return `'${text}`;
  }
  return text;
}

/**
 * RFC 4180 field escaping: wrap in double quotes when the value contains a
 * comma, a double quote, CR or LF; double every embedded quote.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One cell, fully safe and escaped: injection-neutralised then RFC 4180 quoted. */
export function csvCell(value: unknown): string {
  return escapeCsvField(safeCell(value));
}

/** One CSV record (no trailing separator). */
export function csvRow(values: readonly unknown[]): string {
  return values.map((value) => csvCell(value)).join(',');
}

/** A column: its CSV header and how to pull the cell out of a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export interface CsvBatchRequest {
  skip: number;
  take: number;
}

export type CsvBatchFetcher<T> = (args: CsvBatchRequest) => Promise<T[]>;

export interface StreamCsvResult {
  /** Data rows written (excludes the header and any truncation notice). */
  rows: number;
  /** True when the source held more rows than {@link EXPORT_MAX_ROWS}. */
  truncated: boolean;
}

/**
 * Stream a CSV to an Express response.
 *
 * Rows are pulled in bounded batches ({@link EXPORT_BATCH_SIZE}) and written as
 * they arrive, so a large table never has to fit in memory. The loop stops at
 * {@link EXPORT_MAX_ROWS}; when there is at least one more row beyond the cap a
 * final notice line is appended so the truncation is visible, never silent.
 *
 * Callers are responsible for setting `Content-Type`/`Content-Disposition`
 * (the filename depends on the entity) before calling this; this function only
 * writes the body, starting with the UTF-8 BOM.
 */
export async function streamCsv<T>(
  res: Response,
  columns: readonly CsvColumn<T>[],
  fetchBatch: CsvBatchFetcher<T>,
): Promise<StreamCsvResult> {
  res.write(CSV_UTF8_BOM);
  res.write(csvRow(columns.map((column) => column.header)) + CSV_RECORD_SEPARATOR);

  let written = 0;
  let truncated = false;

  for (;;) {
    const remaining = EXPORT_MAX_ROWS - written;
    if (remaining <= 0) {
      // Already at the cap: a single probe row tells us whether the export
      // was actually truncated.
      truncated = (await fetchBatch({ skip: written, take: 1 })).length > 0;
      break;
    }

    const take = Math.min(EXPORT_BATCH_SIZE, remaining);
    const batch = await fetchBatch({ skip: written, take });
    if (batch.length === 0) break;

    for (const row of batch) {
      res.write(csvRow(columns.map((column) => column.value(row))) + CSV_RECORD_SEPARATOR);
    }
    written += batch.length;

    if (batch.length < take) break; // source exhausted
    if (written < EXPORT_MAX_ROWS) continue;

    // Hit the cap exactly — probe once so "complete" and "truncated" are
    // distinguishable rather than both looking like an empty next batch.
    truncated = (await fetchBatch({ skip: written, take: 1 })).length > 0;
    break;
  }

  if (truncated) {
    res.write(
      `# EXPORT TRUNCATED: returned the first ${written} rows (hard cap ${EXPORT_MAX_ROWS}). ` +
        `Narrow the filters for a complete file.${CSV_RECORD_SEPARATOR}`,
    );
  }

  return { rows: written, truncated };
}
