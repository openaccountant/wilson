import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initSavingsRateTool, savingsRateTool } from '../tools/query/savings-rate.js';
import { createTestDb, seedTestData, currentMonth, daysAgo } from './helpers.js';

describe('savings_rate tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initSavingsRateTool(db);
  });

  test('returns monthly savings data', async () => {
    const raw = await savingsRateTool.func({ months: 6 });
    const result = JSON.parse(raw as string);
    expect(result.data.months).toBeDefined();
    expect(Array.isArray(result.data.months)).toBe(true);
  });

  test('formatted output includes 50/30/20 benchmark when income exists', async () => {
    // Paycheck is daysAgo(30) — end on that month so the latest month has income
    const paycheckMonth = daysAgo(30).slice(0, 7);
    const raw = await savingsRateTool.func({ months: 1, endMonth: paycheckMonth });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('50/30/20');
  });

  test('empty DB returns no data message', async () => {
    const emptyDb = createTestDb();
    initSavingsRateTool(emptyDb);
    const raw = await savingsRateTool.func({ months: 3 });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('No income/expense data');
  });

  test('each month has income, expenses, savings, savingsRate', async () => {
    const raw = await savingsRateTool.func({ months: 3, endMonth: currentMonth() });
    const result = JSON.parse(raw as string);
    for (const m of result.data.months) {
      expect(typeof m.income).toBe('number');
      expect(typeof m.expenses).toBe('number');
      expect(typeof m.savings).toBe('number');
      expect(typeof m.savingsRate).toBe('number');
    }
  });
});
