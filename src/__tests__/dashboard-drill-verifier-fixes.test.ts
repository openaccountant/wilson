import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  barScaleMax,
  breakdownTableData,
  buildSeriesBars,
  categorizeLabel,
  compareCaption,
  deltaCell,
  donutSlices,
  drillCompareWindow,
  expandedRemainder,
  foldTopN,
  isAppPushedTxnEntry,
  isNeutralDrillLabel,
  MIN_BAR_PCT,
  monthBarAria,
  monthTooltip,
  MORE_KEY,
  NO_DATA_STRIP_PCT,
  pushedHistoryState,
  seeAllLabel,
  seriesTableData,
  settledFocusKey,
  spanLabel,
  tooltipAnchor,
  DRILL_TXN_STATE_KEY,
} from '../dashboard/ui/src/lib/drill.js';
import { isNeutralLabel, PAYMENT_METHOD_LABELS } from '../dashboard/ui/src/lib/neutralLabels.js';
import { buildCategoryPalette, isNeutralCategory } from '../dashboard/ui/src/charts/palette.js';
import { createRequestGate } from '../dashboard/ui/src/lib/requestGate.js';
import { navigateUrl, readUrlState } from '../dashboard/ui/src/lib/urlHistory.js';
import { computeCompareWindow } from '../db/compare-window.js';
import type { BreakdownRow } from '../dashboard/ui/src/lib/spendingApi.js';
import type { UrlState } from '../dashboard/ui/src/lib/urlState.js';

// Verifier fixes for the spending drill (Charting Batch 2). Pure modules only.

const row = (key: string, total: number, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  label: key,
  total,
  count: 1,
  last: '2026-03-10',
  prevTotal: null,
  ...extra,
});

const cw = (
  preset: UrlState['preset'],
  start: string | null,
  end: string | null,
  today: string,
  cmp: 'prev' | 'yoy' | null,
  coverageEnd?: string | null,
) => drillCompareWindow({ preset, start, end, today, cmp, coverageEnd });

describe('H2 — Δ when imports lag: asOf = min(today, coverage end)', () => {
  test('Sep with data through Sep 15 compares Aug 1–15, not all of August', () => {
    expect(cw('month', '2026-09-01', null, '2026-10-03', 'prev', '2026-09-15')).toMatchObject({
      compareStart: '2026-08-01',
      compareEnd: '2026-08-15',
      partial: true,
      elapsedDays: 15,
    });
  });
  test('the current month with data lagging today uses the data end', () => {
    expect(cw('month', null, null, '2026-10-20', 'prev', '2026-10-05')).toMatchObject({
      compareStart: '2026-09-01',
      compareEnd: '2026-09-05',
    });
  });
  test('coverage past today, missing, or malformed falls back to today', () => {
    expect(cw('month', null, null, '2026-10-03', 'prev', '2026-12-31')).toMatchObject({ compareEnd: '2026-09-03' });
    expect(cw('month', null, null, '2026-10-03', 'prev', null)).toMatchObject({ compareEnd: '2026-09-03' });
    expect(cw('month', null, null, '2026-10-03', 'prev', 'garbage')).toMatchObject({ compareEnd: '2026-09-03' });
  });
  test('a fully covered past month is unaffected', () => {
    expect(cw('month', '2026-08-01', null, '2026-10-03', 'prev', '2026-09-30')).toMatchObject({
      compareStart: '2026-07-01',
      compareEnd: '2026-07-31',
      partial: false,
    });
  });
  test('data ends before the period starts → no comparison', () => {
    expect(cw('month', null, null, '2026-10-03', 'prev', '2026-09-20')).toBeNull();
  });
});

describe('H3 — the Δ caption says what it compares against', () => {
  test('partial windows: same N days', () => {
    expect(cw('month', '2026-09-01', null, '2026-10-03', 'prev', '2026-09-15')!.caption).toBe('vs Aug 1–15 (same 15 days)');
    expect(cw('month', null, null, '2026-10-01', 'prev')!.caption).toBe('vs Sep 1 (same 1 day)');
    expect(cw('month', null, null, '2026-10-03', 'yoy')!.caption).toBe('vs Oct 1–3, 2025 (same 3 days)');
    expect(cw('ytd', null, null, '2026-02-10', 'prev')!.caption).toBe('vs Jan 1 – Feb 10, 2025 (same 41 days)');
  });
  test('whole periods: month, quarter, year', () => {
    expect(cw('month', '2026-10-01', null, '2026-11-15', 'yoy')!.caption).toBe('vs Oct 2025');
    expect(cw('quarter', '2026-07-01', null, '2026-10-03', 'prev')!.caption).toBe('vs Q2 2026');
    expect(cw('year', '2025-01-01', null, '2026-05-15', 'prev')!.caption).toBe('vs 2024');
  });
  test('elapsed days clamped to a shorter month → the whole month, not "same N days"', () => {
    expect(cw('month', null, null, '2026-03-30', 'prev')!.caption).toBe('vs Feb 2026');
  });
  test('custom ranges', () => {
    expect(cw('custom', '2026-01-11', '2026-01-20', '2026-03-10', 'prev')!.caption).toBe('vs Jan 1–10');
    expect(cw('custom', '2026-01-01', '2026-04-30', '2026-06-10', 'prev')!.caption).toBe('vs Sep–Dec 2025');
    expect(cw('custom', '2026-02-01', '2026-05-31', '2026-07-10', 'prev')!.caption).toBe('vs Oct 2025 – Jan 2026');
    expect(compareCaption({ start: '2026-01-01', end: '2026-04-30', partial: false, elapsedDays: 120 }, 2026)).toBe(
      'vs Jan–Apr 2026',
    );
  });
  test('span labels', () => {
    expect(spanLabel('2026-08-01', '2026-08-15', 2026)).toBe('Aug 1–15');
    expect(spanLabel('2026-01-30', '2026-02-12', 2026)).toBe('Jan 30 – Feb 12');
    expect(spanLabel('2025-12-20', '2026-01-02', 2026)).toBe('Dec 20, 2025 – Jan 2, 2026');
    expect(spanLabel('2025-08-01', '2025-08-15', 2026)).toBe('Aug 1–15, 2025');
  });
});

describe('L7 — Feb 29: whole months compare whole months; partial windows match dates', () => {
  test('Feb 2029 (yoy) compares against ALL of Feb 2028, incl. the 29th', () => {
    expect(computeCompareWindow({ start: '2029-02-01', end: '2029-02-28' }, 'yoy', '2029-03-10')).toMatchObject({
      start: '2028-02-01',
      end: '2028-02-29',
      partial: false,
    });
    // Multi-month aligned ranges end on the last day of the shifted month too.
    expect(computeCompareWindow({ start: '2029-01-01', end: '2029-02-28' }, 'yoy', '2029-06-01')).toMatchObject({
      start: '2028-01-01',
      end: '2028-02-29',
    });
  });
  test('Feb 2028 (yoy) still compares against all of Feb 2027 (28 days)', () => {
    expect(computeCompareWindow({ start: '2028-02-01', end: '2028-02-29' }, 'yoy', '2028-03-10')).toMatchObject({
      start: '2027-02-01',
      end: '2027-02-28',
    });
  });
  test('partial yoy windows match calendar dates across a leap day', () => {
    // YTD 2029 through Mar 10 vs Jan 1 – Mar 10 2028 (not Mar 9 by day count).
    expect(computeCompareWindow({ start: '2029-01-01', end: '2029-12-31' }, 'yoy', '2029-03-10')).toMatchObject({
      start: '2028-01-01',
      end: '2028-03-10',
      partial: true,
    });
    // On Feb 29 itself: same date last year falls back to Feb 28.
    expect(computeCompareWindow({ start: '2028-01-01', end: '2028-12-31' }, 'yoy', '2028-02-29')).toMatchObject({
      start: '2027-01-01',
      end: '2027-02-28',
    });
  });
  test('non-aligned custom yoy keeps calendar dates', () => {
    expect(computeCompareWindow({ start: '2029-02-10', end: '2029-02-28' }, 'yoy', '2029-06-01')).toMatchObject({
      start: '2028-02-10',
      end: '2028-02-28',
    });
  });
});

describe('H4 / M2 / M4 — month bars placement math', () => {
  const series = {
    periods: ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'],
    values: [null, 400, 100, 0, 50],
  };
  const range = { startDate: '2026-01-01', endDate: '2026-01-31' };

  test('no-data months are a short placeholder strip, never a full-height bar', () => {
    const { bars } = buildSeriesBars(series, range);
    expect(bars[0]).toMatchObject({ noData: true, heightPct: NO_DATA_STRIP_PCT });
    expect(NO_DATA_STRIP_PCT).toBeLessThan(20);
    expect(bars[1].heightPct).toBe(100); // the max covered month
    expect(bars[2].heightPct).toBe(25);
    expect(bars[3].heightPct).toBe(0); // covered, no spend → baseline
    // A tiny non-zero month stays visible.
    const tiny = buildSeriesBars({ periods: ['2026-01', '2026-02'], values: [1000, 1] }, range).bars[1];
    expect(tiny.heightPct).toBe(MIN_BAR_PCT);
  });

  test('the partial coverage-end month is flagged and left out of the average', () => {
    const { bars, average, max } = buildSeriesBars(series, range, { coverageEnd: '2026-03-12' });
    expect(bars.map((b) => b.partial)).toEqual([false, false, false, false, true]);
    expect(average).toBe((400 + 100 + 0) / 3);
    expect(max).toBe(400);
    // Half a month is never compared with a full-month average.
    expect(bars[4].vsAverage).toBeNull();
    expect(bars[0].vsAverage).toBeNull();
  });

  test('a coverage end on the last day of its month is not partial', () => {
    const { bars, average } = buildSeriesBars(series, range, { coverageEnd: '2026-03-31' });
    expect(bars.some((b) => b.partial)).toBe(false);
    expect(average).toBe((400 + 100 + 0 + 50) / 4);
  });

  test('axis ticks carry the year at January and on the first tick; the max bar is flagged', () => {
    const { bars } = buildSeriesBars(series, range);
    expect(bars.map((b) => b.axisLabel)).toEqual(['Nov ’25', 'Dec', 'Jan ’26', 'Feb', 'Mar']);
    expect(bars.map((b) => b.isMax)).toEqual([false, true, false, false, false]);
    expect(bars.map((b) => b.inRange)).toEqual([false, false, true, false, false]);
  });

  test('tooltip anchors on the hovered bar, pinned to the edges near the ends', () => {
    expect(tooltipAnchor(0, 12).align).toBe('start');
    expect(tooltipAnchor(0, 12).leftPct).toBeCloseTo(100 / 24);
    expect(tooltipAnchor(6, 12).align).toBe('center');
    expect(tooltipAnchor(6, 12).leftPct).toBeCloseTo(54.1667, 3);
    expect(tooltipAnchor(11, 12).align).toBe('end');
    expect(tooltipAnchor(11, 12).leftPct).toBeCloseTo(100 - 100 / 24);
    expect(tooltipAnchor(99, 12).align).toBe('end');
  });

  test('tooltip content + aria name', () => {
    const { bars } = buildSeriesBars(series, range, { coverageEnd: '2026-03-12' });
    expect(monthTooltip(bars[2])).toEqual({
      title: 'Jan 2026',
      value: '$100.00',
      lines: ['vs avg -$67', 'In selected range'],
    });
    expect(monthTooltip(bars[4], { coverageEnd: '2026-03-12', count: 3 }).lines).toEqual([
      'Partial month (data through Mar 12, 2026)',
      '3 transactions',
    ]);
    expect(monthTooltip(bars[0])).toEqual({ title: 'Nov 2025', value: 'No data', lines: ['No imported statements'] });
    expect(monthBarAria(bars[0])).toBe('Nov 2025: no data');
    expect(monthBarAria(bars[4])).toBe('Mar 2026: $50.00, partial month. Show this month');
  });
});

describe('M5 / M7 — one shared neutral-label list', () => {
  test('payment-method labels are neutral in the palette AND the drill', () => {
    for (const l of [...PAYMENT_METHOD_LABELS, 'venmo', ' Debit ', 'Uncategorized', 'Other', '', null]) {
      expect(isNeutralLabel(l)).toBe(true);
      expect(isNeutralCategory(l)).toBe(true);
      expect(isNeutralDrillLabel(l)).toBe(true);
    }
    expect(isNeutralLabel('Dining')).toBe(false);
  });

  test('payment-method labels never consume a palette slot', () => {
    const p = buildCategoryPalette(
      [
        { category: 'Debit', total: -9000 },
        { category: 'Venmo', total: -8000 },
        { category: 'Dining', total: -500 },
        { category: 'Groceries', total: -400 },
      ],
      ['s1', 's2', 's3'],
      'grey',
    );
    expect([...p.slots.entries()]).toEqual([
      ['Dining', 's1'],
      ['Groceries', 's2'],
    ]);
  });
});

describe('M6 — donut: colored slices first, greys in one trailing run', () => {
  test('neutral labels and "more" trail the colored slices in rank order', () => {
    const colorFor = (l: string) => (l === 'Unslotted' ? 'grey' : `color:${l}`);
    const slices = donutSlices(
      [row('Venmo', 90), row('Dining', 50), row('Uncategorized', 40), row('Unslotted', 30), row('Shopping', 20)],
      { key: MORE_KEY, label: '3 more categories', groups: 3, total: 30, count: 4 },
      colorFor,
      'grey',
    );
    expect(slices.map((s) => s.name)).toEqual(['Dining', 'Shopping', 'Venmo', 'Uncategorized', 'Unslotted', '3 more categories']);
    const firstGrey = slices.findIndex((s) => s.color === 'grey');
    expect(slices.slice(firstGrey).every((s) => s.color === 'grey')).toBe(true);
  });
});

describe('H1 — the folded row never scales the bars', () => {
  test('barScaleMax ignores the "more" row', () => {
    expect(barScaleMax([{ total: 100 }, { total: 40 }, { total: 5000, action: 'expand' }])).toBe(100);
  });
  test('foldTopN carries the folded transaction count', () => {
    const { more } = foldTopN({ rows: [row('A', 10), row('B', 5, { count: 3 })], otherTotal: 7, otherCount: 2, otherTxnCount: 4 }, 1);
    expect(more).toMatchObject({ groups: 3, total: 12, count: 7 });
  });
});

describe('M9 — table views carry every row, Δ, and the series', () => {
  const visible = [row('Dining', 60, { count: 3, prevTotal: 50 }), row('Travel', 30, { count: 1, prevTotal: null })];
  const more = { key: MORE_KEY, label: '2 more categories', groups: 2, total: 10, count: 2 } as const;

  test('L1 table includes the "N more" row so rows sum to the total', () => {
    const t = breakdownTableData({ rows: visible, more, total: 100, cmp: null, firstColumn: 'Category' });
    expect(t.columns.map((c) => c.label)).toEqual(['Category', 'Spent', 'Share', 'Txns']);
    expect(t.rows).toEqual([
      ['Dining', '$60.00', '60%', 3],
      ['Travel', '$30.00', '30%', 1],
      ['2 more categories', '$10.00', '10%', 2],
    ]);
    const sum = t.rows.reduce((s, r) => s + Number(String(r[1]).replace(/[$,]/g, '')), 0);
    expect(sum).toBe(100);
  });

  test('a Change column when the comparison is on (L1 + L2)', () => {
    const t = breakdownTableData({ rows: visible, more, moreText: 'Other merchants (2)', total: 100, cmp: 'prev', firstColumn: 'Merchant' });
    expect(t.columns.map((c) => c.label)).toEqual(['Merchant', 'Spent', 'Share', 'Txns', 'Change']);
    expect(t.rows.map((r) => r[4])).toEqual(['+$10 (+20%)', 'no prior data', '—']);
    expect(t.rows[2][0]).toBe('Other merchants (2)');
    expect(deltaCell(10, undefined, 'prev')).toBe('—');
  });

  test('the 12-month series as a table (L2 and L3)', () => {
    const { bars, average } = buildSeriesBars(
      { periods: ['2026-01', '2026-02', '2026-03'], values: [null, 100, 40] },
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      { coverageEnd: '2026-03-10' },
    );
    const t = seriesTableData(bars, average, 'Dining by month.');
    expect(t.columns.map((c) => c.label)).toEqual(['Month', 'Spent', 'vs avg', 'Note']);
    expect(t.rows).toEqual([
      ['Jan 2026', 'No data', '—', ''],
      ['Feb 2026', '$100.00', '$0', 'In selected range'],
      ['Mar 2026', '$40.00', '—', 'Partial month'],
    ]);
    expect(t.caption).toBe('Dining by month. Average $100 a month over complete months.');
  });
});

describe('L1 — focus fallback after going up', () => {
  test('target row rendered → nothing to do; missing → the "N more" control, else the heading', () => {
    const rendered = (keys: string[]) => (k: string) => keys.includes(k);
    expect(settledFocusKey('Dining', rendered(['Dining', MORE_KEY]))).toBeNull();
    expect(settledFocusKey('Tiny cat', rendered(['Dining', MORE_KEY]))).toBe(MORE_KEY);
    expect(settledFocusKey('Tiny cat', rendered(['Dining']))).toBe('heading');
    expect(settledFocusKey(null, rendered([]))).toBeNull();
  });
});

describe('L2 — expansion responses for a stale scope are ignored', () => {
  test('a response that lands after the path changed is not current', () => {
    const gate = createRequestGate('/a');
    const t1 = gate.begin('/a');
    expect(gate.isCurrent(t1, '/a')).toBe(true);
    gate.reset('/b'); // the user changed the range while page 1 was in flight
    expect(gate.isCurrent(t1, '/a')).toBe(false);
    expect(gate.isCurrent(t1, '/b')).toBe(false);
    const t2 = gate.begin('/b');
    expect(gate.isCurrent(t2, '/b')).toBe(true);
  });
  test('a newer request supersedes an older one in the same scope', () => {
    const gate = createRequestGate('/a');
    const t1 = gate.begin('/a');
    const t2 = gate.begin('/a');
    expect(gate.isCurrent(t1, '/a')).toBe(false);
    expect(gate.isCurrent(t2, '/a')).toBe(true);
  });
});

describe('L3 — drawer entries are marked in history.state', () => {
  test('pushedHistoryState: marker belongs to one entry', () => {
    expect(pushedHistoryState(null, 7)).toEqual({ [DRILL_TXN_STATE_KEY]: 7 });
    expect(pushedHistoryState({ other: 1, [DRILL_TXN_STATE_KEY]: 7 }, null)).toEqual({ other: 1 });
    expect(pushedHistoryState({ [DRILL_TXN_STATE_KEY]: 7 }, 9)).toEqual({ [DRILL_TXN_STATE_KEY]: 9 });
    expect(pushedHistoryState(null, null)).toBeNull();
    expect(isAppPushedTxnEntry({ [DRILL_TXN_STATE_KEY]: 7 }, 7)).toBe(true);
    expect(isAppPushedTxnEntry({ [DRILL_TXN_STATE_KEY]: 7 }, 8)).toBe(false);
    expect(isAppPushedTxnEntry(null, 7)).toBe(false);
    expect(isAppPushedTxnEntry({ [DRILL_TXN_STATE_KEY]: 7 }, null)).toBe(false);
  });

  // A history with per-entry state (Back/Forward restore it), like a browser.
  class StatefulWindow extends EventTarget {
    entries: { hash: string; state: unknown }[];
    index = 0;
    constructor(hash: string) {
      super();
      this.entries = [{ hash, state: null }];
    }
    get location() {
      const self = this;
      return { pathname: '/', search: '', get hash() { return self.entries[self.index].hash; } };
    }
    get history() {
      const self = this;
      const hashOf = (url: string) => url.slice(url.indexOf('#'));
      return {
        get state() {
          return self.entries[self.index].state;
        },
        pushState(state: unknown, _t: string, url: string) {
          self.entries = self.entries.slice(0, self.index + 1);
          self.entries.push({ hash: hashOf(url), state });
          self.index++;
        },
        replaceState(state: unknown, _t: string, url: string) {
          self.entries[self.index] = { hash: hashOf(url), state };
        },
      };
    }
    go(delta: number) {
      this.index += delta;
      this.dispatchEvent(new Event('popstate'));
    }
  }

  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;
  let win: StatefulWindow;
  beforeEach(() => {
    saved = g.window;
    win = new StatefulWindow('#overview?cat=Dining&merchant=KFC');
    g.window = win;
  });
  afterEach(() => {
    g.window = saved;
  });

  test('Back → Forward → close still recognizes the app-pushed drawer entry (no duplicate L3)', () => {
    navigateUrl((s) => ({ ...s, txn: '42' }), { mode: 'push', pushState: (prev) => pushedHistoryState(prev, 42) });
    expect(win.entries).toHaveLength(2);
    win.go(-1); // Back: drawer closes
    win.go(1); // Forward: drawer reopens
    expect(readUrlState().txn).toBe('42');
    expect(isAppPushedTxnEntry(win.history.state, 42)).toBe(true);
  });

  test('ordinary pushes from a drawer entry do not inherit its marker', () => {
    navigateUrl((s) => ({ ...s, txn: '42' }), { mode: 'push', pushState: (prev) => pushedHistoryState(prev, 42) });
    navigateUrl((s) => ({ ...s, tab: 'transactions' }), { mode: 'push' });
    expect(win.history.state).toBeNull();
    // A replace keeps the entry's own state.
    win.go(-1);
    navigateUrl((s) => ({ ...s, cmp: 'prev' }), { mode: 'replace' });
    expect(isAppPushedTxnEntry(win.history.state, 42)).toBe(true);
  });

  test('a deep-linked drawer entry is not app-pushed (close replaces instead of going Back)', () => {
    win.entries = [{ hash: '#overview?cat=Dining&merchant=KFC&txn=42', state: null }];
    expect(isAppPushedTxnEntry(win.history.state, Number(readUrlState().txn))).toBe(false);
  });
});

describe('L6 — link counts say "spending transactions"', () => {
  test('labels', () => {
    expect(seeAllLabel(42)).toBe('See all 42 spending transactions');
    expect(seeAllLabel(1)).toBe('See all 1 spending transaction');
    expect(categorizeLabel(1234)).toBe('Categorize 1,234 spending transactions');
  });
});

describe('M9 — expanded table still sums to the total', () => {
  test('groups not loaded yet fold into a remainder row', () => {
    const loaded = [row('A', 50, { count: 2 }), row('B', 30, { count: 1 })];
    expect(expandedRemainder(loaded, { total: 100, count: 5, groups: 4 })).toEqual({
      key: MORE_KEY,
      label: '2 more categories',
      groups: 2,
      total: 20,
      count: 2,
    });
    expect(expandedRemainder(loaded, { total: 80, count: 3, groups: 2 })).toBeNull();
  });
});
