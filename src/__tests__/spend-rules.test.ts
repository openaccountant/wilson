import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';
import {
  NON_SPEND_CATEGORIES,
  DASHBOARD_RULES,
  categoryLabel,
  categoryLabelSql,
  incomeAmount,
  incomeSql,
  isIncome,
  isNonSpendCategory,
  isSpend,
  isUncategorized,
  monthsInRange,
  spendSql,
  uncategorizedSql,
  hasDashboardRules,
} from '../db/spend-rules.js';
import {
  DAILY_SPENDING_SQL,
  composeDailySpendingSql,
  composeSpendingSummarySql,
  composePnlSql,
  composeSavingsSql,
  composeBudgetActualClauses,
  budgetActualRangeRow,
  composeStreakDailySql,
  composeWeekSql,
  STREAK_DAILY_SQL,
  WEEK_TOTAL_SQL,
  WEEK_BY_CATEGORY_SQL,
  WEEK_TOP_MERCHANT_SQL,
} from '../db/overview-sql.js';
import { buildTransactionWhere, composeTransactionListSql, type TransactionFilters } from '../db/transaction-where.js';
import {
  getSpendingSummary,
  getProfitLoss,
  getMonthlySavingsData,
  getBudgetVsActual,
  getTransactions,
  insertTransactions,
  setBudget,
} from '../db/queries.js';
import { getDailySpending, getStreak, getWeeklySummary } from '../db/daily-queries.js';
import { createEntity } from '../db/entity-queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import {
  apiSummary,
  apiPnl,
  apiBudgets,
  apiDailySpending,
  apiTransactions,
  apiCoverage,
  apiNetWorthTrend,
  apiSavings,
  apiStreak,
  apiWeeklySummary,
} from '../dashboard/api.js';
import { parseTransactionListParams } from '../dashboard/transactions-query.js';
import { parseNetWorthMonths } from '../dashboard/overview-params.js';

// ── Legacy composers, copied VERBATIM from release/0.10.0 ────────────────────
//
// CLI tools, reports, goals and context hints call the shared composers with
// no options; they must get these exact strings forever (decision (a) of the
// charting batch: the dashboard spend/income rules are dashboard-only).

function legacySpendingSummarySql(startDate: string, endDate: string, accountId?: number, entityId?: number) {
  const conditions = ['date >= @startDate', 'date <= @endDate', 'amount < 0'];
  const params: Record<string, unknown> = { startDate, endDate };
  if (accountId !== undefined) {
    conditions.push('account_id = @accountId');
    params.accountId = accountId;
  }
  if (entityId !== undefined) {
    conditions.push('entity_id = @entityId');
    params.entityId = entityId;
  }
  const sql = `
    SELECT
      COALESCE(category, 'Uncategorized') AS category,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE ${conditions.join(' AND ')}
    GROUP BY category
    ORDER BY total ASC
  `;
  return { sql, params };
}

function legacyPnlSql(startDate: string, endDate: string, accountId?: number, entityId?: number) {
  const baseParams: Record<string, unknown> = { startDate, endDate };
  const acctFilter = accountId !== undefined ? ' AND account_id = @accountId' : '';
  if (accountId !== undefined) baseParams.accountId = accountId;
  const entityFilter = entityId !== undefined ? ' AND entity_id = @entityId' : '';
  if (entityId !== undefined) baseParams.entityId = entityId;

  const incomeSql = `
    SELECT COALESCE(category, 'Uncategorized') AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= @startDate AND date <= @endDate AND (amount > 0 OR category = 'Income')${acctFilter}${entityFilter}
    GROUP BY category ORDER BY total DESC
  `;
  const expensesSql = `
    SELECT COALESCE(category, 'Uncategorized') AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= @startDate AND date <= @endDate AND amount < 0
      AND COALESCE(category, '') NOT IN ('Income', 'Transfer')${acctFilter}${entityFilter}
    GROUP BY category ORDER BY total ASC
  `;
  return { incomeSql, expensesSql, params: baseParams };
}

function legacySavingsSql(startDate: string, endDate: string, accountId?: number, entityId?: number) {
  const params: Record<string, unknown> = { startDate, endDate };
  const acctFilter = accountId !== undefined ? ' AND account_id = @accountId' : '';
  if (accountId !== undefined) params.accountId = accountId;
  const entityFilter = entityId !== undefined ? ' AND entity_id = @entityId' : '';
  if (entityId !== undefined) params.entityId = entityId;
  const sql = `
    SELECT strftime('%Y-%m', date) AS month,
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS expenses
    FROM transactions WHERE date >= @startDate AND date <= @endDate${acctFilter}${entityFilter}
    GROUP BY strftime('%Y-%m', date) ORDER BY month
  `;
  return { sql, params };
}

const LEGACY_MERCHANT_WORD_START_SQL = String.raw`(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(description), '*', ' '), '.', ' '), ',', ' '), '/', ' '), '#', ' '), '-', ' '), ':', ' '), ';', ' '), '(', ' '), ')', ' '), '&', ' '), '''', ' '), '"', ' '), '_', ' '), '  ', ' '), '  ', ' '), '  ', ' ')) LIKE @merchant ESCAPE '\'`;

function legacyBuildWhere(filters: TransactionFilters) {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.dateStart) { conditions.push('date >= @dateStart'); params.dateStart = filters.dateStart; }
  if (filters.dateEnd) { conditions.push('date <= @dateEnd'); params.dateEnd = filters.dateEnd; }
  if (filters.category) { conditions.push('category = @category'); params.category = filters.category; }
  if (filters.minAmount !== undefined) { conditions.push('amount >= @minAmount'); params.minAmount = filters.minAmount; }
  if (filters.maxAmount !== undefined) { conditions.push('amount <= @maxAmount'); params.maxAmount = filters.maxAmount; }
  // The one intentional change to the historical WHERE (Round 4 search precision): a merchant
  // term must start a word of the punctuation-normalized description. Behaviour is pinned in
  // transaction-merchant-match.test.ts; this oracle only covers plain lower-case-able terms.
  if (filters.merchant) { conditions.push(LEGACY_MERCHANT_WORD_START_SQL); params.merchant = `% ${filters.merchant.toLowerCase().trim()}%`; }
  if (filters.isRecurring !== undefined) { conditions.push('is_recurring = @isRecurring'); params.isRecurring = filters.isRecurring ? 1 : 0; }
  if (filters.accountId !== undefined) { conditions.push('account_id = @accountId'); params.accountId = filters.accountId; }
  if (filters.entityId !== undefined) { conditions.push('entity_id = @entityId'); params.entityId = filters.entityId; }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereSql, params };
}

const LEGACY_DAILY_SPENDING_SQL = `
    SELECT
      date,
      SUM(ABS(amount)) AS spending,
      COUNT(*) AS count
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
    GROUP BY date
    ORDER BY date
  `;

// ── Fixture: every edge the dashboard rules care about ───────────────────────

const START = '2026-01-01';
const END = '2026-03-31';

function seed(): { db: Database; accountId: number; bizId: number; defaultId: number } {
  const db = createTestDb();
  const accountId = insertAccount(db, {
    name: 'Checking',
    account_type: 'asset',
    account_subtype: 'checking',
    institution: 'Test Bank',
  });
  const bizId = createEntity(db, { name: 'Biz', color: '#3b82f6' });
  const defaultId = (db.prepare('SELECT id FROM entities WHERE is_default = 1').get() as { id: number }).id;
  insertTransactions(db, [
    { date: '2026-01-05', description: 'Paycheck (stored negative)', amount: -2000, category: 'Income' },
    { date: '2026-01-06', description: 'Paycheck', amount: 3000, category: 'Income' },
    { date: '2026-01-07', description: 'CARD PAYMENT', amount: -500, category: 'Credit Card' },
    { date: '2026-01-08', description: 'CARD PAYMENT THANK YOU', amount: 500, category: 'Payment' },
    { date: '2026-01-09', description: 'To savings', amount: -250, category: 'Internal Account Transfer' },
    { date: '2026-01-10', description: 'Xfer', amount: -100, category: 'Transfer' },
    { date: '2026-01-11', description: 'CC autopay', amount: -75, category: 'Credit Card Payment' },
    { date: '2026-01-12', description: 'Whole Foods #12', amount: -80, category: 'Groceries', merchant_name: 'Whole Foods' },
    { date: '2026-01-12', description: 'Whole Foods #14', amount: -20, category: 'Groceries', merchant_name: '  ' },
    { date: '2026-02-13', description: 'Grocery refund', amount: 15, category: 'Groceries' },
    { date: '2026-02-14', description: 'Mystery A', amount: -10 }, // NULL category
    { date: '2026-02-15', description: 'Mystery B', amount: -5, category: '' }, // blank
    { date: '2026-02-16', description: 'Mystery C', amount: -2.5, category: '   ' }, // whitespace
    { date: '2026-03-17', description: 'Mystery D', amount: -1.25, category: 'Uncategorized' }, // literal
    { date: '2026-03-18', description: 'Dinner', amount: -40, category: 'Dining' },
    { date: '2026-03-19', description: 'Biz lunch', amount: -60, category: 'Dining' },
  ]);
  db.prepare("UPDATE transactions SET account_id = @a WHERE category IN ('Groceries', 'Credit Card')").run({ a: accountId });
  db.prepare("UPDATE transactions SET entity_id = @e WHERE description = 'Biz lunch'").run({ e: bizId });
  db.prepare("UPDATE transactions SET entity_id = @e WHERE description = 'Dinner'").run({ e: defaultId });
  setBudget(db, 'Groceries', 100);
  setBudget(db, 'Dining', 50);
  return { db, accountId, bizId, defaultId };
}

const runAll = (db: Database, q: { sql: string; params: Record<string, unknown> }) =>
  db.prepare(q.sql).all(q.params);

// ── Pure predicates ──────────────────────────────────────────────────────────

describe('spend-rules predicates', () => {
  test('non-spend vocabulary', () => {
    expect([...NON_SPEND_CATEGORIES]).toEqual([
      'Income', 'Transfer', 'Internal Account Transfer', 'Credit Card', 'Credit Card Payment', 'Payment',
    ]);
    expect(isNonSpendCategory('Credit Card')).toBe(true);
    expect(isNonSpendCategory('Groceries')).toBe(false);
    expect(isNonSpendCategory(null)).toBe(false);
  });

  test('spend / income / uncategorized', () => {
    expect(isSpend({ amount: -10, category: 'Dining' })).toBe(true);
    expect(isSpend({ amount: -10, category: null })).toBe(true);
    expect(isSpend({ amount: -10, category: 'Credit Card' })).toBe(false);
    expect(isSpend({ amount: -10, category: 'Income' })).toBe(false);
    expect(isSpend({ amount: 10, category: 'Dining' })).toBe(false);

    expect(isIncome({ amount: -2000, category: 'Income' })).toBe(true);
    expect(incomeAmount({ amount: -2000, category: 'Income' })).toBe(2000);
    expect(isIncome({ amount: 15, category: 'Groceries' })).toBe(true);
    expect(isIncome({ amount: 500, category: 'Payment' })).toBe(false);
    expect(isIncome({ amount: 500, category: 'Transfer' })).toBe(false);
    expect(incomeAmount({ amount: -5, category: 'Dining' })).toBe(0);

    expect(isUncategorized(null)).toBe(true);
    expect(isUncategorized('  ')).toBe(true);
    expect(isUncategorized('Uncategorized')).toBe(true);
    expect(isUncategorized('Dining')).toBe(false);
    expect(categoryLabel('  ')).toBe('Uncategorized');
    expect(categoryLabel(' Dining ')).toBe('Dining');
  });

  test('monthsInRange prorates partial months by day (L6)', () => {
    // Whole months count exactly 1 each.
    expect(monthsInRange('2026-01-01', '2026-03-31')).toBe(3);
    expect(monthsInRange('2026-03-01', '2026-03-31')).toBe(1);
    expect(monthsInRange('2024-02-01', '2024-02-29')).toBe(1); // leap February
    // A 2-day range across a month boundary is ~1/15 of a month, not 2 months.
    expect(monthsInRange('2026-01-31', '2026-02-01')).toBeCloseTo(1 / 31 + 1 / 28, 12);
    // YTD on Oct 2: nine whole months + 2/31 — not 10.
    expect(monthsInRange('2026-01-01', '2026-10-02')).toBeCloseTo(9 + 2 / 31, 12);
    // Nov 15 – Feb 1: 16/30 + Dec + Jan + 1/28.
    expect(monthsInRange('2025-11-15', '2026-02-01')).toBeCloseTo(16 / 30 + 2 + 1 / 28, 12);
    expect(monthsInRange('2026-03-05', '2026-03-05')).toBeCloseTo(1 / 31, 12); // one day
    expect(monthsInRange('2026-12-01', '2026-01-01')).toBe(1); // inverted
    expect(monthsInRange('garbage', '2026-01-01')).toBe(1);
    expect(monthsInRange('2026-02-30', '2026-03-01')).toBe(1); // impossible date
  });

  test('hasDashboardRules', () => {
    expect(hasDashboardRules(undefined)).toBe(false);
    expect(hasDashboardRules({})).toBe(false);
    expect(hasDashboardRules(DASHBOARD_RULES)).toBe(true);
  });

  test('the SQL fragments classify every fixture row exactly like the JS predicates', () => {
    const { db } = seed();
    const rows = db.prepare(`
      SELECT amount, category,
        ${spendSql()} AS spend,
        ${incomeSql()} AS income,
        ${uncategorizedSql()} AS uncat,
        ${categoryLabelSql()} AS label
      FROM transactions
    `).all() as { amount: number; category: string | null; spend: number; income: number; uncat: number; label: string }[];
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(Boolean(r.spend)).toBe(isSpend(r));
      expect(Boolean(r.income)).toBe(isIncome(r));
      expect(Boolean(r.uncat)).toBe(isUncategorized(r.category));
      expect(r.label).toBe(categoryLabel(r.category));
    }
  });
});

// ── CLI callers: SQL and output unchanged ────────────────────────────────────

describe('CLI callers keep their historical SQL and output (no options passed)', () => {
  const argMatrix: [number | undefined, number | undefined][] = [
    [undefined, undefined],
    [1, undefined],
    [undefined, 2],
    [3, 4],
  ];

  test.each(argMatrix)('composer SQL is byte-identical (accountId=%p, entityId=%p)', (a, e) => {
    expect(composeSpendingSummarySql(START, END, a, e)).toEqual(legacySpendingSummarySql(START, END, a, e));
    expect(composePnlSql(START, END, a, e)).toEqual(legacyPnlSql(START, END, a, e));
    expect(composeSavingsSql(START, END, a, e)).toEqual(legacySavingsSql(START, END, a, e));
    // An empty options object is "no options" too.
    expect(composeSpendingSummarySql(START, END, a, e, {})).toEqual(legacySpendingSummarySql(START, END, a, e));
  });

  test('daily spending SQL is the historical constant', () => {
    expect(DAILY_SPENDING_SQL).toBe(LEGACY_DAILY_SPENDING_SQL);
    expect(composeDailySpendingSql(START, END)).toEqual({
      sql: LEGACY_DAILY_SPENDING_SQL,
      params: { startDate: START, endDate: END },
    });
  });

  test('budget clauses are the historical strings', () => {
    expect(composeBudgetActualClauses(1, 2)).toEqual({
      acctFilter: ' AND t.account_id = @accountId',
      entityFilter: ' AND t.entity_id = @entityId',
    });
    expect(composeBudgetActualClauses()).toEqual({ acctFilter: '', entityFilter: '' });
  });

  const filterMatrix: TransactionFilters[] = [
    {},
    { dateStart: START, dateEnd: END },
    { category: 'Uncategorized' },
    { category: 'Groceries', merchant: 'whole', accountId: 1, entityId: 1 },
    { minAmount: -100, maxAmount: 0, isRecurring: false },
  ];

  test.each(filterMatrix)('transaction WHERE + list SQL are byte-identical (%p)', (filters) => {
    const legacy = legacyBuildWhere(filters);
    expect(buildTransactionWhere(filters)).toEqual(legacy);
    expect(composeTransactionListSql(filters)).toEqual({
      sql: `SELECT * FROM transactions ${legacy.whereSql} ORDER BY date DESC`,
      params: legacy.params,
    });
  });

  test('server functions return exactly what the legacy SQL returns on the edge fixture', () => {
    const { db, accountId, defaultId } = seed();
    expect(getSpendingSummary(db, START, END)).toEqual(runAll(db, legacySpendingSummarySql(START, END)) as never);
    const lp = legacyPnlSql(START, END);
    const pnl = getProfitLoss(db, START, END);
    expect(pnl.incomeByCategory).toEqual(db.prepare(lp.incomeSql).all(lp.params) as never);
    expect(pnl.expensesByCategory).toEqual(db.prepare(lp.expensesSql).all(lp.params) as never);
    expect(getDailySpending(db, START, END)).toEqual(
      db.prepare(LEGACY_DAILY_SPENDING_SQL).all({ startDate: START, endDate: END }) as never
    );
    expect(getTransactions(db, { category: 'Uncategorized' })).toEqual(
      db.prepare("SELECT * FROM transactions WHERE category = 'Uncategorized' ORDER BY date DESC").all() as never
    );
    expect(getTransactions(db, { entityId: defaultId })).toEqual(
      db.prepare('SELECT * FROM transactions WHERE entity_id = @e ORDER BY date DESC').all({ e: defaultId }) as never
    );
    // Historical semantics the CLI relies on: card payments count as spending,
    // Uncategorized-ish rows are separate groups, negative Income is negative.
    const summary = getSpendingSummary(db, START, END);
    expect(summary.some((r) => r.category === 'Credit Card')).toBe(true);
    expect(pnl.incomeByCategory.find((r) => r.category === 'Income')!.total).toBe(1000);
    expect(getMonthlySavingsData(db, '2026-03', 3, accountId).length).toBeGreaterThan(0);
    // Month-mode budgets (CLI): no range labels.
    const budgets = getBudgetVsActual(db, '2026-01');
    expect(budgets.every((b) => !('limit' in b) && !('months' in b))).toBe(true);
  });

  test('CLI caller modules never opt into the dashboard rules', () => {
    const files = [
      'tools/query/spending-summary.ts',
      'tools/query/profit-loss.ts',
      'tools/query/profit-diff.ts',
      'tools/query/forecast.ts',
      'tools/query/transaction-search.ts',
      'tools/export/export-transactions.ts',
      'tools/budget/budget-check.ts',
      'reports.ts',
      'report/generator.ts',
      'components/context-hints.ts',
      'db/goal-queries.ts',
      'alerts/engine.ts',
      'agent/prompts.ts',
      'cli.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(import.meta.dir, '..', f), 'utf8');
      expect({ f, hit: /DASHBOARD_RULES|parseDashboardOptions|spend-rules|getBudgetVsActualRange/.test(src) }).toEqual({ f, hit: false });
    }
  });
});

// ── Dashboard semantics ──────────────────────────────────────────────────────

const qs = (o: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));

describe('dashboard endpoints apply the spend/income rules', () => {
  const range = { startDate: START, endDate: END };

  test('/api/summary excludes transfers/payments and merges Uncategorized', () => {
    const { db } = seed();
    const rows = apiSummary(db, qs(range));
    const cats = rows.map((r) => r.category).sort();
    expect(cats).toEqual(['Dining', 'Groceries', 'Uncategorized']);
    const uncat = rows.find((r) => r.category === 'Uncategorized')!;
    expect(uncat.count).toBe(4);
    expect(uncat.total).toBe(-18.75);
  });

  test('/api/summary honors category (Uncategorized matches NULL/blank)', () => {
    const { db } = seed();
    expect(apiSummary(db, qs({ ...range, category: 'Uncategorized' }))).toEqual([
      { category: 'Uncategorized', total: -18.75, count: 4 },
    ]);
    expect(apiSummary(db, qs({ ...range, category: 'Dining' }))).toEqual([
      { category: 'Dining', total: -100, count: 2 },
    ]);
  });

  test('/api/pnl normalizes income and excludes non-spend from expenses', () => {
    const { db } = seed();
    const pnl = apiPnl(db, qs(range));
    expect(pnl.incomeByCategory).toEqual([
      { category: 'Income', total: 5000, count: 2 },
      { category: 'Groceries', total: 15, count: 1 },
    ]);
    expect(pnl.totalIncome).toBe(5015);
    expect(pnl.totalExpenses).toBe(-80 - 20 - 18.75 - 100);
    expect(pnl.expensesByCategory.map((r) => r.category).sort()).toEqual(['Dining', 'Groceries', 'Uncategorized']);
  });

  test('/api/pnl under a category filter is expense-only for that category', () => {
    const { db } = seed();
    const groceries = apiPnl(db, qs({ ...range, category: 'Groceries' }));
    expect(groceries.incomeByCategory).toEqual([]); // the +15 refund is not income here
    expect(groceries.expensesByCategory).toEqual([{ category: 'Groceries', total: -100, count: 2 }]);
    const income = apiPnl(db, qs({ ...range, category: 'Income' }));
    expect(income.totalIncome).toBe(5000);
    expect(income.expensesByCategory).toEqual([]);
  });

  test('default entity includes NULL-entity rows; other entities do not', () => {
    const { db, bizId, defaultId } = seed();
    const def = apiSummary(db, qs({ ...range, entityId: defaultId, category: 'Dining' }));
    expect(def).toEqual([{ category: 'Dining', total: -40, count: 1 }]);
    const defAll = apiSummary(db, qs({ ...range, entityId: defaultId }));
    expect(defAll.find((r) => r.category === 'Uncategorized')!.count).toBe(4); // NULL entity rows
    expect(apiSummary(db, qs({ ...range, entityId: bizId }))).toEqual([{ category: 'Dining', total: -60, count: 1 }]);
  });

  test('/api/daily-spending honors spend rule, account, entity and category', () => {
    const { db, accountId, bizId } = seed();
    const all = apiDailySpending(db, qs(range)) as { date: string; spending: number; count: number }[];
    expect(all.find((d) => d.date === '2026-01-07')).toBeUndefined(); // card payment
    expect(all.find((d) => d.date === '2026-01-05')).toBeUndefined(); // negative income
    expect(all.find((d) => d.date === '2026-01-12')).toEqual({ date: '2026-01-12', spending: 100, count: 2 });
    expect(apiDailySpending(db, qs({ ...range, accountId }))).toEqual([{ date: '2026-01-12', spending: 100, count: 2 }]);
    expect(apiDailySpending(db, qs({ ...range, entityId: bizId }))).toEqual([{ date: '2026-03-19', spending: 60, count: 1 }]);
    expect((apiDailySpending(db, qs({ ...range, category: 'Uncategorized' })) as unknown[]).length).toBe(4);
    expect(apiDailySpending(db, qs({}))).toEqual({ error: 'startDate and endDate required' });
  });

  test('/api/budgets scales the limit by the months in the range', () => {
    const { db } = seed();
    const quarter = apiBudgets(db, qs(range));
    const groceries = quarter.find((b) => b.category === 'Groceries')!;
    expect(groceries).toEqual({
      category: 'Groceries', monthly_limit: 100, limit: 300, months: 3,
      actual: 100, remaining: 200, percent_used: 33, over: false,
    });
    const jan = apiBudgets(db, qs({ month: '2026-01' })).find((b) => b.category === 'Groceries')!;
    expect(jan.months).toBe(1);
    expect(jan.limit).toBe(100);
    expect(jan.actual).toBe(100);
    expect(budgetActualRangeRow({ category: 'X', monthly_limit: 0 }, 5, 3).percent_used).toBe(0);
  });

  test('/api/savings: card payments are not expenses, negative paychecks are income', () => {
    const { db } = seed();
    // Savings is a trailing window from the current month; compose directly
    // for the fixture window instead.
    const q = composeSavingsSql(START, END, undefined, undefined, { ...DASHBOARD_RULES });
    const rows = db.prepare(q.sql).all(q.params) as { month: string; income: number; expenses: number }[];
    expect(rows.find((r) => r.month === '2026-01')).toEqual({ month: '2026-01', income: 5000, expenses: 100 });
    expect(Array.isArray(apiSavings(db, qs({})))).toBe(true);
  });

  test('/api/coverage lists every month with data, unfiltered', () => {
    const { db } = seed();
    expect(apiCoverage(db)).toEqual({ start: '2026-01-05', end: '2026-03-19', months: ['2026-01', '2026-02', '2026-03'] });
    expect(apiCoverage(createTestDb())).toEqual({ start: null, end: null, months: [] });
  });

  test('/api/net-worth/trend never throws on garbage months', () => {
    const { db } = seed();
    expect(() => apiNetWorthTrend(db, qs({ months: 'abc' }))).not.toThrow();
    expect(() => apiNetWorthTrend(db, qs({ months: '-5' }))).not.toThrow();
    expect(() => apiNetWorthTrend(db, qs({ months: '99999999' }))).not.toThrow();
    expect(parseNetWorthMonths(qs({ months: 'abc' }))).toBe(12);
    expect(parseNetWorthMonths(qs({}))).toBe(12);
    expect(parseNetWorthMonths(qs({ months: '0' }))).toBe(1);
    expect(parseNetWorthMonths(qs({ months: '5000' }))).toBe(360);
  });
});

describe('/api/transactions params', () => {
  test('startDate/endDate alias start/end; start/end win', () => {
    expect(parseTransactionListParams(qs({ startDate: START, endDate: END })).filters).toEqual({
      dateStart: START, dateEnd: END,
    });
    expect(parseTransactionListParams(qs({ start: '2026-02-01', startDate: START })).filters.dateStart).toBe('2026-02-01');
  });

  test('offset pages in SQL with a stable order', () => {
    const { db } = seed();
    const all = apiTransactions(db, qs({ limit: 1000 }));
    const page1 = apiTransactions(db, qs({ limit: 5 }));
    const page2 = apiTransactions(db, qs({ limit: 5, offset: 5 }));
    expect([...page1, ...page2]).toEqual(all.slice(0, 10));
    expect(apiTransactions(db, qs({ limit: '' }))).toEqual([]);
    expect(apiTransactions(db, qs({ limit: 5, offset: 'x' }))).toEqual(page1);
  });

  test('merchantExact matches the merchant label; merchant stays fuzzy on description', () => {
    const { db } = seed();
    const exact = apiTransactions(db, qs({ merchantExact: 'Whole Foods', limit: 100 }));
    expect(exact.map((t) => t.description)).toEqual(['Whole Foods #12']);
    // Blank merchant_name falls back to description.
    const fallback = apiTransactions(db, qs({ merchantExact: 'Whole Foods #14', limit: 100 }));
    expect(fallback.length).toBe(1);
    const fuzzy = apiTransactions(db, qs({ merchant: 'whole foods', limit: 100 }));
    expect(fuzzy.length).toBe(2);
  });

  test('category=Uncategorized, spendOnly, default entity', () => {
    const { db, defaultId } = seed();
    expect(apiTransactions(db, qs({ category: 'Uncategorized', limit: 100 })).length).toBe(4);
    const spend = apiTransactions(db, qs({ spendOnly: 1, limit: 100 }));
    expect(spend.every((t) => isSpend(t))).toBe(true);
    expect(spend.length).toBe(8);
    const def = apiTransactions(db, qs({ entityId: defaultId, limit: 100 }));
    expect(def.some((t) => t.description === 'Biz lunch')).toBe(false);
    expect(def.length).toBe(15);
  });
});

// ── Streak + weekly summary (dashboard-only endpoints) ──────────────────────

describe('streak and weekly summary take the rules only when asked', () => {
  test('no options → the historical constants', () => {
    expect(composeStreakDailySql()).toBe(STREAK_DAILY_SQL);
    expect(composeStreakDailySql({})).toBe(STREAK_DAILY_SQL);
    expect(composeWeekSql()).toEqual({
      total: WEEK_TOTAL_SQL,
      byCategory: WEEK_BY_CATEGORY_SQL,
      topMerchant: WEEK_TOP_MERCHANT_SQL,
    });
  });

  test('streak days use the SPEND rule under the dashboard rules', () => {
    const { db } = seed();
    const legacy = db.prepare(composeStreakDailySql()).all() as { date: string }[];
    const dash = db.prepare(composeStreakDailySql(DASHBOARD_RULES)).all() as { date: string }[];
    // 01-05..01-11 hold only negative income, card payments and transfers.
    for (const d of ['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-10', '2026-01-11']) {
      expect(legacy.some((r) => r.date === d)).toBe(true);
      expect(dash.some((r) => r.date === d)).toBe(false);
    }
    // The endpoint opts in; a CLI-style call (no opts) does not.
    const now = new Date(2026, 0, 11, 12); // the $75 card autopay is not spend
    expect(getStreak(db, 50, now).current).toBe(0);
    expect(getStreak(db, 50, now, DASHBOARD_RULES).current).toBeGreaterThan(0);
    expect(apiStreak(db)).toEqual(getStreak(db, undefined, undefined, DASHBOARD_RULES));
  });

  test('weekly summary excludes non-spend and merges Uncategorized under the rules', () => {
    const { db } = seed();
    const jan12 = new Date(2026, 0, 12, 12); // Monday: last week = Jan 5–11
    expect(getWeeklySummary(db, jan12).lastWeek.total).toBe(2000 + 500 + 250 + 100 + 75);
    const dash = getWeeklySummary(db, jan12, DASHBOARD_RULES);
    expect(dash.lastWeek).toEqual({ total: 0, byCategory: [], topMerchant: null });
    expect(dash.thisWeek.total).toBe(100);

    const feb16 = new Date(2026, 1, 16, 12); // last week = Feb 9–15: NULL + blank category
    expect(getWeeklySummary(db, feb16).lastWeek.byCategory).toHaveLength(2);
    expect(getWeeklySummary(db, feb16, DASHBOARD_RULES).lastWeek.byCategory).toEqual([
      { category: 'Uncategorized', total: 15 },
    ]);
    expect(apiWeeklySummary(db).thisWeek).toBeDefined();
  });
});
