/**
 * Budgets-vs-actual card text (pure, unit-tested).
 *
 * No `@/` imports and no `window`, so bun tests can load it from the repo root.
 */
import type { BudgetVsActualRow } from '../types';

type BudgetRowLike = Pick<BudgetVsActualRow, 'over'>;

/**
 * One-line takeaway. Counts rows by the server's `over` flag (actual > limit),
 * NOT the rounded percent_used — $100.40 of $100 rounds to 100% but is over.
 */
export function budgetTakeaway(rows: readonly BudgetRowLike[]): string | undefined {
  if (rows.length === 0) return undefined;
  const overCount = rows.filter((r) => r.over).length;
  return overCount > 0
    ? `${overCount} of ${rows.length} budgets over limit.`
    : `All ${rows.length} budgets within limit.`;
}

/** Up to two decimals, trailing zeros trimmed: 3 → '3', 0.0645 → '0.06', 9.0645 → '9.06'. */
function fmtMonths(m: number): string {
  return String(Math.round(m * 100) / 100);
}

/**
 * Label for how the range scales the monthly limits (range-mode rows carry
 * `months`, day-prorated by the server): exactly one month → 'Monthly limits';
 * otherwise 'Limits × N months' (e.g. a 2-day range → '× 0.06 months', YTD on
 * Oct 2 → '× 9.06 months'). Undefined when there are no rows or no scaling info.
 */
export function budgetLimitScaleLabel(rows: readonly Pick<BudgetVsActualRow, 'months'>[]): string | undefined {
  const months = rows.find((r) => typeof r.months === 'number')?.months;
  if (months === undefined) return undefined;
  if (Math.abs(months - 1) < 1e-9) return 'Monthly limits';
  const n = fmtMonths(months);
  return `Limits × ${n} ${n === '1' ? 'month' : 'months'} (prorated by day)`;
}
