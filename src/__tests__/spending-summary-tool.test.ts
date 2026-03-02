import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
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
