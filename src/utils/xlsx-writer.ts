/**
 * Shared spreadsheet writer for every export path (CLI --export, the
 * export_transactions tool, Schedule C, tax_flag, the dashboard download).
 *
 * Wraps `write-excel-file` (Wilson only ever *writes* xlsx) and owns the
 * cross-cutting rules so call sites stay declarative:
 *  - every string cell is formula-neutralised (see spreadsheet-safe.ts);
 *  - numbers stay numeric cells; dates stay whatever the caller passes (ISO strings);
 *  - header row is bold, currency columns get a red-negative number format.
 *
 * Also provides `sheetToCsv`, which reproduces the CSV the previous SheetJS
 * implementation wrote, for the `csv` branches that used to share the xlsx code.
 */
import writeExcelFile from 'write-excel-file/node';
import { neutralizeFormula } from './spreadsheet-safe.js';

export type XlsxCell = string | number | boolean | null | undefined;

export interface XlsxSheet {
  /** Sheet (tab) name, max 31 chars (Excel limit). */
  name: string;
  /** Header cell text, one per column. */
  header: string[];
  /** Data rows, each aligned with `header`. */
  rows: XlsxCell[][];
  /** Column widths in characters, aligned with `header` (optional). */
  widths?: number[];
  /** Header names (or 0-based indexes) of amount columns to format as currency. */
  currencyColumns?: Array<string | number>;
}

/** Number format for amount columns: thousands separators, 2dp, negatives red with a minus sign. */
export const CURRENCY_FORMAT = '#,##0.00;[Red]-#,##0.00';

const MAX_SHEET_NAME = 31;

function currencyIndexes(sheet: XlsxSheet): Set<number> {
  const out = new Set<number>();
  for (const c of sheet.currencyColumns ?? []) {
    const i = typeof c === 'number' ? c : sheet.header.indexOf(c);
    if (i >= 0) out.add(i);
  }
  return out;
}

function toSheetData(sheet: XlsxSheet) {
  const currency = currencyIndexes(sheet);
  const header = sheet.header.map((h) => ({ value: h, type: String, fontWeight: 'bold' as const }));
  const body = sheet.rows.map((row) =>
    row.map((v, i) => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') {
        return currency.has(i) ? { value: v, type: Number, format: CURRENCY_FORMAT } : { value: v, type: Number };
      }
      if (typeof v === 'boolean') return { value: v, type: Boolean };
      return { value: neutralizeFormula(v), type: String };
    }),
  );
  return [header, ...body];
}

function toSheets(sheets: XlsxSheet[]) {
  return sheets.map((s) => {
    if (s.name.length > MAX_SHEET_NAME) throw new Error(`Sheet name too long (max ${MAX_SHEET_NAME}): ${s.name}`);
    return {
      sheet: s.name,
      data: toSheetData(s),
      ...(s.widths ? { columns: s.widths.map((width) => ({ width })) } : {}),
    };
  });
}

/** Write one or more sheets to an .xlsx file. */
export async function writeXlsxFile(sheets: XlsxSheet[], filePath: string): Promise<void> {
  await writeExcelFile(toSheets(sheets) as any).toFile(filePath);
}

/** Render one or more sheets to an in-memory .xlsx. */
export async function xlsxToBuffer(sheets: XlsxSheet[]): Promise<Buffer> {
  return writeExcelFile(toSheets(sheets) as any).toBuffer();
}

/**
 * CSV for a sheet, byte-compatible with the old SheetJS `bookType: 'csv'`
 * output: UTF-8 BOM, comma separated, `\n` rows with no trailing newline, a
 * field quoted when it contains `,` `"` or `\n` (and a bare `ID`), numbers in
 * Excel "General" form, formula-neutralised strings.
 */
export function sheetToCsv(sheet: Pick<XlsxSheet, 'header' | 'rows'>): string {
  const field = (v: XlsxCell): string => {
    if (v === null || v === undefined) return '';
    let txt: string;
    if (typeof v === 'number') txt = String(Number(v.toPrecision(11)));
    else if (typeof v === 'boolean') txt = v ? 'TRUE' : 'FALSE';
    else txt = neutralizeFormula(v);
    if (/[,"\n]/.test(txt)) return `"${txt.replace(/"/g, '""')}"`;
    return txt === 'ID' ? '"ID"' : txt;
  };
  const lines = [sheet.header, ...sheet.rows].map((r) => r.map(field).join(','));
  return '﻿' + lines.join('\n');
}
