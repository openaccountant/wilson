import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { Database } from '../db/compat-sqlite.js';
import { printStatus, printSummary, printBudget, runExport, printPnl, printSavings, printTaxSummary } from '../reports.js';
import { flagTaxDeduction, getTransactions } from '../db/queries.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('reports', () => {
  let db: Database;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function allOutput(): string {
    return logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  // ── printStatus ─────────────────────────────────────────────────────────

  describe('printStatus', () => {
    test('output contains transaction count', async () => {
      await printStatus(db);
      const output = allOutput();
      expect(output).toContain('7');
    });

    test('output contains date range', async () => {
      await printStatus(db);
      const output = allOutput();
      expect(output).toContain('2026-01-10');
      expect(output).toContain('2026-03-05');
    });

    test('output contains categorized/uncategorized split', async () => {
      await printStatus(db);
      const output = allOutput();
      expect(output).toContain('Categorized:     6');
      expect(output).toContain('Uncategorized:   1');
    });
  });

  // ── printSummary ────────────────────────────────────────────────────────

  describe('printSummary', () => {
    test('default period is month', async () => {
      await printSummary(['--summary'], db);
      const output = allOutput();
      // Should contain "Spending Summary:" with a month label
      expect(output).toContain('Spending Summary:');
    });

    test('quarter period uses quarter', async () => {
      await printSummary(['--summary', 'quarter'], db);
      const output = allOutput();
      expect(output).toContain('Spending Summary:');
    });

    test('offset shifts period', async () => {
      await printSummary(['--summary', 'month', '--offset', '-1'], db);
      const output = allOutput();
      // Should show previous month's data — should have spending data from Feb
      expect(output).toContain('Spending Summary:');
    });

    test('empty data prints no spending data message', async () => {
      const emptyDb = createTestDb();
      await printSummary(['--summary'], emptyDb);
      const output = allOutput();
      expect(output).toContain('No spending data');
    });
  });

  // ── printBudget ─────────────────────────────────────────────────────────

  describe('printBudget', () => {
    test('shows Groceries and Dining budgets', async () => {
      await printBudget(['--budget', '--month', '2026-02'], db);
      const output = allOutput();
      expect(output).toContain('Groceries');
      expect(output).toContain('Dining');
    });

    test('actual amounts match seeded data', async () => {
      await printBudget(['--budget', '--month', '2026-02'], db);
      const output = allOutput();
      expect(output).toContain('$85.50');
      expect(output).toContain('$45.00');
    });

    test('no budgets message when none set', async () => {
      const emptyDb = createTestDb();
      await printBudget(['--budget', '--month', '2026-02'], emptyDb);
      const output = allOutput();
      expect(output).toContain('No budgets configured');
    });
  });

  // ── runExport ───────────────────────────────────────────────────────────

  describe('runExport', () => {
    test('CSV file written and non-empty', async () => {
      const tmpFile = path.join(os.tmpdir(), `wilson-test-${Date.now()}.csv`);
      await runExport(['--export', tmpFile], db);
      expect(fs.existsSync(tmpFile)).toBe(true);
      const content = fs.readFileSync(tmpFile, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      fs.unlinkSync(tmpFile);
    });

    test('XLSX file written', async () => {
      const tmpFile = path.join(os.tmpdir(), `wilson-test-${Date.now()}.xlsx`);
      await runExport(['--export', tmpFile, '--format', 'xlsx'], db);
      expect(fs.existsSync(tmpFile)).toBe(true);
      const stats = fs.statSync(tmpFile);
      expect(stats.size).toBeGreaterThan(0);
      fs.unlinkSync(tmpFile);
    });

    test('category filter reduces output', async () => {
      const allFile = path.join(os.tmpdir(), `wilson-test-all-${Date.now()}.csv`);
      const filteredFile = path.join(os.tmpdir(), `wilson-test-filtered-${Date.now()}.csv`);

      await runExport(['--export', allFile], db);
      await runExport(['--export', filteredFile, '--category', 'Groceries'], db);

      const allContent = fs.readFileSync(allFile, 'utf-8');
      const filteredContent = fs.readFileSync(filteredFile, 'utf-8');
      expect(filteredContent.length).toBeLessThan(allContent.length);

      fs.unlinkSync(allFile);
      fs.unlinkSync(filteredFile);
    });

    test('missing path prints error', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await runExport(['--export'], db);
      } catch {
        // expected — process.exit throws
      }

      expect(errorSpy).toHaveBeenCalled();
      const errorOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errorOutput).toContain('--export requires a file path');

      errorSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  // ── printPnl ──────────────────────────────────────────────────────────

  describe('printPnl', () => {
    test('shows income and expenses', async () => {
      await printPnl(['--pnl', 'year', '--offset', '0'], db);
      const output = allOutput();
      expect(output).toContain('Profit & Loss');
    });

    test('shows net profit or loss', async () => {
      await printPnl(['--pnl'], db);
      const output = allOutput();
      expect(output).toMatch(/NET (PROFIT|LOSS)/);
    });
  });

  // ── printSavings ──────────────────────────────────────────────────────

  describe('printSavings', () => {
    test('shows savings rate trend', async () => {
      await printSavings(['--savings'], db);
      const output = allOutput();
      expect(output).toContain('Savings Rate Trend');
    });

    test('shows months and rates', async () => {
      await printSavings(['--savings', '--months', '12'], db);
      const output = allOutput();
      expect(output).toContain('Month');
      expect(output).toContain('Rate');
    });
  });

  // ── printTaxSummary ───────────────────────────────────────────────────

  describe('printTaxSummary', () => {
    test('shows no deductions when empty', async () => {
      await printTaxSummary(['--tax-summary', '2026'], db);
      const output = allOutput();
      expect(output).toContain('No tax deductions');
    });

    test('shows deductions when present', async () => {
      const txns = getTransactions(db).filter((t) => t.amount < 0);
      flagTaxDeduction(db, txns[0].id, 'Office expense', 2026);
      flagTaxDeduction(db, txns[1].id, 'Travel', 2026);
      await printTaxSummary(['--tax-summary', '2026'], db);
      const output = allOutput();
      expect(output).toContain('Tax Deductions Summary');
      expect(output).toContain('Office expense');
      expect(output).toContain('Travel');
    });
  });
});
