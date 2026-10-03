// ── Offline mirror: overview aggregation drivers ─────────────────────────────
//
// Async mirror counterparts of the server's eight overview aggregations
// (getDailySpending, getStreak, getWeeklySummary, getBudgetCountdown,
// getSpendingSummary, getProfitLoss, getMonthlySavingsData, getBudgetVsActual
// in src/db/queries.ts + src/db/daily-queries.ts).
//
// Equivalence by construction: every SQL string and every piece of calendar /
// streak / rollup math comes from the shared zero-import module
// src/db/overview-sql.ts — the server functions compose the SAME constants.
// Only the per-side glue differs (await here, sync `.all()/.get()` there),
// plus the two per-budget loops mirrored below exactly as the server runs
// them. The overview parity test deep-equals every driver against the real
// server handlers.
//
// Pure module — imports only overview-sql.js (shared constants + math) and the
// zero-import spend-rules.js; no browser glue, no bun:sqlite.

import {
  composeDailySpendingSql,
  COVERAGE_RANGE_SQL,
  COVERAGE_MONTHS_SQL,
  toCoverage,
  CATEGORY_OPTIONS_SQL,
  toCategoryOptions,
  budgetActualRangeRow,
  STREAK_BUDGET_TOTAL_SQL,
  composeStreakDailySql,
  composeWeekSql,
  BUDGET_COUNTDOWN_BUDGETS_SQL,
  BUDGET_COUNTDOWN_SPENT_SQL,
  BUDGETS_ALL_SQL,
  HAS_CATEGORIES_PROBE_SQL,
  composeSpendingSummarySql,
  composePnlSql,
  composeSavingsSql,
  composeBudgetActualClauses,
  composeBudgetRollupSql,
  composeBudgetFallbackSql,
  budgetMonthWindow,
  countdownMonthBounds,
  countdownDaysLeft,
  computeStreak,
  computeStreakDailyBudget,
  savingsWindow,
  toMonthlyIncomeExpense,
  summarizePnl,
  budgetActualRow,
  weekWindows,
  type BudgetCountdownRow,
  type BudgetLimitRow,
  type BudgetVsActualRow,
  type CoverageResult,
  type OverviewOptions,
  type DailySpendingRow,
  type MonthlyIncomeExpense,
  type OverviewQueryable,
  type ProfitLossRow,
  type SpendingSummaryRow,
  type StreakResult,
  type WeekCategorySpending,
  type WeekData,
  type WeekSql,
  type EntityScopedOptions,
  entityScopeParams,
  type WeeklySummaryResult,
} from '../../../../db/overview-sql.js';
import { monthsInRange, type DashboardRules } from '../../../../db/spend-rules.js';

/** Mirror counterpart of getDailySpending (src/db/daily-queries.ts). */
export async function mirrorGetDailySpending(
  db: OverviewQueryable,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): Promise<DailySpendingRow[]> {
  const { sql, params } = composeDailySpendingSql(startDate, endDate, accountId, entityId, opts);
  return (await db.prepare(sql).all(params)) as unknown as DailySpendingRow[];
}

/** Mirror counterpart of getCoverage (src/db/queries.ts). */
export async function mirrorGetCoverage(db: OverviewQueryable): Promise<CoverageResult> {
  const range = (await db.prepare(COVERAGE_RANGE_SQL).get()) as { first_date?: unknown; last_date?: unknown } | undefined;
  const months = (await db.prepare(COVERAGE_MONTHS_SQL).all()) as { month?: unknown }[];
  return toCoverage(range, months);
}

/** Mirror counterpart of getCategoryOptions (src/db/queries.ts). */
export async function mirrorGetCategoryOptions(db: OverviewQueryable): Promise<string[]> {
  const rows = (await db.prepare(CATEGORY_OPTIONS_SQL).all()) as { category?: unknown }[];
  return toCategoryOptions(rows);
}

/**
 * Mirror counterpart of getStreak — derives the daily budget from the budgets
 * table (SUM(monthly_limit)/days-in-month) exactly as the server does when the
 * endpoint passes no explicit budget.
 */
export async function mirrorGetStreak(
  db: OverviewQueryable,
  now: Date = new Date(),
  opts?: EntityScopedOptions
): Promise<StreakResult> {
  const row = (await db.prepare(STREAK_BUDGET_TOTAL_SQL).get()) as unknown as { total: number };
  const budget = computeStreakDailyBudget(row.total, now);

  const rows = (await db.prepare(composeStreakDailySql(opts)).all(entityScopeParams(opts))) as unknown as {
    date: string;
    spending: number;
  }[];
  return computeStreak(rows, budget, now);
}

/** Mirror counterpart of getWeeklySummary's getWeekData glue. */
async function mirrorGetWeekData(
  db: OverviewQueryable,
  sql: WeekSql,
  params: Record<string, unknown>
): Promise<WeekData> {
  const totalRow = (await db.prepare(sql.total).get(params)) as unknown as { total: number };
  const byCategory = (await db
    .prepare(sql.byCategory)
    .all(params)) as unknown as WeekCategorySpending[];
  const topMerchantRow = (await db
    .prepare(sql.topMerchant)
    .get(params)) as unknown as { merchant: string } | undefined;

  return {
    total: totalRow.total,
    byCategory,
    topMerchant: topMerchantRow?.merchant ?? null,
  };
}

/** Mirror counterpart of getWeeklySummary (Monday-based weeks). */
export async function mirrorGetWeeklySummary(
  db: OverviewQueryable,
  now: Date = new Date(),
  opts?: EntityScopedOptions
): Promise<WeeklySummaryResult> {
  const windows = weekWindows(now);
  const sql = composeWeekSql(opts);
  const scope = entityScopeParams(opts);

  const thisWeek = await mirrorGetWeekData(db, sql, { ...scope, startDate: windows.thisStart, endDate: windows.thisEnd });
  const lastWeek = await mirrorGetWeekData(db, sql, { ...scope, startDate: windows.lastStart, endDate: windows.lastEnd });

  const changeAmount = thisWeek.total - lastWeek.total;
  const changePercent = lastWeek.total > 0 ? Math.round((changeAmount / lastWeek.total) * 100) : 0;

  return {
    thisWeek,
    lastWeek,
    change: { amount: changeAmount, percent: changePercent },
  };
}

/** Mirror counterpart of getBudgetCountdown (per-budget spent loop). */
export async function mirrorGetBudgetCountdown(
  db: OverviewQueryable,
  month: string,
  now: Date = new Date()
): Promise<BudgetCountdownRow[]> {
  const { startDate, endDate } = countdownMonthBounds(month);
  const daysLeft = countdownDaysLeft(month, now);

  const budgets = (await db
    .prepare(BUDGET_COUNTDOWN_BUDGETS_SQL)
    .all()) as unknown as { category: string; monthly_limit: number }[];

  if (budgets.length === 0) return [];

  const results: BudgetCountdownRow[] = [];

  for (const budget of budgets) {
    const row = (await db
      .prepare(BUDGET_COUNTDOWN_SPENT_SQL)
      .get({ category: budget.category, startDate, endDate })) as unknown as { spent: number };

    const remaining = budget.monthly_limit - row.spent;
    const perDay = daysLeft > 0 ? remaining / daysLeft : 0;

    results.push({
      category: budget.category,
      limit: budget.monthly_limit,
      spent: row.spent,
      remaining,
      daysLeft,
      perDay,
    });
  }

  return results;
}

/** Mirror counterpart of getSpendingSummary. */
export async function mirrorGetSpendingSummary(
  db: OverviewQueryable,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): Promise<SpendingSummaryRow[]> {
  const { sql, params } = composeSpendingSummarySql(startDate, endDate, accountId, entityId, opts);
  return (await db.prepare(sql).all(params)) as unknown as SpendingSummaryRow[];
}

/** Mirror counterpart of getProfitLoss. */
export async function mirrorGetProfitLoss(
  db: OverviewQueryable,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): Promise<ProfitLossRow> {
  const { incomeSql, expensesSql, params } = composePnlSql(startDate, endDate, accountId, entityId, opts);

  const incomeByCategory = (await db.prepare(incomeSql).all(params)) as unknown as SpendingSummaryRow[];
  const expensesByCategory = (await db.prepare(expensesSql).all(params)) as unknown as SpendingSummaryRow[];

  return summarizePnl(incomeByCategory, expensesByCategory);
}

/** Mirror counterpart of getMonthlySavingsData. */
export async function mirrorGetMonthlySavingsData(
  db: OverviewQueryable,
  endMonth?: string,
  months: number = 6,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): Promise<MonthlyIncomeExpense[]> {
  const { startDate, endDate } = savingsWindow(endMonth, months);
  const { sql, params } = composeSavingsSql(startDate, endDate, accountId, entityId, opts);

  const rows = (await db.prepare(sql).all(params)) as unknown as { month: string; income: number; expenses: number }[];
  return toMonthlyIncomeExpense(rows);
}

/**
 * Mirror counterpart of getBudgetVsActual, including the hasCategories probe
 * (try/catch, as server-side) and the per-budget loop. The mirror always
 * carries categories (they are synced), so the recursive-rollup CTE is the
 * live path on both migrated servers and mirrors.
 */
export async function mirrorGetBudgetVsActual(
  db: OverviewQueryable,
  month: string,
  accountId?: number,
  entityId?: number
): Promise<BudgetVsActualRow[]> {
  const { startDate, endDate } = budgetMonthWindow(month);

  const budgets = (await db.prepare(BUDGETS_ALL_SQL).all()) as unknown as BudgetLimitRow[];
  if (budgets.length === 0) return [];

  const hasCategories = await (async () => {
    try {
      await db.prepare(HAS_CATEGORIES_PROBE_SQL).get();
      return true;
    } catch {
      return false;
    }
  })();

  const { acctFilter, entityFilter } = composeBudgetActualClauses(accountId, entityId);
  const results: BudgetVsActualRow[] = [];

  for (const budget of budgets) {
    const params: Record<string, unknown> = { category: budget.category, startDate, endDate };
    if (accountId !== undefined) params.accountId = accountId;
    if (entityId !== undefined) params.entityId = entityId;

    const sql = hasCategories
      ? composeBudgetRollupSql(acctFilter, entityFilter)
      : composeBudgetFallbackSql(acctFilter, entityFilter);
    const row = (await db.prepare(sql).get(params)) as unknown as { actual: number };

    results.push(budgetActualRow(budget, row.actual));
  }

  return results;
}

/**
 * Mirror counterpart of getBudgetVsActualRange (dashboard range mode): actual
 * over [startDate, endDate] vs monthly_limit × day-prorated months in the range.
 */
export async function mirrorGetBudgetVsActualRange(
  db: OverviewQueryable,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  rules?: DashboardRules
): Promise<BudgetVsActualRow[]> {
  const budgets = (await db.prepare(BUDGETS_ALL_SQL).all()) as unknown as BudgetLimitRow[];
  if (budgets.length === 0) return [];

  const hasCategories = await (async () => {
    try {
      await db.prepare(HAS_CATEGORIES_PROBE_SQL).get();
      return true;
    } catch {
      return false;
    }
  })();

  const months = monthsInRange(startDate, endDate);
  const { acctFilter, entityFilter } = composeBudgetActualClauses(accountId, entityId, rules);
  const sql = hasCategories
    ? composeBudgetRollupSql(acctFilter, entityFilter)
    : composeBudgetFallbackSql(acctFilter, entityFilter);

  const results: BudgetVsActualRow[] = [];
  for (const budget of budgets) {
    const params: Record<string, unknown> = { category: budget.category, startDate, endDate };
    if (accountId !== undefined) params.accountId = accountId;
    if (entityId !== undefined) params.entityId = entityId;
    const row = (await db.prepare(sql).get(params)) as unknown as { actual: number };
    results.push(budgetActualRangeRow(budget, row.actual, months));
  }
  return results;
}
