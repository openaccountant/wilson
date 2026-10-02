import { describe, expect, test } from 'bun:test';
import {
  bands,
  mulberry32,
  percentile,
  standardNormal,
} from '../dashboard/ui/src/lib/forecastCore.js';
import {
  BUCKET_MONTHS,
  DRAG_PATHS,
  FIXED_ANNUAL_VOLATILITY,
  HORIZON_DEFAULT_YEARS,
  HORIZON_MAX_YEARS,
  HORIZON_MIN_YEARS,
  NET_WORTH_MIN_HISTORY_MONTHS,
  RELEASE_PATHS,
  RETURN_DEFAULT,
  RETURN_MAX,
  RETURN_MIN,
  RETURN_STEP,
  SAVINGS_DELTA_MAX_PP,
  SAVINGS_DELTA_MIN_PP,
  SAVINGS_DELTA_STEP_PP,
  SHOCK_DEFAULT_YEAR,
  SHOCK_MAX,
  SHOCK_MIN,
  SHOCK_STEP,
  STEP_CHUNK,
  deriveNetWorthInputs,
  runNetWorthForecast,
  savingsDeltaToDollars,
  simulateNetWorth,
} from '../dashboard/ui/src/lib/netWorthForecast.js';
import type { NetWorthSimInput } from '../dashboard/ui/src/lib/netWorthForecast.js';
import { MIN_HISTORY_MONTHS } from '../dashboard/ui/src/lib/cashflowForecast.js';

// Pure, dependency-free simulation engine tests (no DB, no DOM, no worker).
// The modules live in the dashboard UI bundle but join the root tsc program
// via these imports — same pattern as cashflow-forecast.test.ts.

/** A well-formed baseline input; every test clones and overrides. */
function input(over: Partial<NetWorthSimInput> = {}): NetWorthSimInput {
  return {
    startNetWorth: 100_000,
    contributionPool: [1000],
    contributionDelta: 0,
    realAnnualReturn: 0.05,
    annualVolatility: 0,
    horizonMonths: 120,
    shock: null,
    paths: 64,
    seed: 1337,
    bucketMonths: 3,
    startMonth: '2026-01',
    ...over,
  };
}

/** Varied history pool: bootstrap draws actually matter here. */
const VARIED_POOL = [1200, -400, 2500, 800, 1900, -100, 3000, 600];

// ---------------------------------------------------------------------------
// 1-4. The random source
// ---------------------------------------------------------------------------

describe('standardNormal', () => {
  test('1. first five draws for seed 42 (pinned exactly)', () => {
    const rng = mulberry32(42);
    expect(standardNormal(rng)).toBe(-1.2848381576290195);
    expect(standardNormal(rng)).toBe(-0.9453528099747296);
    expect(standardNormal(rng)).toBe(-0.6112802846514629);
    expect(standardNormal(rng)).toBe(-0.5658325852126875);
    expect(standardNormal(rng)).toBe(-1.9727758972262703);
  });

  test('1b. first five draws for seed 1337 / DEFAULT_SEED (pinned exactly)', () => {
    const rng = mulberry32(1337);
    expect(standardNormal(rng)).toBe(0.23509028585214065);
    expect(standardNormal(rng)).toBe(-1.1291464760850458);
    expect(standardNormal(rng)).toBe(-0.7786192506746321);
    expect(standardNormal(rng)).toBe(-1.1663525205128167);
    expect(standardNormal(rng)).toBe(-1.2064328428408957);
  });

  test('2. consumes exactly two uniforms and never caches the sine half', () => {
    const rng = mulberry32(42);
    standardNormal(rng);
    // mulberry32(42)'s THIRD uniform: the first two went into the draw above,
    // and the discarded sine component did not steal a third.
    expect(rng()).toBe(0.8524657934904099);

    // Two draws consume four, so the fifth uniform comes next.
    const rng2 = mulberry32(42);
    standardNormal(rng2);
    standardNormal(rng2);
    expect(rng2()).toBe(0.17481389874592423);
  });

  test('3. the bootstrap uniform source is untouched by the new normal layer', () => {
    const rng = mulberry32(42);
    expect(rng()).toBe(0.6011037519201636);
    expect(rng()).toBe(0.44829055899754167);
    expect(rng()).toBe(0.8524657934904099);
    expect(rng()).toBe(0.6697340414393693);
    expect(rng()).toBe(0.17481389874592423);
  });

  test('4. distribution sanity over 200,000 seeded draws', () => {
    const rng = mulberry32(2024);
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    let within3 = 0;
    for (let i = 0; i < n; i++) {
      const z = standardNormal(rng);
      sum += z;
      sumSq += z * z;
      if (Math.abs(z) <= 3) within3++;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.abs(sd - 1)).toBeLessThan(0.02);
    expect(within3 / n).toBeGreaterThanOrEqual(0.995);
    expect(within3 / n).toBeLessThanOrEqual(0.999);
  });
});

// ---------------------------------------------------------------------------
// 5. Float64Array storage
// ---------------------------------------------------------------------------

describe('percentile over a Float64Array', () => {
  test('5. matches the number[] result and Float64Array.sort() is numeric', () => {
    const raw = [10, 9, 100, 2, 55, 7, 1000, 3, 41, 8];

    // The distinguishing case: Array.prototype.sort() with no comparator is
    // lexicographic, Float64Array.prototype.sort() is numeric.
    expect([...raw].sort()).toEqual([10, 100, 1000, 2, 3, 41, 55, 7, 8, 9]);
    const typedSorted = Float64Array.from(raw).sort();
    expect([...typedSorted]).toEqual([2, 3, 7, 8, 9, 10, 41, 55, 100, 1000]);

    const plainSorted = [...raw].sort((a, b) => a - b);
    for (const p of [10, 25, 50, 75, 90]) {
      expect(percentile(typedSorted, p)).toBe(percentile(plainSorted, p));
    }
    expect(bands(typedSorted)).toEqual(bands(plainSorted));
  });
});

// ---------------------------------------------------------------------------
// 6-9. Shape and determinism
// ---------------------------------------------------------------------------

describe('runNetWorthForecast shape', () => {
  test('6. is deterministic — identical inputs give deeply equal results', () => {
    const opts = input({ contributionPool: VARIED_POOL, annualVolatility: 0.15, paths: 500 });
    expect(runNetWorthForecast(opts)).toEqual(runNetWorthForecast(opts));
  });

  test('7. bands are ordered p10 <= p25 <= p50 <= p75 <= p90 at every point', () => {
    const f = runNetWorthForecast(
      input({ contributionPool: VARIED_POOL, annualVolatility: 0.15, paths: 500 }),
    );
    expect(f).not.toBeNull();
    for (const pt of f!.points) {
      expect(pt.p10).toBeLessThanOrEqual(pt.p25);
      expect(pt.p25).toBeLessThanOrEqual(pt.p50);
      expect(pt.p50).toBeLessThanOrEqual(pt.p75);
      expect(pt.p75).toBeLessThanOrEqual(pt.p90);
      expect(Number.isFinite(pt.p10)).toBe(true);
      expect(Number.isFinite(pt.p90)).toBe(true);
    }
  });

  test('8. the anchor is never simulated, shocked or scaled', () => {
    const f = runNetWorthForecast(
      input({
        startNetWorth: -12_345.67,
        contributionPool: VARIED_POOL,
        contributionDelta: 900,
        annualVolatility: 0.15,
        shock: { month: 1, amount: -50_000 },
      }),
    );
    expect(f).not.toBeNull();
    const a = f!.points[0];
    expect(a.step).toBe(0);
    expect(a.label).toBe('Now');
    expect(a.p10).toBe(-12_345.67);
    expect(a.p25).toBe(-12_345.67);
    expect(a.p50).toBe(-12_345.67);
    expect(a.p75).toBe(-12_345.67);
    expect(a.p90).toBe(-12_345.67);
    expect(f!.startNetWorth).toBe(-12_345.67);
    expect(f!.pathCount).toBe(64);
    expect(f!.horizonMonths).toBe(120);
  });

  test('9. quarterly bucketing emits anchor + one point per bucket', () => {
    const f = runNetWorthForecast(input({ horizonMonths: 120, bucketMonths: 3 }));
    expect(f).not.toBeNull();
    expect(f!.points.length).toBe(41);
    for (let k = 0; k < f!.points.length; k++) {
      expect(f!.points[k].step).toBe(k * 3);
    }
    expect(f!.points[40].step).toBe(120);
    // startMonth '2026-01' + 3 months.
    expect(f!.points[1].label).toBe('Apr 2026');
    expect(f!.points[40].label).toBe('Jan 2036');

    const long = runNetWorthForecast(input({ horizonMonths: 480, bucketMonths: 3 }));
    expect(long!.points.length).toBe(161);
    expect(long!.points[160].step).toBe(480);

    // A horizon that is not a whole number of buckets truncates the tail.
    const ragged = runNetWorthForecast(input({ horizonMonths: 121, bucketMonths: 3 }));
    expect(ragged!.points.length).toBe(41);
    expect(ragged!.points[40].step).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 10-13. The model
// ---------------------------------------------------------------------------

describe('the growth model', () => {
  test('10. zero volatility reproduces the closed-form annuity exactly', () => {
    const f = runNetWorthForecast(
      input({
        annualVolatility: 0,
        contributionPool: [1000],
        contributionDelta: 0,
        realAnnualReturn: 0.05,
        startNetWorth: 100_000,
        horizonMonths: 120,
        bucketMonths: 3,
      }),
    );
    expect(f).not.toBeNull();
    const g = Math.exp(Math.log(1.05) / 12);
    const expected = 100_000 * g ** 120 + (1000 * (g ** 120 - 1)) / (g - 1);
    const last = f!.points[f!.points.length - 1];
    for (const v of [last.p10, last.p25, last.p50, last.p75, last.p90]) {
      expect(Math.abs(v - expected) / expected).toBeLessThan(1e-9);
    }
  });

  test('10b. zero return and zero volatility give exactly start + contribution * k', () => {
    const f = runNetWorthForecast(
      input({ annualVolatility: 0, realAnnualReturn: 0, bucketMonths: 1, horizonMonths: 60 }),
    );
    expect(f).not.toBeNull();
    for (const pt of f!.points) {
      expect(pt.p50).toBe(100_000 + 1000 * pt.step);
      expect(pt.p10).toBe(100_000 + 1000 * pt.step);
      expect(pt.p90).toBe(100_000 + 1000 * pt.step);
    }
  });

  test('11. horizon prefix-stability — a longer run replays the shorter one', () => {
    const base = {
      contributionPool: VARIED_POOL,
      annualVolatility: 0.15,
      paths: 500,
      bucketMonths: 3,
    };
    const short = runNetWorthForecast(input({ ...base, horizonMonths: 120 }));
    const long = runNetWorthForecast(input({ ...base, horizonMonths: 240 }));
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(short!.points.length).toBe(41);
    expect(long!.points.length).toBe(81);
    expect(long!.points.slice(0, 41)).toEqual(short!.points);
  });

  test('12. the savings-rate delta reaches the simulation', () => {
    const exact = runNetWorthForecast(
      input({
        annualVolatility: 0,
        realAnnualReturn: 0,
        contributionDelta: 500,
        bucketMonths: 1,
        horizonMonths: 36,
      }),
    );
    expect(exact).not.toBeNull();
    for (const pt of exact!.points) {
      expect(pt.p50).toBe(100_000 + 1500 * pt.step);
    }

    // Same seed, non-zero vol: every band shifts up, the endpoint strictly.
    const stochastic = { contributionPool: VARIED_POOL, annualVolatility: 0.15, paths: 500 };
    const baseline = runNetWorthForecast(input({ ...stochastic, contributionDelta: 0 }));
    const boosted = runNetWorthForecast(input({ ...stochastic, contributionDelta: 500 }));
    expect(baseline).not.toBeNull();
    expect(boosted).not.toBeNull();
    for (let i = 0; i < baseline!.points.length; i++) {
      expect(boosted!.points[i].p50).toBeGreaterThanOrEqual(baseline!.points[i].p50);
    }
    const n = baseline!.points.length - 1;
    expect(boosted!.points[n].p50).toBeGreaterThan(baseline!.points[n].p50);
  });

  test('13. the return slider reaches the simulation', () => {
    const stochastic = { contributionPool: VARIED_POOL, annualVolatility: 0.15, paths: 500 };
    const low = runNetWorthForecast(input({ ...stochastic, realAnnualReturn: 0.05 }));
    const high = runNetWorthForecast(input({ ...stochastic, realAnnualReturn: 0.07 }));
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    for (let i = 0; i < low!.points.length; i++) {
      expect(high!.points[i].p50).toBeGreaterThanOrEqual(low!.points[i].p50);
    }
    const n = low!.points.length - 1;
    expect(high!.points[n].p50).toBeGreaterThan(low!.points[n].p50);
  });
});

// ---------------------------------------------------------------------------
// 14-16. Shocks and sanitization
// ---------------------------------------------------------------------------

describe('shocks', () => {
  const shockBase = {
    annualVolatility: 0,
    realAnnualReturn: 0,
    bucketMonths: 3,
    horizonMonths: 36,
  };

  test('14. a shock leaves earlier points untouched and offsets every later one', () => {
    const plain = runNetWorthForecast(input(shockBase));
    const shocked = runNetWorthForecast(
      input({ ...shockBase, shock: { month: 13, amount: -50_000 } }),
    );
    expect(plain).not.toBeNull();
    expect(shocked).not.toBeNull();

    for (let i = 0; i < plain!.points.length; i++) {
      const before = plain!.points[i];
      const after = shocked!.points[i];
      if (after.step <= 12) {
        expect(after).toEqual(before);
      } else {
        expect(after.step).toBeGreaterThanOrEqual(15);
        expect(after.p10).toBe(before.p10 - 50_000);
        expect(after.p50).toBe(before.p50 - 50_000);
        expect(after.p90).toBe(before.p90 - 50_000);
      }
    }
  });

  test('15. out-of-range and non-finite shocks behave exactly like no shock', () => {
    const plain = runNetWorthForecast(input(shockBase));
    const equivalents = [
      { month: 0, amount: -50_000 },
      { month: -3, amount: -50_000 },
      { month: 37, amount: -50_000 },
      { month: Number.NaN, amount: -50_000 },
      { month: Number.POSITIVE_INFINITY, amount: -50_000 },
      { month: 13, amount: Number.NaN },
      { month: 13, amount: Number.POSITIVE_INFINITY },
    ];
    for (const shock of equivalents) {
      expect(runNetWorthForecast(input({ ...shockBase, shock }))).toEqual(plain);
    }
    // ...and month 36, the last simulated month, is still in range.
    const edge = runNetWorthForecast(
      input({ ...shockBase, shock: { month: 36, amount: -50_000 } }),
    );
    expect(edge).not.toEqual(plain);
    expect(edge!.points[12].p50).toBe(plain!.points[12].p50 - 50_000);
  });
});

describe('input sanitization (no-throw)', () => {
  const nullCases: Array<[string, Partial<NetWorthSimInput>]> = [
    ['empty contributionPool', { contributionPool: [] }],
    ['all-non-finite pool', { contributionPool: [Number.NaN, Number.POSITIVE_INFINITY] }],
    ['paths: 0', { paths: 0 }],
    ['paths: -1', { paths: -1 }],
    ['paths: NaN', { paths: Number.NaN }],
    ['horizonMonths: 0', { horizonMonths: 0 }],
    ['horizonMonths: NaN', { horizonMonths: Number.NaN }],
    ['bucketMonths: 0', { bucketMonths: 0 }],
    ['bucketMonths: NaN', { bucketMonths: Number.NaN }],
    ['non-finite startNetWorth', { startNetWorth: Number.NaN }],
    ['infinite startNetWorth', { startNetWorth: Number.POSITIVE_INFINITY }],
    ['non-finite realAnnualReturn', { realAnnualReturn: Number.NaN }],
    ['non-finite annualVolatility', { annualVolatility: Number.POSITIVE_INFINITY }],
    // Math.log(1 + r) is -Infinity at exactly -1 and NaN below it. Without a
    // guard these are "finite" inputs that silently produce a chart of NaN
    // bands rather than an honest null.
    ['realAnnualReturn: -1 (total loss)', { realAnnualReturn: -1 }],
    ['realAnnualReturn below -1', { realAnnualReturn: -1.5 }],
  ];

  for (const [name, over] of nullCases) {
    test(`16. ${name} returns null without throwing`, () => {
      let result: unknown;
      expect(() => {
        result = runNetWorthForecast(input(over));
      }).not.toThrow();
      expect(result).toBeNull();
    });
  }

  test('16b. a partly broken pool keeps only the finite entries', () => {
    const clean = runNetWorthForecast(input({ contributionPool: [1000, 2000] }));
    const dirty = runNetWorthForecast(
      input({ contributionPool: [1000, Number.NaN, 2000, Number.NEGATIVE_INFINITY] }),
    );
    expect(dirty).toEqual(clean);
  });

  test('16c. a non-finite contributionDelta falls back to zero', () => {
    const zero = runNetWorthForecast(
      input({ contributionPool: VARIED_POOL, annualVolatility: 0.15, contributionDelta: 0 }),
    );
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        runNetWorthForecast(
          input({
            contributionPool: VARIED_POOL,
            annualVolatility: 0.15,
            contributionDelta: delta,
          }),
        ),
      ).toEqual(zero);
    }
  });
});

// ---------------------------------------------------------------------------
// 17-18. The worker path and the RNG consumption order
// ---------------------------------------------------------------------------

describe('simulateNetWorth (the chunked engine)', () => {
  // Horizons deliberately mix multiples of STEP_CHUNK (60/240/480) with
  // non-multiples (7, 50). The non-multiples are the ones that discriminate:
  // the yield count is floor(h / STEP_CHUNK) + 1 — the in-loop yields plus the
  // single trailing `yield 1` — which only coincides with ceil(h / STEP_CHUNK) + 1
  // when STEP_CHUNK divides h evenly.
  for (const horizonMonths of [7, 50, 60, 240, 480]) {
    test(`17. chunked === unchunked at ${horizonMonths} months`, () => {
      const opts = input({
        contributionPool: VARIED_POOL,
        annualVolatility: 0.15,
        paths: 250,
        horizonMonths,
        shock: { month: 25, amount: -20_000 },
        contributionDelta: 250,
      });

      const gen = simulateNetWorth(opts);
      const fractions: number[] = [];
      let next = gen.next();
      while (!next.done) {
        fractions.push(next.value);
        next = gen.next();
      }
      // Determinism of the returned forecast (the engine is shared, so this is
      // a sanity check, NOT the chunking invariant — that is pinned below).
      expect(next.value).toEqual(runNetWorthForecast(opts));

      // THE invariant: the generator must actually suspend every STEP_CHUNK
      // simulated months. That is the only thing that lets the worker's
      // onmessage run between chunks, so a newer drag can supersede an
      // in-flight 20,000 x 480 run and gen.return(null) can fire mid-run.
      // Deleting the in-loop `yield` collapses this to the lone trailing
      // `yield 1` and every assertion below fails.
      const expected: number[] = [];
      for (let step = STEP_CHUNK; step <= horizonMonths; step += STEP_CHUNK) {
        expected.push(step / horizonMonths);
      }
      expected.push(1); // the unconditional trailing yield

      // Exact count, not an upper bound. floor(...) + 1, never ceil(...) + 1.
      expect(fractions.length).toBe(Math.floor(horizonMonths / STEP_CHUNK) + 1);
      // Exact progress sequence: pins the spacing, not merely the count.
      expect(fractions).toEqual(expected);

      // The longest run of simulated months with no suspension point.
      let maxGapMonths = 0;
      let prevStep = 0;
      for (const f of fractions) {
        const step = Math.round(f * horizonMonths);
        maxGapMonths = Math.max(maxGapMonths, step - prevStep);
        prevStep = step;
      }
      expect(maxGapMonths).toBeLessThanOrEqual(STEP_CHUNK);

      for (let i = 0; i < fractions.length; i++) {
        expect(fractions[i]).toBeGreaterThan(0);
        expect(fractions[i]).toBeLessThanOrEqual(1);
        if (i > 0) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
      }
      expect(fractions[fractions.length - 1]).toBe(1);
    });
  }

  test('17b. a rejected input yields nothing and returns null', () => {
    const gen = simulateNetWorth(input({ paths: 0 }));
    const first = gen.next();
    expect(first.done).toBe(true);
    expect(first.value).toBeNull();
  });
});

describe('RNG consumption order', () => {
  test('18. matches a hand-rolled reference implementation exactly', () => {
    // Independent re-implementations of the primitives, so a refactor that
    // silently reorders draws inside the engine fails here.
    const rngOf = (seed: number): (() => number) => {
      let a = seed >>> 0;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const normalOf = (rng: () => number): number =>
      Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

    const pool = [1200, -400, 2500];
    const delta = 125;
    const start = 50_000;
    const seed = 99;
    const paths = 2;
    const horizonMonths = 2;
    const realAnnualReturn = 0.06;
    const annualVolatility = 0.15;

    const mu = Math.log(1 + realAnnualReturn) / 12;
    const sigma = annualVolatility / Math.sqrt(12);

    const rng = rngOf(seed);
    const nw = [start, start];
    const expectedPoints: number[][] = [];
    // Step-major / path-minor; per path-step: pick, then TWO normal uniforms.
    for (let step = 1; step <= horizonMonths; step++) {
      for (let p = 0; p < paths; p++) {
        const contribution = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] + delta;
        const z = normalOf(rng);
        const v = nw[p];
        nw[p] = (v > 0 ? v * Math.exp(mu + sigma * z) : v) + contribution;
      }
      expectedPoints.push([...nw].sort((a, b) => a - b));
    }

    const f = runNetWorthForecast(
      input({
        startNetWorth: start,
        contributionPool: pool,
        contributionDelta: delta,
        realAnnualReturn,
        annualVolatility,
        horizonMonths,
        paths,
        seed,
        bucketMonths: 1,
      }),
    );
    expect(f).not.toBeNull();
    expect(f!.points.length).toBe(3);
    for (let step = 1; step <= horizonMonths; step++) {
      const sorted = expectedPoints[step - 1];
      const pt = f!.points[step];
      expect(pt.step).toBe(step);
      expect(pt.p10).toBe(percentile(sorted, 10));
      expect(pt.p25).toBe(percentile(sorted, 25));
      expect(pt.p50).toBe(percentile(sorted, 50));
      expect(pt.p75).toBe(percentile(sorted, 75));
      expect(pt.p90).toBe(percentile(sorted, 90));
    }
  });
});

// ---------------------------------------------------------------------------
// 19-21. Derivation helpers and constants
// ---------------------------------------------------------------------------

describe('deriveNetWorthInputs', () => {
  const sixMonths = [
    { income: 8000, expenses: 6000 },
    { income: 8200, expenses: 6500 },
    { income: 7800, expenses: 5800 },
    { income: 8100, expenses: 6200 },
    { income: 7900, expenses: 6100 },
    { income: 8300, expenses: 6400 },
  ];

  test('19. six clean months give a pool of six net flows and the medians', () => {
    const d = deriveNetWorthInputs(sixMonths);
    expect(d).not.toBeNull();
    expect(d!.months).toBe(6);
    expect(d!.contributionPool).toEqual([2000, 1700, 2000, 1900, 1800, 1900]);
    // Nearest-rank median (ceil(0.5 * 6) - 1 = index 2 of the ascending sort).
    expect(d!.medianMonthlyIncome).toBe(8000);
    expect(d!.medianMonthlyContribution).toBe(1900);
  });

  test('19b. five months is below the gate', () => {
    expect(deriveNetWorthInputs(sixMonths.slice(0, 5))).toBeNull();
    expect(deriveNetWorthInputs([])).toBeNull();
  });

  test('19c. non-finite rows are dropped BEFORE the count', () => {
    const seven = [
      ...sixMonths.slice(0, 5),
      { income: Number.NaN, expenses: 6000 },
      { income: 8000, expenses: Number.POSITIVE_INFINITY },
    ];
    expect(seven.length).toBe(7);
    // Only five usable months remain.
    expect(deriveNetWorthInputs(seven)).toBeNull();

    const eight = [...seven, { income: 8400, expenses: 6300 }];
    const d = deriveNetWorthInputs(eight);
    expect(d).not.toBeNull();
    expect(d!.months).toBe(6);
    expect(d!.contributionPool).toEqual([2000, 1700, 2000, 1900, 1800, 2100]);
  });

  test('19d. the derived pool feeds the simulator through the same code path', () => {
    const d = deriveNetWorthInputs(sixMonths)!;
    const f = runNetWorthForecast(
      input({ contributionPool: d.contributionPool, annualVolatility: 0.15, paths: 200 }),
    );
    expect(f).not.toBeNull();
    expect(f!.pathCount).toBe(200);
  });
});

describe('savingsDeltaToDollars', () => {
  test('21. converts percentage points of income to dollars per month', () => {
    expect(savingsDeltaToDollars(3, 8000)).toBe(240);
    expect(savingsDeltaToDollars(-10, 8000)).toBe(-800);
    expect(savingsDeltaToDollars(0, 8000)).toBe(0);
    expect(savingsDeltaToDollars(3, 0)).toBe(0);
  });

  test('21b. non-finite inputs fall back to zero', () => {
    expect(savingsDeltaToDollars(3, Number.NaN)).toBe(0);
    expect(savingsDeltaToDollars(3, Number.POSITIVE_INFINITY)).toBe(0);
    expect(savingsDeltaToDollars(Number.NaN, 8000)).toBe(0);
  });
});

describe('constants', () => {
  test('20. the net-worth gate and the simulation constants are pinned', () => {
    expect(NET_WORTH_MIN_HISTORY_MONTHS).toBe(6);
    expect(FIXED_ANNUAL_VOLATILITY).toBe(0.15);
    expect(BUCKET_MONTHS).toBe(3);
    expect(DRAG_PATHS).toBe(5000);
    expect(RELEASE_PATHS).toBe(20000);
    expect(STEP_CHUNK).toBe(6);
  });

  test('20b. every slider bound is pinned', () => {
    expect(SAVINGS_DELTA_MIN_PP).toBe(-10);
    expect(SAVINGS_DELTA_MAX_PP).toBe(25);
    expect(SAVINGS_DELTA_STEP_PP).toBe(1);
    expect(RETURN_MIN).toBe(-0.02);
    expect(RETURN_MAX).toBe(0.1);
    expect(RETURN_STEP).toBe(0.0025);
    expect(RETURN_DEFAULT).toBe(0.05);
    expect(HORIZON_MIN_YEARS).toBe(5);
    expect(HORIZON_MAX_YEARS).toBe(40);
    expect(HORIZON_DEFAULT_YEARS).toBe(20);
    expect(SHOCK_MIN).toBe(-100000);
    expect(SHOCK_MAX).toBe(100000);
    expect(SHOCK_STEP).toBe(5000);
    expect(SHOCK_DEFAULT_YEAR).toBe(5);
  });

  test("20c. the cash card's own history gate is still 2", () => {
    expect(MIN_HISTORY_MONTHS).toBe(2);
    expect(NET_WORTH_MIN_HISTORY_MONTHS).not.toBe(MIN_HISTORY_MONTHS);
  });
});

// ---------------------------------------------------------------------------
// 22. The underwater fix
// ---------------------------------------------------------------------------

describe('underwater balances are never compounded', () => {
  test('22. a path at exactly zero stays at zero under returns alone', () => {
    const f = runNetWorthForecast(
      input({
        startNetWorth: 0,
        contributionPool: [0],
        contributionDelta: 0,
        annualVolatility: 0.15,
        realAnnualReturn: 0.05,
        horizonMonths: 120,
        paths: 200,
      }),
    );
    expect(f).not.toBeNull();
    for (const pt of f!.points) {
      expect(pt.p10).toBe(0);
      expect(pt.p50).toBe(0);
      expect(pt.p90).toBe(0);
    }
  });

  test('22b. a negative path never becomes more negative from returns', () => {
    const f = runNetWorthForecast(
      input({
        startNetWorth: -50_000,
        contributionPool: [0],
        contributionDelta: 0,
        annualVolatility: 0.15,
        realAnnualReturn: 0.05,
        horizonMonths: 480,
        paths: 200,
      }),
    );
    expect(f).not.toBeNull();
    for (const pt of f!.points) {
      expect(pt.p10).toBe(-50_000);
      expect(pt.p50).toBe(-50_000);
      expect(pt.p90).toBe(-50_000);
    }

    // The same holds with a negative real return: debt does not shrink either.
    const shrinking = runNetWorthForecast(
      input({
        startNetWorth: -50_000,
        contributionPool: [0],
        contributionDelta: 0,
        annualVolatility: 0,
        realAnnualReturn: -0.02,
        horizonMonths: 120,
        paths: 8,
      }),
    );
    for (const pt of shrinking!.points) expect(pt.p50).toBe(-50_000);
  });

  test('22c. contributions climb an underwater path out, then compounding resumes', () => {
    const f = runNetWorthForecast(
      input({
        startNetWorth: -10_000,
        contributionPool: [1000],
        contributionDelta: 0,
        annualVolatility: 0,
        realAnnualReturn: 0.05,
        horizonMonths: 24,
        bucketMonths: 1,
        paths: 4,
      }),
    );
    expect(f).not.toBeNull();
    const at = (step: number): number => f!.points[step].p50;

    // Flat climb while underwater: no growth term at all.
    for (let step = 0; step <= 10; step++) expect(at(step)).toBe(-10_000 + 1000 * step);
    expect(at(10)).toBe(0);
    // Month 11 starts at exactly 0 — still not > 0, so still no growth.
    expect(at(11)).toBe(1000);
    // Month 12 is the first compounding month.
    const g = Math.exp(Math.log(1.05) / 12);
    expect(at(12)).toBe(1000 * g + 1000);
    expect(at(12)).toBeGreaterThan(2000);
    // Normal compounding from here: strictly more than pure contributions.
    expect(at(24)).toBeGreaterThan(14_000);

    // The whole path is non-decreasing and crosses zero exactly once.
    for (let step = 1; step <= 24; step++) expect(at(step)).toBeGreaterThan(at(step - 1));
  });
});
