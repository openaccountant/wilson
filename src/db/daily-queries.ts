import type { Database } from './compat-sqlite.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

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

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Get daily spending totals between two dates.
 */
export function getDailySpending(
  db: Database,
  startDate: string,
  endDate: string
): DailySpendingRow[] {
  return db.prepare(`
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
  `).all({ startDate, endDate }) as DailySpendingRow[];
}

/**
 * Get the current and longest under-budget spending streaks.
 * If no dailyBudget is provided, computes it from the budgets table.
 */
export function getStreak(
  db: Database,
  dailyBudget?: number
): StreakResult {
  // Compute daily budget from budgets table if not provided
  let budget = dailyBudget;
  if (budget === undefined) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(monthly_limit), 0) AS total
      FROM budgets
    `).get() as { total: number };
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    budget = row.total > 0 ? row.total / daysInMonth : 0;
  }

  if (budget <= 0) {
    return { current: 0, longest: 0, dailyBudget: budget };
  }

  // Get daily spending for all time, ordered by date descending
  const rows = db.prepare(`
    SELECT date, COALESCE(SUM(ABS(amount)), 0) AS spending
    FROM transactions
    WHERE amount < 0
    GROUP BY date
    ORDER BY date DESC
  `).all() as { date: string; spending: number }[];

  if (rows.length === 0) {
    return { current: 0, longest: 0, dailyBudget: budget };
  }

  // Build a set of dates with their spending
  const spendingByDate = new Map<string, number>();
  for (const row of rows) {
    spendingByDate.set(row.date, row.spending);
  }

  // Walk backwards from today to compute current streak
  const today = new Date();
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
 * Get a summary comparing this week's spending to last week's.
 * Weeks run Monday through Sunday.
 */
export function getWeeklySummary(db: Database): WeeklySummaryResult {
  const today = new Date();
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

  const thisWeek = getWeekData(db, thisMonday.toISOString().slice(0, 10), thisSunday.toISOString().slice(0, 10));
  const lastWeek = getWeekData(db, lastMonday.toISOString().slice(0, 10), lastSunday.toISOString().slice(0, 10));

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
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
  `).get({ startDate, endDate }) as { total: number };

  // By category
  const byCategory = db.prepare(`
    SELECT
      COALESCE(category, 'Uncategorized') AS category,
      SUM(ABS(amount)) AS total
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
    GROUP BY category
    ORDER BY total DESC
  `).all({ startDate, endDate }) as WeekCategorySpending[];

  // Top merchant
  const topMerchantRow = db.prepare(`
    SELECT COALESCE(merchant_name, description) AS merchant
    FROM transactions
    WHERE amount < 0
      AND date >= @startDate
      AND date <= @endDate
    GROUP BY merchant
    ORDER BY SUM(ABS(amount)) DESC
    LIMIT 1
  `).get({ startDate, endDate }) as { merchant: string } | undefined;

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
  month: string
): BudgetCountdownRow[] {
  const startDate = `${month}-01`;
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

  // Compute days left in the month
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfMonth = new Date(year, mon - 1, lastDay);
  const todayStr = today.toISOString().slice(0, 10);

  let daysLeft: number;
  if (todayStr < startDate) {
    // Month hasn't started
    daysLeft = lastDay;
  } else if (todayStr > endDate) {
    // Month is over
    daysLeft = 0;
  } else {
    // We're in the month: remaining days including today
    daysLeft = Math.ceil((endOfMonth.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  }

  // Get all budgets
  const budgets = db.prepare(`
    SELECT category, monthly_limit
    FROM budgets
    ORDER BY category
  `).all() as { category: string; monthly_limit: number }[];

  if (budgets.length === 0) return [];

  const results: BudgetCountdownRow[] = [];

  for (const budget of budgets) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS spent
      FROM transactions
      WHERE category = @category
        AND date >= @startDate
        AND date <= @endDate
        AND amount < 0
    `).get({ category: budget.category, startDate, endDate }) as { spent: number };

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
