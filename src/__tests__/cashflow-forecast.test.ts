import { describe, expect, test } from 'bun:test';
import {
  mulberry32,
  percentile,
  runCashflowForecast,
  MIN_HISTORY_MONTHS,
} from '../dashboard/ui/src/lib/cashflowForecast.js';
import type { CashflowMonth } from '../dashboard/ui/src/lib/cashflowForecast.js';

// Pure, dependency-free simulation engine tests (no DB, no DOM). The module
// lives in the dashboard UI bundle but joins the root tsc program via this
// import — same pattern as the hybrid-core tests.

describe('mulberry32', () => {
  test('is deterministic — two instances with the same seed emit the identical sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  test('first five outputs for seed 42 (pinned exactly)', () => {
    const rng = mulberry32(42);
    expect(rng()).toBe(0.6011037519201636);
    expect(rng()).toBe(0.44829055899754167);
    expect(rng()).toBe(0.8524657934904099);
    expect(rng()).toBe(0.6697340414393693);
    expect(rng()).toBe(0.17481389874592423);
  });

  test('every value is in [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('different seeds give different sequences', () => {
    const r1 = mulberry32(1);
    expect(r1()).toBe(0.6270739405881613);
    const r2 = mulberry32(2);
    expect(r2()).not.toBe(0.6270739405881613);
  });
});

describe('percentile', () => {
  test('nearest-rank on 1..100 ascending', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 10)).toBe(10);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(100);
  });
});

describe('runCashflowForecast', () => {
  const variedHistory: CashflowMonth[] = [
    { month: '2026-02', income: 3800, expenses: 2600 },
    { month: '2026-03', income: 4700, expenses: 2200 },
    { month: '2026-04', income: 4100, expenses: 2900 },
    { month: '2026-05', income: 3900, expenses: 2400 },
    { month: '2026-06', income: 4400, expenses: 2700 },
    { month: '2026-07', income: 4200, expenses: 2500 },
  ];

  test('bands stay ordered at every point', () => {
    const result = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      seed: 42,
    });
    expect(result).not.toBeNull();
    for (const pt of result!.points) {
      expect(pt.p10).toBeLessThanOrEqual(pt.p25);
      expect(pt.p25).toBeLessThanOrEqual(pt.p50);
      expect(pt.p50).toBeLessThanOrEqual(pt.p75);
      expect(pt.p75).toBeLessThanOrEqual(pt.p90);
    }
  });

  test('every path starts at the seeded starting balance (anchor is not simulated)', () => {
    const result = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      seed: 42,
    })!;
    const anchor = result.points[0];
    expect(anchor.step).toBe(0);
    expect(anchor.label).toBe('Now');
    expect(anchor.p10).toBe(5000);
    expect(anchor.p25).toBe(5000);
    expect(anchor.p50).toBe(5000);
    expect(anchor.p75).toBe(5000);
    expect(anchor.p90).toBe(5000);
    expect(result.startBalance).toBe(5000);
  });

  test('horizon length is honored', () => {
    const twelve = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      horizonMonths: 12,
      seed: 42,
    })!;
    expect(twelve.points).toHaveLength(13);

    const six = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      horizonMonths: 6,
      seed: 42,
    })!;
    expect(six.points).toHaveLength(7);
    expect(six.points[6].step).toBe(6);
  });

  test('deterministic under a fixed seed; different seed shifts the median somewhere', () => {
    const a = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      seed: 1234,
    });
    const b = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      seed: 1234,
    });
    expect(a).toEqual(b);

    const c = runCashflowForecast({
      history: variedHistory,
      startBalance: 5000,
      startMonth: '2026-09',
      seed: 5678,
    })!;
    const medianA = a!.points.map((p) => p.p50);
    const medianC = c.points.map((p) => p.p50);
    expect(medianA).not.toEqual(medianC);
  });

  test('degenerate history (identical months) yields exact percentile lines', () => {
    // Every month identical → every bootstrap draw identical → every path is
    // the same line startBalance + k * net, so ALL percentiles at step k must
    // equal it exactly. Pins bootstrap + percentile + accumulation together.
    const history: CashflowMonth[] = Array.from({ length: 5 }, (_, i) => ({
      month: `2026-0${i + 3}`,
      income: 3000,
      expenses: 2000,
    }));
    const result = runCashflowForecast({
      history,
      startBalance: 1000,
      startMonth: '2026-09',
      seed: 99,
    })!;
    for (let step = 0; step <= 12; step++) {
      const pt = result.points[step];
      const expected = 1000 + step * 1000;
      expect(pt.p10).toBe(expected);
      expect(pt.p25).toBe(expected);
      expect(pt.p50).toBe(expected);
      expect(pt.p75).toBe(expected);
      expect(pt.p90).toBe(expected);
    }
  });

  test('short/empty history degrades gracefully (null below MIN_HISTORY_MONTHS)', () => {
    expect(MIN_HISTORY_MONTHS).toBe(2);
    expect(runCashflowForecast({ history: [], startBalance: 1000, startMonth: '2026-09' })).toBeNull();
    expect(
      runCashflowForecast({
        history: [{ month: '2026-08', income: 3000, expenses: 2000 }],
        startBalance: 1000,
        startMonth: '2026-09',
      }),
    ).toBeNull();
    expect(
      runCashflowForecast({
        history: [
          { month: '2026-07', income: 3000, expenses: 2000 },
          { month: '2026-08', income: Number.NaN, expenses: 2000 },
        ],
        startBalance: 1000,
        startMonth: '2026-09',
      }),
    ).toBeNull(); // non-finite row dropped → only one usable month
  });

  test('two months of history produce a fully finite result', () => {
    const result = runCashflowForecast({
      history: [
        { month: '2026-07', income: 3000, expenses: 2000 },
        { month: '2026-08', income: 3400, expenses: 2400 },
      ],
      startBalance: 1500,
      startMonth: '2026-09',
      seed: 5,
    })!;
    expect(result.points).toHaveLength(13);
    expect(result.pathCount).toBe(500);
    for (const pt of result.points) {
      for (const v of [pt.p10, pt.p25, pt.p50, pt.p75, pt.p90]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});