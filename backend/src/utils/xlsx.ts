/**
 * A dependency-free .xlsx writer.
 *
 * WHY THIS IS HAND-ROLLED INSTEAD OF A LIBRARY
 * --------------------------------------------
 * This is roughly 150 lines and no dependency is added. That trade is deliberate:
 *
 *  1. The deployment installs with `npm ci --omit=dev`. Every new runtime
 *     dependency is one more package that has to exist, resolve and be patched
 *     on that path — for a feature that is a pure format conversion.
 *  2. An .xlsx is a ZIP of XML parts. It is a *format*, and a backend that can
 *     already read and write bytes must not need a third-party library to emit
 *     one. (The same reasoning kept the CSV writer in `./csv` dependency-free.)
 *  3. The alternatives are heavy (`exceljs`/`xlsx`) or still a dependency for
 *     half the job (`jszip` + a XML writer). None of them is needed for the
 *     fixed, simple shapes this API exports.
 *
 * An .xlsx that Excel and LibreOffice both open needs only:
 *   - a ZIP with STORED (method 0) entries — no DEFLATE, so the only "compression"
 *     work is a CRC-32, which is 10 lines;
 *   - `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
 *     `xl/_rels/workbook.xml.rels`, one `xl/worksheets/sheetN.xml` per sheet and a
 *     minimal `xl/styles.xml`;
 *   - inline strings (`t="inlineStr"`), so no shared-string table is required.
 *
 * The ZIP offsets are the part that silently produces a "corrupt file" if they
 * are wrong, so `buildZip` computes them from the byte lengths it actually
 * writes rather than from any assumed constant.
 */

/** A cell value that survives a round-trip through the XML parts. */
export type XlsxCell = string | number | boolean | null;

export interface XlsxSheet {
  /** Raw name; sanitised to Excel's rules before it is written. */
  name: string;
  /** Row-major cells. The first row is not treated specially. */
  rows: XlsxCell[][];
}

/* ------------------------------------------------------------------
 *  CRC-32 (IEEE 802.3, the polynomial ZIP uses)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of a byte sequence. Exported so the tests can assert a known vector
 * (`crc32(Buffer.from('123456789')) === 0xcbf43926`) without going through ZIP.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------
 *  Text hygiene
 * ------------------------------------------------------------------ */

/**
 * Drop the C0 control characters that XML 1.0 forbids, except TAB, LF and CR.
 * A single stray 0x00–0x08 byte inside a cell is enough to make a workbook
 * unopenable, and Telegram display names / channel titles are attacker-adjacent
 * data, so this is applied to every string cell and every sheet name.
 */
export function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) out += ch;
  }
  return out;
}

/** Escape the characters that would otherwise break an XML text node/attribute. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Make a sheet name legal for Excel: at most 31 characters, none of `[]:*?/\`,
 * no leading/trailing apostrophe, never empty, and unique (case-insensitively)
 * within the workbook. `used` is threaded through so a second sheet cannot
 * silently collide with the first and make the file unopenable.
 */
export function sanitizeSheetName(name: string, used: Set<string> = new Set()): string {
  let base = stripControlChars(name)
    .replace(/[[\]:*?/\\]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim();

  if (base.length === 0) base = 'Sheet';
  if (base.length > 31) base = base.slice(0, 31);

  let candidate = base;
  let suffix = 1;
  while (used.has(candidate.toLowerCase())) {
    const tag = `_${suffix}`;
    candidate = `${base.slice(0, 31 - tag.length)}${tag}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* ------------------------------------------------------------------
 *  ZIP (STORED entries, central directory, EOCD)
 * ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 1980-01-01 00:00:00 in MS-DOS date/time form. Fixed so a given input always
 * produces the same bytes (which is what makes the structure testable), and
 * valid: Excel does not use the timestamp for anything that matters here.
 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/**
 * Assemble a ZIP archive with STORED (uncompressed) entries.
 *
 * Layout: [local header + name + data] per entry, then the central directory,
 * then the end-of-central-directory record. The running `offset` is advanced by
 * exactly the number of bytes pushed for each entry, and each central-directory
 * record stores that offset — this is the invariant that decides whether a
 * reader sees a valid archive or calls it corrupt.
 */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const { data } = entry;
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(0, 8); // compression method: STORED
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size == uncompressed (STORED)
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralDir = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with the start of the central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/* ------------------------------------------------------------------
 *  SpreadsheetML parts
 * ------------------------------------------------------------------ */

/** A1, B1, … Z1, AA1, … for a zero-based column index. */
function columnRef(index: number): string {
  let n = index + 1;
  let ref = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    ref = String.fromCharCode(65 + rem) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

function cellXml(cell: XlsxCell, ref: string): string {
  if (cell === null || cell === undefined) return `<c r="${ref}"/>`;
  if (typeof cell === 'number') {
    // Keep finite numbers numeric (`t="n"`); Infinity/NaN have no number form
    // Excel accepts, so they fall back to text rather than producing a cell
    // Excel refuses to open.
    if (!Number.isFinite(cell)) return inlineStrCell(String(cell), ref);
    return `<c r="${ref}" t="n"><v>${cell}</v></c>`;
  }
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  return inlineStrCell(cell, ref);
}

function inlineStrCell(value: string, ref: string): string {
  // inlineStr means the string lives in this cell; no shared-string table, so
  // there is nothing to keep in sync. xml:space="preserve" keeps leading /
  // trailing whitespace that would otherwise be normalised away.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(stripControlChars(value))}</t></is></c>`;
}

function sheetXml(rows: XlsxCell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(cell, `${columnRef(c)}${r + 1}`)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData>` +
    '</worksheet>'
  );
}

function workbookXml(names: string[]): string {
  const sheets = names
    .map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>` +
    '</workbook>'
  );
}

function workbookRelsXml(count: number): string {
  const rels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    rels.push(
      `<Relationship Id="rId${i + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="worksheets/sheet${i + 1}.xml"/>`,
    );
  }
  rels.push(
    `<Relationship Id="rId${count + 1}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/>',
  );
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') +
    '</Relationships>'
  );
}

function contentTypesXml(count: number): string {
  const overrides: string[] = [
    '<Override PartName="/xl/workbook.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ];
  for (let i = 0; i < count; i += 1) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ` +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    );
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ' +
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.join('') +
    '</Types>'
  );
}

/**
 * Minimal but complete style sheet. Excel is tolerant, but it does expect the
 * `none` + `gray125` fill pair to exist, so both are declared.
 */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '</styleSheet>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="xl/workbook.xml"/>' +
  '</Relationships>';

/**
 * Build an .xlsx workbook. One sheet per entry; sheet names are sanitised and
 * de-duplicated; the first row of each sheet is the header merely by convention
 * (this function has no opinion about it).
 */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (sheets.length === 0) throw new Error('buildXlsx requires at least one sheet');

  const used = new Set<string>();
  const names = sheets.map((sheet) => sanitizeSheetName(sheet.name, used));

  const parts: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(sheets.length), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(names), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml(sheets.length), 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
  ];

  sheets.forEach((sheet, i) => {
    parts.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(sheet.rows), 'utf8'),
    });
  });

  return buildZip(parts);
}
