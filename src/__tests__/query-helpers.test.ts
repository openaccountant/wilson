import { describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';
import { insertTransactions, getTransactions, addCategory } from '../db/queries.js';
import { parseNaturalQuery, initTransactionSearchTool, transactionSearchTool } from '../tools/query/transaction-search.js';
import { computeSpendingSummary, initSpendingSummaryTool, spendingSummaryTool } from '../tools/query/spending-summary.js';
import { computeProfitLoss, initProfitLossTool, profitLossTool } from '../tools/query/profit-loss.js';
import { computeNetWorth, initNetWorthTool, netWorthTool } from '../tools/net-worth/net-worth.js';
import { formatToolResult } from '../tools/types.js';

/**
 * T08: read helpers take the database explicitly. Each test points the chat
 * tools' module-level connection at database A and calls the helper with
 * database B: if a helper still reached for the module global, A's rows would
 * show up.
 */

const today = () => new Date().toISOString().slice(0, 10);

function twoDbs() {
  const dbA = createTestDb();
  const dbB = createTestDb();
  insertTransactions(dbA, [
    { date: today(), description: 'Alpha Cafe', amount: -10, category: 'Dining' },
    { date: today(), description: 'Alpha Payroll', amount: 1000, category: 'Income' },
  ]);
  insertTransactions(dbB, [
    { date: today(), description: 'Beta Bistro', amount: -99, category: 'Dining' },
    { date: today(), description: 'Beta Payroll', amount: 5000, category: 'Income' },
  ]);
  for (const [db, bal] of [[dbA, 100], [dbB, 200]] as Array<[Database, number]>) {
    db.prepare("INSERT INTO accounts (name, account_type, account_subtype, current_balance) VALUES ('Main','asset','checking',@bal)").run({ bal });
  }
  initTransactionSearchTool(dbA);
  initSpendingSummaryTool(dbA);
  initProfitLossTool(dbA);
  initNetWorthTool(dbA);
  return { dbA, dbB };
}

describe('getTransactions(db, parseNaturalQuery(query, db))', () => {
  test('reads the given database', () => {
    const { dbA, dbB } = twoDbs();
    expect(getTransactions(dbB, parseNaturalQuery('bistro', dbB)).map((t) => t.description)).toEqual(['Beta Bistro']);
    expect(getTransactions(dbA, parseNaturalQuery('cafe', dbA)).map((t) => t.description)).toEqual(['Alpha Cafe']);
    expect(getTransactions(dbB, parseNaturalQuery('cafe', dbB))).toEqual([]);
  });

  test('category names are looked up in the given database too', () => {
    const { dbA, dbB } = twoDbs();
    addCategory(dbA, 'Pet Supplies');
    expect(parseNaturalQuery('pet supplies', dbA).category).toBe('Pet Supplies');
    // dbB has no such category, so the words fall through to a merchant search.
    const filters = parseNaturalQuery('pet supplies', dbB);
    expect(filters.category).toBeUndefined();
    expect(filters.merchant).toBe('pet supplies');
  });
});

describe('computeSpendingSummary(db)', () => {
  test('reads the given database', () => {
    const { dbB } = twoDbs();
    const out = computeSpendingSummary(dbB, { period: 'year' });
    expect(out.totalSpending).toBe(-99);
    expect(out.categories.map((c) => c.category)).toEqual(['Dining']);
    expect(out.previousPeriod).toBeUndefined();
  });

  test('compareWithPrevious adds the previous period', () => {
    const { dbB } = twoDbs();
    expect(computeSpendingSummary(dbB, { period: 'month', compareWithPrevious: true }).previousPeriod).toBeDefined();
  });

  test('period defaults to month', () => {
    const { dbB } = twoDbs();
    expect(computeSpendingSummary(dbB, {}).period).toBe(computeSpendingSummary(dbB, { period: 'month' }).period);
  });
});

describe('computeProfitLoss(db)', () => {
  test('reads the given database', () => {
    const { dbB } = twoDbs();
    const out = computeProfitLoss(dbB, { period: 'year' });
    expect(out.totalIncome).toBe(5000);
    expect(out.totalExpenses).toBe(-99);
    expect(out.netProfitLoss).toBe(4901);
  });
});

describe('computeNetWorth(db)', () => {
  test('reads the given database', () => {
    const { dbB } = twoDbs();
    expect(computeNetWorth(dbB, { action: 'summary' }).netWorth).toBe(200);
    const sheet = computeNetWorth(dbB, { action: 'balance_sheet' }) as any;
    expect(sheet.assets.map((a: any) => a.balance)).toEqual([200]);
  });

  test('no accounts yields the same message the chat tool always gave', () => {
    const db = createTestDb();
    expect(computeNetWorth(db, { action: 'summary' })).toEqual({ message: 'No accounts configured. Add accounts to track net worth.' });
    expect(computeNetWorth(db, { action: 'balance_sheet' })).toEqual({ message: 'No accounts configured.' });
  });
});

describe('chat tool output is unchanged for the same seed', () => {
  async function dataOf(raw: string) {
    return JSON.parse(raw).data;
  }

  test('spending_summary: chat output is exactly formatToolResult(helper)', async () => {
    const db = createTestDb();
    seedTestData(db);
    initSpendingSummaryTool(db);
    for (const args of [
      { period: 'month', compareWithPrevious: true },
      { period: 'quarter', compareWithPrevious: false },
      { period: 'year', compareWithPrevious: true },
    ] as const) {
      const raw = await spendingSummaryTool.func({ ...args });
      expect(raw).toBe(formatToolResult(computeSpendingSummary(db, args)));
    }
    const data = await dataOf(await spendingSummaryTool.func({ period: 'month', compareWithPrevious: true }));
    expect(Object.keys(data)).toEqual(['period', 'dateRange', 'totalSpending', 'transactionCount', 'categories', 'previousPeriod', 'formatted']);
    expect(data.formatted.startsWith('Spending Summary:')).toBe(true);
  });

  test('profit_loss: chat output is exactly formatToolResult(helper)', async () => {
    const db = createTestDb();
    seedTestData(db);
    initProfitLossTool(db);
    for (const args of [{ period: 'month', offset: 0 }, { period: 'year', offset: -1 }] as const) {
      expect(await profitLossTool.func({ ...args })).toBe(formatToolResult(computeProfitLoss(db, args)));
    }
    const data = await dataOf(await profitLossTool.func({ period: 'month', offset: 0 }));
    expect(data.formatted.startsWith('Profit & Loss:')).toBe(true);
    expect(data.dateRange.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  test('net_worth: chat output is exactly formatToolResult(helper); trend stays Pro-gated', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO accounts (name, account_type, account_subtype, current_balance) VALUES ('Main','asset','checking',500),('Card','liability','credit_card',50)").run();
    initNetWorthTool(db);
    for (const action of ['summary', 'balance_sheet'] as const) {
      expect(await netWorthTool.func({ action })).toBe(formatToolResult(computeNetWorth(db, { action })));
    }
    const trend = await dataOf(await netWorthTool.func({ action: 'trend' }));
    expect(trend.error).toContain('Pro feature');
  });

  test('transaction_search: chat output still lists the first 100 rows with a formatted table', async () => {
    const db = createTestDb();
    seedTestData(db);
    initTransactionSearchTool(db);
    const data = await dataOf(await transactionSearchTool.func({ query: 'groceries' }));
    expect(data.count).toBe(2);
    expect(data.transactions).toHaveLength(2);
    expect(data.formatted).toContain('Found 2 transactions');
    expect(data.filtersApplied.category).toBe('Groceries');
  });
});
