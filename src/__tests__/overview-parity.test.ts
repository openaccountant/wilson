import { beforeAll, describe, expect, test } from 'bun:test';
import { createTestDb, daysAgo, currentMonth, previousMonth } from './helpers.js';
import { Database } from '../db/compat-sqlite.js';
import {
  apiSummary,
  apiPnl,
  apiBudgets,
  apiSavings,
  apiTransactions,
  apiEntities,
  apiBudgetLimits,
  apiCategories,
  apiDailySpending,
  apiStreak,
  apiWeeklySummary,
  apiBudgetCountdown,
} from '../dashboard/api.js';
import { insertTransactions, setBudget, addCategory, getCategoryByName, getBudgets } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { createEntity } from '../db/entity-queries.js';
import {
  applySync,
  createMirrorSchema,
} from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { MirrorTestBinding } from './mirror-helpers.js';
import {
  computeStreak,
  computeStreakDailyBudget,
  weekWindows,
  countdownDaysLeft,
  savingsWindow,
  toMonthlyIncomeExpense,
  summarizePnl,
  budgetActualRow,
} from '../db/overview-sql.js';
import type {
  MirrorTransactionRow,
  MirrorEntityRow,
  MirrorBudgetRow,
  MirrorCategoryRow,
} from '../dashboard/ui/src/store/types.js';

/**
 * THE aggregation-equivalence gate for the offline overview cards: for
 * identical seed data, every offline overview card's computation
 * (serveApiPath over the local mirror) must deep-equal its server endpoint's
 * output (the api handler over the real server db).
 *
 * Setup mirrors the sync engine exactly: the mirror is seeded from the
 * server's own raw pulls — apiTransactions (huge limit) + apiEntities +
 * apiBudgetLimits + apiCategories — over the SAME per-profile path. The
 * budgets include a parent budget whose child categories carry spending, so
 * the recursive rollup runs on both sides.
 *
 * Float discipline: every fixture amount is exactly representable (halves,
 * quarters, integers) so SUM is order-insensitive across SQLite engines.
 * Dates are relative (daysAgo) so the time-window endpoints get real data on
 * any run day.
 */

const serverDb: Database = createTestDb();
let mirrorBinding: MirrorTestBinding;

// ── Seed: budgets + category hierarchy ──────────────────────────────────────

setBudget(serverDb, 'Groceries', 900);
setBudget(serverDb, 'Dining', 500);

// A parent budget (Dining) with child categories: budget-vs-actual must roll
// spending up through categories.parent_id via the recursive CTE on BOTH sides.
const dining = getCategoryByName(serverDb, 'Dining')!;
const coffeeId = addCategory(serverDb, 'Coffee', dining.id, 'Coffee shops');
const espressoId = addCategory(serverDb, 'Espresso', coffeeId, 'Espresso drinks');

// ── Seed: transactions (relative dates, binary-exact amounts) ────────────────

insertTransactions(serverDb, [
  // This week / today
  { date: daysAgo(0), description: 'Espresso Bar', amount: -7.25, category: 'Espresso', merchant_name: 'Espresso Bar' },
  { date: daysAgo(1), description: 'Nice Restaurant', amount: -30, category: 'Dining', merchant_name: 'Nice Restaurant' },
  { date: daysAgo(2), description: 'Grocery Store', amount: -55.5, category: 'Groceries' },
  { date: daysAgo(3), description: 'Gas Station', amount: -12, category: 'Transport' },
  { date: daysAgo(4), description: 'Unknown Purchase', amount: -20 },
  // Income / Transfer edge cases
  { date: daysAgo(5), description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: daysAgo(6), description: 'Transfer to savings', amount: -500, category: 'Transfer' },
  // Last week (and earlier, whichever window the run day lands them in)
  { date: daysAgo(8), description: 'Diner', amount: -25.5, category: 'Dining' },
  { date: daysAgo(9), description: 'Trader Joes', amount: -60, category: 'Groceries', merchant_name: 'Trader Joes' },
  { date: daysAgo(14), description: 'Book Store', amount: -80, category: 'Shopping' },
  // 1–6 months back (savings sparkline window)
  { date: daysAgo(35), description: 'Diner', amount: -45, category: 'Dining' },
  { date: daysAgo(40), description: 'Freelance invoice', amount: 2800, category: 'Income' },
  { date: daysAgo(65), description: 'Grocery run', amount: -75.25, category: 'Groceries' },
  { date: daysAgo(95), description: 'Electric Company', amount: -130.5, category: 'Utilities' },
  { date: daysAgo(125), description: 'Paycheck', amount: 2500, category: 'Income' },
  { date: daysAgo(155), description: 'Ride share', amount: -40.75, category: 'Transport' },
  { date: daysAgo(185), description: 'Clothing', amount: -99.5, category: 'Shopping' },
]);

// Deterministic current-month child-category spending so the Dining rollup
// provably includes child categories regardless of the run day.
insertTransactions(serverDb, [
  { date: `${currentMonth()}-02`, description: 'Nice Restaurant', amount: -30, category: 'Dining' },
  { date: `${currentMonth()}-03`, description: 'Espresso Bar', amount: -8.5, category: 'Espresso' },
]);

// Account + entity links, like the server pipelines make them.
const accountId = insertAccount(serverDb, {
  name: 'Everyday Checking',
  account_type: 'asset',
  account_subtype: 'checking',
  institution: 'Test Bank',
  account_number_last4: '1234',
});
const bizEntityId = createEntity(serverDb, { name: 'Side Business', color: '#3b82f6' });
serverDb.prepare(`UPDATE transactions SET account_id = @id WHERE category = 'Groceries'`).run({ id: accountId });
serverDb.prepare(
  `UPDATE transactions SET entity_id = @id WHERE category IN ('Dining', 'Espresso', 'Coffee')`
).run({ id: bizEntityId });

// ── Mirror: seeded from the server's own raw pulls (the sync-engine path) ───

beforeAll(async () => {
  mirrorBinding = new MirrorTestBinding(new Database(':memory:'));
  await createMirrorSchema(mirrorBinding);
  const transactions = apiTransactions(
    serverDb,
    new URLSearchParams({ limit: String(10_000_000) })
  ) as unknown as MirrorTransactionRow[];
  const entities = apiEntities(serverDb) as unknown as MirrorEntityRow[];
  const budgets = apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[];
  const categories = apiCategories(serverDb) as unknown as MirrorCategoryRow[];
  await applySync(mirrorBinding, {
    profile: 'default',
    transactions,
    entities,
    budgets,
    categories,
  });
});

// ── Equivalence matrices: server handler vs serveApiPath ─────────────────────

describe('offline overview aggregation parity with the server', () => {
  test('/api/streak (daily budget derived from the synced budgets table)', async () => {
    const fromServer = apiStreak(serverDb);
    const fromMirror = await serveApiPath(mirrorBinding, '/api/streak');
    expect(fromMirror).toEqual(fromServer);
    // Sanity: the seeded budgets must actually drive the daily budget.
    expect(fromServer.dailyBudget).toBeGreaterThan(0);
  });

  test('/api/weekly-summary', async () => {
    const fromServer = apiWeeklySummary(serverDb);
    const fromMirror = await serveApiPath(mirrorBinding, '/api/weekly-summary');
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    `startDate=${daysAgo(30)}&endDate=${daysAgo(0)}`,
    `startDate=${daysAgo(1)}&endDate=${daysAgo(0)}`,
    '', // missing params → the 200-shaped { error } object on both sides
  ])('/api/daily-spending?%s', async (query) => {
    const fromServer = apiDailySpending(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/daily-spending?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    `month=${currentMonth()}`,
    `month=${previousMonth()}`,
    '', // default: current UTC month
  ])('/api/budget-countdown?%s', async (query) => {
    const fromServer = apiBudgetCountdown(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/budget-countdown?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    '', // no params → current month
    `month=${currentMonth()}`,
    `month=${previousMonth()}`,
    `startDate=${daysAgo(60)}&endDate=${daysAgo(0)}`, // direct window
    `month=${currentMonth()}&accountId=${accountId}`,
    `month=${currentMonth()}&entityId=${bizEntityId}`,
    `month=${currentMonth()}&accountId=${accountId}&entityId=${bizEntityId}`,
    'month=1999-01', // empty window
  ])('/api/summary?%s', async (query) => {
    const fromServer = apiSummary(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/summary?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    '',
    `month=${currentMonth()}`,
    `month=${previousMonth()}`,
    `startDate=${daysAgo(60)}&endDate=${daysAgo(0)}`,
    `month=${currentMonth()}&accountId=${accountId}`,
    `month=${currentMonth()}&entityId=${bizEntityId}`,
    `month=${currentMonth()}&accountId=${accountId}&entityId=${bizEntityId}`,
    'month=1999-01',
  ])('/api/pnl?%s', async (query) => {
    const fromServer = apiPnl(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/pnl?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    '', // default months=6
    'months=12',
    'months=1',
    `months=12&accountId=${accountId}`,
    `months=6&entityId=${bizEntityId}`,
  ])('/api/savings?%s', async (query) => {
    const fromServer = apiSavings(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/savings?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test.each([
    `month=${currentMonth()}`,
    '', // default month
    `month=${previousMonth()}`,
    `month=${currentMonth()}&accountId=${accountId}`,
    `month=${currentMonth()}&entityId=${bizEntityId}`,
    `month=${currentMonth()}&accountId=${accountId}&entityId=${bizEntityId}`,
    'month=1999-01',
  ])('/api/budgets?%s', async (query) => {
    const fromServer = apiBudgets(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/budgets?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test('the Dining budget rolls child-category spending up into actual (recursive rollup)', async () => {
    const rows = (await serveApiPath(mirrorBinding, `/api/budgets?month=${currentMonth()}`)) as Array<{
      category: string;
      actual: number;
    }>;
    const diningRow = rows.find((r) => r.category === 'Dining')!;
    // Direct Dining spending this month is -30; the rollup must also include
    // the Espresso/Coffee child rows (-7.25, -8.5) — strictly more than the
    // parent-only amount.
    expect(diningRow.actual as number).toBeGreaterThan(30);
    // And identical to what the server computes with the same CTE.
    const serverRows = apiBudgets(serverDb, new URLSearchParams(`month=${currentMonth()}`));
    expect(diningRow.actual).toBe(serverRows.find((r) => r.category === 'Dining')!.actual);
  });
});

// ── Shared pure helpers: deterministic with an injected `now` ─────────────────

/** The same local-midnight → YYYY-MM-DD rendering computeStreak's walk uses. */
function utcDay(year: number, month: number, day: number): string {
  return new Date(year, month, day, 0, 0, 0, 0).toISOString().slice(0, 10);
}

/** Sep 16 2026 is a Wednesday; local noon so UTC renderings stay on-date. */
const NOON_SEP_16 = new Date(2026, 8, 16, 12, 0, 0, 0);

describe('computeStreak (injected now)', () => {
  const budget = 10;

  test('current walk stops at an over-budget day; longest comes from history', () => {
    const rows = [
      { date: utcDay(2026, 8, 16), spending: 5 }, // today
      { date: utcDay(2026, 8, 15), spending: 5 },
      { date: utcDay(2026, 8, 14), spending: 500 }, // breaks the current streak
      { date: utcDay(2026, 8, 13), spending: 5 },
      { date: utcDay(2026, 8, 12), spending: 5 },
      { date: utcDay(2026, 8, 11), spending: 500 },
      // Longest run: Sep 1–10
      ...Array.from({ length: 10 }, (_, i) => ({ date: utcDay(2026, 8, i + 1), spending: 5 })),
    ];
    expect(computeStreak(rows, budget, NOON_SEP_16)).toEqual({ current: 2, longest: 10, dailyBudget: budget });
  });

  test('a current streak crossing empty days beats the historical best (fixup)', () => {
    const rows = [
      { date: utcDay(2026, 8, 16), spending: 5 },
      { date: utcDay(2026, 8, 15), spending: 5 },
      // Sep 14 has NO row (no spending day) — the walk counts it as under budget
      { date: utcDay(2026, 8, 13), spending: 5 },
      { date: utcDay(2026, 8, 2), spending: 500 },
      { date: utcDay(2026, 8, 1), spending: 5 },
    ];
    // Current: Sep 3..16 = 14 days (including the empty Sep 14). Longest scan
    // (first → last spending date, Sep 1..16): Sep 3–13 = 11 → fixup to 14.
    expect(computeStreak(rows, budget, NOON_SEP_16)).toEqual({ current: 14, longest: 14, dailyBudget: budget });
  });

  test('the walk caps at 365 days', () => {
    const rows = Array.from({ length: 400 }, (_, i) => {
      const d = new Date(NOON_SEP_16);
      d.setDate(d.getDate() - (399 - i));
      return { date: d.toISOString().slice(0, 10), spending: 1 };
    });
    const result = computeStreak(rows, budget, NOON_SEP_16);
    expect(result.current).toBe(366);
    expect(result.longest).toBe(400);
  });

  test('empty rows and non-positive budgets short-circuit', () => {
    expect(computeStreak([], budget, NOON_SEP_16)).toEqual({ current: 0, longest: 0, dailyBudget: budget });
    expect(computeStreak([{ date: utcDay(2026, 8, 16), spending: 5 }], 0, NOON_SEP_16)).toEqual({
      current: 0,
      longest: 0,
      dailyBudget: 0,
    });
    expect(computeStreak([{ date: utcDay(2026, 8, 16), spending: 5 }], -3, NOON_SEP_16).dailyBudget).toBe(-3);
  });
});

describe('weekWindows (injected now)', () => {
  test('Wednesday: Monday–Sunday this week, shifted seven days last week', () => {
    const w = weekWindows(NOON_SEP_16);
    expect(w.thisStart).toBe(utcDay(2026, 8, 14)); // Monday
    expect(w.thisEnd).toBe(utcDay(2026, 8, 20)); // Sunday
    expect(w.lastStart).toBe(utcDay(2026, 8, 7));
    expect(w.lastEnd).toBe(utcDay(2026, 8, 13));
  });

  test('Sunday closes the week that Monday opened (offset -6)', () => {
    const w = weekWindows(new Date(2026, 8, 20, 12)); // Sunday Sep 20
    expect(w.thisStart).toBe(utcDay(2026, 8, 14));
    expect(w.thisEnd).toBe(utcDay(2026, 8, 20));
    expect(w.lastStart).toBe(utcDay(2026, 8, 7));
    expect(w.lastEnd).toBe(utcDay(2026, 8, 13));
  });

  test('Monday starts its own week with no offset', () => {
    const w = weekWindows(new Date(2026, 8, 14, 12)); // Monday Sep 14
    expect(w.thisStart).toBe(utcDay(2026, 8, 14));
    expect(w.lastStart).toBe(utcDay(2026, 8, 7));
  });
});

describe('countdownDaysLeft (injected now)', () => {
  test('inside the month: remaining days including today', () => {
    // Sep 16 noon → Sep 30 local midnight is 13.5 days away → ceil + 1 = 15.
    expect(countdownDaysLeft('2026-09', NOON_SEP_16)).toBe(15);
  });

  test('before the month: the whole month remains', () => {
    expect(countdownDaysLeft('2026-10', NOON_SEP_16)).toBe(31);
    expect(countdownDaysLeft('2027-02', NOON_SEP_16)).toBe(28);
    expect(countdownDaysLeft('2028-02', NOON_SEP_16)).toBe(29); // leap
  });

  test('after the month: zero', () => {
    expect(countdownDaysLeft('2026-08', NOON_SEP_16)).toBe(0);
  });
});

describe('savingsWindow (injected now)', () => {
  test('defaults the end to the current month and spans `months` back', () => {
    const w = savingsWindow(undefined, 6, NOON_SEP_16);
    expect(w.startDate).toBe('2026-04-01');
    expect(w.endDate).toBe(utcDay(2026, 9, 0)); // UTC-rendered local Sep 30
  });

  test('an explicit endMonth anchors the window', () => {
    const w = savingsWindow('2025-12', 6, NOON_SEP_16);
    expect(w.startDate).toBe('2025-07-01');
    expect(w.endDate).toBe(utcDay(2025, 11, 31));
  });
});

describe('computeStreakDailyBudget (injected now)', () => {
  test('total monthly budget divided by the days in the current local month', () => {
    // September 2026 has 30 days.
    expect(computeStreakDailyBudget(1400, NOON_SEP_16)).toBe(1400 / 30);
    expect(computeStreakDailyBudget(0, NOON_SEP_16)).toBe(0);
    expect(computeStreakDailyBudget(-5, NOON_SEP_16)).toBe(0);
  });
});

describe('small pure mappers', () => {
  test('toMonthlyIncomeExpense', () => {
    expect(toMonthlyIncomeExpense([
      { month: '2026-08', income: 100, expenses: 25 },
      { month: '2026-09', income: 0, expenses: 10 },
    ])).toEqual([
      { month: '2026-08', income: 100, expenses: 25, savings: 75, savingsRate: 75 },
      { month: '2026-09', income: 0, expenses: 10, savings: -10, savingsRate: 0 },
    ]);
  });

  test('summarizePnl keeps the historical sign convention', () => {
    const pnl = summarizePnl(
      [{ category: 'Income', total: 3500, count: 1 }],
      [{ category: 'Dining', total: -30, count: 1 }]
    );
    expect(pnl).toEqual({
      totalIncome: 3500,
      totalExpenses: -30,
      netProfitLoss: 3470,
      incomeByCategory: [{ category: 'Income', total: 3500, count: 1 }],
      expensesByCategory: [{ category: 'Dining', total: -30, count: 1 }],
    });
  });

  test('budgetActualRow', () => {
    expect(budgetActualRow({ category: 'X', monthly_limit: 200 }, 50)).toEqual({
      category: 'X',
      monthly_limit: 200,
      actual: 50,
      remaining: 150,
      percent_used: 25,
      over: false,
    });
    expect(budgetActualRow({ category: 'X', monthly_limit: 200 }, 250).over).toBe(true);
    expect(budgetActualRow({ category: 'X', monthly_limit: 0 }, 50).percent_used).toBe(0);
  });
});

// Guard the test's own assumptions: the server db must have rolled-up budgets.
describe('fixture sanity', () => {
  test('seeded budgets include the hierarchical Dining budget', () => {
    const budgets = getBudgets(serverDb);
    expect(budgets.map((b) => b.category).sort()).toEqual(['Dining', 'Groceries']);
  });
});
