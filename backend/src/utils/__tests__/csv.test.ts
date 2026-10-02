import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  CSV_RECORD_SEPARATOR,
  CSV_UTF8_BOM,
  EXPORT_MAX_ROWS,
  cellToString,
  csvCell,
  csvRow,
  escapeCsvField,
  safeCell,
  streamCsv,
} from '../csv';

/**
 * DB-FREE unit tests for the CSV helpers.
 *
 * Everything under test is pure logic — no Prisma, no request context — so no
 * database or Redis is involved. `streamCsv` is driven with a fake response
 * object that just collects the written chunks.
 */

function fakeResponse() {
  const chunks: string[] = [];
  const res = {
    write: (chunk: string): boolean => {
      chunks.push(chunk);
      return true;
    },
  } as unknown as Response;
  return { res, text: () => chunks.join('') };
}

describe('cellToString', () => {
  it('stringifies BigInt columns instead of throwing', () => {
    expect(cellToString(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('renders Dates as ISO-8601 strings', () => {
    expect(cellToString(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(cellToString(null)).toBe('');
    expect(cellToString(undefined)).toBe('');
  });
});

describe('safeCell', () => {
  it('prefixes every formula-injection trigger with a single quote', () => {
    for (const payload of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\r\nDDE']) {
      expect(safeCell(payload)).toBe(`'${payload}`);
    }
  });

  it('leaves ordinary text untouched', () => {
    expect(safeCell('Alice')).toBe('Alice');
    expect(safeCell('12345')).toBe('12345');
    expect(safeCell('')).toBe('');
  });

  it('protects a value that only becomes dangerous once stringified', () => {
    // A numeric amount already carries a leading minus; it must be neutralised.
    expect(safeCell(-500)).toBe("'-500");
    expect(safeCell(42n)).toBe('42');
  });
});

describe('escapeCsvField', () => {
  it('wraps values containing a comma, quote, CR or LF', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('cr\rlf')).toBe('"cr\rlf"');
  });

  it('doubles embedded double quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('does not quote a plain value', () => {
    expect(escapeCsvField('plain')).toBe('plain');
  });
});

describe('csvCell / csvRow', () => {
  it('applies injection neutralisation before RFC 4180 quoting', () => {
    // First the leading `=` is neutralised into `'=`, then the comma forces
    // RFC 4180 quoting around the whole (now-safe) value.
    expect(csvCell('=cmd,arg')).toBe('"\'=cmd,arg"');
  });

  it('joins cells with commas and escapes each one', () => {
    expect(csvRow(['a', 'b,c', 3n, new Date('2020-05-06T00:00:00.000Z')])).toBe(
      'a,"b,c",3,2020-05-06T00:00:00.000Z',
    );
  });
});

describe('streamCsv', () => {
  const columns = [
    { header: 'name', value: (row: { name: string }) => row.name },
    { header: 'value', value: (row: { name: string }) => row.name.length },
  ];

  it('writes a BOM, a header and every row, in batches, when the source fits', async () => {
    const source = [{ name: 'a' }, { name: 'bb' }, { name: 'ccc' }];
    const { res, text } = fakeResponse();

    const result = await streamCsv(res, columns, async ({ skip, take }) =>
      source.slice(skip, skip + take),
    );

    expect(result).toEqual({ rows: 3, truncated: false });
    expect(text()).toBe(
      `${CSV_UTF8_BOM}name,value${CSV_RECORD_SEPARATOR}` +
        `a,1${CSV_RECORD_SEPARATOR}` +
        `bb,2${CSV_RECORD_SEPARATOR}` +
        `ccc,3${CSV_RECORD_SEPARATOR}`,
    );
    expect(text()).not.toContain('TRUNCATED');
  });

  it('caps the export at EXPORT_MAX_ROWS and appends an explicit truncation notice', async () => {
    const source = Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, index) => ({ name: `row-${index}` }));
    const { res, text } = fakeResponse();

    const result = await streamCsv(res, columns, async ({ skip, take }) =>
      source.slice(skip, skip + take),
    );

    expect(result).toEqual({ rows: EXPORT_MAX_ROWS, truncated: true });
    const output = text();
    expect(output).toContain(`# EXPORT TRUNCATED: returned the first ${EXPORT_MAX_ROWS} rows`);
    // The extra row beyond the cap must never appear.
    expect(output).not.toContain(`row-${EXPORT_MAX_ROWS}`);
    // One header line + EXPORT_MAX_ROWS data rows + one truncation line.
    expect(output.split(CSV_RECORD_SEPARATOR).filter(Boolean)).toHaveLength(EXPORT_MAX_ROWS + 2);
  });
});
