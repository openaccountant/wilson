// ── read-core: trailing-rate cash forecast, injected clock + readers ─────────
//
// Zero-import, async-generic port of computeForecast (src/tools/query/forecast.ts,
// the original stays untouched). The three data reads are injected, so the same
// arithmetic runs against the server's sync Database or the browser mirror's
// async SqliteBinding. Parity with the server tool is pinned by
// src/__tests__/mirror-tool-parity.test.ts; the arithmetic order and rounding
// below are deliberately identical to the original (float results must match).

type MaybePromise<T> = T | Promise<T>;

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

/** The three reads a forecast needs. */
export interface ForecastReaders {
  /** Sum of active checking / savings / cash balances. */
  startingCash(): MaybePromise<number>;
  /** Income / expense rows for the last `months` calendar months (getMonthlySavingsData). */
  monthly(months: number): MaybePromise<Array<{ income: number; expenses: number }>>;
  /** SUM(ABS(amount)) of recurring transactions whose description contains `match` (case-insensitive) in [startStr, endStr]; null when none. */
  recurringTotal(match: string, startStr: string, endStr: string): MaybePromise<number | null>;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The date window `monthlyRecurringAverage` scans: from the first of the month `months` back, to the UTC date of `now`. */
export function recurringWindow(now: Date, months: number): { startStr: string; endStr: string } {
  const end = new Date(now);
  const start = new Date(end.getFullYear(), end.getMonth() - months, 1);
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
  const endStr = end.toISOString().slice(0, 10);
  return { startStr, endStr };
}

/**
 * Project end-of-period cash from the trailing income/expense rate, with
 * optional what-if adjustments, using `now` as the clock.
 */
export async function computeForecastAt(readers: ForecastReaders, params: ForecastParams = {}, now: Date): Promise<ForecastResult> {
  const trailingMonths = Math.max(1, Math.min(24, params.trailingMonths ?? 3));
  const horizonMonths = Math.max(1, Math.min(24, params.horizonMonths ?? 3));

  const startingCash = await readers.startingCash();

  const monthly = await readers.monthly(trailingMonths);
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
      const { startStr, endStr } = recurringWindow(now, trailingMonths);
      const total = await readers.recurringTotal(adj.description, startStr, endStr);
      const avg = total ? total / trailingMonths : 0;
      adjustmentTotal += avg;
      appliedAdjustments.push({
        description: `Drop recurring expense matching "${adj.description}" (~$${avg.toFixed(2)}/mo)`,
        monthlyImpact: avg,
      });
    }
  }

  const adjustedMonthlyNet = trailingMonthlyNet + adjustmentTotal;

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
