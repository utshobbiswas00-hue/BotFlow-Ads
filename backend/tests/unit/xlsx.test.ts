import { describe, expect, it } from 'vitest';
import {
  buildXlsx,
  crc32,
  sanitizeSheetName,
  stripControlChars,
  xmlEscape,
} from '../../src/utils/xlsx';

/**
 * DB-FREE unit tests for the hand-rolled .xlsx writer.
 *
 * There is no zip library in `node_modules` (on purpose), so the central
 * directory is read back with the small reader below. That is the important
 * assertion: `buildXlsx` is only correct if a real reader can follow the offsets
 * it wrote, and that is exactly the failure mode this file exists to catch.
 */

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
  localOffset: number;
}

/** Minimal ZIP reader: EOCD → central directory → local headers → STORED data. */
function readZip(buf: Buffer): { entries: ZipEntry[]; eocdOffset: number } {
  const eocdOffset = buf.length - 22;
  expect(buf.readUInt32LE(eocdOffset)).toBe(0x06054b50);

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // The central directory must run exactly up to the EOCD record.
  expect(cdOffset + cdSize).toBe(eocdOffset);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The offset must actually land on a local file header, and its name length
    // must agree — otherwise a reader looks in the wrong place.
    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    expect(localNameLen).toBe(nameLen);

    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({
      name,
      data: Buffer.from(buf.subarray(dataStart, dataStart + size)),
      crc,
      method,
      localOffset,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, eocdOffset };
}

const ONE_SHEET = [{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }];

describe('crc32', () => {
  it('matches the standard IEEE test vector', () => {
    // The canonical check value for "123456789".
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for an empty input and stable for repeated calls', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from('botflow'))).toBe(crc32(Buffer.from('botflow')));
  });
});

describe('buildXlsx — ZIP structure', () => {
  it('has an EOCD record whose central-directory offsets are consistent', () => {
    const buf = buildXlsx(ONE_SHEET);
    const { entries, eocdOffset } = readZip(buf);

    // Six parts: content types, root rels, workbook, workbook rels, styles, sheet1.
    expect(buf.readUInt16LE(eocdOffset + 10)).toBe(entries.length);
    expect(entries.length).toBe(6);
  });

  it('stores every entry with method 0 and a CRC that matches its bytes', () => {
    const buf = buildXlsx(ONE_SHEET);
    for (const entry of readZip(buf).entries) {
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(crc32(entry.data));
      // STORED means the bytes are verbatim, so the declared size is the real one.
      expect(entry.data.length).toBeGreaterThan(0);
    }
  });

  it('contains each required workbook part', () => {
    const names = readZip(buildXlsx(ONE_SHEET)).entries.map((e) => e.name).sort();
    expect(names).toEqual(
      [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ].sort(),
    );
  });
});

describe('buildXlsx — cell serialisation', () => {
  const xmlOf = (rows: (string | number | boolean | null)[][]): string => {
    const buf = buildXlsx([{ name: 'Sheet1', rows }]);
    const sheet = readZip(buf).entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
    if (!sheet) throw new Error('sheet1.xml missing');
    return sheet.data.toString('utf8');
  };

  it('keeps numbers numeric (t="n"), not inline strings', () => {
    const xml = xmlOf([['n'], [42], [3.5]]);
    expect(xml).toContain('<c r="A2" t="n"><v>42</v></c>');
    expect(xml).toContain('<c r="A3" t="n"><v>3.5</v></c>');
    // And 42 is NOT emitted as a string cell.
    expect(xml).not.toContain('<is><t xml:space="preserve">42</t></is>');
  });

  it('writes booleans as t="b" and nulls as empty cells', () => {
    const xml = xmlOf([[true], [false], [null]]);
    expect(xml).toContain('<c r="A1" t="b"><v>1</v></c>');
    expect(xml).toContain('<c r="A2" t="b"><v>0</v></c>');
    expect(xml).toContain('<c r="A3"/>');
  });

  it('XML-escapes & < > " and the apostrophe inside inline strings', () => {
    const xml = xmlOf([['a&b<c>"d\'e']]);
    expect(xml).toContain('a&amp;b&lt;c&gt;&quot;d&apos;e');
    expect(xml).toContain('t="inlineStr"');
  });

  it('strips control characters that make a workbook unopenable', () => {
    const dirty = `a\u0000b\u0008c\u000bd`;
    const xml = xmlOf([[dirty]]);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(xml).toContain('abcd');
  });
});

describe('sheet-name sanitising', () => {
  it('caps the name at 31 characters', () => {
    expect(sanitizeSheetName('x'.repeat(50)).length).toBe(31);
  });

  it('removes the characters Excel forbids', () => {
    const name = sanitizeSheetName('bad/name[1]*?:\\');
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  it('never returns empty and de-duplicates case-insensitively', () => {
    const used = new Set<string>();
    expect(sanitizeSheetName('', used)).toBe('Sheet');
    const first = sanitizeSheetName('Data', used);
    const second = sanitizeSheetName('data', used);
    expect(first).toBe('Data');
    expect(second).not.toBe(first);
    expect(second.toLowerCase()).not.toBe(first.toLowerCase());
  });

  it('is applied inside buildXlsx so two same-named sheets both survive', () => {
    const buf = buildXlsx([
      { name: 'Data', rows: [[1]] },
      { name: 'Data', rows: [[2]] },
    ]);
    const workbook = readZip(buf).entries.find((e) => e.name === 'xl/workbook.xml');
    expect(workbook?.data.toString('utf8')).toContain('name="Data"');
    expect(workbook?.data.toString('utf8')).toContain('name="Data_1"');
  });
});

describe('stripControlChars / xmlEscape helpers', () => {
  it('keeps TAB, LF and CR but drops other C0 controls', () => {
    expect(stripControlChars('a\tb\nc\rd\u0000')).toBe('a\tb\nc\rd');
  });

  it('escapes the four XML metacharacters and the apostrophe', () => {
    expect(xmlEscape('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});
