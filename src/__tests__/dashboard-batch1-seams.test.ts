import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { apiCoverage, apiDailySpending, apiTransactions } from '../dashboard/api.js';
import {
  dailySpendingPath,
  dayTransactionsPath,
  daySpendTotal,
  savingsPath,
  type OverviewFilters,
} from '../dashboard/ui/src/lib/overviewQueries.js';
import { buildHeatmapGrid } from '../dashboard/ui/src/lib/heatmapGrid.js';
import { parseHash } from '../dashboard/ui/src/lib/urlState.js';
import { formatAmount, money } from '../dashboard/ui/src/format.js';

/**
 * Cross-track seams of Charting Batch 1: URL state (day/account/entity/cat)
 * → the overview query builders → the data layer's dashboard endpoints, and
 * /api/coverage → the heatmap grid. Seeded fixtures only.
 */

const NONE: OverviewFilters = { accountId: null, entityId: null, category: null };

function seed() {
  const db = createTestDb();
  const accountId = insertAccount(db, {
    name: 'Checking',
    account_type: 'asset',
    account_subtype: 'checking',
    institution: 'Test Bank',
  });
  insertTransactions(db, [
    { date: '2026-03-10', description: 'Groceries', amount: -42.5, category: 'Groceries' },
    { date: '2026-03-10', description: 'Dinner', amount: -30, category: 'Dining' },
    { date: '2026-03-10', description: 'CARD PAYMENT', amount: -500, category: 'Credit Card' },
    { date: '2026-03-10', description: 'To savings', amount: -100, category: 'Transfer' },
    { date: '2026-03-10', description: 'Paycheck (stored negative)', amount: -1200, category: 'Income' },
    { date: '2026-03-10', description: 'Refund', amount: 8, category: 'Groceries' },
    { date: '2026-03-10', description: 'Mystery', amount: -4.25 },
    { date: '2026-05-02', description: 'Coffee', amount: -3.5, category: 'Dining' },
  ]);
  db.prepare("UPDATE transactions SET account_id = @a WHERE category = 'Groceries'").run({ a: accountId });
  return { db, accountId };
}

const qs = (path: string) => new URLSearchParams(path.slice(path.indexOf('?') + 1));

describe('overview query builders', () => {
  test('paths carry the header filters (encoded) and skip a closed day', () => {
    expect(dayTransactionsPath(null, NONE)).toBeNull();
    expect(dayTransactionsPath('2026-03-10', NONE)).toBe('/api/transactions?start=2026-03-10&end=2026-03-10&limit=50');
    expect(dayTransactionsPath('2026-03-10', { accountId: 3, entityId: 4, category: 'Food & Drink' })).toBe(
      '/api/transactions?start=2026-03-10&end=2026-03-10&limit=50&accountId=3&entityId=4&category=Food%20%26%20Drink',
    );
    expect(dailySpendingPath('2025-01-01', '2025-12-31', { ...NONE, category: 'Dining' })).toBe(
      '/api/daily-spending?startDate=2025-01-01&endDate=2025-12-31&category=Dining',
    );
    expect(savingsPath(NONE)).toBe('/api/savings');
    expect(savingsPath({ accountId: 1, entityId: null, category: 'Dining' })).toBe('/api/savings?accountId=1');
  });

  test('the URL day/account/entity/cat keys drive the day dialog fetch', () => {
    const s = parseHash('#overview?account=7&entity=2&cat=Dining&day=2026-03-10');
    expect(dayTransactionsPath(s.day, { accountId: s.account, entityId: s.entity, category: s.cat })).toBe(
      '/api/transactions?start=2026-03-10&end=2026-03-10&limit=50&accountId=7&entityId=2&category=Dining',
    );
  });

  test('daySpendTotal uses the SPEND rule', () => {
    expect(
      daySpendTotal([
        { amount: -10, category: 'Dining' },
        { amount: -500, category: 'Credit Card' },
        { amount: -1200, category: 'Income' },
        { amount: 25, category: 'Groceries' },
        { amount: -2.5, category: null },
      ]),
    ).toBe(12.5);
  });
});

describe('heatmap cell == day dialog total (server endpoints)', () => {
  const day = '2026-03-10';
  const cases: [string, (accountId: number) => OverviewFilters][] = [
    ['no filters', () => NONE],
    ['category', () => ({ ...NONE, category: 'Dining' })],
    ['Uncategorized', () => ({ ...NONE, category: 'Uncategorized' })],
    ['account', (accountId) => ({ ...NONE, accountId })],
  ];
  test.each(cases)('%s', (_label, filtersFor) => {
    const { db, accountId } = seed();
    const f = filtersFor(accountId);
    const cells = apiDailySpending(db, qs(dailySpendingPath(day, day, f))) as { date: string; spending: number }[];
    const cell = cells.find((c) => c.date === day)?.spending ?? 0;
    const rows = apiTransactions(db, qs(dayTransactionsPath(day, f)!));
    expect(daySpendTotal(rows)).toBe(cell);
    expect(cell).toBeGreaterThan(0);
  });

  test('the unfiltered day total excludes payments, transfers and negative income', () => {
    const { db } = seed();
    expect(daySpendTotal(apiTransactions(db, qs(dayTransactionsPath(day, NONE)!)))).toBe(42.5 + 30 + 4.25);
  });
});

describe('/api/coverage feeds the heatmap grid', () => {
  test('months without imports are uncovered and skipped by the tally', () => {
    const { db } = seed();
    const coverage = apiCoverage(db);
    expect(coverage).toEqual({ start: '2026-03-10', end: '2026-05-02', months: ['2026-03', '2026-05'] });
    const grid = buildHeatmapGrid({
      startDate: '2026-03-01',
      endDate: '2026-05-31',
      spending: new Map([['2026-03-10', 76.75]]),
      dailyBudget: 50,
      coverage,
      now: new Date(2026, 5, 15, 12),
    });
    const days = grid.weeks.flat();
    expect(days.find((d) => d.date === '2026-04-15')!.covered).toBe(false);
    expect(days.find((d) => d.date === '2026-03-09')!.covered).toBe(false); // before the first import
    expect(days.find((d) => d.date === '2026-03-10')!.covered).toBe(true);
    // Mar 10–31 (22) + May 1–2 (2) are covered; only Mar 10 is over budget.
    expect(grid.totalDays).toBe(24);
    expect(grid.underBudgetDays).toBe(23);
  });
});

describe('shared money formatter', () => {
  test('the legacy formatAmount is the shared money()', () => {
    for (const n of [0, -0.001, 12.5, -1234.567, 1_000_000]) expect(formatAmount(n)).toBe(money(n));
    expect(formatAmount(-1234.5)).toBe('-$1,234.50');
  });
});
