import { describe, expect, test, beforeEach } from 'bun:test';
import { money, moneyWhole, moneyCompact, pct } from '../dashboard/ui/src/format.js';
import {
  buildCategoryPalette,
  categoryColor,
  primeCategoryPalette,
  getCategoryPalette,
  resetCategoryPaletteForTests,
} from '../dashboard/ui/src/charts/palette.js';
import { cssVarName, chartTokens, TOKEN_FALLBACKS, seriesSlots } from '../dashboard/ui/src/charts/tokens.js';
import { buildTooltipRows } from '../dashboard/ui/src/charts/tooltipRows.js';
import { chartCardPhase } from '../dashboard/ui/src/charts/chartCardState.js';
import { buildDonutData } from '../dashboard/ui/src/lib/donutData.js';
import {
  buildHeatmapGrid,
  makeCoveredFn,
  spaceMonthLabels,
  heatmapYearRange,
} from '../dashboard/ui/src/lib/heatmapGrid.js';
import { buildSavingsSeries, monthWindow, isLowIncome } from '../dashboard/ui/src/lib/savingsSeries.js';

describe('format: money / moneyWhole / moneyCompact / pct', () => {
  test('money puts the sign before $ and groups thousands', () => {
    expect(money(-1234.56)).toBe('-$1,234.56');
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(27400)).toBe('$27,400.00');
    expect(money(0)).toBe('$0.00');
  });

  test('never renders negative zero', () => {
    expect(money(-0.001)).toBe('$0.00');
    expect(moneyWhole(-0.4)).toBe('$0');
    expect(moneyCompact(-0.2)).toBe('$0');
    expect(pct(-0.04)).toBe('0%');
  });

  test('negative balances stay negative (no Math.abs)', () => {
    expect(money(-161809)).toBe('-$161,809.00');
    expect(moneyWhole(-161809.4)).toBe('-$161,809');
  });

  test('moneyWhole rounds to dollars', () => {
    expect(moneyWhole(27400)).toBe('$27,400');
    expect(moneyWhole(-1234.56)).toBe('-$1,235');
  });

  test('moneyCompact: sign before $, k/m suffixes', () => {
    expect(moneyCompact(-14000)).toBe('-$14k');
    expect(moneyCompact(950)).toBe('$950');
    expect(moneyCompact(-1500)).toBe('-$1.5k');
    expect(moneyCompact(2000)).toBe('$2k');
    expect(moneyCompact(999_600)).toBe('$1m');
    expect(moneyCompact(1_250_000)).toBe('$1.3m');
    expect(moneyCompact(-12_000_000)).toBe('-$12m');
  });

  test('pct takes percent units', () => {
    expect(pct(12.345)).toBe('12%');
    expect(pct(-12.345, 1)).toBe('-12.3%');
    expect(pct(1234)).toBe('1,234%');
  });

  test('non-finite values render a dash', () => {
    expect(money(Number.NaN)).toBe('—');
    expect(moneyCompact(Infinity)).toBe('—');
  });
});

describe('chart tokens', () => {
  test('maps camelCase names to the @theme CSS variables', () => {
    expect(cssVarName('chart1')).toBe('--color-chart-1');
    expect(cssVarName('chartNeutral')).toBe('--color-chart-neutral');
    expect(cssVarName('surfaceRaised')).toBe('--color-surface-raised');
    expect(cssVarName('chartTooltipBg')).toBe('--color-chart-tooltip-bg');
  });

  test('falls back to app.css values outside a browser', () => {
    expect(chartTokens()).toEqual({ ...TOKEN_FALLBACKS });
    expect(seriesSlots()).toHaveLength(7);
  });

  test('every token name exists in app.css', async () => {
    const css = await Bun.file(new URL('../dashboard/ui/src/styles/app.css', import.meta.url)).text();
    for (const name of Object.keys(TOKEN_FALLBACKS) as (keyof typeof TOKEN_FALLBACKS)[]) {
      const m = css.match(new RegExp(`${cssVarName(name)}:\\s*([^;]+);`));
      expect(m?.[1].trim()).toBe(TOKEN_FALLBACKS[name]);
    }
  });
});

describe('category palette', () => {
  const SLOTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  const allTime = [
    { category: 'Groceries', total: -900 },
    { category: 'Rent', total: -5000 },
    { category: 'Dining', total: -800 },
    { category: 'Uncategorized', total: -9999 },
    { category: null, total: -50 },
    { category: 'Income', total: -7000 }, // income stored negative — not spend
    { category: 'Salary', total: 8000 }, // positive — not spend
    { category: 'Gas', total: -300 },
    { category: 'Travel', total: -700 },
    { category: 'Utilities', total: -400 },
    { category: 'Shopping', total: -600 },
    { category: 'Pets', total: -100 },
  ];

  beforeEach(() => resetCategoryPaletteForTests());

  test('top 7 by all-time spend get slots 1-7 in rank order', () => {
    const p = buildCategoryPalette(allTime, SLOTS, 'grey');
    expect(categoryColor(p, 'Rent')).toBe('c1');
    expect(categoryColor(p, 'Groceries')).toBe('c2');
    expect(categoryColor(p, 'Dining')).toBe('c3');
    expect(categoryColor(p, 'Travel')).toBe('c4');
    expect(categoryColor(p, 'Shopping')).toBe('c5');
    expect(categoryColor(p, 'Utilities')).toBe('c6');
    expect(categoryColor(p, 'Gas')).toBe('c7');
  });

  test('rank 8+, Uncategorized, unknown, Income and income-only categories are neutral', () => {
    const p = buildCategoryPalette(allTime, SLOTS, 'grey');
    expect(categoryColor(p, 'Pets')).toBe('grey');
    expect(categoryColor(p, 'Uncategorized')).toBe('grey');
    expect(categoryColor(p, null)).toBe('grey');
    expect(categoryColor(p, 'Income')).toBe('grey');
    expect(categoryColor(p, 'Salary')).toBe('grey');
    expect(categoryColor(p, 'Never Seen')).toBe('grey');
  });

  test('color follows the entity: independent of the current view', () => {
    const p = buildCategoryPalette(allTime, SLOTS, 'grey');
    // A filtered view where Gas is the only category still paints Gas slot 7.
    expect(categoryColor(p, 'Gas')).toBe('c7');
  });

  test('session memo: first non-empty prime wins', () => {
    expect(primeCategoryPalette(null, SLOTS, 'grey')).toBeNull();
    expect(primeCategoryPalette([], SLOTS, 'grey')).toBeNull();
    primeCategoryPalette(allTime, SLOTS, 'grey');
    primeCategoryPalette([{ category: 'Pets', total: -1e9 }], SLOTS, 'grey');
    const p = getCategoryPalette()!;
    expect(categoryColor(p, 'Rent')).toBe('c1');
    expect(categoryColor(p, 'Pets')).toBe('grey');
  });
});

describe('tooltip rows', () => {
  test('keeps the category name for pie entries and computes share/count', () => {
    const rows = buildTooltipRows(
      [{ name: 'Groceries', value: 250, dataKey: 'value', payload: { fill: '#abc', count: 4 } }],
      { total: 1000, countKey: 'count' },
    );
    expect(rows).toEqual([
      { key: 'value|Groceries', value: 250, name: 'Groceries', color: '#abc', share: 25, count: 4 },
    ]);
  });

  test('maps dataKeys to display names (no dead name branches)', () => {
    const names: Record<string, string> = { netWorth: 'Net worth', totalAssets: 'Assets' };
    const rows = buildTooltipRows(
      [
        { name: 'netWorth', dataKey: 'netWorth', value: -5, color: '#0f0' },
        { name: 'totalAssets', dataKey: 'totalAssets', value: 10 },
      ],
      { nameFor: (k, n) => names[k] ?? n },
    );
    expect(rows.map((r) => r.name)).toEqual(['Net worth', 'Assets']);
    expect(rows[0].share).toBeUndefined();
  });

  test('null values, hidden keys and duplicates', () => {
    const rows = buildTooltipRows(
      [
        { dataKey: 'p10', value: 1 },
        { dataKey: 'rate', value: null },
        { dataKey: 'rate', value: null },
      ],
      { hideKeys: ['p10'] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeNull();
  });
});

describe('ChartCard phases', () => {
  test('skeleton only on first load; stale keeps the old chart', () => {
    expect(chartCardPhase(true, false)).toBe('skeleton');
    expect(chartCardPhase(true, true)).toBe('stale');
    expect(chartCardPhase(false, true)).toBe('ready');
    expect(chartCardPhase(false, false)).toBe('empty');
  });
});

describe('donut data', () => {
  test('merges labels that display the same (unique legend keys)', () => {
    const { slices, total } = buildDonutData([
      { category: 'Uncategorized', total: -10, count: 1 },
      { category: null, total: -5, count: 2 },
      { category: '', total: -5, count: 1 },
      { category: 'Food', total: -30, count: 3 },
      { category: 'Salary', total: 100, count: 1 },
    ]);
    expect(slices).toEqual([
      { name: 'Food', value: 30, count: 3 },
      { name: 'Uncategorized', value: 20, count: 4 },
    ]);
    expect(new Set(slices.map((s) => s.name)).size).toBe(slices.length);
    expect(total).toBe(50);
  });
});

describe('heatmap grid', () => {
  const now = new Date(2026, 8, 30, 12); // Sep 30 2026 local

  test('month labels never overlap (no label crammed at weekIndex 0)', () => {
    const { startDate, endDate } = heatmapYearRange(now);
    const grid = buildHeatmapGrid({ startDate, endDate, spending: new Map(), dailyBudget: 50, now });
    for (let i = 1; i < grid.months.length; i++) {
      expect(grid.months[i].weekIndex - grid.months[i - 1].weekIndex).toBeGreaterThanOrEqual(2);
    }
    // Start is Sunday Sep 28 2025: Sep has only 3 days → its label is dropped.
    expect(startDate).toBe('2025-09-28');
    expect(grid.months[0].label).toBe('Oct');
  });

  test('spaceMonthLabels drops labels too close to the next one or the edge', () => {
    expect(
      spaceMonthLabels(
        [
          { label: 'Sep', weekIndex: 0 },
          { label: 'Oct', weekIndex: 1 },
          { label: 'Nov', weekIndex: 5 },
          { label: 'Dec', weekIndex: 9 },
        ],
        10,
      ).map((m) => m.label),
    ).toEqual(['Oct', 'Nov']);
  });

  test('missing coverage → every day covered (pre-coverage behavior)', () => {
    const covered = makeCoveredFn(null);
    expect(covered('1999-01-01')).toBe(true);
  });

  test('days after coverage end / in gap months are uncovered and excluded from the tally', () => {
    const coverage = { start: '2026-09-01', end: '2026-09-10', months: ['2026-09'] };
    const grid = buildHeatmapGrid({
      startDate: '2026-08-30',
      endDate: '2026-09-30',
      spending: new Map([['2026-09-02', 80]]),
      dailyBudget: 50,
      coverage,
      now,
    });
    const days = grid.weeks.flat();
    expect(days.find((d) => d.date === '2026-08-31')!.covered).toBe(false);
    expect(days.find((d) => d.date === '2026-09-05')!.covered).toBe(true);
    expect(days.find((d) => d.date === '2026-09-20')!.covered).toBe(false);
    // Sep 1-10 covered: 10 days, one over budget.
    expect(grid.totalDays).toBe(10);
    expect(grid.underBudgetDays).toBe(9);
  });

  test('gap months inside [start, end] are uncovered', () => {
    const covered = makeCoveredFn({ start: '2026-01-05', end: '2026-03-20', months: ['2026-01', '2026-03'] });
    expect(covered('2026-02-10')).toBe(false);
    expect(covered('2026-01-04')).toBe(false);
    expect(covered('2026-03-20')).toBe(true);
  });

  test('empty coverage (nothing imported) covers nothing', () => {
    const covered = makeCoveredFn({ start: null, end: null, months: [] });
    expect(covered('2026-09-01')).toBe(false);
  });

  test('future days are not counted', () => {
    const grid = buildHeatmapGrid({
      startDate: '2026-09-27',
      endDate: '2026-10-03',
      spending: new Map(),
      dailyBudget: 50,
      now,
    });
    expect(grid.totalDays).toBe(4); // Sep 27-30
    expect(grid.weeks.flat().filter((d) => d.future)).toHaveLength(3);
  });
});

describe('savings series', () => {
  const now = new Date(2026, 8, 15); // Sep 2026

  test('fixed calendar window with null gaps (no joining non-adjacent months)', () => {
    const s = buildSavingsSeries(
      [
        { month: '2026-04', income: 1000, expenses: 500 },
        { month: '2026-07', income: 1000, expenses: 900 },
        { month: '2026-09', income: 1000, expenses: 2000 },
      ],
      { now },
    );
    expect(s.points.map((p) => p.month)).toEqual(monthWindow('2026-09', 6));
    expect(s.points.map((p) => p.month)[0]).toBe('2026-04');
    expect(s.points.map((p) => p.value)).toEqual([50, null, null, 10, null, -100]);
    expect(s.mode).toBe('rate');
    // Latest (Sep) vs Aug: Aug is a gap → no trend claimed.
    expect(s.trend).toBeNull();
  });

  test('values are not clamped; trend uses unclamped adjacent months', () => {
    const s = buildSavingsSeries(
      [
        { month: '2026-08', income: 1000, expenses: 3000 }, // -200%
        { month: '2026-09', income: 1000, expenses: 2500 }, // -150%
      ],
      { now },
    );
    expect(s.latest!.value).toBe(-150);
    expect(s.points[4].value).toBe(-200);
    // Old code clamped both to -100 and called it flat/up for the wrong reason.
    expect(s.trend).toBe('up');
  });

  test('income < 10% of expenses switches to net dollars with a low-income flag', () => {
    expect(isLowIncome(50, 1000)).toBe(true);
    expect(isLowIncome(100, 1000)).toBe(false);
    expect(isLowIncome(0, 0)).toBe(false);
    const s = buildSavingsSeries(
      [
        { month: '2026-08', income: 2000, expenses: 1000 },
        { month: '2026-09', income: 20, expenses: 1000 },
      ],
      { now },
    );
    expect(s.mode).toBe('net');
    expect(s.lowIncome).toBe(true);
    expect(s.latest!.value).toBe(-980);
    expect(s.points[4].value).toBe(1000);
    expect(s.trend).toBe('down');
  });

  test('window ends at the later of the current month and the latest data month', () => {
    const s = buildSavingsSeries([{ month: '2026-11', income: 10, expenses: 5 }], { now });
    expect(s.points[s.points.length - 1].month).toBe('2026-11');
  });

  test('empty input → no latest', () => {
    const s = buildSavingsSeries([], { now });
    expect(s.latest).toBeNull();
    expect(s.points.every((p) => p.value === null)).toBe(true);
  });
});
