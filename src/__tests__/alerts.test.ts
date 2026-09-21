import { describe, expect, test, beforeEach, beforeAll, afterAll, setSystemTime } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { checkAlerts } from '../alerts/engine.js';
import { setBudget, insertTransactions } from '../db/queries.js';
import { createTestDb, seedTestData } from './helpers.js';

describe('alerts', () => {
  let db: Database;

  // Freeze the clock to a fixed mid-month date so "current month" budget
  // math is deterministic regardless of what day the suite runs on. Without
  // this, seedTestData's daysAgo(10)/daysAgo(2..8) offsets can straddle a
  // real month boundary and silently change how much "current month"
  // Groceries spend checkAlerts sees (see #23).
  beforeAll(() => {
    setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });

  afterAll(() => {
    setSystemTime(); // restore real system time
  });

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  /**
   * Current-month Groceries spend from the seed data. Varies with the calendar
   * (daysAgo(10) can fall into the previous month), so tests derive budgets
   * from it instead of assuming a fixed dollar figure.
   */
  function groceriesActual(): number {
    const month = new Date().toISOString().slice(0, 7);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE category = 'Groceries' AND substr(date, 1, 7) = @month`
      )
      .get({ month }) as { total: number };
    return Math.abs(row.total);
  }

  test('no alerts when budgets are healthy', () => {
    // Keep Groceries at 50% of actual and Dining at 45% — both under 80%
    setBudget(db, 'Groceries', Math.max(1, Math.ceil(groceriesActual() / 0.5)));
    const alerts = checkAlerts(db);
    const budgetAlerts = alerts.filter((a) => a.type.startsWith('budget_'));
    expect(budgetAlerts).toHaveLength(0);
  });

  test('budget_warning at 80%+', () => {
    // Budget Groceries at ~90% of actual spend — warning territory (80–100%)
    setBudget(db, 'Groceries', Math.max(1, Math.ceil(groceriesActual() / 0.9)));
    const alerts = checkAlerts(db);
    const warning = alerts.find((a) => a.type === 'budget_warning' && a.category === 'Groceries');
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe('warning');
  });

  test('budget_exceeded at 100%+', () => {
    // Set Groceries budget to $50 — $85.50 actual = 171%
    setBudget(db, 'Groceries', 50);
    const alerts = checkAlerts(db);
    const exceeded = alerts.find((a) => a.type === 'budget_exceeded' && a.category === 'Groceries');
    expect(exceeded).toBeDefined();
    expect(exceeded?.severity).toBe('critical');
  });

  test('returns array even with no data', () => {
    const emptyDb = createTestDb();
    const alerts = checkAlerts(emptyDb);
    expect(Array.isArray(alerts)).toBe(true);
  });

  test('spending spike detected for outlier', () => {
    // Create a merchant with consistent low amounts, then a spike
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    insertTransactions(db, [
      { date: thirtyDaysAgo, description: 'Test Merchant', amount: -10 },
      { date: thirtyDaysAgo, description: 'Test Merchant', amount: -10 },
      { date: thirtyDaysAgo, description: 'Test Merchant', amount: -10 },
      { date: today, description: 'Test Merchant', amount: -100 }, // 10x average
    ]);
    const alerts = checkAlerts(db);
    const spike = alerts.find((a) => a.type === 'spending_spike');
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe('warning');
  });

  test('budget at exactly 100% triggers exceeded', () => {
    // Set Groceries budget to exactly the spent amount ($85.50)
    setBudget(db, 'Groceries', 85.50);
    const alerts = checkAlerts(db);
    const exceeded = alerts.find((a) => a.type === 'budget_exceeded' && a.category === 'Groceries');
    expect(exceeded).toBeDefined();
    expect(exceeded?.severity).toBe('critical');
  });

  test('no transactions for budget category shows no alert', () => {
    // Create a budget for a category with no transactions
    setBudget(db, 'Travel', 500);
    const alerts = checkAlerts(db);
    const travelAlerts = alerts.filter((a) => a.category === 'Travel');
    expect(travelAlerts).toHaveLength(0);
  });

  test('new recurring charge detected', () => {
    // Insert a single recurring charge within last 30 days
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO transactions (date, description, amount, category, is_recurring) VALUES (@date, @description, @amount, @category, @isRecurring)`
    ).run({ date: recent, description: 'NEW SUBSCRIPTION', amount: -9.99, category: 'Entertainment', isRecurring: 1 });

    const alerts = checkAlerts(db);
    const newRecurring = alerts.find((a) => a.type === 'new_recurring');
    expect(newRecurring).toBeDefined();
    expect(newRecurring?.severity).toBe('info');
    expect(newRecurring?.message).toContain('NEW SUBSCRIPTION');
    expect(newRecurring?.amount).toBeCloseTo(9.99);
  });
});
