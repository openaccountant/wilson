import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initProfitLossTool, profitLossTool } from '../tools/query/profit-loss.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('profit_loss tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initProfitLossTool(db);
  });

  test('returns income and expenses', async () => {
    const raw = await profitLossTool.func({ period: 'year', offset: 0 });
    const result = JSON.parse(raw as string);
    expect(result.data.totalIncome).toBeGreaterThan(0);
    expect(result.data.totalExpenses).toBeLessThan(0);
  });

  test('net = income + expenses', async () => {
    const raw = await profitLossTool.func({ period: 'year', offset: 0 });
    const result = JSON.parse(raw as string);
    expect(result.data.netProfitLoss).toBeCloseTo(result.data.totalIncome + result.data.totalExpenses);
  });

  test('formatted output contains Profit & Loss header', async () => {
    const raw = await profitLossTool.func({ period: 'month', offset: 0 });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('Profit & Loss');
  });

  test('month period narrows to single month', async () => {
    const raw = await profitLossTool.func({ period: 'month', offset: -2 });
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  test('empty date range returns zeroes', async () => {
    const raw = await profitLossTool.func({ period: 'year', offset: -10 });
    const result = JSON.parse(raw as string);
    expect(result.data.totalIncome).toBe(0);
    expect(result.data.totalExpenses).toBe(0);
    expect(result.data.netProfitLoss).toBe(0);
  });

  test('income categories present', async () => {
    const raw = await profitLossTool.func({ period: 'year', offset: 0 });
    const result = JSON.parse(raw as string);
    expect(result.data.incomeByCategory.length).toBeGreaterThan(0);
  });
});
