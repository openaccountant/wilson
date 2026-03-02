import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initBudgetCheckTool, budgetCheckTool } from '../tools/budget/budget-check.js';
import { setBudget, insertTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';

describe('budget_check tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initBudgetCheckTool(db);
  });

  test('no budgets returns helpful message', async () => {
    const raw = await budgetCheckTool.func({ month: '2026-02' });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('No budgets set');
  });

  test('returns budget vs actual data', async () => {
    setBudget(db, 'Groceries', 200);
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Store', amount: -85, category: 'Groceries' },
    ]);
    initBudgetCheckTool(db);

    const raw = await budgetCheckTool.func({ month: '2026-02' });
    const result = JSON.parse(raw as string);
    expect(result.data.budgets).toBeDefined();
    expect(result.data.budgets[0].category).toBe('Groceries');
    expect(result.data.budgets[0].actual).toBe(85);
    expect(result.data.budgets[0].status).toBe('OK');
  });

  test('shows OVER status when exceeded', async () => {
    setBudget(db, 'Dining', 50);
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Fancy Restaurant', amount: -80, category: 'Dining' },
    ]);
    initBudgetCheckTool(db);

    const raw = await budgetCheckTool.func({ month: '2026-02' });
    const result = JSON.parse(raw as string);
    const dining = result.data.budgets.find((b: any) => b.category === 'Dining');
    expect(dining.status).toBe('OVER');
  });

  test('category filter narrows results', async () => {
    setBudget(db, 'Groceries', 200);
    setBudget(db, 'Dining', 100);
    insertTransactions(db, [
      { date: '2026-02-15', description: 'Store', amount: -50, category: 'Groceries' },
      { date: '2026-02-15', description: 'Food', amount: -30, category: 'Dining' },
    ]);
    initBudgetCheckTool(db);

    const raw = await budgetCheckTool.func({ month: '2026-02', category: 'Groceries' });
    const result = JSON.parse(raw as string);
    expect(result.data.budgets).toHaveLength(1);
    expect(result.data.budgets[0].category).toBe('Groceries');
  });

  test('defaults to current month when no month specified', async () => {
    setBudget(db, 'Test', 100);
    const raw = await budgetCheckTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.month).toMatch(/^\d{4}-\d{2}$/);
  });

  test('no matching category returns message', async () => {
    setBudget(db, 'Groceries', 200);
    const raw = await budgetCheckTool.func({ month: '2026-02', category: 'Nonexistent' });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('No budget set');
  });
});
