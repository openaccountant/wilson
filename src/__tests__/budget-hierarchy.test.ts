import { describe, test, expect } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  insertTransactions,
  setBudget,
  getBudgetVsActual,
  clearBudget,
  getBudgets,
  getCategoryByName,
  addCategory,
} from '../db/queries.js';

describe('getBudgetVsActual — case-insensitive matching', () => {
  test('matches transactions regardless of category case', () => {
    const db = createTestDb();
    setBudget(db, 'Dining', 300);
    insertTransactions(db, [
      { date: '2026-03-10', description: 'Restaurant A', amount: -50, category: 'Dining' },
      { date: '2026-03-12', description: 'Restaurant B', amount: -30, category: 'dining' },
      { date: '2026-03-14', description: 'Restaurant C', amount: -20, category: 'DINING' },
    ]);

    const results = getBudgetVsActual(db, '2026-03');
    const dining = results.find(r => r.category === 'Dining')!;
    expect(dining.actual).toBe(100);
    expect(dining.remaining).toBe(200);
  });
});

describe('getBudgetVsActual — hierarchical rollup', () => {
  test('parent budget includes spending from child categories', () => {
    const db = createTestDb();

    // Create sub-categories under Dining
    const dining = getCategoryByName(db, 'Dining')!;
    addCategory(db, 'Coffee', dining.id, 'Coffee shops');
    addCategory(db, 'Fast Food', dining.id, 'Fast food');

    // Set budget on parent
    setBudget(db, 'Dining', 500);

    // Insert transactions in both parent and child categories
    insertTransactions(db, [
      { date: '2026-03-01', description: 'Nice Restaurant', amount: -80, category: 'Dining' },
      { date: '2026-03-05', description: 'Starbucks', amount: -15, category: 'Coffee' },
      { date: '2026-03-08', description: 'McDonalds', amount: -12, category: 'Fast Food' },
      { date: '2026-03-10', description: 'Blue Bottle', amount: -7, category: 'Coffee' },
    ]);

    const results = getBudgetVsActual(db, '2026-03');
    const diningBudget = results.find(r => r.category === 'Dining')!;

    // Parent budget should sum: 80 + 15 + 12 + 7 = 114
    expect(diningBudget.actual).toBe(114);
    expect(diningBudget.remaining).toBe(386);
    expect(diningBudget.over).toBe(false);
  });

  test('deeply nested categories roll up to grandparent budget', () => {
    const db = createTestDb();

    const dining = getCategoryByName(db, 'Dining')!;
    const coffeeId = addCategory(db, 'Coffee', dining.id);
    addCategory(db, 'Espresso', coffeeId, 'Espresso drinks');

    setBudget(db, 'Dining', 200);

    insertTransactions(db, [
      { date: '2026-03-01', description: 'Diner', amount: -30, category: 'Dining' },
      { date: '2026-03-02', description: 'Starbucks', amount: -10, category: 'Coffee' },
      { date: '2026-03-03', description: 'Espresso Bar', amount: -8, category: 'Espresso' },
    ]);

    const results = getBudgetVsActual(db, '2026-03');
    const diningBudget = results.find(r => r.category === 'Dining')!;

    // Should sum: 30 + 10 + 8 = 48
    expect(diningBudget.actual).toBe(48);
  });

  test('leaf-only budget does not pull from parent or siblings', () => {
    const db = createTestDb();

    const dining = getCategoryByName(db, 'Dining')!;
    addCategory(db, 'Coffee', dining.id);

    // Set budget ONLY on child
    setBudget(db, 'Coffee', 50);

    insertTransactions(db, [
      { date: '2026-03-01', description: 'Restaurant', amount: -100, category: 'Dining' },
      { date: '2026-03-02', description: 'Starbucks', amount: -25, category: 'Coffee' },
    ]);

    const results = getBudgetVsActual(db, '2026-03');
    expect(results.length).toBe(1);
    const coffeeBudget = results[0];
    expect(coffeeBudget.category).toBe('Coffee');
    expect(coffeeBudget.actual).toBe(25);
  });
});

describe('clearBudget — case-insensitive', () => {
  test('clears budget regardless of case', () => {
    const db = createTestDb();
    setBudget(db, 'Dining', 300);
    expect(getBudgets(db).length).toBe(1);

    const cleared = clearBudget(db, 'dining');
    expect(cleared).toBe(true);
    expect(getBudgets(db).length).toBe(0);
  });
});
