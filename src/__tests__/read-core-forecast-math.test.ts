import { describe, expect, test } from 'bun:test';
import { computeForecastAt, recurringWindow, type ForecastReaders } from '../tools/read-core/forecast-math.js';

/**
 * read-core/forecast-math.ts is the zero-import, async-generic port of
 * computeForecast (src/tools/query/forecast.ts). Server parity is pinned by
 * mirror-tool-parity.test.ts; this file pins the pure arithmetic with injected
 * readers (sync or async), so an edge can be tested without a database.
 */

const NOW = new Date('2026-07-15T12:00:00');

function readers(over: Partial<ForecastReaders> = {}): ForecastReaders {
  return {
    startingCash: () => 1000,
    monthly: () => [
      { income: 3000, expenses: 2000 },
      { income: 3000, expenses: 2200 },
    ],
    recurringTotal: () => null,
    ...over,
  };
}

describe('computeForecastAt', () => {
  test('averages the trailing months and projects the horizon from the injected clock', async () => {
    const r = await computeForecastAt(readers(), { horizonMonths: 3 }, NOW);
    expect(r.trailingMonthlyIncome).toBe(3000);
    expect(r.trailingMonthlyExpense).toBe(2100);
    expect(r.trailingMonthlyNet).toBe(900);
    expect(r.projection).toEqual([
      { month: '2026-08', projectedCash: 1900 },
      { month: '2026-09', projectedCash: 2800 },
      { month: '2026-10', projectedCash: 3700 },
    ]);
    expect(r.horizonEndCash).toBe(3700);
    expect(r.appliedAdjustments).toEqual([]);
  });

  test('works with synchronous and asynchronous readers alike', async () => {
    const sync = await computeForecastAt(readers(), {}, NOW);
    const asyn = await computeForecastAt(
      { startingCash: async () => 1000, monthly: async () => [{ income: 3000, expenses: 2000 }, { income: 3000, expenses: 2200 }], recurringTotal: async () => null },
      {},
      NOW,
    );
    expect(asyn).toEqual(sync);
  });

  test('clamps trailing and horizon months to 1..24 and passes the clamped window to the reader', async () => {
    const asked: number[] = [];
    const r = await computeForecastAt(readers({ monthly: (m) => (asked.push(m), []) }), { trailingMonths: 99, horizonMonths: 0 }, NOW);
    expect(asked).toEqual([24]);
    expect(r.trailingMonths).toBe(24);
    expect(r.horizonMonths).toBe(1);
    // No monthly rows: averages are 0 (monthCount falls back to 1), not NaN.
    expect(r.trailingMonthlyNet).toBe(0);
  });

  test('adjust_category: negative delta (spend less) improves net; a missing category is ignored', async () => {
    const r = await computeForecastAt(
      readers(),
      { whatIf: [{ type: 'adjust_category', category: 'Dining', monthlyDelta: -100 }, { type: 'adjust_category', monthlyDelta: -999 }] },
      NOW,
    );
    expect(r.adjustedMonthlyNet).toBe(1000);
    expect(r.appliedAdjustments).toHaveLength(1);
    expect(r.appliedAdjustments[0].description).toBe('Adjust "Dining" monthly spend by -100.00');
    expect(r.appliedAdjustments[0].monthlyImpact).toBe(100);
  });

  test('drop_recurring divides the matched total by the trailing months, and 0 / null totals add nothing', async () => {
    const calls: Array<[string, string, string]> = [];
    const r = await computeForecastAt(
      readers({ recurringTotal: (match, start, end) => (calls.push([match, start, end]), match === 'netflix' ? 93 : null) }),
      { trailingMonths: 6, whatIf: [{ type: 'drop_recurring', description: 'netflix' }, { type: 'drop_recurring', description: 'zzz' }] },
      NOW,
    );
    expect(r.appliedAdjustments.map((a) => a.monthlyImpact)).toEqual([15.5, 0]);
    expect(r.appliedAdjustments[0].description).toBe('Drop recurring expense matching "netflix" (~$15.50/mo)');
    expect(calls[0]).toEqual(['netflix', '2026-01-01', NOW.toISOString().slice(0, 10)]);
  });

  test('rounds money to cents', async () => {
    const r = await computeForecastAt(readers({ startingCash: () => 100.004, monthly: () => [{ income: 100.333, expenses: 0.111 }] }), {}, NOW);
    expect(r.startingCash).toBe(100);
    expect(r.trailingMonthlyIncome).toBe(100.33);
    expect(r.trailingMonthlyExpense).toBe(0.11);
  });
});

describe('recurringWindow', () => {
  test('starts on the first of the month `months` back and ends on the UTC date of now', () => {
    const a = new Date('2026-07-15T12:00:00');
    expect(recurringWindow(a, 3)).toEqual({ startStr: '2026-04-01', endStr: a.toISOString().slice(0, 10) });
    const b = new Date('2026-01-20T09:00:00');
    expect(recurringWindow(b, 6)).toEqual({ startStr: '2025-07-01', endStr: b.toISOString().slice(0, 10) });
  });
});
