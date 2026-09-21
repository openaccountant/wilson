/**
 * Trailing-rate cash/savings forecast — new for the WebMCP read-only catalog
 * (src/mcp/tool-catalog.ts). Projects end-of-period cash from the average
 * monthly income/expense rate over a trailing window, with optional
 * what-if adjustments layered on top. No confirmation needed: read-only.
 */
import type { Database } from '../../db/compat-sqlite.js';
import { getMonthlySavingsData, getSpendingSummary } from '../../db/queries.js';
import { getNetWorthSummary } from '../../db/net-worth-queries.js';

const CASH_SUBTYPES = new Set(['checking', 'savings', 'cash']);

export interface ForecastWhatIf {
  /** 'adjust_category' shifts a category's trailing monthly spend by monthlyDelta (positive = spend more). */
  type: 'adjust_category' | 'drop_recurring';
  category?: string;
  monthlyDelta?: number;
  /** 'drop_recurring' removes the trailing average of recurring transactions matching this description. */
  description?: string;
}

export interface ForecastParams {
  trailingMonths?: number;
  horizonMonths?: number;
  whatIf?: ForecastWhatIf[];
}

export interface ForecastResult {
  trailingMonths: number;
  horizonMonths: number;
  startingCash: number;
  trailingMonthlyIncome: number;
  trailingMonthlyExpense: number;
  trailingMonthlyNet: number;
  adjustedMonthlyNet: number;
  appliedAdjustments: Array<{ description: string; monthlyImpact: number }>;
  projection: Array<{ month: string; projectedCash: number }>;
  horizonEndCash: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthlyRecurringAverage(db: Database, descriptionMatch: string, months: number): number {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth() - months, 1);
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
  const endStr = end.toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT SUM(ABS(amount)) AS total
    FROM transactions
    WHERE is_recurring = 1 AND date >= @startStr AND date <= @endStr
      AND LOWER(description) LIKE '%' || LOWER(@match) || '%'
  `).get({ startStr, endStr, match: descriptionMatch }) as { total: number | null };
  if (!row.total) return 0;
  return row.total / months;
}

/**
 * Project end-of-period cash/savings from the trailing income/expense rate.
 * Pure read: never touches the mutation prepare/commit protocol.
 */
export function computeForecast(db: Database, params: ForecastParams = {}): ForecastResult {
  const trailingMonths = Math.max(1, Math.min(24, params.trailingMonths ?? 3));
  const horizonMonths = Math.max(1, Math.min(24, params.horizonMonths ?? 3));

  const netWorth = getNetWorthSummary(db);
  const startingCash = netWorth.accounts
    .filter((a) => a.account_type === 'asset' && a.is_active && CASH_SUBTYPES.has(a.account_subtype))
    .reduce((sum, a) => sum + a.current_balance, 0);

  const monthly = getMonthlySavingsData(db, undefined, trailingMonths);
  const monthCount = monthly.length || 1;
  const trailingMonthlyIncome = monthly.reduce((sum, m) => sum + m.income, 0) / monthCount;
  const trailingMonthlyExpense = monthly.reduce((sum, m) => sum + m.expenses, 0) / monthCount;
  const trailingMonthlyNet = trailingMonthlyIncome - trailingMonthlyExpense;

  const appliedAdjustments: Array<{ description: string; monthlyImpact: number }> = [];
  let adjustmentTotal = 0; // positive = improves monthly net

  for (const adj of params.whatIf ?? []) {
    if (adj.type === 'adjust_category' && adj.category) {
      const delta = adj.monthlyDelta ?? 0;
      // monthlyDelta is a signed change to monthly SPEND: negative delta (spend less) improves net.
      adjustmentTotal += -delta;
      appliedAdjustments.push({
        description: `Adjust "${adj.category}" monthly spend by ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
        monthlyImpact: -delta,
      });
    } else if (adj.type === 'drop_recurring' && adj.description) {
      const avg = monthlyRecurringAverage(db, adj.description, trailingMonths);
      adjustmentTotal += avg;
      appliedAdjustments.push({
        description: `Drop recurring expense matching "${adj.description}" (~$${avg.toFixed(2)}/mo)`,
        monthlyImpact: avg,
      });
    }
  }

  const adjustedMonthlyNet = trailingMonthlyNet + adjustmentTotal;

  const now = new Date();
  const projection: Array<{ month: string; projectedCash: number }> = [];
  let cash = startingCash;
  for (let i = 1; i <= horizonMonths; i++) {
    cash += adjustedMonthlyNet;
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    projection.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      projectedCash: round2(cash),
    });
  }

  return {
    trailingMonths,
    horizonMonths,
    startingCash: round2(startingCash),
    trailingMonthlyIncome: round2(trailingMonthlyIncome),
    trailingMonthlyExpense: round2(trailingMonthlyExpense),
    trailingMonthlyNet: round2(trailingMonthlyNet),
    adjustedMonthlyNet: round2(adjustedMonthlyNet),
    appliedAdjustments,
    projection,
    horizonEndCash: projection.length ? projection[projection.length - 1].projectedCash : round2(startingCash),
  };
}
