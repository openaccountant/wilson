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
// Pure module — imports only overview-sql.js (shared constants + math); no
// browser glue, no bun:sqlite.

import {
  DAILY_SPENDING_SQL,
  STREAK_BUDGET_TOTAL_SQL,
  STREAK_DAILY_SQL,
  WEEK_TOTAL_SQL,
  WEEK_BY_CATEGORY_SQL,
  WEEK_TOP_MERCHANT_SQL,
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
  type DailySpendingRow,
  type MonthlyIncomeExpense,
  type OverviewQueryable,
  type ProfitLossRow,
  type SpendingSummaryRow,
  type StreakResult,
  type WeekCategorySpending,
  type WeekData,
  type WeeklySummaryResult,
} from '../../../../db/overview-sql.js';

/** Mirror counterpart of getDailySpending (src/db/daily-queries.ts). */
export async function mirrorGetDailySpending(
  db: OverviewQueryable,
  startDate: string,
  endDate: string
): Promise<DailySpendingRow[]> {
  return (await db.prepare(DAILY_SPENDING_SQL).all({ startDate, endDate })) as unknown as DailySpendingRow[];
}

/**
 * Mirror counterpart of getStreak — derives the daily budget from the budgets
 * table (SUM(monthly_limit)/days-in-month) exactly as the server does when the
 * endpoint passes no explicit budget.
 */
export async function mirrorGetStreak(
  db: OverviewQueryable,
  now: Date = new Date()
): Promise<StreakResult> {
  const row = (await db.prepare(STREAK_BUDGET_TOTAL_SQL).get()) as unknown as { total: number };
  const budget = computeStreakDailyBudget(row.total, now);

  const rows = (await db.prepare(STREAK_DAILY_SQL).all()) as unknown as { date: string; spending: number }[];
  return computeStreak(rows, budget, now);
}

/** Mirror counterpart of getWeeklySummary's getWeekData glue. */
async function mirrorGetWeekData(
  db: OverviewQueryable,
  startDate: string,
  endDate: string
): Promise<WeekData> {
  const totalRow = (await db.prepare(WEEK_TOTAL_SQL).get({ startDate, endDate })) as unknown as { total: number };
  const byCategory = (await db
    .prepare(WEEK_BY_CATEGORY_SQL)
    .all({ startDate, endDate })) as unknown as WeekCategorySpending[];
  const topMerchantRow = (await db
    .prepare(WEEK_TOP_MERCHANT_SQL)
    .get({ startDate, endDate })) as unknown as { merchant: string } | undefined;

  return {
    total: totalRow.total,
    byCategory,
    topMerchant: topMerchantRow?.merchant ?? null,
  };
}

/** Mirror counterpart of getWeeklySummary (Monday-based weeks). */
export async function mirrorGetWeeklySummary(
  db: OverviewQueryable,
  now: Date = new Date()
): Promise<WeeklySummaryResult> {
  const windows = weekWindows(now);

  const thisWeek = await mirrorGetWeekData(db, windows.thisStart, windows.thisEnd);
  const lastWeek = await mirrorGetWeekData(db, windows.lastStart, windows.lastEnd);

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
  entityId?: number
): Promise<SpendingSummaryRow[]> {
  const { sql, params } = composeSpendingSummarySql(startDate, endDate, accountId, entityId);
  return (await db.prepare(sql).all(params)) as unknown as SpendingSummaryRow[];
}

/** Mirror counterpart of getProfitLoss. */
export async function mirrorGetProfitLoss(
  db: OverviewQueryable,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number
): Promise<ProfitLossRow> {
  const { incomeSql, expensesSql, params } = composePnlSql(startDate, endDate, accountId, entityId);

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
  entityId?: number
): Promise<MonthlyIncomeExpense[]> {
  const { startDate, endDate } = savingsWindow(endMonth, months);
  const { sql, params } = composeSavingsSql(startDate, endDate, accountId, entityId);

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