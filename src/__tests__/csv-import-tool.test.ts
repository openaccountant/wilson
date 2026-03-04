import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { Database } from '../db/compat-sqlite.js';
import { initImportTool, csvImportTool } from '../tools/import/csv-import.js';
import { getTransactions } from '../db/queries.js';
import { createTestDb, makeTmpPath } from './helpers.js';

const CHASE_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,
01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,
01/20/2026,01/21/2026,RESTAURANT,Dining,Sale,-45.00,`;

const AMEX_CSV = `Date,Description,Amount
01/15/2026,GROCERY STORE,85.50
01/18/2026,ELECTRIC CO,120.00`;

describe('csv_import tool', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  function writeTmp(content: string, ext = '.csv'): string {
    const fp = makeTmpPath(ext);
    writeFileSync(fp, content);
    tmpFiles.push(fp);
    return fp;
  }

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('imports Chase CSV successfully', async () => {
    const fp = writeTmp(CHASE_CSV);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(3);
    expect(result.data.bankDetected).toBe('chase');
  });

  test('imported transactions appear in DB', async () => {
    const fp = writeTmp(CHASE_CSV);
    await csvImportTool.func({ filePath: fp });
    const txns = getTransactions(db);
    expect(txns.length).toBe(3);
  });

  test('re-import same file is rejected (file-level dedup)', async () => {
    const fp = writeTmp(CHASE_CSV);
    await csvImportTool.func({ filePath: fp });

    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.alreadyImported).toBe(true);
    expect(result.data.message).toContain('already imported');
  });

  test('imports Amex CSV with amount negation', async () => {
    const fp = writeTmp(AMEX_CSV);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);

    const txns = getTransactions(db);
    // Amex amounts are positive in CSV but should be negated (expenses)
    expect(txns.every((t) => t.amount < 0)).toBe(true);
  });

  test('explicit bank override works', async () => {
    const fp = writeTmp(CHASE_CSV);
    const raw = await csvImportTool.func({ filePath: fp, bank: 'chase' });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.bankDetected).toBe('chase');
  });

  test('per-transaction dedup via external_id', async () => {
    // Import first file
    const fp1 = writeTmp(CHASE_CSV);
    await csvImportTool.func({ filePath: fp1 });

    // Create a second file with overlapping transactions + 1 new
    const csv2 = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,
01/25/2026,01/26/2026,NEW PURCHASE,Shopping,Sale,-50.00,`;
    const fp2 = writeTmp(csv2);
    const raw = await csvImportTool.func({ filePath: fp2 });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(1); // Only new one
    expect(result.data.transactionsSkipped).toBe(1); // Duplicate skipped
  });

  test('all transactions are duplicates returns message', async () => {
    const fp1 = writeTmp(CHASE_CSV);
    await csvImportTool.func({ filePath: fp1 });

    // Same transactions, different file content (different hash, but same external_ids)
    const csv2 = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,
01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,
01/20/2026,01/21/2026,RESTAURANT,Dining,Sale,-45.00,
`;
    const fp2 = writeTmp(csv2);
    const raw = await csvImportTool.func({ filePath: fp2 });
    const result = JSON.parse(raw as string);
    expect(result.data.alreadyImported).toBe(true);
    expect(result.data.message).toContain('already exist');
  });

  test('nonexistent file returns error', async () => {
    const raw = await csvImportTool.func({ filePath: '/nonexistent/file.csv' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Could not read file');
  });

  test('date range is recorded', async () => {
    const fp = writeTmp(CHASE_CSV);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange.start).toBe('2026-01-15');
    expect(result.data.dateRange.end).toBe('2026-01-20');
  });

  test('empty CSV returns error', async () => {
    const fp = writeTmp('Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n');
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('No valid transactions');
  });

  test('format detection label in message', async () => {
    const fp = writeTmp(CHASE_CSV);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('chase CSV');
  });
});

describe('csv_import edge cases', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  function writeTmp(content: string, ext = '.csv'): string {
    const fp = makeTmpPath(ext);
    writeFileSync(fp, content);
    tmpFiles.push(fp);
    return fp;
  }

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('CSV with MM/DD/YY date format (2-digit year) imported as-is via generic parser', async () => {
    // The generic parser's normalizeDate does not handle 2-digit years,
    // so dates pass through as-is. Verify parsing doesn't throw.
    const csv = `Date,Description,Amount
01/15/26,Coffee Shop,-5.50
02/20/26,Grocery Store,-42.00`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);
  });

  test('CSV with MM/DD/YYYY date format imports correctly', async () => {
    const csv = `Date,Description,Amount
03/15/2026,Rent Payment,-1200.00
03/20/2026,Utilities,-85.00`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);
    const txns = getTransactions(db);
    // normalizeDate should convert MM/DD/YYYY to YYYY-MM-DD
    expect(txns.some((t) => t.date === '2026-03-15')).toBe(true);
    expect(txns.some((t) => t.date === '2026-03-20')).toBe(true);
  });

  test('CSV missing amount/debit/credit column returns parse error', async () => {
    const csv = `Date,Description,Category
01/15/2026,Coffee Shop,Food
01/20/2026,Gas Station,Transportation`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toBeTruthy();
    expect(result.data.error).toContain('amount');
  });

  test('CSV with extra columns still parses correctly', async () => {
    const csv = `Date,Description,Amount,Extra1,Extra2
01/15/2026,Coffee Shop,-5.50,foo,bar
01/20/2026,Grocery,-42.00,baz,qux`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);
  });

  test('CSV with separate withdrawal/deposit columns', async () => {
    const csv = `Date,Description,Withdrawal,Deposit
01/15/2026,Coffee Shop,5.50,
01/20/2026,Paycheck,,3000.00`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);
    const txns = getTransactions(db);
    const debit = txns.find((t) => t.description === 'Coffee Shop');
    const credit = txns.find((t) => t.description === 'Paycheck');
    expect(debit!.amount).toBeLessThan(0);
    expect(credit!.amount).toBeGreaterThan(0);
  });

  test('CSV with only headers and no data rows', async () => {
    const csv = `Date,Description,Amount`;
    const fp = writeTmp(csv);
    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('No valid transactions');
  });
});

const CHASE_DIR_CSV = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
01/15/2026,01/16/2026,GROCERY STORE,Groceries,Sale,-85.50,
01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,`;

const AMEX_DIR_CSV = `Date,Description,Amount
02/10/2026,RESTAURANT,45.00
02/15/2026,GAS STATION,55.00`;

describe('csv_import directory support', () => {
  let db: Database;
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = makeTmpPath('.dir').replace('.dir', '');
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
  });

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  test('imports all CSV files from a directory', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'chase.csv'), CHASE_DIR_CSV);
    writeFileSync(join(dir, 'amex.csv'), AMEX_DIR_CSV);

    const raw = await csvImportTool.func({ filePath: dir });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.filesFound).toBe(2);
    expect(result.data.filesImported).toBe(2);
    expect(result.data.totalTransactionsImported).toBe(4);
  });

  test('skips non-importable files (.txt, .md)', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'chase.csv'), CHASE_DIR_CSV);
    writeFileSync(join(dir, 'notes.txt'), 'some notes');
    writeFileSync(join(dir, 'README.md'), '# readme');

    const raw = await csvImportTool.func({ filePath: dir });
    const result = JSON.parse(raw as string);
    expect(result.data.filesFound).toBe(1);
    expect(result.data.filesImported).toBe(1);
    expect(result.data.totalTransactionsImported).toBe(2);
  });

  test('empty directory returns error', async () => {
    const dir = makeTmpDir();

    const raw = await csvImportTool.func({ filePath: dir });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('No importable files');
  });

  test('directory with only non-importable files returns error', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'notes.txt'), 'some notes');

    const raw = await csvImportTool.func({ filePath: dir });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('No importable files');
  });

  test('already-imported files report skipped', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'chase.csv'), CHASE_DIR_CSV);

    // First import
    await csvImportTool.func({ filePath: dir });

    // Second import of same directory
    const raw = await csvImportTool.func({ filePath: dir });
    const result = JSON.parse(raw as string);
    expect(result.data.filesSkipped).toBe(1);
    expect(result.data.filesImported).toBe(0);
    expect(result.data.totalTransactionsImported).toBe(0);
  });

  test('single file path still works (regression)', async () => {
    const dir = makeTmpDir();
    const fp = join(dir, 'chase.csv');
    writeFileSync(fp, CHASE_DIR_CSV);

    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(2);
    expect(result.data.bankDetected).toBe('chase');
  });

  test('strips @ prefix from directory path', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'chase.csv'), CHASE_DIR_CSV);

    const raw = await csvImportTool.func({ filePath: `@${dir}` });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.filesImported).toBe(1);
  });
});
