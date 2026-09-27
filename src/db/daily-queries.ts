import type { Database } from './compat-sqlite.js';
import {
  DAILY_SPENDING_SQL,
  STREAK_BUDGET_TOTAL_SQL,
  STREAK_DAILY_SQL,
  WEEK_TOTAL_SQL,
  WEEK_BY_CATEGORY_SQL,
  WEEK_TOP_MERCHANT_SQL,
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
  endDate: string
): DailySpendingRow[] {
  return db.prepare(DAILY_SPENDING_SQL).all({ startDate, endDate }) as DailySpendingRow[];
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
  now?: Date
): StreakResult {
  // Compute daily budget from budgets table if not provided
  let budget = dailyBudget;
  if (budget === undefined) {
    const row = db.prepare(STREAK_BUDGET_TOTAL_SQL).get() as { total: number };
    budget = computeStreakDailyBudget(row.total, now ?? new Date());
  }

  // Get daily spending for all time, ordered by date descending
  const rows = db.prepare(STREAK_DAILY_SQL).all() as { date: string; spending: number }[];

  return computeStreak(rows, budget, now ?? new Date());
}

/**
 * Get a summary comparing this week's spending to last week's.
 * Weeks run Monday through Sunday.
 */
export function getWeeklySummary(db: Database, now?: Date): WeeklySummaryResult {
  const windows = weekWindows(now ?? new Date());

  const thisWeek = getWeekData(db, windows.thisStart, windows.thisEnd);
  const lastWeek = getWeekData(db, windows.lastStart, windows.lastEnd);

  const changeAmount = thisWeek.total - lastWeek.total;
  const changePercent = lastWeek.total > 0 ? Math.round((changeAmount / lastWeek.total) * 100) : 0;

  return {
    thisWeek,
    lastWeek,
    change: { amount: changeAmount, percent: changePercent },
  };
}

function getWeekData(db: Database, startDate: string, endDate: string): WeekData {
  // Total spending
  const totalRow = db.prepare(WEEK_TOTAL_SQL).get({ startDate, endDate }) as { total: number };

  // By category
  const byCategory = db
    .prepare(WEEK_BY_CATEGORY_SQL)
    .all({ startDate, endDate }) as WeekCategorySpending[];

  // Top merchant
  const topMerchantRow = db.prepare(WEEK_TOP_MERCHANT_SQL).get({ startDate, endDate }) as
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