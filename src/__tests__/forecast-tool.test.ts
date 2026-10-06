import { describe, expect, test } from 'bun:test';
import { createTestDb, daysAgoThisMonth } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { computeForecast } from '../tools/query/forecast.js';
import { executeRead } from '../mcp/tool-catalog.js';

describe('forecast tool', () => {
  test('projects flat cash forward when income equals expenses', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 1000 });
    insertTransactions(db, [
      { date: daysAgoThisMonth(20), description: 'Paycheck', amount: 2000, category: 'Income' },
      { date: daysAgoThisMonth(20), description: 'Rent', amount: -2000, category: 'Home' },
    ]);

    const result = computeForecast(db, { trailingMonths: 1, horizonMonths: 3 });
    expect(result.startingCash).toBe(1000);
    expect(result.trailingMonthlyNet).toBeCloseTo(0, 5);
    expect(result.projection).toHaveLength(3);
    expect(result.horizonEndCash).toBeCloseTo(1000, 5);
  });

  test('projects growth when income exceeds expenses', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Savings', account_type: 'asset', account_subtype: 'savings', current_balance: 5000 });
    insertTransactions(db, [
      { date: daysAgoThisMonth(10), description: 'Paycheck', amount: 3000, category: 'Income' },
      { date: daysAgoThisMonth(10), description: 'Groceries', amount: -500, category: 'Groceries' },
    ]);

    const result = computeForecast(db, { trailingMonths: 1, horizonMonths: 2 });
    expect(result.trailingMonthlyNet).toBeCloseTo(2500, 5);
    expect(result.projection[1].projectedCash).toBeGreaterThan(result.projection[0].projectedCash);
  });

  test('what-if adjust_category improves the projection when reducing spend', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 0 });
    insertTransactions(db, [
      { date: daysAgoThisMonth(5), description: 'Paycheck', amount: 3000, category: 'Income' },
      { date: daysAgoThisMonth(5), description: 'Dining out', amount: -800, category: 'Dining' },
    ]);

    const baseline = computeForecast(db, { trailingMonths: 1, horizonMonths: 1 });
    const adjusted = computeForecast(db, {
      trailingMonths: 1,
      horizonMonths: 1,
      whatIf: [{ type: 'adjust_category', category: 'Dining', monthlyDelta: -400 }],
    });
    expect(adjusted.adjustedMonthlyNet).toBeGreaterThan(baseline.trailingMonthlyNet);
    expect(adjusted.appliedAdjustments).toHaveLength(1);
  });

  test('what-if drop_recurring removes the matched recurring expense from the projection', () => {
    const db = createTestDb();
    insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 0 });
    insertTransactions(db, [
      { date: daysAgoThisMonth(5), description: 'Paycheck', amount: 3000, category: 'Income' },
      { date: daysAgoThisMonth(5), description: 'Netflix Subscription', amount: -15, category: 'Subscriptions', is_recurring: 1 },
    ]);

    const result = computeForecast(db, {
      trailingMonths: 1,
      horizonMonths: 1,
      whatIf: [{ type: 'drop_recurring', description: 'Netflix' }],
    });
    expect(result.appliedAdjustments[0].monthlyImpact).toBeCloseTo(15, 1);
  });

  test('handles no accounts and no transactions without throwing', () => {
    const db = createTestDb();
    const result = computeForecast(db);
    expect(result.startingCash).toBe(0);
    expect(result.projection).toHaveLength(3);
  });

  test('the horizon is capped at 24 months for every caller unless the caller raises the cap', () => {
    const db = createTestDb();
    expect(computeForecast(db, { horizonMonths: 60 }).horizonMonths).toBe(24);
    expect(computeForecast(db, { horizonMonths: 60 }).projection).toHaveLength(24);
    expect(computeForecast(db, { horizonMonths: 60, maxHorizonMonths: 60 }).projection).toHaveLength(60);
    expect(computeForecast(db, { horizonMonths: 100, maxHorizonMonths: 60 }).horizonMonths).toBe(60);
  });

  test('the MCP forecast tool is the one path that allows 60 months', async () => {
    const db = createTestDb();
    const out = (await executeRead(db, 'get_cash_forecast', { horizonMonths: 60 })) as { horizonMonths: number };
    expect(out.horizonMonths).toBe(60);
  });
});
