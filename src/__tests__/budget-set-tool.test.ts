import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initBudgetSetTool, budgetSetTool } from '../tools/budget/budget-set.js';
import { getBudgets } from '../db/queries.js';
import { createTestDb } from './helpers.js';

describe('budget_set tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initBudgetSetTool(db);
  });

  test('sets a new budget and reads it back', async () => {
    const raw = await budgetSetTool.func({ category: 'Groceries', monthlyLimit: 300 });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('Groceries');
    expect(result.data.message).toContain('$300');

    const budgets = getBudgets(db);
    const groceries = budgets.find((b) => b.category === 'Groceries');
    expect(groceries?.monthly_limit).toBe(300);
  });

  test('upsert behavior: second set updates existing', async () => {
    await budgetSetTool.func({ category: 'Dining', monthlyLimit: 100 });
    await budgetSetTool.func({ category: 'Dining', monthlyLimit: 200 });

    const budgets = getBudgets(db);
    const dining = budgets.find((b) => b.category === 'Dining');
    expect(dining?.monthly_limit).toBe(200);
    expect(budgets.filter((b) => b.category === 'Dining')).toHaveLength(1);
  });

  test('returns category and limit in response', async () => {
    const raw = await budgetSetTool.func({ category: 'Entertainment', monthlyLimit: 150 });
    const result = JSON.parse(raw as string);
    expect(result.data.category).toBe('Entertainment');
    expect(result.data.monthlyLimit).toBe(150);
  });
});
