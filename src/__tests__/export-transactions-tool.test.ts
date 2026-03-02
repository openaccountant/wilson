import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import type { Database } from '../db/compat-sqlite.js';
import { initExportTool, exportTransactionsTool } from '../tools/export/export-transactions.js';
import { insertTransactions } from '../db/queries.js';
import { createTestDb, makeTmpPath } from './helpers.js';

describe('export_transactions tool', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    db = createTestDb();
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Grocery Store', amount: -85.50, category: 'Groceries' },
      { date: '2026-02-18', description: 'Electric Company', amount: -120.00, category: 'Utilities' },
      { date: '2026-02-20', description: 'Restaurant', amount: -45.00, category: 'Dining' },
    ]);
    initExportTool(db);
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('CSV export writes file and returns success', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'csv', filePath });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsExported).toBe(3);
    expect(existsSync(filePath)).toBe(true);
  });

  test('XLSX export writes file', async () => {
    const filePath = makeTmpPath('.xlsx');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'xlsx', filePath });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(existsSync(filePath)).toBe(true);
  });

  test('CSV file contains transaction data', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    await exportTransactionsTool.func({ format: 'csv', filePath });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Grocery Store');
    expect(content).toContain('Groceries');
  });

  test('category filter narrows results', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'csv', filePath, category: 'Groceries' });
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsExported).toBe(1);
  });

  test('date range filter works', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({
      format: 'csv',
      filePath,
      dateStart: '2026-02-18',
      dateEnd: '2026-02-20',
    });
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsExported).toBe(2);
  });

  test('no matching transactions returns error message', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'csv', filePath, category: 'Nonexistent' });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(false);
    expect(result.data.message).toContain('No transactions found');
  });

  test('merchant filter narrows results', async () => {
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'csv', filePath, merchant: 'Restaurant' });
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsExported).toBe(1);
  });

  test('empty DB returns no transactions message', async () => {
    const emptyDb = createTestDb();
    initExportTool(emptyDb);
    const filePath = makeTmpPath('.csv');
    tmpFiles.push(filePath);

    const raw = await exportTransactionsTool.func({ format: 'csv', filePath });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(false);
  });
});
