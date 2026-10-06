import { describe, expect, test, beforeEach, beforeAll, afterAll, setSystemTime } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { insertTransactions } from '../db/queries.js';
import { initSpendingSummaryTool, spendingSummaryTool } from '../tools/query/spending-summary.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('spending_summary tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initSpendingSummaryTool(db);
  });

  test('returns spending categories for month period', async () => {
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: false });
    const result = JSON.parse(raw as string);
    expect(result.data.categories).toBeDefined();
    expect(Array.isArray(result.data.categories)).toBe(true);
  });

  test('returns formatted output', async () => {
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: false });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('Spending Summary:');
  });

  test('compareWithPrevious includes previous period data', async () => {
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: true });
    const result = JSON.parse(raw as string);
    expect(result.data.previousPeriod).toBeDefined();
  });

  test('quarter period returns broader data', async () => {
    const raw = await spendingSummaryTool.func({ period: 'quarter', compareWithPrevious: false });
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange).toBeDefined();
  });

  test('year period includes full year', async () => {
    const raw = await spendingSummaryTool.func({ period: 'year', compareWithPrevious: false });
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange.start).toContain('-01-01');
    expect(result.data.dateRange.end).toContain('-12-31');
  });

  test('empty DB returns zero totals', async () => {
    const emptyDb = createTestDb();
    initSpendingSummaryTool(emptyDb);
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: false });
    const result = JSON.parse(raw as string);
    expect(result.data.totalSpending).toBe(0);
    expect(result.data.transactionCount).toBe(0);
  });
});

describe('spending_summary month argument (local agent only)', () => {
  // Not in the schema (cloud tool definitions stay unchanged): the local agent
  // sets it when the user names a month (src/agent/local-date-args.ts).
  beforeAll(() => setSystemTime(new Date('2026-10-03T12:00:00')));
  afterAll(() => setSystemTime());

  test('summarises the named month and compares with the month before it', async () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-08-12', description: 'Airline', amount: -640, category: 'Travel' },
      { date: '2026-07-03', description: 'Grocery Store', amount: -90, category: 'Groceries' },
      { date: '2026-10-01', description: 'Restaurant', amount: -40, category: 'Dining' },
    ]);
    initSpendingSummaryTool(db);
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: true, month: '2026-08' } as never);
    const { data } = JSON.parse(raw as string);
    expect(data.period).toBe('August 2026');
    expect(data.dateRange).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(data.totalSpending).toBe(-640);
    expect(data.previousPeriod.label).toBe('July 2026');
    expect(data.previousPeriod.totalSpending).toBe(-90);
  });

  test('a malformed month is ignored (current month)', async () => {
    initSpendingSummaryTool(createTestDb());
    const raw = await spendingSummaryTool.func({ period: 'month', compareWithPrevious: false, month: 'August' } as never);
    expect(JSON.parse(raw as string).data.period).toBe('October 2026');
  });
});
