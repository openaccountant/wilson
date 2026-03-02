import { describe, expect, test, beforeEach, beforeAll, afterAll } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initTransactionSearchTool, transactionSearchTool } from '../tools/query/transaction-search.js';
import { insertTransactions } from '../db/queries.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('transaction_search tool', () => {
  let db: Database;
  let realDate: DateConstructor;

  beforeAll(() => {
    realDate = globalThis.Date;
    const MockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(2026, 2, 1); // March 1, 2026
        // @ts-ignore
        else super(...args);
      }
      static now() { return new realDate(2026, 2, 1).getTime(); }
    } as unknown as DateConstructor;
    globalThis.Date = MockDate;
  });

  afterAll(() => {
    globalThis.Date = realDate;
  });

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initTransactionSearchTool(db);
  });

  test('search by category keyword "groceries"', async () => {
    const raw = await transactionSearchTool.func({ query: 'groceries' });
    const result = JSON.parse(raw as string);
    expect(result.data.count).toBeGreaterThan(0);
    expect(result.data.filtersApplied.category).toBe('Groceries');
  });

  test('search "over $80" filters high amounts', async () => {
    const raw = await transactionSearchTool.func({ query: 'over $80' });
    const result = JSON.parse(raw as string);
    // Should find transactions with amount < -80
    for (const txn of result.data.transactions) {
      expect(txn.amount).toBeLessThanOrEqual(-80);
    }
  });

  test('search "last month" sets date range to February', async () => {
    const raw = await transactionSearchTool.func({ query: 'last month' });
    const result = JSON.parse(raw as string);
    expect(result.data.filtersApplied.dateStart).toBe('2026-02-01');
    expect(result.data.filtersApplied.dateEnd).toBe('2026-02-28');
  });

  test('search "in February" sets date range', async () => {
    const raw = await transactionSearchTool.func({ query: 'in February' });
    const result = JSON.parse(raw as string);
    expect(result.data.filtersApplied.dateStart).toBe('2026-02-01');
    expect(result.data.filtersApplied.dateEnd).toBe('2026-02-28');
  });

  test('search "recurring" sets isRecurring filter', async () => {
    const raw = await transactionSearchTool.func({ query: 'recurring charges' });
    const result = JSON.parse(raw as string);
    expect(result.data.filtersApplied.isRecurring).toBe(true);
  });

  test('category + date combo: "groceries in February"', async () => {
    const raw = await transactionSearchTool.func({ query: 'groceries in February' });
    const result = JSON.parse(raw as string);
    expect(result.data.filtersApplied.category).toBe('Groceries');
    expect(result.data.filtersApplied.dateStart).toBe('2026-02-01');
  });

  test('merchant name search via remaining words', async () => {
    insertTransactions(db, [
      { date: '2026-02-20', description: 'COSTCO WHOLESALE', amount: -150, category: 'Shopping' },
    ]);
    initTransactionSearchTool(db);
    const raw = await transactionSearchTool.func({ query: 'COSTCO' });
    const result = JSON.parse(raw as string);
    expect(result.data.filtersApplied.merchant).toContain('COSTCO');
  });

  test('no matches returns zero count', async () => {
    const raw = await transactionSearchTool.func({ query: 'zzz_nonexistent_merchant' });
    const result = JSON.parse(raw as string);
    expect(result.data.count).toBe(0);
  });

  test('formatted output includes "Found X transactions"', async () => {
    const raw = await transactionSearchTool.func({ query: 'groceries' });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('Found');
    expect(result.data.formatted).toContain('transaction');
  });
});
