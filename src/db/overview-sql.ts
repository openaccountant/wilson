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
// Import-safe for the dashboard UI bundle: it imports ONLY the bundle-safe
// siblings spend-rules.ts (zero imports) and transaction-where.ts (imports
// only spend-rules). No `bun:sqlite`, no other src/db/* imports, no browser
// APIs. Row interfaces are COPIED here as the single source; the server
// modules re-export them for compatibility.
//
// Dashboard rules (spend-rules.ts) are OPT-IN: each composer takes an
// optional trailing `opts`; with no opts (every CLI/report/goal caller) the
// historical SQL is returned byte-for-byte — pinned by spend-rules.test.ts.

import {
  categoryLabelSql,
  incomeAmountSql,
  incomeSql as incomeRuleSql,
  spendSql,
  entityFilterSql,
  hasDashboardRules,
  INCOME_CATEGORY,
  type DashboardRules,
} from './spend-rules.js';
import { buildTransactionConditions } from './transaction-where.js';

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

// ── Dashboard options (opt-in rules + dashboard-only category filter) ───────

/**
 * Optional trailing argument of the overview composers: the dashboard rule
 * flags plus the dashboard-only category filter. Omitted → historical SQL.
 */
export interface OverviewOptions extends DashboardRules {
  /** Exact category filter ('Uncategorized' matches NULL/blank under uncategorizedMatchesBlank). */
  category?: string;
}

/**
 * Options for the all-time / fixed-window cards (streak, weekly summary) that
 * have no account/date params of their own: the dashboard rules plus an
 * optional entity scope (`@entityId`).
 */
export interface EntityScopedOptions extends OverviewOptions {
  entityId?: number;
}

/** The entity condition for EntityScopedOptions (null when unscoped). */
function entityConditionSql(opts: EntityScopedOptions | undefined): string | null {
  if (opts?.entityId === undefined) return null;
  return opts.defaultEntityIncludesNull ? entityFilterSql(opts.entityId).sql : 'entity_id = @entityId';
}

/** Bind params for the entity condition (merge into the statement's params). */
export function entityScopeParams(opts: EntityScopedOptions | undefined): SqlParams {
  return opts?.entityId === undefined ? {} : { entityId: opts.entityId };
}

/** True when opts change anything (otherwise the legacy SQL path runs). */
function isActive(opts: OverviewOptions | undefined): opts is OverviewOptions {
  return !!opts && (hasDashboardRules(opts) || !!opts.category);
}

/** Shared dashboard WHERE conditions: date window + account/entity/category. */
function dashboardConditions(
  startDate: string,
  endDate: string,
  accountId: number | undefined,
  entityId: number | undefined,
  opts: OverviewOptions
): { conditions: string[]; params: SqlParams } {
  return buildTransactionConditions(
    { dateStart: startDate, dateEnd: endDate, accountId, entityId, category: opts.category || undefined },
    opts
  );
}

function expenseConditionSql(opts: OverviewOptions): string {
  return opts.excludeNonSpend ? spendSql() : 'amount < 0';
}

function labelSelectSql(opts: OverviewOptions): string {
  return opts.labelGrouping ? categoryLabelSql() : "COALESCE(category, 'Uncategorized')";
}

function labelGroupSql(opts: OverviewOptions): string {
  return opts.labelGrouping ? categoryLabelSql() : 'category';
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
  /** Range mode only (dashboard): monthly_limit × months — what remaining/percent/over compare against. */
  limit?: number;
  /** Range mode only (dashboard): day-prorated months in the requested range (spend-rules monthsInRange). */
  months?: number;
  actual: number;
  remaining: number;
  percent_used: number;
  over: boolean;
}

/** GET /api/coverage — months that have ANY imported transactions (unfiltered). */
export interface CoverageResult {
  start: string | null;
  end: string | null;
  months: string[];
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

/**
 * getDailySpending — DAILY_SPENDING_SQL with no filters/opts; otherwise the
 * account/entity/category filters (and, with dashboard opts, the spend rule)
 * apply.
 */
export function composeDailySpendingSql(
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): { sql: string; params: SqlParams } {
  if (!isActive(opts) && accountId === undefined && entityId === undefined) {
    return { sql: DAILY_SPENDING_SQL, params: { startDate, endDate } };
  }
  const o = opts ?? {};
  const { conditions, params } = dashboardConditions(startDate, endDate, accountId, entityId, o);
  conditions.push(expenseConditionSql(o));
  const sql = `
    SELECT
      date,
      SUM(ABS(amount)) AS spending,
      COUNT(*) AS count
    FROM transactions
    WHERE ${conditions.join(' AND ')}
    GROUP BY date
    ORDER BY date
  `;
  return { sql, params };
}

/** getCoverage — first/last transaction date (well-formed dates only). */
export const COVERAGE_RANGE_SQL = `
    SELECT MIN(date) AS first_date, MAX(date) AS last_date
    FROM transactions
    WHERE date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'
  `;

/** getCoverage — every YYYY-MM with at least one transaction, ascending. */
export const COVERAGE_MONTHS_SQL = `
    SELECT DISTINCT substr(date, 1, 7) AS month
    FROM transactions
    WHERE date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'
    ORDER BY month
  `;

/** Shape the coverage rows into the /api/coverage contract. */
export function toCoverage(
  range: { first_date?: unknown; last_date?: unknown } | undefined,
  monthRows: { month?: unknown }[]
): CoverageResult {
  const day = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null);
  return {
    start: day(range?.first_date),
    end: day(range?.last_date),
    months: monthRows.map((r) => String(r.month)),
  };
}

/**
 * Dashboard header category filter options: every distinct category LABEL in
 * transactions (NULL/blank/'Uncategorized' are one 'Uncategorized' bucket).
 * Deliberately NOT spend-filtered — Transfer, Credit Card, Payment and Income
 * are valid filters even though the spending summary excludes them.
 */
export const CATEGORY_OPTIONS_SQL = `
    SELECT DISTINCT ${categoryLabelSql()} AS category
    FROM transactions
    ORDER BY category
  `;

/** Shape CATEGORY_OPTIONS_SQL rows into the /api/category-options contract. */
export function toCategoryOptions(rows: { category?: unknown }[]): string[] {
  return rows.map((r) => String(r.category));
}

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

/**
 * getStreak — STREAK_DAILY_SQL verbatim without dashboard opts; with
 * `excludeNonSpend` the per-day total uses the SPEND rule, so the streak
 * agrees with the dashboard heatmap (composeDailySpendingSql). An `entityId`
 * scopes the days to that entity (bind entityScopeParams(opts)).
 */
export function composeStreakDailySql(opts?: EntityScopedOptions): string {
  const entity = entityConditionSql(opts);
  const spendRule = isActive(opts) && !!opts.excludeNonSpend;
  if (!spendRule && !entity) return STREAK_DAILY_SQL;
  const conditions = [spendRule ? spendSql() : 'amount < 0'];
  if (entity) conditions.push(entity);
  return `
    SELECT date, COALESCE(SUM(ABS(amount)), 0) AS spending
    FROM transactions
    WHERE ${conditions.join(' AND ')}
    GROUP BY date
    ORDER BY date DESC
  `;
}

/** The three getWeekData statements (params: @startDate, @endDate). */
export interface WeekSql {
  total: string;
  byCategory: string;
  topMerchant: string;
}

/**
 * getWeekData — the WEEK_* constants verbatim without dashboard opts. With
 * opts, spending uses the SPEND rule (excludeNonSpend) and categories group
 * into one Uncategorized bucket (labelGrouping), matching the summary card.
 * An `entityId` scopes every statement (bind entityScopeParams(opts)).
 */
export function composeWeekSql(opts?: EntityScopedOptions): WeekSql {
  const entity = entityConditionSql(opts);
  if (!isActive(opts) && !entity) {
    return { total: WEEK_TOTAL_SQL, byCategory: WEEK_BY_CATEGORY_SQL, topMerchant: WEEK_TOP_MERCHANT_SQL };
  }
  const o: EntityScopedOptions = opts ?? {};
  const spend = expenseConditionSql(o);
  const window = `${spend}
      AND date >= @startDate
      AND date <= @endDate${entity ? `\n      AND ${entity}` : ''}`;
  return {
    total: `
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total
    FROM transactions
    WHERE ${window}
  `,
    byCategory: `
    SELECT
      ${labelSelectSql(o)} AS category,
      SUM(ABS(amount)) AS total
    FROM transactions
    WHERE ${window}
    GROUP BY ${labelGroupSql(o)}
    ORDER BY total DESC
  `,
    topMerchant: `
    SELECT COALESCE(merchant_name, description) AS merchant
    FROM transactions
    WHERE ${window}
    GROUP BY merchant
    ORDER BY SUM(ABS(amount)) DESC
    LIMIT 1
  `,
  };
}

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
  entityId?: number,
  opts?: OverviewOptions
): { sql: string; params: SqlParams } {
  if (isActive(opts)) {
    const { conditions, params } = dashboardConditions(startDate, endDate, accountId, entityId, opts);
    conditions.push(expenseConditionSql(opts));
    const sql = `
    SELECT
      ${labelSelectSql(opts)} AS category,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${labelGroupSql(opts)}
    ORDER BY total ASC
  `;
    return { sql, params };
  }
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
 *
 * Dashboard opts: income follows the INCOME rule summed as ABS(amount)
 * (negative-stored paychecks count), expenses follow the SPEND rule.
 * Under a category filter the P&L is EXPENSE-ONLY for that category — income
 * appears only when the filter is 'Income' itself — so a refund inside a
 * spending category never shows up as income for it.
 */
export function composePnlSql(
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): { incomeSql: string; expensesSql: string; params: SqlParams } {
  if (isActive(opts)) {
    const { conditions, params } = dashboardConditions(startDate, endDate, accountId, entityId, opts);
    const incomeConds = [...conditions];
    incomeConds.push(opts.normalizedIncome ? incomeRuleSql() : "(amount > 0 OR category = 'Income')");
    if (opts.category) incomeConds.push(`category = '${INCOME_CATEGORY}'`);
    const incomeTotal = opts.normalizedIncome ? `SUM(${incomeAmountSql()})` : 'SUM(amount)';
    const expenseConds = [...conditions];
    expenseConds.push(
      opts.excludeNonSpend ? spendSql() : "amount < 0 AND COALESCE(category, '') NOT IN ('Income', 'Transfer')"
    );
    const incomeSqlText = `
    SELECT ${labelSelectSql(opts)} AS category, ${incomeTotal} AS total, COUNT(*) AS count
    FROM transactions
    WHERE ${incomeConds.join(' AND ')}
    GROUP BY ${labelGroupSql(opts)} ORDER BY total DESC
  `;
    const expensesSqlText = `
    SELECT ${labelSelectSql(opts)} AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE ${expenseConds.join(' AND ')}
    GROUP BY ${labelGroupSql(opts)} ORDER BY total ASC
  `;
    return { incomeSql: incomeSqlText, expensesSql: expensesSqlText, params };
  }
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
  entityId?: number,
  opts?: OverviewOptions
): { sql: string; params: SqlParams } {
  if (isActive(opts)) {
    const { conditions, params } = dashboardConditions(startDate, endDate, accountId, entityId, opts);
    const incomeCase = opts.normalizedIncome
      ? `CASE WHEN ${incomeRuleSql()} THEN ${incomeAmountSql()} ELSE 0 END`
      : 'CASE WHEN amount > 0 THEN amount ELSE 0 END';
    const expenseCase = `CASE WHEN ${expenseConditionSql(opts)} THEN ABS(amount) ELSE 0 END`;
    const sql = `
    SELECT strftime('%Y-%m', date) AS month,
      COALESCE(SUM(${incomeCase}), 0) AS income,
      COALESCE(SUM(${expenseCase}), 0) AS expenses
    FROM transactions WHERE ${conditions.join(' AND ')}
    GROUP BY strftime('%Y-%m', date) ORDER BY month
  `;
    return { sql, params };
  }
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
  entityId?: number,
  opts?: Pick<DashboardRules, 'defaultEntityIncludesNull'>
): { acctFilter: string; entityFilter: string } {
  let entityFilter = entityId !== undefined ? ' AND t.entity_id = @entityId' : '';
  if (entityId !== undefined && opts?.defaultEntityIncludesNull) {
    entityFilter = ` AND ${entityFilterSql(entityId, 't').sql}`;
  }
  return {
    acctFilter: accountId !== undefined ? ' AND t.account_id = @accountId' : '',
    entityFilter,
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

/**
 * Range-mode budget row (dashboard): the limit is monthly_limit × the number
 * of day-prorated months in the requested range, and remaining / percent_used /
 * over compare against that scaled limit. `monthly_limit` stays the raw
 * monthly figure; `limit` and `months` label the scaling.
 */
export function budgetActualRangeRow(budget: BudgetLimitRow, actual: number, months: number): BudgetVsActualRow {
  const limit = budget.monthly_limit * months;
  const remaining = limit - actual;
  const percentUsed = limit > 0 ? Math.round((actual / limit) * 100) : 0;
  return {
    category: budget.category,
    monthly_limit: budget.monthly_limit,
    limit,
    months,
    actual,
    remaining,
    percent_used: percentUsed,
    over: actual > limit,
  };
}
