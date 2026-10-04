import { describe, expect, test } from 'bun:test';
import {
  drillCompareWindow,
  applyDrill,
  barPercent,
  breadcrumbs,
  buildSeriesBars,
  byPatch,
  deriveDrill,
  donutReplacement,
  donutSlices,
  drillIntoPatch,
  drillNavMode,
  emptyRangeMessage,
  excludedFootnote,
  expandCapped,
  focusAfterTransition,
  foldTopN,
  formatDelta,
  isActivateKey,
  isDrillable,
  isNeutralDrillLabel,
  isUpKey,
  lastTwelveMonthsPatch,
  mergeRows,
  monthRangePatch,
  MORE_KEY,
  moreLabel,
  nextExpandPage,
  openTxnPatch,
  rovingIndex,
  seriesWindow,
  shareLabel,
  transactionsHash,
  truncateLabel,
  upPatch,
} from '../dashboard/ui/src/lib/drill.js';
import {
  breakdownPath,
  merchantTransactionsPath,
  pageCount,
  seriesPath,
  type BreakdownRow,
} from '../dashboard/ui/src/lib/spendingApi.js';
import { defaultUrlState, parseHash, serializeHash, withTab, type UrlState } from '../dashboard/ui/src/lib/urlState.js';

const row = (key: string, total: number, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
  key,
  label: key,
  total,
  count: 1,
  last: '2026-03-10',
  prevTotal: null,
  ...extra,
});

const keys = (s: Partial<{ cat: string | null; merchant: string | null; txn: string | null; by: string | null }>) => ({
  cat: null,
  merchant: null,
  txn: null,
  by: null,
  ...s,
});

describe('deriveDrill: levels come from the URL', () => {
  test('L1 with no drill keys', () => {
    expect(deriveDrill(keys({}))).toMatchObject({ level: 1, baseLevel: 1, by: 'merchant' });
  });
  test('L2 with cat; by=detailed honored only at L2', () => {
    expect(deriveDrill(keys({ cat: 'Dining', by: 'detailed' }))).toMatchObject({ level: 2, cat: 'Dining', by: 'detailed' });
    expect(deriveDrill(keys({ by: 'detailed' })).by).toBe('merchant');
    expect(deriveDrill(keys({ cat: 'Dining', merchant: 'KFC', by: 'detailed' })).by).toBe('merchant');
  });
  test('L3 with merchant, cat optional ("all KFC")', () => {
    expect(deriveDrill(keys({ merchant: 'KFC' }))).toMatchObject({ level: 3, baseLevel: 3, cat: null, merchant: 'KFC' });
    expect(deriveDrill(keys({ cat: 'Dining', merchant: 'KFC' }))).toMatchObject({ level: 3, cat: 'Dining' });
  });
  test('L4 with a valid txn id over the base level; junk ids ignored', () => {
    expect(deriveDrill(keys({ cat: 'Dining', merchant: 'KFC', txn: '42' }))).toMatchObject({ level: 4, baseLevel: 3, txn: 42 });
    expect(deriveDrill(keys({ merchant: 'KFC', txn: 'abc' })).level).toBe(3);
    expect(deriveDrill(keys({ merchant: 'KFC', txn: '0' })).level).toBe(3);
  });
  test('reload restores the exact depth (URL round-trip)', () => {
    const s = parseHash('#overview?cat=Dining&merchant=KFC%20%2342&txn=7');
    const d = deriveDrill(s);
    expect(d).toMatchObject({ level: 4, cat: 'Dining', merchant: 'KFC #42', txn: 7 });
    expect(deriveDrill(parseHash(serializeHash(s)))).toEqual(d);
  });
});

describe('navigation targets + history modes', () => {
  test('every drill step / crumb / txn open pushes; by toggle replaces', () => {
    expect(drillNavMode('drill')).toBe('push');
    expect(drillNavMode('up')).toBe('push');
    expect(drillNavMode('crumb')).toBe('push');
    expect(drillNavMode('openTxn')).toBe('push');
    expect(drillNavMode('month')).toBe('push');
    expect(drillNavMode('by')).toBe('replace');
  });

  test('drill into: L1 → cat, L2 → merchant (keeps cat), L2 detailed / L3 not drillable', () => {
    expect(drillIntoPatch(deriveDrill(keys({})), 'Dining')).toEqual(keys({ cat: 'Dining' }));
    expect(drillIntoPatch(deriveDrill(keys({ cat: 'Dining' })), 'KFC')).toEqual(keys({ cat: 'Dining', merchant: 'KFC' }));
    const detailed = deriveDrill(keys({ cat: 'Dining', by: 'detailed' }));
    expect(drillIntoPatch(detailed, 'Fast Food')).toBeNull();
    expect(isDrillable(detailed)).toBe(false);
    expect(drillIntoPatch(deriveDrill(keys({ merchant: 'KFC' })), 'x')).toBeNull();
  });

  test('up one level: L4 closes drawer, L3 drops merchant, L2 drops cat+by, L1 none', () => {
    expect(upPatch(deriveDrill(keys({ cat: 'D', merchant: 'K', txn: '3' })))).toEqual(keys({ cat: 'D', merchant: 'K' }));
    expect(upPatch(deriveDrill(keys({ cat: 'D', merchant: 'K' })))).toEqual(keys({ cat: 'D' }));
    expect(upPatch(deriveDrill(keys({ merchant: 'K' })))).toEqual(keys({}));
    expect(upPatch(deriveDrill(keys({ cat: 'D', by: 'detailed' })))).toEqual(keys({}));
    expect(upPatch(deriveDrill(keys({})))).toBeNull();
  });

  test('openTxn keeps the scope; by patch only touches by', () => {
    const l3 = deriveDrill(keys({ cat: 'D', merchant: 'K' }));
    expect(openTxnPatch(l3, 9)).toEqual(keys({ cat: 'D', merchant: 'K', txn: '9' }));
    expect(byPatch(deriveDrill(keys({ cat: 'D' })), 'detailed')).toEqual(keys({ cat: 'D', by: 'detailed' }));
    expect(byPatch(deriveDrill(keys({ cat: 'D', by: 'detailed' })), 'merchant')).toEqual(keys({ cat: 'D' }));
  });

  test('applyDrill keeps the global keys', () => {
    const s = parseHash('#overview?preset=quarter&account=3&cmp=prev');
    const next = applyDrill(s, keys({ cat: 'Dining' }));
    expect(serializeHash(next)).toBe('#overview?preset=quarter&account=3&cat=Dining&cmp=prev');
  });

  test('tab switch keeps cat, drops by/merchant/txn', () => {
    const s = parseHash('#overview?cat=Dining&merchant=KFC&txn=4&by=detailed');
    expect(serializeHash(withTab(s, 'transactions'))).toBe('#transactions?cat=Dining');
  });
});

describe('breadcrumb', () => {
  test('root → cat → merchant, last is current, each crumb pushes its patch', () => {
    const c = breadcrumbs(deriveDrill(keys({ cat: 'Dining', merchant: 'KFC', txn: '5' })));
    expect(c.map((x) => x.label)).toEqual(['All spending', 'Dining', 'KFC']);
    expect(c.map((x) => x.current)).toEqual([false, false, true]);
    expect(c[0].patch).toEqual(keys({}));
    expect(c[1].patch).toEqual(keys({ cat: 'Dining' }));
    expect(c[2].patch).toEqual(keys({ cat: 'Dining', merchant: 'KFC' }));
  });
  test('merchant without cat skips the cat crumb', () => {
    expect(breadcrumbs(deriveDrill(keys({ merchant: 'KFC' }))).map((x) => x.id)).toEqual(['all', 'merchant']);
  });
  test('long labels truncate with the full text kept', () => {
    const long = 'AMZN Mktp US*2K4AB1234 Seattle WA';
    const [, crumb] = breadcrumbs(deriveDrill(keys({ cat: long })));
    expect(crumb.truncated).toBe(true);
    expect(crumb.label.endsWith('…')).toBe(true);
    expect([...crumb.label].length).toBeLessThanOrEqual(28);
    expect(crumb.full).toBe(long);
    expect(truncateLabel('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('focus after transitions', () => {
  const l1 = deriveDrill(keys({}));
  const l2 = deriveDrill(keys({ cat: 'Dining' }));
  const l3 = deriveDrill(keys({ cat: 'Dining', merchant: 'KFC' }));
  const l4 = deriveDrill(keys({ cat: 'Dining', merchant: 'KFC', txn: '1' }));
  test('drill down → heading', () => {
    expect(focusAfterTransition(l1, l2)).toEqual({ kind: 'heading' });
    expect(focusAfterTransition(l2, l3)).toEqual({ kind: 'heading' });
  });
  test('up → the row for the level left', () => {
    expect(focusAfterTransition(l2, l1)).toEqual({ kind: 'row', key: 'Dining' });
    expect(focusAfterTransition(l3, l2)).toEqual({ kind: 'row', key: 'KFC' });
    expect(focusAfterTransition(l3, l1)).toEqual({ kind: 'row', key: 'Dining' });
  });
  test('merchant-only L3 → L1 has no matching row: heading', () => {
    expect(focusAfterTransition(deriveDrill(keys({ merchant: 'KFC' })), l1)).toEqual({ kind: 'heading' });
  });
  test('drawer open/close leaves focus to the dialog; first render does nothing', () => {
    expect(focusAfterTransition(l3, l4)).toBeNull();
    expect(focusAfterTransition(l4, l3)).toBeNull();
    expect(focusAfterTransition(null, l2)).toBeNull();
  });
});

describe('keyboard', () => {
  test('roving index: Up/Down clamp, Home/End', () => {
    expect(rovingIndex('ArrowDown', 0, 3)).toBe(1);
    expect(rovingIndex('ArrowDown', 2, 3)).toBe(2);
    expect(rovingIndex('ArrowUp', 0, 3)).toBe(0);
    expect(rovingIndex('Home', 2, 3)).toBe(0);
    expect(rovingIndex('End', 0, 3)).toBe(2);
    expect(rovingIndex('a', 0, 3)).toBeNull();
    expect(rovingIndex('ArrowDown', 0, 0)).toBeNull();
  });
  test('up keys and activate keys', () => {
    expect(isUpKey({ key: 'Backspace' })).toBe(true);
    expect(isUpKey({ key: 'ArrowUp', altKey: true })).toBe(true);
    expect(isUpKey({ key: 'ArrowUp' })).toBe(false);
    expect(isActivateKey('Enter')).toBe(true);
    expect(isActivateKey(' ')).toBe(true);
    expect(isActivateKey('Escape')).toBe(false);
  });
});

describe('top-N folding', () => {
  test('top 7 + "N more categories" from server otherTotal/otherCount', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`C${i}`, 100 - i));
    const { visible, more } = foldTopN({ rows, otherTotal: 55, otherCount: 4 }, 7);
    expect(visible).toHaveLength(7);
    expect(more).toEqual({ key: MORE_KEY, label: '4 more categories', groups: 4, total: 55, count: 0 });
  });
  test('extra rows past N fold too', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`C${i}`, 10));
    const { visible, more } = foldTopN({ rows, otherTotal: 5, otherCount: 1 }, 7);
    expect(visible).toHaveLength(7);
    expect(more?.groups).toBe(3);
    expect(more?.total).toBe(25);
  });
  test('nothing folded → no more row', () => {
    expect(foldTopN({ rows: [row('A', 1)], otherTotal: 0, otherCount: 0 }, 7).more).toBeNull();
  });
  test('the label never collides with a real "Other" category', () => {
    const { visible, more } = foldTopN({ rows: [row('Other', 50)], otherTotal: 10, otherCount: 1 }, 7);
    expect(visible[0].key).toBe('Other');
    expect(more!.key).not.toBe('Other');
    expect(more!.label).toBe('1 more category');
    expect(moreLabel(3, 'merchant')).toBe('3 more merchants');
  });
});

describe('neutral-grey rule + donut', () => {
  test('Uncategorized and payment-method labels are neutral', () => {
    for (const l of ['Uncategorized', '', null, 'Debit', 'credit', 'Check', 'VENMO', 'PayPal', 'Deposit']) {
      expect(isNeutralDrillLabel(l)).toBe(true);
    }
    for (const l of ['Dining', 'Groceries', 'Credit Union Fees', 'Debit Card Fees']) expect(isNeutralDrillLabel(l)).toBe(false);
    // The palette's catch-alls are grey in the drill too (one shared list).
    for (const l of ['Other', 'Unclassified']) expect(isNeutralDrillLabel(l)).toBe(true);
  });

  test('slices: palette for visible rows, neutral for more / neutral labels', () => {
    const colorFor = (l: string) => `color:${l}`;
    const slices = donutSlices(
      [row('Dining', 50), row('Venmo', 20), row('Uncategorized', 10), row('Zero', 0)],
      { key: MORE_KEY, label: '3 more categories', groups: 3, total: 30, count: 3 },
      colorFor,
      'grey',
    );
    expect(slices.map((s) => [s.name, s.color])).toEqual([
      ['Dining', 'color:Dining'],
      ['Venmo', 'grey'],
      ['Uncategorized', 'grey'],
      ['3 more categories', 'grey'],
    ]);
  });

  test('>80% uncategorized or a single category replaces the donut', () => {
    expect(
      donutReplacement({ rows: [row('Uncategorized', 90, { count: 12 }), row('Dining', 10)], total: 100, otherCount: 0, otherTotal: 0 }),
    ).toEqual({ kind: 'uncategorized', share: 90, total: 90, count: 12 });
    expect(donutReplacement({ rows: [row('Dining', 10)], total: 10, otherCount: 0, otherTotal: 0 })).toEqual({
      kind: 'single',
      label: 'Dining',
    });
    expect(
      donutReplacement({ rows: [row('Uncategorized', 80), row('Dining', 20)], total: 100, otherCount: 0, otherTotal: 0 }),
    ).toBeNull();
    expect(donutReplacement({ rows: [], total: 0, otherCount: 0, otherTotal: 0 })).toBeNull();
  });

  test('bars share one zero baseline; share labels', () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(0, 200)).toBe(0);
    expect(barPercent(10, 0)).toBe(0);
    expect(shareLabel(25, 100)).toBe('25%');
    expect(shareLabel(0.5, 100)).toBe('<1%');
    expect(shareLabel(5, 0)).toBe('0%');
  });
});

describe('delta formatting', () => {
  test('up = ▲, bad tone, Δ$ always, Δ% when base ≥ $50', () => {
    expect(formatDelta(120, 100)).toMatchObject({
      direction: 'up',
      arrow: '▲',
      dollars: '+$20',
      percent: '+20%',
      text: '▲ +$20 (+20%)',
      tone: 'bad',
    });
  });
  test('down = ▼ good tone; text never relies on color', () => {
    const d = formatDelta(80, 100)!;
    expect(d.text).toBe('▼ -$20 (-20%)');
    expect(d.tone).toBe('good');
    expect(d.srText).toBe('down $20 (20%) vs previous period');
  });
  test('base under $50: Δ$ only', () => {
    expect(formatDelta(60, 49.99)).toMatchObject({ dollars: '+$10', percent: null, text: '▲ +$10' });
    expect(formatDelta(60, 50)!.percent).toBe('+20%');
  });
  test('$0 base still shows Δ$; null base (no coverage) shows nothing', () => {
    expect(formatDelta(30, 0)).toMatchObject({ dollars: '+$30', percent: null });
    expect(formatDelta(30, null)).toBeNull();
    expect(formatDelta(30, undefined)).toBeNull();
  });
  test('flat', () => {
    expect(formatDelta(100.2, 100)).toMatchObject({ direction: 'flat', arrow: '–', dollars: '$0', percent: null, tone: 'neutral' });
    expect(formatDelta(100, 100, 'yoy')!.srText).toBe('no change vs same period last year');
  });
});

describe('links + month patches', () => {
  test('See all → #transactions keeping the range, with cat', () => {
    const s = parseHash('#overview?preset=custom&start=2026-01-01&end=2026-03-31&entity=2&cat=Dining&by=detailed');
    expect(transactionsHash(s, { cat: 'Dining' })).toBe(
      '#transactions?preset=custom&start=2026-01-01&end=2026-03-31&entity=2&cat=Dining',
    );
  });
  test('explicit merchant/txn survive into the transactions link', () => {
    const s = parseHash('#overview?cat=Dining&merchant=KFC');
    expect(transactionsHash(s, { cat: 'Dining', merchant: 'KFC', txn: 9 })).toBe(
      '#transactions?cat=Dining&merchant=KFC&txn=9',
    );
  });
  test('Uncategorized CTA goes to transactions, not review', () => {
    expect(transactionsHash(defaultUrlState(), { cat: 'Uncategorized' })).toBe('#transactions?cat=Uncategorized');
  });
  test('month bar → custom calendar month', () => {
    expect(monthRangePatch('2024-02')).toEqual({ preset: 'custom', start: '2024-02-01', end: '2024-02-29' });
    expect(monthRangePatch('2026-12')).toEqual({ preset: 'custom', start: '2026-12-01', end: '2026-12-31' });
  });
  test('series window: trailing 12 months ending at coverage end, else today', () => {
    expect(seriesWindow('2026-03-14', '2026-10-03')).toEqual({
      startDate: '2025-04-01',
      endDate: '2026-03-31',
      startMonth: '2025-04',
      endMonth: '2026-03',
    });
    expect(seriesWindow(null, '2026-01-15').startMonth).toBe('2025-02');
    expect(lastTwelveMonthsPatch('2026-03-14', '2026-10-03')).toEqual({
      preset: 'custom',
      start: '2025-04-01',
      end: '2026-03-31',
    });
  });
});

describe('series bars', () => {
  test('nulls are no-data, zeros are covered; average skips nulls; band marks the range', () => {
    const { bars, average, max } = buildSeriesBars(
      { periods: ['2026-01', '2026-02', '2026-03', '2026-04'], values: [null, 0, 300, 150] },
      { startDate: '2026-03-01', endDate: '2026-04-15' },
    );
    expect(bars.map((b) => b.noData)).toEqual([true, false, false, false]);
    expect(bars.map((b) => b.inRange)).toEqual([false, false, true, true]);
    expect(bars[0].label).toBe('Jan');
    expect(average).toBe(150);
    expect(max).toBe(300);
  });
  test('all-null series: no average', () => {
    expect(buildSeriesBars({ periods: ['2026-01'], values: [null] }, { startDate: '2026-01-01', endDate: '2026-01-31' }).average).toBeNull();
    expect(buildSeriesBars(null, { startDate: 'x', endDate: 'y' }).bars).toEqual([]);
  });
});

describe('expansion paging', () => {
  test('pages of 100 up to the 200-row cap', () => {
    expect(nextExpandPage(0, 340)).toEqual({ offset: 0, limit: 100 });
    expect(nextExpandPage(100, 340)).toEqual({ offset: 100, limit: 100 });
    expect(nextExpandPage(200, 340)).toBeNull();
    expect(nextExpandPage(0, 30)).toEqual({ offset: 0, limit: 30 });
    expect(nextExpandPage(30, 30)).toBeNull();
    expect(expandCapped(200, 340)).toBe(true);
    expect(expandCapped(30, 30)).toBe(false);
  });
  test('mergeRows dedupes by key', () => {
    expect(mergeRows([row('A', 1), row('B', 1)], [row('B', 1), row('C', 1)]).map((r) => r.key)).toEqual(['A', 'B', 'C']);
  });
});

describe('copy', () => {
  test('empty range + excluded footnote', () => {
    expect(emptyRangeMessage('March 2026', '2026-02-28')).toBe('No spending in March 2026 — data through Feb 28, 2026');
    expect(emptyRangeMessage('March 2026', null)).toBe('No spending in March 2026');
    expect(excludedFootnote(1234.4)).toBe('Excludes $1,234 in transfers & card payments');
    expect(excludedFootnote(0)).toBeNull();
  });
});

describe('spending client paths', () => {
  test('breakdown carries scope, grouping, paging and compare window', () => {
    expect(
      breakdownPath({
        startDate: '2026-03-01',
        endDate: '2026-03-31',
        accountId: 2,
        entityId: null,
        cat: 'Food & Drink',
        by: 'merchant',
        limit: 12,
        offset: 0,
        compareStart: '2026-02-01',
        compareEnd: '2026-02-28',
      }),
    ).toBe(
      '/api/spending/breakdown?startDate=2026-03-01&endDate=2026-03-31&accountId=2&cat=Food%20%26%20Drink&by=merchant&limit=12&compareStart=2026-02-01&compareEnd=2026-02-28',
    );
    expect(breakdownPath({ startDate: 'a', endDate: 'b', merchant: 'KFC #1', offset: 100, compareStart: 'x' })).toBe(
      '/api/spending/breakdown?startDate=a&endDate=b&merchant=KFC%20%231&offset=100',
    );
  });
  test('series path', () => {
    expect(seriesPath({ startDate: '2025-04-01', endDate: '2026-03-31', cat: 'Dining', entityId: 1 })).toBe(
      '/api/spending/series?startDate=2025-04-01&endDate=2026-03-31&entityId=1&cat=Dining&interval=month',
    );
  });
  test('L3 table uses merchantExact (never the fuzzy merchant param), spendOnly, SQL paging', () => {
    const p = merchantTransactionsPath({ startDate: 'a', endDate: 'b', merchant: 'KFC', cat: 'Dining', page: 2 });
    expect(p).toBe('/api/transactions?startDate=a&endDate=b&merchantExact=KFC&spendOnly=1&limit=50&offset=100&category=Dining');
    expect(new URLSearchParams(p.split('?')[1]).has('merchant')).toBe(false);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(101)).toBe(3);
  });
});

describe('drillCompareWindow (adapter over db/compare-window)', () => {
  const cw = (preset: UrlState['preset'], start: string | null, end: string | null, today: string, cmp: 'prev' | 'yoy' | null) =>
    drillCompareWindow({ preset, start, end, today, cmp });

  test('no cmp → null', () => {
    expect(cw('month', null, null, '2026-03-10', null)).toBeNull();
  });
  test('partial current month vs the same elapsed days of last month', () => {
    expect(cw('month', null, null, '2026-03-10', 'prev')).toMatchObject({ compareStart: '2026-02-01', compareEnd: '2026-02-10' });
  });
  test('elapsed days clamp to the comparison period end', () => {
    expect(cw('month', null, null, '2026-03-30', 'prev')).toMatchObject({ compareStart: '2026-02-01', compareEnd: '2026-02-28' });
  });
  test('full past month vs full previous month', () => {
    expect(cw('month', '2026-01-01', null, '2026-03-10', 'prev')).toMatchObject({ compareStart: '2025-12-01', compareEnd: '2025-12-31' });
  });
  test('yoy, partial and full; Feb 29 clamps', () => {
    expect(cw('month', null, null, '2026-03-10', 'yoy')).toMatchObject({ compareStart: '2025-03-01', compareEnd: '2025-03-10' });
    expect(cw('month', '2024-02-01', null, '2026-03-10', 'yoy')).toMatchObject({ compareStart: '2023-02-01', compareEnd: '2023-02-28' });
  });
  test('quarter / year / ytd / prev-year', () => {
    expect(cw('quarter', null, null, '2026-05-15', 'prev')).toMatchObject({ compareStart: '2026-01-01', compareEnd: '2026-02-14' });
    expect(cw('year', '2025-01-01', null, '2026-05-15', 'prev')).toMatchObject({ compareStart: '2024-01-01', compareEnd: '2024-12-31' });
    expect(cw('ytd', null, null, '2026-02-10', 'prev')).toMatchObject({ compareStart: '2025-01-01', compareEnd: '2025-02-10' });
    expect(cw('prev-year', null, null, '2026-02-10', 'yoy')).toMatchObject({ compareStart: '2024-01-01', compareEnd: '2024-12-31' });
  });
  test('custom: the equally long window just before it', () => {
    expect(cw('custom', '2026-01-11', '2026-01-20', '2026-03-10', 'prev')).toMatchObject({
      compareStart: '2026-01-01',
      compareEnd: '2026-01-10',
    });
    // partial custom (not month-aligned): elapsed days of the equally long window before it
    expect(cw('custom', '2026-03-10', '2026-04-08', '2026-03-14', 'prev')).toMatchObject({
      compareStart: '2026-02-08',
      compareEnd: '2026-02-12',
    });
    // a custom range of whole months compares like the month preset (Feb 1–5)
    expect(cw('custom', '2026-03-01', '2026-03-31', '2026-03-05', 'prev')).toMatchObject({
      compareStart: '2026-02-01',
      compareEnd: '2026-02-05',
    });
  });
  test('period entirely in the future → null', () => {
    expect(cw('month', '2026-05-01', null, '2026-03-10', 'prev')).toBeNull();
  });
});
