// ── Shared overview aggregation SQL + pure math ──────────────────────────────
//
// The single source for the eight overview-card aggregations (daily spending,
// streak, weekly summary, budget countdown, spending summary, P&L, monthly
// savings, budget-vs-actual). The server functions (src/db/queries.ts,
// src/db/daily-queries.ts) and the offline mirror drivers
// (src/dashboard/ui/src/store/mirror-overview.ts) both compose THESE strings
// and helpers, so the two implementations can only drift in their trivial
// .all()/.get() glue — which the overview parity test pins by deep-equality.
//
// ZERO imports: this module must stay safe for the dashboard UI bundle (same
// constraint as transaction-where.ts). No `bun:sqlite`, no src/db/* imports,
// no browser APIs. Row interfaces are COPIED here as the single source; the
// server modules re-export them for compatibility.

// ── Minimal structural queryable ─────────────────────────────────────────────
//
// Both the server Database (compat-sqlite) and the mirror store's
// SqliteBinding satisfy this shape structurally. Callers await results
// unconditionally so one driver serves both the sync server and the
// promise-based wa-sqlite mirror.

export type SqlParams = Record<string, unknown>;
export type OverviewRow = Record<string, unknown>;
export type MaybePromise<T> = T | Promise<T>;

export interface OverviewStatement {
  all(params?: SqlParams): MaybePromise<OverviewRow[]>;
  get(params?: SqlParams): MaybePromise<OverviewRow | undefined>;
}

export interface OverviewQueryable {
  prepare(sql: string): OverviewStatement;
}

// ── Row interfaces (single source; server modules re-export these) ──────────

export interface DailySpendingRow {
  date: string;
  spending: number;
  count: number;
}

export interface StreakResult {
  current: number;
  longest: number;
  dailyBudget: number;
}

export interface WeekCategorySpending {
  category: string;
  total: number;
}

export interface WeekData {
  total: number;
  byCategory: WeekCategorySpending[];
  topMerchant: string | null;
}

export interface WeeklySummaryResult {
  thisWeek: WeekData;
  lastWeek: WeekData;
  change: { amount: number; percent: number };
}

export interface BudgetCountdownRow {
  category: string;
  limit: number;
  spent: number;
  remaining: number;
  daysLeft: number;
  perDay: number;
}

export interface SpendingSummaryRow {
  category: string;
  total: number;
  count: number;
}

export interface ProfitLossRow {
  totalIncome: number;
  totalExpenses: number;
  netProfitLoss: number;
  incomeByCategory: SpendingSummaryRow[];
  expensesByCategory: SpendingSummaryRow[];
}

export interface MonthlyIncomeExpense {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

export interface BudgetVsActualRow {
  category: string;
  monthly_limit: number;
  actual: number;
  remaining: number;
  percent_used: number;
  over: boolean;
}

/** Minimal shape the budget-vs-actual loop consumes from a budgets row. */
export interface BudgetLimitRow {
  category: string;
  monthly_limit: number;
}

// ── SQL constants (verbatim from the server implementations) ─────────────────

/** getDailySpending — daily expense totals between two dates. */
export const DAILY_SPENDING_SQL = `
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

/** getStreak — SUM(monthly_limit) across all budgets (the daily-budget basis). */
export const STREAK_BUDGET_TOTAL_SQL = `
      SELECT COALESCE(SUM(monthly_limit), 0) AS total
      FROM budgets
    `;

/** getStreak — per-day spending for all time, newest first. */
export const STREAK_DAILY_SQL = `
    SELECT date, COALESCE(SUM(ABS(amount)), 0) AS spending
    FROM transactions
    WHERE amount < 0
    GROUP BY date
    ORDER BY date DESC
  `;

/** getWeekData — total spending in a [startDate, endDate] window. */
export const WEEK_TOTAL_SQL = `
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
  `;

/** getWeekData — spending by category in a window. */
export const WEEK_BY_CATEGORY_SQL = `
    SELECT
      COALESCE(category, 'Uncategorized') AS category,
      SUM(ABS(amount)) AS total
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
    GROUP BY category
    ORDER BY total DESC
  `;

/** getWeekData — the window's biggest merchant. */
export const WEEK_TOP_MERCHANT_SQL = `
    SELECT COALESCE(merchant_name, description) AS merchant
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
    GROUP BY merchant
    ORDER BY SUM(ABS(amount)) DESC
    LIMIT 1
  `;

/** getBudgetCountdown — the budgets the countdown iterates. */
export const BUDGET_COUNTDOWN_BUDGETS_SQL = `
    SELECT category, monthly_limit
    FROM budgets
    ORDER BY category
  `;

/** getBudgetCountdown — one budget's month-to-date spending. */
export const BUDGET_COUNTDOWN_SPENT_SQL = `
      SELECT COALESCE(SUM(ABS(amount)), 0) AS spent
      FROM transactions
      WHERE category = @category
        AND date >= @startDate
        AND date <= @endDate
        AND amount < 0
    `;

/** getBudgets — the raw budgets rows (also the sync feed for /api/budgets/limits). */
export const BUDGETS_ALL_SQL = 'SELECT * FROM budgets ORDER BY category';

/** getBudgetVsActual — does the server have the categories table? (backward compat probe) */
export const HAS_CATEGORIES_PROBE_SQL = 'SELECT 1 FROM categories LIMIT 1';

// ── SQL composers (the dynamically-filtered aggregations) ────────────────────

/**
 * getSpendingSummary — spending by category with optional account/entity
 * filters. Note the filters carry NO table alias here (the query has none).
 */
export function composeSpendingSummarySql(
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number
): { sql: string; params: SqlParams } {
  const conditions = ['date >= @startDate', 'date <= @endDate', 'amount < 0'];
  const params: SqlParams = { startDate, endDate };
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

/**
 * getProfitLoss — income and expense category breakdowns with optional
 * account/entity filters. Income counts positives plus 'Income'-tagged rows;
 * expenses exclude 'Income'/'Transfer' so transfers are never double-counted.
 */
export function composePnlSql(
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number
): { incomeSql: string; expensesSql: string; params: SqlParams } {
  const baseParams: SqlParams = { startDate, endDate };
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

/**
 * getMonthlySavingsData — monthly income/expense series with optional
 * account/entity filters.
 */
export function composeSavingsSql(
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number
): { sql: string; params: SqlParams } {
  const params: SqlParams = { startDate, endDate };
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

/**
 * getBudgetVsActual — the optional t.-aliased filters (budget queries join
 * transactions through the categories rollup, hence the alias).
 */
export function composeBudgetActualClauses(
  accountId?: number,
  entityId?: number
): { acctFilter: string; entityFilter: string } {
  return {
    acctFilter: accountId !== undefined ? ' AND t.account_id = @accountId' : '',
    entityFilter: entityId !== undefined ? ' AND t.entity_id = @entityId' : '',
  };
}

/** getBudgetVsActual — rollup SQL: this category plus every descendant. */
export function composeBudgetRollupSql(acctFilter: string, entityFilter: string): string {
  return `
        WITH RECURSIVE descendants AS (
          SELECT id, name FROM categories WHERE LOWER(name) = LOWER(@category)
          UNION ALL
          SELECT c.id, c.name FROM categories c
          JOIN descendants d ON c.parent_id = d.id
        )
        SELECT COALESCE(SUM(ABS(t.amount)), 0) AS actual
        FROM transactions t
        JOIN descendants d ON LOWER(t.category) = LOWER(d.name)
        WHERE t.date >= @startDate
          AND t.date <= @endDate
          AND t.amount < 0${acctFilter}${entityFilter}
      `;
}

/** getBudgetVsActual — fallback when the categories table does not exist. */
export function composeBudgetFallbackSql(acctFilter: string, entityFilter: string): string {
  return `
        SELECT COALESCE(SUM(ABS(t.amount)), 0) AS actual
        FROM transactions t
        WHERE LOWER(t.category) = LOWER(@category)
          AND t.date >= @startDate
          AND t.date <= @endDate
          AND t.amount < 0${acctFilter}${entityFilter}
      `;
}

// ── Calendar windows (pure math; `now` injectable for deterministic tests) ──

/**
 * Budget-countdown month bounds: string-built month start and end (the
 * countdown compares date STRINGS against today, so the end is the padded
 * calendar last day, not a UTC-rendered one).
 */
export function countdownMonthBounds(month: string): { startDate: string; endDate: string; lastDay: number } {
  const startDate = `${month}-01`;
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate, lastDay };
}

/**
 * Days remaining in `month` (YYYY-MM) as of `now`, computed exactly as the
 * budget-countdown endpoint always has: before the month → the full month;
 * after it → 0; inside it → remaining days including today.
 */
export function countdownDaysLeft(month: string, now: Date = new Date()): number {
  const { startDate, endDate, lastDay } = countdownMonthBounds(month);
  const [year, mon] = month.split('-').map(Number);

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const endOfMonth = new Date(year, mon - 1, lastDay);
  const todayStr = today.toISOString().slice(0, 10);

  if (todayStr < startDate) {
    // Month hasn't started
    return lastDay;
  }
  if (todayStr > endDate) {
    // Month is over
    return 0;
  }
  // We're in the month: remaining days including today
  return Math.ceil((endOfMonth.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Budget-vs-actual month window: UTC month-end via toISOString (the
 * construction getBudgetVsActual has always used).
 */
export function budgetMonthWindow(month: string): { startDate: string; endDate: string } {
  const startDate = `${month}-01`;
  const [year, mon] = month.split('-').map(Number);
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);
  return { startDate, endDate };
}

export interface WeekWindows {
  thisStart: string;
  thisEnd: string;
  lastStart: string;
  lastEnd: string;
}

/**
 * Monday-based this/last week windows (getWeeklySummary's calendar rule,
 * verbatim): Monday of the current week through Sunday, and the same window
 * shifted back seven days.
 */
export function weekWindows(now: Date = new Date()): WeekWindows {
  const today = new Date(now);
  // Find Monday of current week (ISO: Monday = 1)
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() + mondayOffset);
  thisMonday.setHours(0, 0, 0, 0);

  const thisSunday = new Date(thisMonday);
  thisSunday.setDate(thisMonday.getDate() + 6);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    thisStart: iso(thisMonday),
    thisEnd: iso(thisSunday),
    lastStart: iso(lastMonday),
    lastEnd: iso(lastSunday),
  };
}

/**
 * The streak's daily budget: total monthly budget divided by the days in the
 * current LOCAL month (0 when there are no budgets). This is why the offline
 * mirror must carry the budgets table.
 */
export function computeStreakDailyBudget(totalMonthlyLimit: number, now: Date = new Date()): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return totalMonthlyLimit > 0 ? totalMonthlyLimit / daysInMonth : 0;
}

/**
 * Current and longest under-budget streaks from daily spending rows.
 *
 * `budget` is the per-day allowance (see computeStreakDailyBudget). Days with
 * no row count as no-spending days (they extend streaks). The current-streak
 * walk goes backward from today with a 365-day safety cap; the longest streak
 * scans every day from the first to the last spending date; a current streak
 * that outgrows every historical one wins via the `current > longest` fixup.
 */
export function computeStreak(
  spendingRows: { date: string; spending: number }[],
  budget: number,
  now: Date = new Date()
): StreakResult {
  if (budget <= 0) {
    return { current: 0, longest: 0, dailyBudget: budget };
  }

  if (spendingRows.length === 0) {
    return { current: 0, longest: 0, dailyBudget: budget };
  }

  // Build a set of dates with their spending
  const spendingByDate = new Map<string, number>();
  for (const row of spendingRows) {
    spendingByDate.set(row.date, row.spending);
  }

  // Walk backwards from today to compute current streak
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let current = 0;
  const cursor = new Date(today);

  while (true) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const spent = spendingByDate.get(dateStr) ?? 0;
    if (spent < budget) {
      current++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
    // Safety: don't walk back more than 365 days
    if (current > 365) break;
  }

  // Compute longest streak from all daily data
  // Sort dates ascending
  const allDates = Array.from(spendingByDate.keys()).sort();
  let longest = 0;
  let streak = 0;

  if (allDates.length > 0) {
    const firstDate = new Date(allDates[0]);
    const lastDate = new Date(allDates[allDates.length - 1]);
    const d = new Date(firstDate);

    while (d <= lastDate) {
      const dateStr = d.toISOString().slice(0, 10);
      const spent = spendingByDate.get(dateStr) ?? 0;
      if (spent < budget) {
        streak++;
        if (streak > longest) longest = streak;
      } else {
        streak = 0;
      }
      d.setDate(d.getDate() + 1);
    }
  }

  if (current > longest) longest = current;

  return { current, longest, dailyBudget: budget };
}

/**
 * Savings-series window: the last `months` calendar months ending with
 * `endMonth` (default: the current month). Month start is built from local
 * calendar math; the end is the UTC-rendered last day of the end month.
 */
export function savingsWindow(
  endMonth: string | undefined,
  months: number,
  now: Date = new Date()
): { startDate: string; endDate: string } {
  const end = endMonth ?? new Date(now).toISOString().slice(0, 7);
  const [endYear, endMon] = end.split('-').map(Number);
  const endDate = new Date(endYear, endMon, 0).toISOString().slice(0, 10);

  const startDate = (() => {
    const d = new Date(endYear, endMon - months, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();

  return { startDate, endDate };
}

/**
 * Savings mapping: income − expenses, and the savings rate as a percentage of
 * income (0 when there was no income).
 */
export function toMonthlyIncomeExpense(
  rows: { month: string; income: number; expenses: number }[]
): MonthlyIncomeExpense[] {
  return rows.map((r) => {
    const savings = r.income - r.expenses;
    const savingsRate = r.income > 0 ? (savings / r.income) * 100 : 0;
    return { ...r, savings, savingsRate };
  });
}

/**
 * P&L summary: category totals in, totals + net out. netProfitLoss adds the
 * (negative-signed) expense total to income — the historical sign convention
 * of the endpoint.
 */
export function summarizePnl(
  incomeByCategory: SpendingSummaryRow[],
  expensesByCategory: SpendingSummaryRow[]
): ProfitLossRow {
  const totalIncome = incomeByCategory.reduce((sum, r) => sum + r.total, 0);
  const totalExpenses = expensesByCategory.reduce((sum, r) => sum + r.total, 0);

  return {
    totalIncome,
    totalExpenses,
    netProfitLoss: totalIncome + totalExpenses,
    incomeByCategory,
    expensesByCategory,
  };
}

/**
 * One budget-vs-actual row: remaining, rounded percent used, over flag.
 */
export function budgetActualRow(budget: BudgetLimitRow, actual: number): BudgetVsActualRow {
  const remaining = budget.monthly_limit - actual;
  const percentUsed = budget.monthly_limit > 0 ? Math.round((actual / budget.monthly_limit) * 100) : 0;

  return {
    category: budget.category,
    monthly_limit: budget.monthly_limit,
    actual,
    remaining,
    percent_used: percentUsed,
    over: actual > budget.monthly_limit,
  };
}