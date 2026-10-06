/**
 * Spending heatmap grid (pure, unit-tested).
 *
 * Builds Sunday-aligned week columns for [startDate, endDate], month header
 * labels that never collide, and the client-side "under budget" tally. Days
 * outside imported-data coverage are marked `covered: false` so the chart can
 * draw them as hatched/neutral and the tally skips them — a day with no
 * imported statements is unknown, not "$0, under budget".
 */

import type { CoverageResponse } from '../types';

/** GET /api/coverage (mirrored): months with ANY imported transactions. */
export type Coverage = CoverageResponse;

export interface HeatmapDay {
  date: string;
  amount: number;
  dayOfWeek: number;
  future: boolean;
  covered: boolean;
}

export interface MonthLabel {
  label: string;
  weekIndex: number;
}

export interface HeatmapGrid {
  weeks: HeatmapDay[][];
  months: MonthLabel[];
  underBudgetDays: number;
  /**
   * Covered, non-future days counted in the tally — only days inside the
   * last TALLY_DAYS (the grid itself starts up to 6 days earlier for Sunday
   * alignment, and those lead-in days are drawn but never counted).
   */
  totalDays: number;
  /** Largest covered, non-future day amount (the filtered view's color scale). */
  maxAmount: number;
}

/** The tally window: the last 365 days, today inclusive. */
export const TALLY_DAYS = 365;

/** Minimum week columns between two month labels (a 3-letter label is ~2 columns wide). */
export const MIN_LABEL_GAP_WEEKS = 2;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Coverage predicate. `null`/absent coverage (endpoint missing or failed)
 * means "treat everything as covered" — the pre-coverage behavior.
 */
export function makeCoveredFn(coverage: Coverage | null | undefined): (date: string) => boolean {
  if (!coverage) return () => true;
  const months = new Set(coverage.months);
  return (date: string) =>
    months.has(date.slice(0, 7)) &&
    (coverage.start === null || date >= coverage.start) &&
    (coverage.end === null || date <= coverage.end);
}

/**
 * Drop month labels that would overlap: a label is kept only when the next
 * label (or the grid's right edge) is at least MIN_LABEL_GAP_WEEKS columns
 * away. This removes the partial leading month that used to print on top of
 * its successor at weekIndex 0/1.
 */
export function spaceMonthLabels(labels: readonly MonthLabel[], weekCount: number): MonthLabel[] {
  const out: MonthLabel[] = [];
  for (let i = 0; i < labels.length; i++) {
    const nextIndex = i + 1 < labels.length ? labels[i + 1].weekIndex : weekCount;
    if (nextIndex - labels[i].weekIndex >= MIN_LABEL_GAP_WEEKS) out.push(labels[i]);
  }
  return out;
}

export function buildHeatmapGrid(opts: {
  startDate: string;
  endDate: string;
  spending: ReadonlyMap<string, number>;
  dailyBudget: number;
  coverage?: Coverage | null;
  /** Injected clock for tests; defaults to now. */
  now?: Date;
}): HeatmapGrid {
  const { startDate, endDate, spending, dailyBudget } = opts;
  const now = opts.now ?? new Date();
  const todayStr = localDateStr(now);
  const tallyStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (TALLY_DAYS - 1));
  const tallyStart = localDateStr(tallyStartDate);
  const isCovered = makeCoveredFn(opts.coverage);

  const weeks: HeatmapDay[][] = [];
  let current: HeatmapDay[] = [];
  const rawLabels: MonthLabel[] = [];
  let lastMonth = -1;
  let under = 0;
  let total = 0;
  let maxAmount = 0;

  const cursor = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cursor <= end) {
    const date = localDateStr(cursor);
    const dayOfWeek = cursor.getDay();
    if (dayOfWeek === 0 && current.length > 0) {
      weeks.push(current);
      current = [];
    }
    if (cursor.getMonth() !== lastMonth) {
      lastMonth = cursor.getMonth();
      rawLabels.push({ label: MONTH_SHORT[lastMonth], weekIndex: weeks.length });
    }
    const future = date > todayStr;
    const covered = isCovered(date);
    const amount = spending.get(date) ?? 0;
    current.push({ date, amount, dayOfWeek, future, covered });
    if (!future && covered) {
      if (amount > maxAmount) maxAmount = amount;
      // Same window for both numbers, so it can never read '370 of 365'.
      if (date >= tallyStart) {
        total++;
        if (amount <= dailyBudget) under++;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (current.length > 0) weeks.push(current);

  return {
    weeks,
    months: spaceMonthLabels(rawLabels, weeks.length),
    underBudgetDays: under,
    totalDays: total,
    maxAmount,
  };
}

/** One year back from `now`, aligned to the preceding Sunday (local calendar). */
export function heatmapYearRange(now: Date = new Date()): { startDate: string; endDate: string } {
  const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1);
  start.setDate(start.getDate() - start.getDay());
  return { startDate: localDateStr(start), endDate: localDateStr(now) };
}

export interface HeatmapFilters {
  accountId: number | null;
  entityId: number | null;
  category: string | null;
}

/**
 * True when header filters scope the cells. The daily budget (/api/streak) is
 * the ALL-budgets total ÷ days in month, so comparing a filtered day (one
 * account, one category, one entity) against it is meaningless — the card
 * hides the under-budget tally and colors by relative intensity instead.
 */
export function isFilteredHeatmap(f: HeatmapFilters): boolean {
  return f.accountId != null || f.entityId != null || !!f.category;
}

/** The card's takeaway line and header tally (null = hidden). */
export function heatmapSummary(
  grid: Pick<HeatmapGrid, 'underBudgetDays' | 'totalDays'>,
  budgetLabel: string,
  filtered: boolean,
): { takeaway: string; tally: { under: number; total: number } | null } {
  if (grid.totalDays === 0) return { takeaway: 'No imported data in the last year.', tally: null };
  if (filtered) {
    return {
      takeaway: `Filtered daily spending on ${grid.totalDays} days with imported data. Shaded by relative amount — the ${budgetLabel} daily budget covers all spending, so no under-budget count is shown.`,
      tally: null,
    };
  }
  return {
    takeaway: `Under the ${budgetLabel} daily budget on ${grid.underBudgetDays} of ${grid.totalDays} days with imported data.`,
    tally: { under: grid.underBudgetDays, total: grid.totalDays },
  };
}
