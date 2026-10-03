import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import * as XLSX from 'xlsx';
import type { Database } from '../db/compat-sqlite.js';
import * as licenseModule from '../licensing/license.js';
import { flagTaxDeduction, insertTransactions } from '../db/queries.js';
import { buildScheduleC, scheduleCToCsv, scheduleCToWorkbook, SCHEDULE_C_LINES } from '../tools/tax/schedule-c.js';
import { IRS_CATEGORIES } from '../tools/tax/irs-categories.js';
import { initTaxFlagTool, taxFlagTool } from '../tools/tax/tax-flag.js';
import { parseTaxExportArgs } from '../dashboard/ui/src/lib/taxExport.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createTestDb, makeTmpPath } from './helpers.js';

// Spy (not mock.module) so other test files keep the real hasLicense.
const mockHasLicense = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
beforeEach(() => mockHasLicense.mockReturnValue(true));
afterAll(() => mockHasLicense.mockRestore());

/** Seeds 2025 deductions across lines 22, 8, 16b and a refund, plus one 2024 row. */
function seed(db: Database): void {
  const { ids } = insertTransactions(db, [
    { date: '2025-03-01', description: 'Office Depot', amount: -40.1, category: 'Shopping' },
    { date: '2025-01-10', description: 'Facebook Ads', amount: -200, category: 'Advertising' },
    { date: '2025-03-05', description: 'Office Depot refund', amount: 10.05, category: 'Shopping' },
    { date: '2025-06-01', description: 'Loan interest, "biz"', amount: -12.5, category: 'Fees' },
    { date: '2024-12-30', description: 'Last year ads', amount: -99, category: 'Advertising' },
  ]);
  flagTaxDeduction(db, ids[0], 'Supplies', 2025);
  flagTaxDeduction(db, ids[1], 'Advertising', 2025, 'Q1 campaign');
  flagTaxDeduction(db, ids[2], 'Supplies', 2025);
  flagTaxDeduction(db, ids[3], 'Interest (other)', 2025);
  flagTaxDeduction(db, ids[4], 'Advertising', 2024);
}

describe('buildScheduleC', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    seed(db);
  });

  test('every IRS category maps to a Schedule C line', () => {
    for (const c of IRS_CATEGORIES) expect(SCHEDULE_C_LINES[c]).toBeTruthy();
  });

  test('totals per line, ordered by line number, scoped to the tax year', () => {
    const r = buildScheduleC(db, 2025);
    expect(r.lines).toEqual([
      { line: '8', category: 'Advertising', total: 200, count: 1 },
      { line: '16b', category: 'Interest (other)', total: 12.5, count: 1 },
      { line: '22', category: 'Supplies', total: 30.05, count: 2 },
    ]);
    expect(r.total).toBe(242.55);
    expect(r.details).toHaveLength(4);
  });

  test('a flagged refund reduces its line instead of adding to it', () => {
    const supplies = buildScheduleC(db, 2025).lines.find((l) => l.category === 'Supplies')!;
    expect(supplies.total).toBe(30.05); // 40.10 - 10.05
  });

  test('an unrecognized category falls back to line 27a', () => {
    const { ids } = insertTransactions(db, [{ date: '2025-07-01', description: 'Odd', amount: -5 }]);
    flagTaxDeduction(db, ids[0], 'Bank fees', 2025);
    const odd = buildScheduleC(db, 2025).lines.find((l) => l.category === 'Bank fees')!;
    expect(odd.line).toBe('27a');
  });

  test('CSV has line rows, escapes commas/quotes, and ends with the line 28 total', () => {
    const csv = scheduleCToCsv(buildScheduleC(db, 2025));
    expect(csv.split('\n')).toEqual([
      'Line,Category,Amount,Transactions',
      '8,Advertising,200.00,1',
      '16b,Interest (other),12.50,1',
      '22,Supplies,30.05,2',
      '28,Total expenses,242.55,4',
    ]);
  });

  test('workbook has a summary sheet and a transactions sheet with every flagged row', () => {
    const wb = scheduleCToWorkbook(buildScheduleC(db, 2025));
    expect(wb.SheetNames).toEqual(['Schedule C 2025', 'Transactions']);
    const detail = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Transactions']);
    expect(detail).toHaveLength(4);
    expect(detail.find((d) => d.Description === 'Loan interest, "biz"')).toMatchObject({ Line: '16b', Amount: 12.5 });
    expect(detail.find((d) => d.Category === 'Advertising')).toMatchObject({ Notes: 'Q1 campaign' });
  });

  test('a year with no deductions is empty with a zero total', () => {
    const r = buildScheduleC(db, 2023);
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
    expect(scheduleCToCsv(r)).toBe('Line,Category,Amount,Transactions\n28,Total expenses,0.00,0');
  });
});

describe('tax_flag export action', () => {
  let db: Database;
  const tmpFiles: string[] = [];
  beforeEach(() => {
    db = createTestDb();
    seed(db);
    initTaxFlagTool(db);
  });
  afterEach(() => {
    for (const f of tmpFiles) try { unlinkSync(f); } catch { /* */ }
    tmpFiles.length = 0;
  });

  async function run(args: Record<string, unknown>) {
    return JSON.parse((await taxFlagTool.func(args as never)) as string).data;
  }

  test('writes an xlsx by default', async () => {
    const filePath = makeTmpPath('.xlsx');
    tmpFiles.push(filePath);
    const data = await run({ action: 'export', taxYear: 2025, filePath });
    expect(data).toMatchObject({ success: true, format: 'xlsx', deductionsExported: 4, total: 242.55 });
    expect(XLSX.readFile(filePath).SheetNames).toEqual(['Schedule C 2025', 'Transactions']);
  });

  test('writes the line summary as csv', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);
    await run({ action: 'export', taxYear: 2025, format: 'csv', filePath });
    expect(readFileSync(filePath, 'utf8')).toContain('22,Supplies,30.05,2');
  });

  test('requires filePath and reports an empty year without writing', async () => {
    expect((await run({ action: 'export', taxYear: 2025 })).error).toContain('filePath');
    const filePath = makeTmpPath('.xlsx');
    const data = await run({ action: 'export', taxYear: 2023, filePath });
    expect(data.success).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  test('refuses a path whose extension does not match the format', async () => {
    const zshrc = makeTmpPath('.zshrc');
    expect((await run({ action: 'export', taxYear: 2025, filePath: zshrc })).error).toContain('.xlsx');
    expect((await run({ action: 'export', taxYear: 2025, format: 'csv', filePath: makeTmpPath('.xlsx') })).error)
      .toContain('.csv');
    expect(existsSync(zshrc)).toBe(false);
  });

  test('is Pro-gated', async () => {
    mockHasLicense.mockReturnValue(false);
    const data = await run({ action: 'export', taxYear: 2025, filePath: makeTmpPath('.xlsx') });
    expect(data.error).toContain('Pro feature');
  });
});

describe('parseTaxExportArgs', () => {
  test('defaults to the current year and xlsx', () => {
    expect(parseTaxExportArgs([], 2026)).toEqual({ ok: true, year: 2026, format: 'xlsx' });
  });
  test('accepts year and format in either order', () => {
    expect(parseTaxExportArgs(['csv', '2025'], 2026)).toEqual({ ok: true, year: 2025, format: 'csv' });
    expect(parseTaxExportArgs(['2025', 'xlsx'], 2026)).toEqual({ ok: true, year: 2025, format: 'xlsx' });
  });
  test('rejects anything else with usage', () => {
    const r = parseTaxExportArgs(['pdf'], 2026);
    expect(r.ok).toBe(false);
  });
});

describe('GET /api/export/tax', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) try { stopDashboardServer(s); } catch { /* */ }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    seed(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    return `http://localhost:${server.port}`;
  }

  test('returns the Schedule C xlsx by default', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/export/tax?year=2025`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('schedule-c-2025.xlsx');
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' });
    expect(wb.SheetNames).toEqual(['Schedule C 2025', 'Transactions']);
  });

  test('returns csv on request', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/export/tax?year=2025&format=csv`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(await res.text()).toContain('28,Total expenses,242.55,4');
  });

  test('400s on a bad year or format', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/export/tax?year=25`)).status).toBe(400);
    expect((await fetch(`${base}/api/export/tax?format=pdf`)).status).toBe(400);
  });

  test('402s with an upgrade link without a Pro license', async () => {
    mockHasLicense.mockReturnValue(false);
    const base = await start();
    const res = await fetch(`${base}/api/export/tax?year=2025`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { upgradeUrl?: string };
    expect(body.upgradeUrl).toBeTruthy();
  });
});
