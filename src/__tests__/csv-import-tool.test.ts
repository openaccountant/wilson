import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
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
