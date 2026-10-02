import { describe, expect, test } from 'bun:test';
import {
  BUCKET_MONTHS,
  DRAG_PATHS,
  RELEASE_PATHS,
  STEP_CHUNK,
  runNetWorthForecast,
  simulateNetWorth,
} from '../dashboard/ui/src/lib/netWorthForecast.js';
import type {
  NetWorthForecast,
  NetWorthSimInput,
} from '../dashboard/ui/src/lib/netWorthForecast.js';

// CI-runnable performance gate for the net-worth simulator. Runs on both
// matrix OSes, pure CPU, no DB / DOM / worker.
//
// Every timing assertion is a ONE-SIDED ceiling with roughly 15x headroom over
// the measurements taken while writing this (bun 1.4.2, darwin: 5k x 240 ~44 ms,
// 5k x 480 ~88 ms, 20k x 240 ~142 ms, 20k x 480 ~280 ms). A fast machine can
// never fail them; only a genuine algorithmic regression can. Each case does a
// discarded warm-up run first so the ceiling measures steady state rather than
// JIT warm-up.

function input(over: Partial<NetWorthSimInput> = {}): NetWorthSimInput {
  return {
    startNetWorth: 250_000,
    contributionPool: [1200, -400, 2500, 800, 1900, -100, 3000, 600],
    contributionDelta: 400,
    realAnnualReturn: 0.05,
    annualVolatility: 0.15,
    horizonMonths: 240,
    shock: null,
    paths: DRAG_PATHS,
    seed: 1337,
    bucketMonths: BUCKET_MONTHS,
    startMonth: '2026-01',
    ...over,
  };
}

/** Warm up once (discarded), then return the best of `samples` timed runs. */
function bestOf(opts: NetWorthSimInput, samples = 3): { ms: number; forecast: NetWorthForecast } {
  runNetWorthForecast(opts);
  let best = Number.POSITIVE_INFINITY;
  let forecast: NetWorthForecast | null = null;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    const f = runNetWorthForecast(opts);
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
    forecast = f;
  }
  expect(forecast).not.toBeNull();
  return { ms: best, forecast: forecast as NetWorthForecast };
}

describe('net-worth simulator performance', () => {
  test('1. release budget: 20,000 paths x 480 months completes well under 5000 ms', () => {
    const { ms, forecast } = bestOf(
      input({ paths: RELEASE_PATHS, horizonMonths: 480, bucketMonths: 3 }),
    );
    expect(ms).toBeLessThan(5000);

    expect(forecast.points.length).toBe(161);
    expect(forecast.pathCount).toBe(RELEASE_PATHS);
    for (const pt of forecast.points) {
      expect(Number.isFinite(pt.p10)).toBe(true);
      expect(Number.isFinite(pt.p25)).toBe(true);
      expect(Number.isFinite(pt.p50)).toBe(true);
      expect(Number.isFinite(pt.p75)).toBe(true);
      expect(Number.isFinite(pt.p90)).toBe(true);
      expect(pt.p10).toBeLessThanOrEqual(pt.p25);
      expect(pt.p25).toBeLessThanOrEqual(pt.p50);
      expect(pt.p50).toBeLessThanOrEqual(pt.p75);
      expect(pt.p75).toBeLessThanOrEqual(pt.p90);
    }
  }, 60_000);

  test('2. drag budget: 5,000 paths x 240 months completes well under 1500 ms', () => {
    const { ms, forecast } = bestOf(
      input({ paths: DRAG_PATHS, horizonMonths: 240, bucketMonths: 3 }),
    );
    expect(ms).toBeLessThan(1500);
    expect(forecast.points.length).toBe(81);
    expect(forecast.pathCount).toBe(DRAG_PATHS);
  }, 60_000);

  test('3. frame budget: the slowest single gen.next() at RELEASE size stays under 100 ms', () => {
    // Measures the engine, at the LARGEST configuration it ever runs (release
    // paths x max horizon) — not the 4x-smaller draft path, and not two
    // constants compared to each other.
    //
    // This is what actually guarantees responsiveness under supersession: the
    // worker cannot service onmessage while a gen.next() is on the stack, so
    // the worst chunk duration IS the worst supersession latency.
    const opts = input({ paths: RELEASE_PATHS, horizonMonths: 480, bucketMonths: 3 });
    runNetWorthForecast(opts); // discarded warm-up, same as bestOf

    const gen = simulateNetWorth(opts);
    let chunks = 0;
    let worstChunkMs = 0;
    let next = gen.next();
    while (!next.done) {
      chunks++;
      const started = performance.now();
      next = gen.next();
      worstChunkMs = Math.max(worstChunkMs, performance.now() - started);
    }
    expect(next.value).not.toBeNull();

    // Structural: the run really is split into floor(h / STEP_CHUNK) + 1
    // suspension points, so no chunk covers more than STEP_CHUNK months.
    // Deterministic — cannot flake.
    expect(chunks).toBe(Math.floor(480 / STEP_CHUNK) + 1);

    // Timed: ~4.5 ms measured (bun 1.4.2, darwin) — a 20x ceiling, one-sided.
    expect(worstChunkMs).toBeLessThan(100);
  }, 60_000);

  test('4. path count does not change the emitted point count', () => {
    const small = runNetWorthForecast(input({ paths: DRAG_PATHS, horizonMonths: 240 }));
    const large = runNetWorthForecast(input({ paths: RELEASE_PATHS, horizonMonths: 240 }));
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small!.points.length).toBe(large!.points.length);
    expect(small!.pathCount).toBe(DRAG_PATHS);
    expect(large!.pathCount).toBe(RELEASE_PATHS);
    expect(small!.horizonMonths).toBe(240);
    expect(large!.horizonMonths).toBe(240);
  }, 60_000);

  test('5. sorting work grows with buckets, not with accumulated history', () => {
    // THE anti-quadratic gate, and it is deterministic: no wall clock, so it
    // cannot flake, and unlike a timing ratio it rejects a quadratic regression
    // of ANY magnitude rather than only a severe one.
    //
    // The invariant: each bucket boundary sorts a snapshot of exactly `paths`
    // values. The regression this guards against — re-sorting the whole
    // accumulated snapshot history at every boundary — sorts arrays whose
    // length grows with the step index, which is O(h^2 log h) work. It is
    // caught here by the per-sort length, by the total element count, and by
    // the sort-call count.
    const sortedLengths: number[] = [];
    let plainArraySorts = 0;

    const f64Proto = Float64Array.prototype as unknown as Record<string, unknown>;
    const typedProto = Object.getPrototypeOf(Float64Array.prototype) as {
      sort: (this: Float64Array, ...args: unknown[]) => Float64Array;
    };
    const nativeTypedSort = typedProto.sort;
    const nativeArraySort = Array.prototype.sort;

    // Own-property shadow on Float64Array.prototype, so other typed arrays and
    // other test files are untouched; `delete` restores the inherited method.
    f64Proto.sort = function (this: Float64Array, ...args: unknown[]): Float64Array {
      sortedLengths.push(this.length);
      return nativeTypedSort.apply(this, args);
    };
    (Array.prototype as unknown as Record<string, unknown>).sort = function (
      this: unknown[],
      ...args: unknown[]
    ): unknown[] {
      plainArraySorts++;
      return (nativeArraySort as (...a: unknown[]) => unknown[]).apply(this, args);
    };

    const paths = 250;
    const horizonMonths = 240;
    const bucketMonths = 3;
    let forecast: NetWorthForecast | null = null;
    try {
      forecast = runNetWorthForecast(input({ paths, horizonMonths, bucketMonths }));
    } finally {
      delete f64Proto.sort;
      (Array.prototype as unknown as Record<string, unknown>).sort = nativeArraySort;
    }

    const buckets = horizonMonths / bucketMonths; // 80
    expect(forecast).not.toBeNull();
    expect(forecast!.points.length).toBe(buckets + 1); // + the un-sorted anchor

    // Exactly one sort per bucket boundary — not one per simulated step.
    expect(sortedLengths.length).toBe(buckets);
    // Every sort is over the live path snapshot only. Constant, never growing.
    expect(new Set(sortedLengths).size).toBe(1);
    expect(sortedLengths[0]).toBe(paths);
    // Total elements sorted is linear in the horizon. The accumulated-history
    // regression would make this ~paths * buckets * (buckets + 1) / 2.
    expect(sortedLengths.reduce((a, b) => a + b, 0)).toBe(paths * buckets);
    // No Array.prototype.sort (i.e. no comparator-driven JS sort) in the engine.
    expect(plainArraySorts).toBe(0);
  }, 60_000);

  test('5b. wall-clock scaling: doubling the horizon roughly doubles the time', () => {
    // A coarse backstop over test 5's deterministic gate. Best-of-5 on both
    // sides; measured healthy ratio on darwin/bun 1.4.2 is 1.99-2.03 across
    // eight trials (sd ~0.014). The published quadratic regression (re-sorting
    // accumulated history every bucket) measures ~3.87 here, so 3.0 sits
    // between the two with ~50% headroom over healthy — deliberately loose,
    // because this runs on shared ubuntu-latest / macos-latest runners and a
    // flaky perf test is worse than a loose one. Tightening this toward the
    // reviewer-suggested 2.5 buys nothing: test 5 already rejects quadratic
    // scaling of any magnitude without a wall clock.
    //
    // NOTE: a ratio bound of 4 would be VACUOUS — for cost a*T + b*T^2 the
    // ratio (2a + 4bT)/(a + bT) is strictly < 4 for all a,b >= 0, i.e. 4 sits
    // exactly on the quadratic asymptote and can never be exceeded.
    const short = bestOf(input({ paths: DRAG_PATHS, horizonMonths: 240 }), 5);
    const long = bestOf(input({ paths: DRAG_PATHS, horizonMonths: 480 }), 5);
    // The 1 ms floor keeps a sub-millisecond short run from inflating the ratio.
    const ratio = long.ms / Math.max(short.ms, 1);
    expect(ratio).toBeLessThanOrEqual(3);
  }, 60_000);
});
