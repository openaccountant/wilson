// Pure client-side Monte Carlo forecast of liquid cash.
//
// Bootstrap-samples the user's own monthly income/expense history into N
// twelve-month paths and extracts percentile bands (p10–p90) around the
// median path. Everything runs in the browser; no server round-trip beyond
// fetching the history series and the account balances.
//
// This module is deliberately dependency-free and DOM-free: it is imported by
// root-tsc-included test files (src/__tests__/cashflow-forecast.test.ts), so
// it must typecheck cleanly under both the root tsconfig and the UI tsconfig,
// exactly like src/dashboard/ui/src/hybrid/core.ts.

export interface CashflowMonth {
  month: string;
  income: number;
  expenses: number;
}

export interface ForecastPoint {
  /** 0 = anchor (now, unsimulated); 1..horizonMonths are projected steps. */
  step: number;
  /** 'Now' for step 0, else 'MMM YYYY' (e.g. 'Oct 2026'). */
  label: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface CashflowForecast {
  /** Length = horizonMonths + 1 (anchor + projected steps). */
  points: ForecastPoint[];
  startBalance: number;
  pathCount: number;
}

export const FORECAST_PATHS = 500;
export const FORECAST_HORIZON_MONTHS = 12;
/** 'A couple of months' — below this the card shows the empty state. */
export const MIN_HISTORY_MONTHS = 2;
export const DEFAULT_SEED = 1337;

/** What-if slider bounds (percent of observed monthly values) and step. */
export const WHATIF_MIN_PCT = 50; // −50%
export const WHATIF_MAX_PCT = 150; // +50%
export const WHATIF_STEP = 5;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Mulberry32 — tiny seeded PRNG, deterministic under test. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/** Non-finite or negative what-if scales fall back to no adjustment (no-throw posture). */
function sanitizeScale(v: number | undefined, fallback = 1): number {
  return v === undefined || !Number.isFinite(v) || v < 0 ? fallback : v;
}

export function runCashflowForecast(opts: {
  history: CashflowMonth[];
  startBalance: number;
  /** 'YYYY-MM' the projection starts from (the card passes the current month); required for deterministic labels. */
  startMonth: string;
  /** Default 12. */
  horizonMonths?: number;
  /** Default 500. */
  paths?: number;
  /** Default DEFAULT_SEED. */
  seed?: number;
  /** Multiplier applied to every drawn income month. Default 1 (no adjustment). */
  incomeScale?: number;
  /** Multiplier applied to every drawn expense month. Default 1 (no adjustment). */
  expenseScale?: number;
}): CashflowForecast | null {
  const horizonMonths = opts.horizonMonths ?? FORECAST_HORIZON_MONTHS;
  const paths = opts.paths ?? FORECAST_PATHS;
  const seed = opts.seed ?? DEFAULT_SEED;
  const incomeScale = sanitizeScale(opts.incomeScale);
  const expenseScale = sanitizeScale(opts.expenseScale);

  // Drop non-finite rows defensively; too little history → no forecast.
  const history = opts.history.filter(
    (m) => Number.isFinite(m.income) && Number.isFinite(m.expenses),
  );
  if (history.length < MIN_HISTORY_MONTHS) return null;

  const incomes = history.map((m) => m.income);
  const expenses = history.map((m) => m.expenses);

  const rng = mulberry32(seed);
  const pick = (arr: number[]): number =>
    arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

  // Income and expense are drawn independently each month (bootstrap with
  // replacement) — good months pairing with good months is exactly the noise
  // the fan is meant to express. The loop is step-major with a per-path
  // balance carried across steps, so month k always consumes the same slice
  // of the single RNG stream regardless of horizonMonths: a 24-month run's
  // first 12 steps replay a 12-month run's steps exactly under the same seed
  // (horizon prefix-stability), and two runs that differ only in the what-if
  // scales consume identical randomness.
  const balances = Array.from({ length: paths }, () => opts.startBalance);
  const stepSamples: number[][] = Array.from({ length: horizonMonths }, () => []);
  for (let step = 1; step <= horizonMonths; step++) {
    for (let path = 0; path < paths; path++) {
      // Scale AFTER the draw: multiplying the picked value keeps the RNG draw
      // sequence and draw count identical regardless of the assumptions, so
      // under one seed the same assumptions always replay the same projection
      // and band shifts reflect the assumptions, not re-sampling luck. The
      // anchor (startBalance) is deliberately not scaled: the what-if adjusts
      // future flows, not the cash you hold today.
      balances[path] += pick(incomes) * incomeScale - pick(expenses) * expenseScale;
      stepSamples[step - 1].push(balances[path]);
    }
  }

  const [startYear, startMon] = opts.startMonth.split('-').map(Number);
  const points: ForecastPoint[] = [
    {
      step: 0,
      label: 'Now',
      p10: opts.startBalance,
      p25: opts.startBalance,
      p50: opts.startBalance,
      p75: opts.startBalance,
      p90: opts.startBalance,
    },
  ];
  for (let step = 1; step <= horizonMonths; step++) {
    const sorted = stepSamples[step - 1].sort((a, b) => a - b);
    const d = new Date(startYear, startMon - 1 + step, 1);
    points.push({
      step,
      label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
      p10: percentile(sorted, 10),
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    });
  }

  return { points, startBalance: opts.startBalance, pathCount: paths };
}