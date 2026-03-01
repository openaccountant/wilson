import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import {
  getTransactions,
  getSpendingSummary,
  getUncategorizedTransactions,
  insertTransactions,
  checkExternalId,
  setBudget,
  getBudgets,
  getBudgetVsActual,
  getProfitLoss,
  getMonthlySavingsData,
  addRule,
  updateRule,
  deleteRule,
  getRules,
  matchRule,
  flagTaxDeduction,
  unflagTaxDeduction,
  getTaxDeductions,
  getTaxSummary,
} from '../db/queries.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('queries', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  // ── getTransactions ──────────────────────────────────────────────────────

  describe('getTransactions', () => {
    test('no filters returns all 7 transactions', () => {
      const rows = getTransactions(db);
      expect(rows).toHaveLength(7);
    });

    test('date range filter narrows results', () => {
      const rows = getTransactions(db, { dateStart: '2026-02-01', dateEnd: '2026-02-28' });
      // Feb transactions: Grocery Store, Electric Company, Restaurant, Unknown Purchase
      expect(rows).toHaveLength(4);
    });

    test('category filter works', () => {
      const rows = getTransactions(db, { category: 'Groceries' });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.category === 'Groceries')).toBe(true);
    });

    test('combined filters work', () => {
      const rows = getTransactions(db, {
        dateStart: '2026-02-01',
        dateEnd: '2026-02-28',
        category: 'Groceries',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Grocery Store');
      expect(rows[0].amount).toBe(-85.50);
    });
  });

  // ── getSpendingSummary ───────────────────────────────────────────────────

  describe('getSpendingSummary', () => {
    test('groups by category for Feb 2026', () => {
      const rows = getSpendingSummary(db, '2026-02-01', '2026-02-28');
      const categories = rows.map((r) => r.category);
      expect(categories).toContain('Groceries');
      expect(categories).toContain('Utilities');
      expect(categories).toContain('Dining');
      expect(categories).toContain('Uncategorized');
    });

    test('totals match seeded amounts', () => {
      const rows = getSpendingSummary(db, '2026-02-01', '2026-02-28');
      const groceries = rows.find((r) => r.category === 'Groceries');
      expect(groceries?.total).toBe(-85.50);
      expect(groceries?.count).toBe(1);

      const utilities = rows.find((r) => r.category === 'Utilities');
      expect(utilities?.total).toBe(-120.00);
    });

    test('uncategorized bucket present', () => {
      const rows = getSpendingSummary(db, '2026-02-01', '2026-02-28');
      const uncat = rows.find((r) => r.category === 'Uncategorized');
      expect(uncat).toBeDefined();
      expect(uncat?.total).toBe(-30.00);
    });
  });

  // ── getUncategorizedTransactions ─────────────────────────────────────────

  describe('getUncategorizedTransactions', () => {
    test('returns only null-category rows', () => {
      const rows = getUncategorizedTransactions(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].description).toBe('Unknown Purchase');
    });

    test('limit param works', () => {
      // Add a second uncategorized transaction
      insertTransactions(db, [
        { date: '2026-02-26', description: 'Mystery Charge', amount: -15.00 },
      ]);
      const all = getUncategorizedTransactions(db);
      expect(all).toHaveLength(2);

      const limited = getUncategorizedTransactions(db, 1);
      expect(limited).toHaveLength(1);
    });
  });

  // ── insertTransactions ──────────────────────────────────────────────────

  describe('insertTransactions', () => {
    test('returns correct insert count', () => {
      const freshDb = createTestDb();
      const count = insertTransactions(freshDb, [
        { date: '2026-04-01', description: 'Test', amount: -10.00 },
        { date: '2026-04-02', description: 'Test 2', amount: -20.00 },
      ]);
      expect(count).toBe(2);
    });

    test('data roundtrips correctly', () => {
      const freshDb = createTestDb();
      insertTransactions(freshDb, [
        { date: '2026-04-01', description: 'Coffee Shop', amount: -5.75, category: 'Dining' },
      ]);
      const rows = getTransactions(freshDb);
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe('2026-04-01');
      expect(rows[0].description).toBe('Coffee Shop');
      expect(rows[0].amount).toBe(-5.75);
      expect(rows[0].category).toBe('Dining');
    });
  });

  // ── checkExternalId ────────────────────────────────────────────────────

  describe('checkExternalId', () => {
    test('returns false for non-existent external_id', () => {
      expect(checkExternalId(db, 'nonexistent-id-123')).toBe(false);
    });

    test('returns true for existing external_id', () => {
      insertTransactions(db, [
        { date: '2026-04-01', description: 'Plaid Txn', amount: -25.00, external_id: 'ext-abc-123' },
      ]);
      expect(checkExternalId(db, 'ext-abc-123')).toBe(true);
    });
  });

  // ── insertTransactions with new columns ───────────────────────────────

  describe('insertTransactions with enriched fields', () => {
    test('merchant_name and category_detailed roundtrip', () => {
      const freshDb = createTestDb();
      insertTransactions(freshDb, [
        {
          date: '2026-04-01',
          description: 'AMZN Mktp US*AB1CD2EF3',
          amount: -42.99,
          category: 'Shopping',
          merchant_name: 'Amazon',
          category_detailed: 'Online Marketplace',
        },
      ]);
      const rows = getTransactions(freshDb);
      expect(rows).toHaveLength(1);
      expect(rows[0].merchant_name).toBe('Amazon');
      expect(rows[0].category_detailed).toBe('Online Marketplace');
    });

    test('external_id dedup via checkExternalId', () => {
      const freshDb = createTestDb();
      insertTransactions(freshDb, [
        { date: '2026-04-01', description: 'Test Txn', amount: -10.00, external_id: 'dedup-001' },
      ]);
      expect(checkExternalId(freshDb, 'dedup-001')).toBe(true);
      expect(checkExternalId(freshDb, 'dedup-002')).toBe(false);
    });
  });

  // ── setBudget / getBudgets ──────────────────────────────────────────────

  describe('setBudget / getBudgets', () => {
    test('set then get', () => {
      const budgets = getBudgets(db);
      expect(budgets).toHaveLength(2);
      const groceries = budgets.find((b) => b.category === 'Groceries');
      expect(groceries?.monthly_limit).toBe(200);
    });

    test('upsert updates existing', () => {
      setBudget(db, 'Groceries', 300);
      const budgets = getBudgets(db);
      const groceries = budgets.find((b) => b.category === 'Groceries');
      expect(groceries?.monthly_limit).toBe(300);
      // Should still be 2 total budgets, not 3
      expect(budgets).toHaveLength(2);
    });
  });

  // ── getBudgetVsActual ───────────────────────────────────────────────────

  describe('getBudgetVsActual', () => {
    test('correct actual amounts for Feb 2026', () => {
      const rows = getBudgetVsActual(db, '2026-02');
      const groceries = rows.find((r) => r.category === 'Groceries');
      expect(groceries?.actual).toBe(85.50);
      expect(groceries?.monthly_limit).toBe(200);
    });

    test('remaining calculation', () => {
      const rows = getBudgetVsActual(db, '2026-02');
      const groceries = rows.find((r) => r.category === 'Groceries');
      expect(groceries?.remaining).toBe(200 - 85.50);
    });

    test('percent_used', () => {
      const rows = getBudgetVsActual(db, '2026-02');
      const groceries = rows.find((r) => r.category === 'Groceries');
      expect(groceries?.percent_used).toBe(Math.round((85.50 / 200) * 100));
    });

    test('over flag when exceeded', () => {
      // Set a very low budget that will be exceeded
      setBudget(db, 'Groceries', 50);
      const rows = getBudgetVsActual(db, '2026-02');
      const groceries = rows.find((r) => r.category === 'Groceries');
      expect(groceries?.over).toBe(true);
      expect(groceries?.remaining).toBeLessThan(0);
    });
  });

  // ── getProfitLoss ────────────────────────────────────────────────────────

  describe('getProfitLoss', () => {
    test('income includes positive amounts', () => {
      const pnl = getProfitLoss(db, '2026-01-01', '2026-01-31');
      expect(pnl.totalIncome).toBe(3500);
      expect(pnl.incomeByCategory).toHaveLength(1);
      expect(pnl.incomeByCategory[0].category).toBe('Income');
    });

    test('expenses exclude Income and Transfer categories', () => {
      const pnl = getProfitLoss(db, '2026-02-01', '2026-02-28');
      const cats = pnl.expensesByCategory.map((r) => r.category);
      expect(cats).not.toContain('Income');
      expect(cats).not.toContain('Transfer');
    });

    test('net profit/loss is income + expenses', () => {
      const pnl = getProfitLoss(db, '2026-01-01', '2026-03-31');
      expect(pnl.netProfitLoss).toBeCloseTo(pnl.totalIncome + pnl.totalExpenses);
    });

    test('empty date range returns zeroes', () => {
      const pnl = getProfitLoss(db, '2025-01-01', '2025-01-31');
      expect(pnl.totalIncome).toBe(0);
      expect(pnl.totalExpenses).toBe(0);
      expect(pnl.netProfitLoss).toBe(0);
    });
  });

  // ── getMonthlySavingsData ───────────────────────────────────────────────

  describe('getMonthlySavingsData', () => {
    test('returns monthly breakdown', () => {
      const data = getMonthlySavingsData(db, '2026-03', 3);
      expect(data.length).toBeGreaterThan(0);
      for (const m of data) {
        expect(m.month).toMatch(/^\d{4}-\d{2}$/);
        expect(typeof m.income).toBe('number');
        expect(typeof m.expenses).toBe('number');
        expect(typeof m.savings).toBe('number');
        expect(typeof m.savingsRate).toBe('number');
      }
    });

    test('savings = income - expenses', () => {
      const data = getMonthlySavingsData(db, '2026-03', 3);
      for (const m of data) {
        expect(m.savings).toBeCloseTo(m.income - m.expenses);
      }
    });

    test('January shows income from paycheck', () => {
      const data = getMonthlySavingsData(db, '2026-01', 1);
      const jan = data.find((m) => m.month === '2026-01');
      expect(jan?.income).toBe(3500);
    });
  });

  // ── Rule CRUD ──────────────────────────────────────────────────────────

  describe('categorization rules', () => {
    test('addRule and getRules', () => {
      const id = addRule(db, '*AMAZON*', 'Shopping', 10);
      expect(id).toBeGreaterThan(0);
      const rules = getRules(db);
      expect(rules).toHaveLength(1);
      expect(rules[0].pattern).toBe('*AMAZON*');
      expect(rules[0].category).toBe('Shopping');
      expect(rules[0].priority).toBe(10);
    });

    test('updateRule changes fields', () => {
      const id = addRule(db, '*STARBUCKS*', 'Dining');
      const updated = updateRule(db, id, { category: 'Coffee', priority: 5 });
      expect(updated).toBe(true);
      const rules = getRules(db);
      const rule = rules.find((r) => r.id === id);
      expect(rule?.category).toBe('Coffee');
      expect(rule?.priority).toBe(5);
    });

    test('deleteRule removes rule', () => {
      const id = addRule(db, '*TEST*', 'Other');
      expect(deleteRule(db, id)).toBe(true);
      expect(deleteRule(db, id)).toBe(false);
    });

    test('matchRule with glob pattern', () => {
      addRule(db, '*AMAZON*', 'Shopping');
      const match = matchRule(db, 'AMZN MKTP US AMAZON.COM');
      expect(match).not.toBeNull();
      expect(match?.category).toBe('Shopping');
    });

    test('matchRule with regex', () => {
      addRule(db, 'starbucks|peet', 'Coffee', 0, true);
      expect(matchRule(db, 'STARBUCKS STORE 123')?.category).toBe('Coffee');
      expect(matchRule(db, 'PEETS COFFEE')?.category).toBe('Coffee');
      expect(matchRule(db, 'DUNKIN DONUTS')).toBeNull();
    });

    test('matchRule respects priority', () => {
      addRule(db, '*COFFEE*', 'Dining', 1);
      addRule(db, '*COFFEE*', 'Coffee', 10);
      const match = matchRule(db, 'BLUE BOTTLE COFFEE');
      expect(match?.category).toBe('Coffee');
    });

    test('matchRule returns null when no match', () => {
      addRule(db, '*SPECIFIC_PATTERN*', 'Other');
      expect(matchRule(db, 'Totally different description')).toBeNull();
    });
  });

  // ── Tax deductions ─────────────────────────────────────────────────────

  describe('tax deductions', () => {
    test('flagTaxDeduction and getTaxDeductions', () => {
      const txns = getTransactions(db);
      const txn = txns[0];
      flagTaxDeduction(db, txn.id, 'Office expense', 2026, 'Test note');
      const deductions = getTaxDeductions(db, 2026);
      expect(deductions).toHaveLength(1);
      expect(deductions[0].irs_category).toBe('Office expense');
      expect(deductions[0].notes).toBe('Test note');
    });

    test('unflagTaxDeduction removes deduction', () => {
      const txns = getTransactions(db);
      flagTaxDeduction(db, txns[0].id, 'Supplies', 2026);
      expect(unflagTaxDeduction(db, txns[0].id)).toBe(true);
      expect(unflagTaxDeduction(db, txns[0].id)).toBe(false);
    });

    test('getTaxSummary groups by IRS category', () => {
      const txns = getTransactions(db).filter((t) => t.amount < 0);
      flagTaxDeduction(db, txns[0].id, 'Office expense', 2026);
      flagTaxDeduction(db, txns[1].id, 'Office expense', 2026);
      flagTaxDeduction(db, txns[2].id, 'Travel', 2026);

      const summary = getTaxSummary(db, 2026);
      expect(summary).toHaveLength(2);
      const office = summary.find((s) => s.irs_category === 'Office expense');
      expect(office?.count).toBe(2);
    });

    test('getTaxDeductions filters by category', () => {
      const txns = getTransactions(db).filter((t) => t.amount < 0);
      flagTaxDeduction(db, txns[0].id, 'Travel', 2026);
      flagTaxDeduction(db, txns[1].id, 'Supplies', 2026);

      const travel = getTaxDeductions(db, 2026, 'Travel');
      expect(travel).toHaveLength(1);
      expect(travel[0].irs_category).toBe('Travel');
    });

    test('flag upserts on conflict', () => {
      const txns = getTransactions(db);
      flagTaxDeduction(db, txns[0].id, 'Travel', 2026);
      flagTaxDeduction(db, txns[0].id, 'Supplies', 2026);
      const deductions = getTaxDeductions(db, 2026);
      expect(deductions).toHaveLength(1);
      expect(deductions[0].irs_category).toBe('Supplies');
    });
  });
});
