// Pure client-side Monte Carlo projection of net worth.
//
// Bootstrap-samples the user's own monthly net cash flow into N paths and
// compounds each path with a log-normal real return, then extracts percentile
// bands (p10-p90) at every bucket boundary.
//
// This module is deliberately dependency-free and DOM-free: it imports only
// ./forecastCore.js and is imported by root-tsc-included test files
// (src/__tests__/net-worth-forecast.test.ts), so it must typecheck cleanly
// under both the root tsconfig and the UI tsconfig, exactly like
// src/dashboard/ui/src/hybrid/core.ts.

import { bands, mulberry32, percentile, standardNormal, stepLabel } from './forecastCore.js';
import type { ForecastPoint } from './forecastCore.js';

export type { ForecastPoint } from './forecastCore.js';

export interface NetWorthSimInput {
  /** Net worth today, from GET /api/net-worth (`netWorth`). May be negative. */
  startNetWorth: number;
  /**
   * Pool of observed monthly net cash flows (income − expenses) to bootstrap
   * contributions from. In manual-inputs mode this is a single-element pool,
   * which makes contributions deterministic through the identical code path.
   */
  contributionPool: number[];
  /** Dollars/month added AFTER each bootstrap draw (the savings-rate slider). */
  contributionDelta: number;
  /** Median real annual compound return, e.g. 0.05. Real dollars; nominal is not modeled. */
  realAnnualReturn: number;
  /** Annual return volatility. FIXED at 0.15 by the caller; an input only so tests can set 0. */
  annualVolatility: number;
  /** 60..480. */
  horizonMonths: number;
  /** One-off net-worth shock applied at the START of `month` (1-based), before that month's return. */
  shock: { month: number; amount: number } | null;
  paths: number;
  seed: number;
  /** Emit a point every N simulated months. 3 (quarterly) in the UI. */
  bucketMonths: number;
  /** 'YYYY-MM' the projection starts from; required for deterministic labels. */
  startMonth: string;
}

export interface NetWorthForecast {
  /** Anchor + one point per bucket: length = 1 + floor(horizonMonths / bucketMonths). */
  points: ForecastPoint[];
  startNetWorth: number;
  pathCount: number;
  horizonMonths: number;
}

/** A month of observed cash flow. Structurally satisfied by `CashflowMonth` and by `MonthlyCashflowRow`. */
export interface CashflowLike {
  income: number;
  expenses: number;
}

export const NET_WORTH_MIN_HISTORY_MONTHS = 6;
export const FIXED_ANNUAL_VOLATILITY = 0.15;
export const BUCKET_MONTHS = 3;
export const DRAG_PATHS = 5_000;
export const RELEASE_PATHS = 20_000;
/** Yield to the worker message queue every 2 quarters. */
export const STEP_CHUNK = 6;

/** Slider bounds (UI-bound, exported so component and tests share one source). */
export const SAVINGS_DELTA_MIN_PP = -10; // percentage points of monthly income
export const SAVINGS_DELTA_MAX_PP = 25;
export const SAVINGS_DELTA_STEP_PP = 1;
export const RETURN_MIN = -0.02; // real annual
export const RETURN_MAX = 0.1;
export const RETURN_STEP = 0.0025;
export const RETURN_DEFAULT = 0.05;
export const HORIZON_MIN_YEARS = 5;
export const HORIZON_MAX_YEARS = 40;
export const HORIZON_DEFAULT_YEARS = 20;
export const SHOCK_MIN = -100_000;
export const SHOCK_MAX = 100_000;
export const SHOCK_STEP = 5_000;
export const SHOCK_DEFAULT_YEAR = 5;

/** Finite and at least 1, floored to an integer. Returns null for anything else (no-throw posture). */
function positiveCount(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n < 1 ? null : n;
}

/**
 * The simulation as a generator, yielding a 0..1 progress fraction at every
 * chunk boundary. The worker drives this so a long run can be aborted or
 * superseded between chunks; `runNetWorthForecast` drives it to completion on
 * the calling thread. ONE engine — the chunked and unchunked results are
 * identical by construction (yielding is pure bookkeeping and never touches
 * the RNG) and that equality is pinned by test.
 */
export function* simulateNetWorth(
  input: NetWorthSimInput,
): Generator<number, NetWorthForecast | null, void> {
  // --- Sanitization: no-throw, matching sanitizeScale's posture. ---
  const pool = input.contributionPool.filter((v) => Number.isFinite(v));
  if (pool.length < 1) return null;

  const paths = positiveCount(input.paths);
  const horizonMonths = positiveCount(input.horizonMonths);
  const bucketMonths = positiveCount(input.bucketMonths);
  if (paths === null || horizonMonths === null || bucketMonths === null) return null;

  const { startNetWorth, realAnnualReturn, annualVolatility } = input;
  if (
    !Number.isFinite(startNetWorth) ||
    !Number.isFinite(realAnnualReturn) ||
    !Number.isFinite(annualVolatility)
  ) {
    return null;
  }
  // Math.log(1 + r) is -Infinity at r === -1 and NaN below it, which would
  // poison every band with NaN instead of reporting "no forecast". Unreachable
  // from the UI (RETURN_MIN is -0.02), but the no-throw posture is that bad
  // input yields null, never a chart full of NaN.
  if (realAnnualReturn <= -1) return null;

  // A shock outside the simulated window, or with a non-finite month/amount,
  // is simply not a shock.
  const rawShock = input.shock;
  const shock =
    rawShock !== null &&
    rawShock !== undefined &&
    Number.isFinite(rawShock.month) &&
    Number.isFinite(rawShock.amount) &&
    rawShock.month >= 1 &&
    rawShock.month <= horizonMonths
      ? rawShock
      : null;

  const contributionDelta = Number.isFinite(input.contributionDelta) ? input.contributionDelta : 0;

  // --- Model constants. The slider states a MEDIAN compound real return, so
  // the drift is the log of it: the median path grows at exactly that rate. ---
  const muMonthlyLog = Math.log(1 + realAnnualReturn) / 12;
  const sigmaMonthly = annualVolatility / Math.sqrt(12);

  // The anchor is never simulated, never shocked, never scaled — the same
  // semantics as the cash forecast's anchor.
  const points: ForecastPoint[] = [
    {
      step: 0,
      label: stepLabel(input.startMonth, 0),
      p10: startNetWorth,
      p25: startNetWorth,
      p50: startNetWorth,
      p75: startNetWorth,
      p90: startNetWorth,
    },
  ];

  const rng = mulberry32(input.seed);
  const poolLen = pool.length;
  // One allocation for the whole run; nothing is allocated per path-step.
  const nw = new Float64Array(paths).fill(startNetWorth);

  // Step-major / path-minor, identical in shape to cashflowForecast.ts — that
  // is what buys horizon prefix-stability (dragging the horizon slider never
  // reshuffles the months already on screen) and what-if replay stability
  // (changing only the return or the savings delta consumes identical
  // randomness). Exactly THREE uniforms per path-step: one for the bootstrap
  // pick, two for the normal.
  for (let step = 1; step <= horizonMonths; step++) {
    const shockNow = shock !== null && step === shock.month;
    const shockAmount = shock !== null ? shock.amount : 0;
    for (let path = 0; path < paths; path++) {
      let v = nw[path];
      // Start of month, before the return.
      if (shockNow) v += shockAmount;
      // The delta is added AFTER the draw so the RNG draw sequence and draw
      // count are identical regardless of the assumptions.
      const contribution = pool[Math.min(poolLen - 1, Math.floor(rng() * poolLen))] + contributionDelta;
      const z = standardNormal(rng);
      // Growth applies ONLY to a positive balance. A negative (underwater) net
      // worth is carried flat and is climbed out of by contributions — never
      // compounded, because compounding signed net worth would grow *debt* at
      // the equity return and an underwater projection could never recover.
      const grown = v > 0 ? v * Math.exp(muMonthlyLog + sigmaMonthly * z) : v;
      nw[path] = grown + contribution;
    }

    if (step % bucketMonths === 0) {
      // Float64Array.prototype.sort is numeric by default, unlike
      // Array.prototype.sort — deliberately no comparator.
      const sorted = nw.slice().sort();
      points.push({ step, label: stepLabel(input.startMonth, step), ...bands(sorted) });
    }

    if (step % STEP_CHUNK === 0) yield step / horizonMonths;
  }
  yield 1;

  return { points, startNetWorth, pathCount: paths, horizonMonths };
}

/** Drive the generator to completion on the calling thread (tests, and the non-chunked path). */
export function runNetWorthForecast(input: NetWorthSimInput): NetWorthForecast | null {
  const gen = simulateNetWorth(input);
  let next = gen.next();
  while (!next.done) next = gen.next();
  return next.value;
}

/** History → simulator inputs. Returns null below NET_WORTH_MIN_HISTORY_MONTHS usable months. */
export function deriveNetWorthInputs(history: CashflowLike[]): {
  contributionPool: number[];
  medianMonthlyIncome: number;
  medianMonthlyContribution: number;
  months: number;
} | null {
  // Non-finite rows are dropped BEFORE the count: five clean months plus two
  // broken ones is five months of history, not seven.
  const usable = history.filter(
    (m) => Number.isFinite(m.income) && Number.isFinite(m.expenses),
  );
  if (usable.length < NET_WORTH_MIN_HISTORY_MONTHS) return null;

  const contributionPool = usable.map((m) => m.income - m.expenses);
  // Nearest-rank median, the same convention the forecast bands use.
  const incomesAsc = usable.map((m) => m.income).sort((a, b) => a - b);
  const contributionsAsc = contributionPool.slice().sort((a, b) => a - b);

  return {
    contributionPool,
    medianMonthlyIncome: percentile(incomesAsc, 50),
    medianMonthlyContribution: percentile(contributionsAsc, 50),
    months: usable.length,
  };
}

/** Percentage-point savings-rate delta → dollars/month. */
export function savingsDeltaToDollars(deltaPp: number, medianMonthlyIncome: number): number {
  if (!Number.isFinite(deltaPp) || !Number.isFinite(medianMonthlyIncome)) return 0;
  // Multiply before dividing so whole-dollar incomes give exact results.
  return (deltaPp * medianMonthlyIncome) / 100;
}
