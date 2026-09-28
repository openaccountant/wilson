// Shared Monte Carlo simulation core for the cash-flow and net-worth
// forecasts.
//
// Zero imports, no DOM, no browser APIs: this module is imported by
// root-tsc-included test files, so it must typecheck cleanly under both the
// root tsconfig and the UI tsconfig, exactly like
// src/dashboard/ui/src/hybrid/core.ts.

export interface ForecastPoint {
  /** 0 = anchor (now, unsimulated); thereafter the simulated step index. */
  step: number;
  /** 'Now' for step 0, else 'MMM YYYY' (e.g. 'Oct 2026'). */
  label: string;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export const DEFAULT_SEED = 1337;

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
export function percentile(sortedAsc: ArrayLike<number>, p: number): number {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

/** Non-finite or negative what-if scales fall back to no adjustment (no-throw posture). */
export function sanitizeScale(v: number | undefined, fallback = 1): number {
  return v === undefined || !Number.isFinite(v) || v < 0 ? fallback : v;
}

/** 'Now' for step 0, else 'MMM YYYY' offset `step` months from `startMonth` ('YYYY-MM'). */
export function stepLabel(startMonth: string, step: number): string {
  if (step === 0) return 'Now';
  const [startYear, startMon] = startMonth.split('-').map(Number);
  const d = new Date(startYear, startMon - 1 + step, 1);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * One standard-normal draw via Box–Muller, layered on top of an existing
 * uniform source. Consumes EXACTLY two uniforms per call and deliberately
 * discards the sine component: caching the second variate would make RNG
 * consumption depend on call parity, which would break the step-major
 * prefix-stability invariant the engine is built around. `1 - rng()` maps
 * [0, 1) onto (0, 1] so Math.log is always finite.
 */
export function standardNormal(rng: () => number): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** p10/p25/p50/p75/p90 of an ascending-sorted sample, nearest-rank. */
export function bands(sortedAsc: ArrayLike<number>): Omit<ForecastPoint, 'step' | 'label'> {
  return {
    p10: percentile(sortedAsc, 10),
    p25: percentile(sortedAsc, 25),
    p50: percentile(sortedAsc, 50),
    p75: percentile(sortedAsc, 75),
    p90: percentile(sortedAsc, 90),
  };
}
