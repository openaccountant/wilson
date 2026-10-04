import type { Database } from './compat-sqlite.js';
import {
  composeDailySpendingSql,
  composeStreakDailySql,
  composeWeekSql,
  STREAK_BUDGET_TOTAL_SQL,
  BUDGET_COUNTDOWN_BUDGETS_SQL,
  BUDGET_COUNTDOWN_SPENT_SQL,
  computeStreak,
  computeStreakDailyBudget,
  weekWindows,
  countdownDaysLeft,
  countdownMonthBounds,
  type DailySpendingRow,
  type StreakResult,
  type WeekCategorySpending,
  type WeekData,
  type WeeklySummaryResult,
  type BudgetCountdownRow,
  entityScopeParams,
  type OverviewOptions,
  type EntityScopedOptions,
  type WeekSql,
} from './overview-sql.js';

// The row interfaces moved to overview-sql.ts (shared with the offline
// dashboard mirror); re-exported here so existing imports keep working.
export type {
  DailySpendingRow,
  StreakResult,
  WeekCategorySpending,
  WeekData,
  WeeklySummaryResult,
  BudgetCountdownRow,
};

// ── Query functions ───────────────────────────────────────────────────────────
//
// Each function composes the shared SQL constants and pure helpers from
// overview-sql.ts — the offline mirror runs the exact same text and math.

/**
 * Get daily spending totals between two dates.
 */
export function getDailySpending(
  db: Database,
  startDate: string,
  endDate: string,
  accountId?: number,
  entityId?: number,
  opts?: OverviewOptions
): DailySpendingRow[] {
  const { sql, params } = composeDailySpendingSql(startDate, endDate, accountId, entityId, opts);
  return db.prepare(sql).all(params) as DailySpendingRow[];
}

/**
 * Get the current and longest under-budget spending streaks.
 * If no dailyBudget is provided, computes it from the budgets table.
 *
 * `now` is injectable so tests can pin the calendar-dependent walk.
 */
export function getStreak(
  db: Database,
  dailyBudget?: number,
  now?: Date,
  opts?: EntityScopedOptions
): StreakResult {
  // Compute daily budget from budgets table if not provided
  let budget = dailyBudget;
  if (budget === undefined) {
    const row = db.prepare(STREAK_BUDGET_TOTAL_SQL).get() as { total: number };
    budget = computeStreakDailyBudget(row.total, now ?? new Date());
  }

  // Get daily spending for all time, ordered by date descending
  const rows = db.prepare(composeStreakDailySql(opts)).all(entityScopeParams(opts)) as { date: string; spending: number }[];

  return computeStreak(rows, budget, now ?? new Date());
}

/**
 * Get a summary comparing this week's spending to last week's.
 * Weeks run Monday through Sunday.
 */
export function getWeeklySummary(db: Database, now?: Date, opts?: EntityScopedOptions): WeeklySummaryResult {
  const windows = weekWindows(now ?? new Date());
  const sql = composeWeekSql(opts);
  const scope = entityScopeParams(opts);

  const thisWeek = getWeekData(db, sql, { ...scope, startDate: windows.thisStart, endDate: windows.thisEnd });
  const lastWeek = getWeekData(db, sql, { ...scope, startDate: windows.lastStart, endDate: windows.lastEnd });

  const changeAmount = thisWeek.total - lastWeek.total;
  const changePercent = lastWeek.total > 0 ? Math.round((changeAmount / lastWeek.total) * 100) : 0;

  return {
    thisWeek,
    lastWeek,
    change: { amount: changeAmount, percent: changePercent },
  };
}

function getWeekData(db: Database, sql: WeekSql, params: Record<string, unknown>): WeekData {
  // Total spending
  const totalRow = db.prepare(sql.total).get(params) as { total: number };

  // By category
  const byCategory = db
    .prepare(sql.byCategory)
    .all(params) as WeekCategorySpending[];

  // Top merchant
  const topMerchantRow = db.prepare(sql.topMerchant).get(params) as
    | { merchant: string }
    | undefined;

  return {
    total: totalRow.total,
    byCategory,
    topMerchant: topMerchantRow?.merchant ?? null,
  };
}

/**
 * Get budget countdown data for a given month (YYYY-MM format).
 */
export function getBudgetCountdown(
  db: Database,
  month: string,
  now?: Date
): BudgetCountdownRow[] {
  const { startDate, endDate } = countdownMonthBounds(month);

  // Compute days left in the month
  const daysLeft = countdownDaysLeft(month, now ?? new Date());

  // Get all budgets
  const budgets = db
    .prepare(BUDGET_COUNTDOWN_BUDGETS_SQL)
    .all() as { category: string; monthly_limit: number }[];

  if (budgets.length === 0) return [];

  const results: BudgetCountdownRow[] = [];

  for (const budget of budgets) {
    const row = db
      .prepare(BUDGET_COUNTDOWN_SPENT_SQL)
      .get({ category: budget.category, startDate, endDate }) as { spent: number };

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