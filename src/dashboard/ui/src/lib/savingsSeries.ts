/**
 * Savings sparkline series (pure, unit-tested).
 *
 * - Plots a fixed window of consecutive calendar months; months with no data
 *   are `null` gaps (drawn with connectNulls=false) instead of being silently
 *   joined to a non-adjacent month.
 * - Values are never clamped: clamping to ±100% flattened every bad month to
 *   the same line and hid the real trend.
 * - When any month in the window has income below 10% of expenses the savings
 *   *rate* is meaningless (tiny denominators → -4000%), so the whole series
 *   switches to net savings in dollars and flags 'low income data'.
 * - The trend compares the latest month with the immediately preceding
 *   calendar month, on the unclamped values of the plotted metric.
 */
export interface SavingsInput {
  month: string; // 'YYYY-MM'
  income: number;
  expenses: number;
}

export type SavingsMode = 'rate' | 'net';

export interface SavingsSeriesPoint {
  month: string;
  /** Plotted value in the series' mode (percent or dollars); null = no data. */
  value: number | null;
  income: number | null;
  expenses: number | null;
  lowIncome: boolean;
}

export interface SavingsSeries {
  mode: SavingsMode;
  points: SavingsSeriesPoint[];
  latest: SavingsSeriesPoint | null;
  trend: 'up' | 'down' | null;
  lowIncome: boolean;
}

/** Income below this share of expenses makes the rate unusable. */
export const LOW_INCOME_RATIO = 0.1;

export function isLowIncome(income: number, expenses: number): boolean {
  return expenses > 0 && income < LOW_INCOME_RATIO * expenses;
}

function monthKey(year: number, monthIndex: number): string {
  const d = new Date(year, monthIndex, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `count` consecutive 'YYYY-MM' keys ending at `endMonth` (inclusive). */
export function monthWindow(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split('-').map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(monthKey(y, m - 1 - i));
  return out;
}

export function buildSavingsSeries(
  data: readonly SavingsInput[],
  opts: { months?: number; now?: Date } = {},
): SavingsSeries {
  const months = opts.months ?? 6;
  const now = opts.now ?? new Date();
  const currentMonth = monthKey(now.getFullYear(), now.getMonth());
  const byMonth = new Map(data.map((p) => [p.month, p]));
  const latestDataMonth = data.reduce<string | null>((max, p) => (max === null || p.month > max ? p.month : max), null);
  const endMonth = latestDataMonth && latestDataMonth > currentMonth ? latestDataMonth : currentMonth;
  const keys = monthWindow(endMonth, months);

  const inWindow = keys.map((k) => byMonth.get(k) ?? null);
  const lowIncome = inWindow.some((p) => p !== null && isLowIncome(p.income, p.expenses));
  const mode: SavingsMode = lowIncome ? 'net' : 'rate';

  const points: SavingsSeriesPoint[] = keys.map((month, i) => {
    const p = inWindow[i];
    if (!p) return { month, value: null, income: null, expenses: null, lowIncome: false };
    const net = p.income - p.expenses;
    const value = mode === 'net' ? net : p.income > 0 ? (net / p.income) * 100 : null;
    return { month, value, income: p.income, expenses: p.expenses, lowIncome: isLowIncome(p.income, p.expenses) };
  });

  let latestIdx = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value !== null) {
      latestIdx = i;
      break;
    }
  }
  const latest = latestIdx >= 0 ? points[latestIdx] : null;
  const prev = latestIdx > 0 ? points[latestIdx - 1] : null;
  const trend =
    latest && prev && latest.value !== null && prev.value !== null
      ? latest.value >= prev.value
        ? 'up'
        : 'down'
      : null;

  return { mode, points, latest, trend, lowIncome };
}
