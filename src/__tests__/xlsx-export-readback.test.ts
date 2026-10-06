import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { unlinkSync } from 'fs';
import type { Database } from '../db/compat-sqlite.js';
import * as licenseModule from '../licensing/license.js';
import { flagTaxDeduction, insertTransactions } from '../db/queries.js';
import { runExport } from '../reports.js';
import { initExportTool, exportTransactionsTool } from '../tools/export/export-transactions.js';
import { initTaxFlagTool, taxFlagTool } from '../tools/tax/tax-flag.js';
import { buildScheduleC, scheduleCToXlsxBuffer } from '../tools/tax/schedule-c.js';
import { apiExportXlsx } from '../dashboard/api.js';
import { startDashboardServer } from '../dashboard/server.js';
import { sheetToCsv, xlsxToBuffer, CURRENCY_FORMAT } from '../utils/xlsx-writer.js';
import { createTestDb, makeTmpPath } from './helpers.js';
import { readXlsx, rowsOf, columnIsNumeric, type XlsxRead } from './helpers/xlsx-read.js';

// Read-back tests: unzip each generated .xlsx and assert on the real OOXML so a
// regression in the writer (string-typed numbers, un-neutralised formulas,
// wrong sheet names/headers) is caught for every export path.

const HYPERLINK = '=HYPERLINK("http://x","y")';
const mockHasLicense = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
beforeEach(() => mockHasLicense.mockReturnValue(true));
afterAll(() => mockHasLicense.mockRestore());

/** Header cells are bold and every Amount cell carries the currency format (resolved via cellXfs). */
function expectBoldHeaderAndCurrency(x: XlsxRead, sheet: string, amountCol: string) {
  const header = x.sheets[sheet][0];
  expect(header.length).toBeGreaterThan(0);
  for (const c of header) expect(x.styleOf(c).bold).toBe(true);
  const col = x.header(sheet).indexOf(amountCol);
  const amounts = x.sheets[sheet].slice(1).map((r) => r[col]).filter(Boolean);
  expect(amounts.length).toBeGreaterThan(0);
  for (const c of amounts) {
    expect(x.styleOf(c).numFmt).toBe(CURRENCY_FORMAT);
    expect(x.styleOf(c).bold).toBe(false);
  }
}

function seed(db: Database): number[] {
  return insertTransactions(db, [
    { date: '2026-03-01', description: HYPERLINK, amount: -12.34, category: 'Supplies', notes: '+cmd' },
    { date: '2026-03-02', description: '+cmd', amount: -5, category: 'Dining' },
    { date: '2026-03-03', description: 'Paycheck', amount: 2500.5, category: 'Income' },
  ]).ids;
}

const TX_HEADER = ['date', 'description', 'amount', 'category'];

/** Shared checks for a plain Transactions sheet. */
function expectTransactionsSheet(x: XlsxRead, header: string[], descKey: string, amountKey: string) {
  expect(x.sheetNames).toEqual(['Transactions']);
  expect(x.header('Transactions')).toEqual(header);
  const rows = rowsOf(x, 'Transactions');
  expect(rows).toHaveLength(3);
  // Negative amount is a real numeric cell, not text.
  expect(columnIsNumeric(x, 'Transactions', amountKey)).toBe(true);
  const col = header.indexOf(amountKey);
  const cell = x.sheets['Transactions'].slice(1).map((r) => r[col]).find((c) => c.value === -12.34)!;
  expect(cell).toBeDefined();
  expect(cell.t).not.toBe('s');
  expect(cell.t).not.toBe('inlineStr');
  // Hostile text is neutralised with a leading apostrophe.
  const descs = rows.map((r) => r[descKey]);
  expect(descs).toContain(`'${HYPERLINK}`);
  expect(descs).toContain("'+cmd");
  expect(descs).not.toContain(HYPERLINK);
  // Styling: bold header + currency format are present in the styles part.
  expect(x.stylesXml).toContain('<b/>');
  expect(x.stylesXml).toContain(CURRENCY_FORMAT);
}

describe('xlsx read-back', () => {
  let db: Database;
  const tmp: string[] = [];
  const tmpPath = (ext: string) => {
    const p = makeTmpPath(ext);
    tmp.push(p);
    return p;
  };

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    for (const f of tmp) try { unlinkSync(f); } catch { /* */ }
    tmp.length = 0;
  });

  test('reports.runExport --format xlsx', async () => {
    seed(db);
    const p = tmpPath('.xlsx');
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExport(['--export', p, '--format', 'xlsx'], db);
      expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(`Exported 3 transactions to ${p} (XLSX).`);
    } finally {
      logSpy.mockRestore();
    }
    expectTransactionsSheet(readXlsx(p), TX_HEADER, 'description', 'amount');
  });

  test('export_transactions tool', async () => {
    seed(db);
    initExportTool(db);
    const p = tmpPath('.xlsx');
    const res = JSON.parse((await exportTransactionsTool.func({ format: 'xlsx', filePath: p })) as string);
    expect(res.data.message).toBe(`Exported 3 transactions to ${p} (XLSX).`);
    expectTransactionsSheet(readXlsx(p), TX_HEADER, 'description', 'amount');
  });

  test('export_transactions tool reports a write failure', async () => {
    seed(db);
    initExportTool(db);
    const res = JSON.parse(
      (await exportTransactionsTool.func({ format: 'xlsx', filePath: '/nonexistent-dir/x/out.xlsx' })) as string,
    );
    expect(res.data.error).toContain('Failed to write file:');
  });

  test('schedule C buffer: both sheets', async () => {
    const ids = seed(db);
    flagTaxDeduction(db, ids[0], 'Supplies', 2026, '+cmd');
    flagTaxDeduction(db, ids[1], 'Meals', 2026);
    const x = readXlsx(await scheduleCToXlsxBuffer(buildScheduleC(db, 2026)));
    expect(x.sheetNames).toEqual(['Schedule C 2026', 'Transactions']);
    expect(x.header('Schedule C 2026')).toEqual(['Line', 'Category', 'Amount', 'Transactions']);
    expect(x.header('Transactions')).toEqual([
      'Line', 'Category', 'Date', 'Description', 'Amount', 'Notes', 'Transaction ID',
    ]);
    // Schedule C amounts are expenses flipped positive; stays numeric.
    expect(columnIsNumeric(x, 'Schedule C 2026', 'Amount')).toBe(true);
    expect(columnIsNumeric(x, 'Transactions', 'Amount')).toBe(true);
    const detail = rowsOf(x, 'Transactions');
    expect(detail.map((r) => r.Amount)).toContain(12.34);
    expect(detail.map((r) => r.Description)).toContain(`'${HYPERLINK}`);
    expect(detail.map((r) => r.Notes)).toContain("'+cmd");
    expect(detail.map((r) => r.Description)).toContain("'+cmd");
    const summary = rowsOf(x, 'Schedule C 2026');
    expect(summary[summary.length - 1]).toMatchObject({ Line: '28', Category: 'Total expenses', Amount: 17.34 });
    expectBoldHeaderAndCurrency(x, 'Schedule C 2026', 'Amount');
    expectBoldHeaderAndCurrency(x, 'Transactions', 'Amount');
  });

  test('tax_flag export writes a readable workbook', async () => {
    const ids = seed(db);
    flagTaxDeduction(db, ids[0], 'Supplies', 2026, '+cmd');
    initTaxFlagTool(db);
    const p = tmpPath('.xlsx');
    const res = JSON.parse((await taxFlagTool.func({ action: 'export', taxYear: 2026, filePath: p } as never)) as string);
    expect(res.data.message).toContain(`to ${p} (Schedule C XLSX).`);
    const x = readXlsx(p);
    expect(x.sheetNames).toEqual(['Schedule C 2026', 'Transactions']);
    expect(x.header('Transactions')[3]).toBe('Description');
    expect(columnIsNumeric(x, 'Transactions', 'Amount')).toBe(true);
    expect(rowsOf(x, 'Transactions').map((r) => r.Description)).toContain(`'${HYPERLINK}`);
    expect(rowsOf(x, 'Transactions').map((r) => r.Notes)).toContain("'+cmd");
    expectBoldHeaderAndCurrency(x, 'Schedule C 2026', 'Amount');
    expectBoldHeaderAndCurrency(x, 'Transactions', 'Amount');
  });

  test('apiExportXlsx', async () => {
    seed(db);
    const x = readXlsx(await apiExportXlsx(db, new URLSearchParams()));
    expectTransactionsSheet(x, ['Date', 'Description', 'Amount', 'Category', 'Bank', 'Account Last4'], 'Description', 'Amount');
  });

  test('dashboard GET /api/export/xlsx', async () => {
    seed(db);
    const { server } = await startDashboardServer(db, 0);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/export/xlsx`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('spreadsheetml.sheet');
      expect(res.headers.get('content-disposition')).toContain('transactions.xlsx');
      const x = readXlsx(new Uint8Array(await res.arrayBuffer()));
      expectTransactionsSheet(x, ['Date', 'Description', 'Amount', 'Category', 'Bank', 'Account Last4'], 'Description', 'Amount');
    } finally {
      server.stop(true);
    }
  });
});

describe('xlsx writer', () => {
  test('widths are written and empty cells are omitted', async () => {
    const x = readXlsx(
      await xlsxToBuffer([
        { name: 'S', header: ['a', 'b'], rows: [['x', null], ['', 1]], widths: [10, 20], currencyColumns: ['b'] },
      ]),
    );
    expect(x.sheetNames).toEqual(['S']);
    expect(x.cellAt('S', 1, 1)).toBeUndefined();
    expect(x.cellAt('S', 2, 0)).toBeUndefined();
    expect(x.cellAt('S', 2, 1)).toMatchObject({ value: 1, numeric: true });
  });

  test('rejects sheet names over 31 chars', async () => {
    await expect(xlsxToBuffer([{ name: 'x'.repeat(32), header: ['a'], rows: [] }])).rejects.toThrow(/too long/);
  });

  test('sheetToCsv matches the previous SheetJS csv output byte for byte', () => {
    const csv = sheetToCsv({
      header: ['date', 'description', 'amount', 'category'],
      rows: [
        ['2025-01-02', 'a,b "q"', -12.34, ''],
        ['2025-01-03', 'ID', 0.1 + 0.2, 'x\ny'],
        ['d', "'=cmd", 1234567.891, ' sp '],
      ],
    });
    expect(csv).toBe(
      '﻿date,description,amount,category\n' +
        '2025-01-02,"a,b ""q""",-12.34,\n' +
        '2025-01-03,"ID",0.3,"x\ny"\n' +
        "d,'=cmd,1234567.891, sp ",
    );
  });

  test('sheetToCsv quotes a field containing a carriage return as one field', () => {
    const desc = 'Coffee\r=HYPERLINK("http://x","y")';
    const csv = sheetToCsv({ header: ['description'], rows: [[desc]] });
    expect(csv).toBe('\ufeffdescription\n"Coffee\r=HYPERLINK(""http://x"",""y"")"');
    expect(csv.split('\n')).toHaveLength(2);
    // CR alone (no comma, quote or LF) must still force quoting.
    expect(sheetToCsv({ header: ['d'], rows: [['a\r=1+1']] })).toBe('\ufeffd\n"a\r=1+1"');
  });

  test('sheetToCsv neutralises formulas', () => {
    expect(readCsvLine(sheetToCsv({ header: ['a'], rows: [['=1+1'], ['-x']] }))).toEqual(['a', "'=1+1", "'-x"]);
  });
});

function readCsvLine(csv: string): string[] {
  return csv.replace('﻿', '').split('\n');
}
