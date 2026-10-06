/**
 * Minimal .xlsx reader for tests: unzips with fflate and parses just enough of
 * the OOXML to assert on sheet names, cell text and whether a cell is numeric.
 * Handles both shared strings (t="s") and inline strings (t="inlineStr").
 */
import { readFileSync } from 'fs';
import { unzipSync, strFromU8 } from 'fflate';

export interface XlsxCellRead {
  /** Cell reference, e.g. "C2". */
  ref: string;
  /** Raw `t` attribute ('s', 'inlineStr', 'str', 'b', 'n' or '' when absent = numeric). */
  t: string;
  /** Decoded string for text cells, number for numeric cells. */
  value: string | number | boolean;
  /** True when stored as a number (no t="s"/inlineStr/str). */
  numeric: boolean;
  /** Style index (`s` attribute) into cellXfs, or undefined when unstyled. */
  s?: number;
}

export interface XlsxCellStyle {
  bold: boolean;
  /** Resolved number format code ('' when General/none). */
  numFmt: string;
}

export interface XlsxRead {
  sheetNames: string[];
  /** Rows of cells per sheet name; empty cells are absent (use `cellAt`). */
  sheets: Record<string, XlsxCellRead[][]>;
  /** Cell by 0-based row/col in the named sheet, or undefined if empty. */
  cellAt(sheet: string, row: number, col: number): XlsxCellRead | undefined;
  /** Header row text (row 0) of a sheet. */
  header(sheet: string): string[];
  /** Raw xl/styles.xml, for number-format / bold assertions. */
  stylesXml: string;
  /** Resolve a cell's s= index through cellXfs -> fonts/numFmts. */
  styleOf(cell: XlsxCellRead | undefined): XlsxCellStyle;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Concatenate every <t>…</t> run inside an <si>/<is> block. */
function textOf(block: string): string {
  let out = '';
  for (const m of block.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]);
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)![0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : undefined;
}

export function readXlsx(input: Uint8Array | Buffer | string): XlsxRead {
  const bytes = typeof input === 'string' ? new Uint8Array(readFileSync(input)) : new Uint8Array(input);
  const files = unzipSync(bytes);
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');

  const shared: string[] = [];
  for (const m of text('xl/sharedStrings.xml').matchAll(/<si[\s>][\s\S]*?<\/si>|<si\/>/g)) shared.push(textOf(m[0]));

  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const sheetNames: string[] = [];
  const sheets: Record<string, XlsxCellRead[][]> = {};
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name')!;
    const rid = attr(m[0], 'r:id')!;
    sheetNames.push(name);
    const xml = text(relTarget.get(rid) ?? '');
    const rows: XlsxCellRead[][] = [];
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: XlsxCellRead[] = [];
      for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const open = cm[1];
        const body = cm[2] ?? '';
        const ref = attr(` ${open}`, 'r')!;
        const t = attr(` ${open}`, 't') ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | number | boolean;
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = textOf(body);
        else if (t === 'str') value = unescapeXml(v ?? '');
        else if (t === 'b') value = v === '1';
        else value = Number(v);
        const sAttr = attr(` ${open}`, 's');
        cells[colIndex(ref)] = { ref, t, value, numeric: t === '' || t === 'n', s: sAttr === undefined ? undefined : Number(sAttr) };
      }
      rows.push(cells);
    }
    sheets[name] = rows;
  }

  const stylesXml = text('xl/styles.xml');
  const numFmts = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) numFmts.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') ?? '');
  const fontsBlock = /<fonts\b[\s\S]*?<\/fonts>/.exec(stylesXml)?.[0] ?? '';
  const fonts = [...fontsBlock.matchAll(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g)].map((m) => /<b\s*\/>|<b>/.test(m[0]));
  const xfsBlock = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? '';
  const xfs = [...xfsBlock.matchAll(/<xf\b[^>]*>/g)].map((m) => m[0]);
  const styleOf = (cell: XlsxCellRead | undefined): XlsxCellStyle => {
    const xf = cell?.s === undefined ? undefined : xfs[cell.s];
    if (!xf) return { bold: false, numFmt: '' };
    return {
      bold: fonts[Number(attr(xf, 'fontId') ?? 0)] ?? false,
      numFmt: numFmts.get(Number(attr(xf, 'numFmtId') ?? 0)) ?? '',
    };
  };

  return {
    styleOf,
    sheetNames,
    sheets,
    stylesXml,
    cellAt: (sheet, row, col) => sheets[sheet]?.[row]?.[col],
    header: (sheet) => (sheets[sheet]?.[0] ?? []).map((c) => String(c?.value ?? '')),
  };
}

/** Column values (without the header) for a named header, as plain values. */
export function columnValues(x: XlsxRead, sheet: string, headerName: string): Array<string | number | boolean | undefined> {
  const col = x.header(sheet).indexOf(headerName);
  if (col < 0) throw new Error(`No column "${headerName}" in sheet "${sheet}"`);
  return (x.sheets[sheet] ?? []).slice(1).map((r) => r[col]?.value);
}

/** True when every non-empty cell in the column is stored as a number. */
export function columnIsNumeric(x: XlsxRead, sheet: string, headerName: string): boolean {
  const col = x.header(sheet).indexOf(headerName);
  return (x.sheets[sheet] ?? []).slice(1).every((r) => !r[col] || r[col].numeric);
}

/** Data rows as {header: value} objects (the shape SheetJS's sheet_to_json used to give tests). */
export function rowsOf(x: XlsxRead, sheet: string): Record<string, string | number | boolean | undefined>[] {
  const header = x.header(sheet);
  return (x.sheets[sheet] ?? []).slice(1).map((r) => {
    const o: Record<string, string | number | boolean | undefined> = {};
    header.forEach((h, i) => {
      if (r[i]) o[h] = r[i].value;
    });
    return o;
  });
}
