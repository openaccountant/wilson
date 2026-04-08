import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initProfitDiffTool, profitDiffTool } from '../tools/query/profit-diff.js';
import { insertTransactions } from '../db/queries.js';
import { createTestDb, seedTestData, daysAgo } from './helpers.js';

describe('profit_diff tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    // Add data from previous month for comparison
    insertTransactions(db, [
      { date: daysAgo(45), description: 'Old Grocery', amount: -60, category: 'Groceries' },
      { date: daysAgo(40), description: 'Old Restaurant', amount: -30, category: 'Dining' },
    ]);
    initProfitDiffTool(db);
  });

  test('returns net delta between periods', async () => {
    const raw = await profitDiffTool.func({ period: 'month', offset: -1, compareOffset: -1 });
    const result = JSON.parse(raw as string);
    expect(typeof result.data.netDelta).toBe('number');
  });

  test('biggestMovers sorted by absolute delta', async () => {
    const raw = await profitDiffTool.func({ period: 'month', offset: -1, compareOffset: -1 });
    const result = JSON.parse(raw as string);
    const movers = result.data.biggestMovers;
    if (movers.length > 1) {
      expect(Math.abs(movers[0].delta)).toBeGreaterThanOrEqual(Math.abs(movers[1].delta));
    }
  });

  test('newCategories contains categories only in current period', async () => {
    // Add a category that only exists in the current period
    insertTransactions(db, [
      { date: daysAgo(5), description: 'Gym', amount: -50, category: 'Fitness' },
    ]);
    initProfitDiffTool(db);
    const raw = await profitDiffTool.func({ period: 'month', offset: 0, compareOffset: -1 });
    const result = JSON.parse(raw as string);
    expect(result.data.newCategories).toContain('Fitness');
  });

  test('percentChange is null when previous is 0', async () => {
    const raw = await profitDiffTool.func({ period: 'month', offset: -1, compareOffset: -1 });
    const result = JSON.parse(raw as string);
    const allDeltas = [...result.data.incomeDeltas, ...result.data.expenseDeltas];
    const newOnes = allDeltas.filter((d: any) => d.previous === 0);
    for (const d of newOnes) {
      expect(d.percentChange).toBeNull();
    }
  });

  test('formatted output contains comparison labels', async () => {
    const raw = await profitDiffTool.func({ period: 'month', offset: -1, compareOffset: -1 });
    const result = JSON.parse(raw as string);
    expect(result.data.formatted).toContain('P&L Comparison');
  });
});
