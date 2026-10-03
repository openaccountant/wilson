import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  defaultUrlState,
  parseHash,
  pruneUnknownIds,
  serializeHash,
  stripProfileScoped,
  withTab,
  type UrlState,
} from '../dashboard/ui/src/lib/urlState.js';
import {
  customRangePatch,
  presetPatch,
  rangeLabel,
  resolveDateRange,
  stepPatch,
} from '../dashboard/ui/src/lib/dateRange.js';
import {
  dropUnknownProfileIds,
  navigateToTab,
  navigateUrl,
  readUrlState,
  reloadForProfileSwitch,
  subscribeUrl,
} from '../dashboard/ui/src/lib/urlHistory.js';

const roundTrip = (s: UrlState) => parseHash(serializeHash(s));
const state = (patch: Partial<UrlState>): UrlState => ({ ...defaultUrlState(), ...patch });

describe('parseHash / serializeHash', () => {
  test('empty and default states serialize to the bare tab', () => {
    expect(serializeHash(parseHash(''))).toBe('#overview');
    expect(serializeHash(parseHash('#'))).toBe('#overview');
    expect(serializeHash(state({ tab: 'goals' }))).toBe('#goals');
  });

  test('legacy bare-tab links (incl. #settings and the old #/tab form) still work', () => {
    expect(parseHash('#settings')).toEqual(defaultUrlState('settings'));
    expect(parseHash('settings').tab).toBe('settings');
    expect(parseHash('#/transactions').tab).toBe('transactions');
    expect(parseHash('#Forecast').tab).toBe('forecast');
  });

  test('unknown tab falls back to overview but keeps its params', () => {
    const s = parseHash('#nope?account=3');
    expect(s.tab).toBe('overview');
    expect(s.account).toBe(3);
  });

  test('canonical key order, defaults omitted', () => {
    const s = state({
      tab: 'transactions',
      cmp: 'yoy',
      day: '2026-03-04',
      cat: 'Food',
      entity: 2,
      account: 7,
      preset: 'custom',
      start: '2026-03-01',
      end: '2026-03-31',
    });
    expect(serializeHash(s)).toBe(
      '#transactions?preset=custom&start=2026-03-01&end=2026-03-31&account=7&entity=2&cat=Food&day=2026-03-04&cmp=yoy',
    );
    // Input order doesn't matter.
    expect(
      serializeHash(parseHash('#transactions?cmp=yoy&cat=Food&end=2026-03-31&preset=custom&day=2026-03-04&entity=2&start=2026-03-01&account=7')),
    ).toBe(serializeHash(s));
    expect(serializeHash(state({ preset: 'month' }))).toBe('#overview');
  });

  test('round-trips every key', () => {
    const s = state({
      tab: 'overview',
      preset: 'quarter',
      start: '2025-04-01',
      account: 12,
      entity: 0,
      cat: 'Rent',
      day: '2025-05-02',
      cmp: 'prev',
      by: 'merchant',
      merchant: 'Blue Bottle',
      txn: '991',
      q: 'coffee',
    });
    expect(roundTrip(s)).toEqual(s);
  });

  test("encodes '&', '=', '#', '?', '%', '+' and unicode in values", () => {
    for (const cat of ['Food & Dining', 'a=b', 'C#', 'what?', '100%', 'a+b', 'Café ☕', '日本', ' spaced ']) {
      const s = state({ cat });
      const hash = serializeHash(s);
      expect(hash.slice(1)).not.toContain('#');
      expect(hash.split('&').length).toBe(1);
      expect(roundTrip(s).cat).toBe(cat);
    }
    expect(serializeHash(state({ cat: 'Food & Dining' }))).toBe('#overview?cat=Food%20%26%20Dining');
  });

  test('swaps a reversed custom range', () => {
    const s = parseHash('#overview?preset=custom&start=2026-05-31&end=2026-05-01');
    expect([s.start, s.end]).toEqual(['2026-05-01', '2026-05-31']);
    expect(serializeHash(s)).toBe('#overview?preset=custom&start=2026-05-01&end=2026-05-31');
  });

  test('custom with one end is a single-day range; with neither it is the current month', () => {
    const one = parseHash('#overview?preset=custom&end=2026-05-09');
    expect([one.preset, one.start, one.end]).toEqual(['custom', '2026-05-09', '2026-05-09']);
    expect(parseHash('#overview?preset=custom').preset).toBe('month');
  });

  test('end is dropped for non-custom presets; start is dropped for ytd / prev-year', () => {
    expect(serializeHash(parseHash('#overview?preset=month&start=2026-02-01&end=2026-02-28'))).toBe(
      '#overview?start=2026-02-01',
    );
    expect(serializeHash(parseHash('#overview?preset=ytd&start=2024-01-01'))).toBe('#overview?preset=ytd');
    expect(serializeHash(parseHash('#overview?preset=prev-year&start=2024-01-01'))).toBe('#overview?preset=prev-year');
  });

  test('invalid values fall back to defaults instead of breaking the link', () => {
    const s = parseHash('#overview?preset=decade&start=2026-02-30&account=abc&entity=-1&day=yesterday&cmp=mom&cat=');
    expect(s).toEqual(defaultUrlState());
    // A malformed escape doesn't throw.
    expect(parseHash('#overview?cat=100%').cat).toBe('100%');
  });

  test('first occurrence of a known key wins', () => {
    expect(parseHash('#overview?account=1&account=2').account).toBe(1);
  });

  test('unknown keys are preserved, after known keys, in first-seen order', () => {
    const s = parseHash('#overview?zeta=1&account=4&alpha=two%20words&flag');
    expect(s.extra).toEqual([
      ['zeta', '1'],
      ['alpha', 'two words'],
      ['flag', ''],
    ]);
    expect(serializeHash(s)).toBe('#overview?account=4&zeta=1&alpha=two%20words&flag');
  });

  test('reserved Batch 2 keys parse and survive a round trip', () => {
    const s = parseHash('#transactions?by=category&merchant=Trader%20Joe%27s&txn=42&q=a%26b');
    expect([s.by, s.merchant, s.txn, s.q]).toEqual(['category', "Trader Joe's", '42', 'a&b']);
    expect(roundTrip(s)).toEqual(s);
  });

  test('serialization is idempotent (canonical form is a fixed point)', () => {
    const hashes = [
      '#overview?cat=Food%20%26%20Dining&account=3',
      '#/settings',
      '#overview?preset=custom&start=2026-05-31&end=2026-05-01&x=1',
      '#llm?q=%E2%98%95',
    ];
    for (const h of hashes) {
      const once = serializeHash(parseHash(h));
      expect(serializeHash(parseHash(once))).toBe(once);
    }
  });
});

describe('withTab / stripProfileScoped', () => {
  test('tab switch keeps global keys and unknown keys, drops tab-scoped ones', () => {
    const s = parseHash('#overview?preset=year&start=2024-01-01&account=3&entity=1&cat=Food&day=2024-02-02&cmp=yoy&txn=9&keep=me');
    expect(serializeHash(withTab(s, 'transactions'))).toBe(
      '#transactions?preset=year&start=2024-01-01&account=3&entity=1&cat=Food&cmp=yoy&keep=me',
    );
    expect(withTab(s, 'bogus').tab).toBe('overview');
  });

  test('profile switch strips account, entity, cat and day only', () => {
    const s = parseHash('#overview?preset=quarter&start=2025-01-01&account=3&entity=1&cat=Food&day=2025-02-02&cmp=prev');
    expect(serializeHash(stripProfileScoped(s))).toBe('#overview?preset=quarter&start=2025-01-01&cmp=prev');
  });
});

describe('date range derivation', () => {
  const now = new Date(2026, 9, 2); // 2026-10-02, local

  test('defaults resolve to the live current period', () => {
    expect(resolveDateRange({ preset: 'month', start: null, end: null }, now)).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });
    expect(resolveDateRange({ preset: 'quarter', start: null, end: null }, now)).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-12-31',
    });
    expect(resolveDateRange({ preset: 'ytd', start: null, end: null }, now)).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-10-02',
    });
    expect(resolveDateRange({ preset: 'year', start: null, end: null }, now).startDate).toBe('2026-01-01');
    expect(resolveDateRange({ preset: 'prev-year', start: null, end: null }, now)).toEqual({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
  });

  test('a bookmarked "this month" stays live (no start written)', () => {
    expect(presetPatch('month')).toEqual({ preset: 'month', start: null, end: null });
    expect(serializeHash(state(presetPatch('month')))).toBe('#overview');
    const nextMonth = new Date(2026, 10, 15);
    expect(resolveDateRange(parseHash('#overview'), nextMonth).startDate).toBe('2026-11-01');
  });

  test('anchored periods resolve from start (any day inside the period)', () => {
    expect(resolveDateRange({ preset: 'month', start: '2024-02-15', end: null }, now)).toEqual({
      startDate: '2024-02-01',
      endDate: '2024-02-29',
    });
    expect(resolveDateRange({ preset: 'quarter', start: '2025-05-10', end: null }, now)).toEqual({
      startDate: '2025-04-01',
      endDate: '2025-06-30',
    });
    expect(resolveDateRange({ preset: 'year', start: '2023-01-01', end: null }, now).endDate).toBe('2023-12-31');
  });

  test('stepping: month and quarter, omitting start when back on the current period', () => {
    const prev = stepPatch({ preset: 'month', start: null, end: null }, -1, now);
    expect(prev).toEqual({ preset: 'month', start: '2026-09-01', end: null });
    expect(stepPatch(prev, 1, now)).toEqual({ preset: 'month', start: null, end: null });
    // Month-end rollover: stepping from Jan 31 lands in February, not March.
    expect(stepPatch({ preset: 'month', start: '2026-01-31', end: null }, 1, now).start).toBe('2026-02-01');
    expect(stepPatch({ preset: 'quarter', start: null, end: null }, -1, now)).toEqual({
      preset: 'quarter',
      start: '2026-07-01',
      end: null,
    });
  });

  test('stepping year-like presets becomes year; custom becomes month', () => {
    expect(stepPatch({ preset: 'ytd', start: null, end: null }, -1, now)).toEqual({
      preset: 'year',
      start: '2025-01-01',
      end: null,
    });
    expect(stepPatch({ preset: 'prev-year', start: null, end: null }, 1, now)).toEqual({
      preset: 'year',
      start: null,
      end: null,
    });
    expect(stepPatch({ preset: 'custom', start: '2026-03-10', end: '2026-06-20' }, 1, now)).toEqual({
      preset: 'month',
      start: '2026-04-01',
      end: null,
    });
  });

  test('any explicit range sets preset=custom (stale pill fix)', () => {
    expect(customRangePatch({ startDate: '2025-01-05', endDate: '2025-03-09' })).toEqual({
      preset: 'custom',
      start: '2025-01-05',
      end: '2025-03-09',
    });
    expect(customRangePatch({ startDate: '2025-03-09', endDate: '2025-01-05' })).toEqual({
      preset: 'custom',
      start: '2025-01-05',
      end: '2025-03-09',
    });
    // e.g. an import while "YTD" was selected: the pill must not stay on YTD.
    const afterImport = { ...state({ preset: 'ytd' }), ...customRangePatch({ startDate: '2024-06-01', endDate: '2024-08-31' }) };
    expect(parseHash(serializeHash(afterImport)).preset).toBe('custom');
  });

  test('labels', () => {
    expect(rangeLabel('month', { startDate: '2026-03-01', endDate: '2026-03-31' })).toBe('March 2026');
    expect(rangeLabel('quarter', { startDate: '2026-04-01', endDate: '2026-06-30' })).toBe('Q2 2026');
    expect(rangeLabel('ytd', { startDate: '2026-01-01', endDate: '2026-10-02' })).toBe('YTD 2026');
    expect(rangeLabel('year', { startDate: '2025-01-01', endDate: '2025-12-31' })).toBe('2025');
    expect(rangeLabel('custom', { startDate: '2025-01-05', endDate: '2025-03-09' })).toBe('Jan 2025 – Mar 2025');
    expect(rangeLabel('custom', { startDate: '2025-03-01', endDate: '2025-03-31' })).toBe('March 2025');
    expect(rangeLabel('custom', { startDate: '2025-03-05', endDate: '2025-03-09' })).toBe('Mar 5 – Mar 9, 2025');
  });
});

// ── History side, against a minimal fake window ──────────────────────────
class FakeWindow extends EventTarget {
  entries: string[];
  index = 0;
  reloads = 0;
  constructor(initialHash: string) {
    super();
    this.entries = [initialHash];
  }
  get location() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      pathname: '/',
      search: '',
      get hash() {
        return self.entries[self.index];
      },
      reload() {
        self.reloads++;
      },
    };
  }
  get history() {
    return {
      state: null,
      pushState: (_s: unknown, _t: string, url: string) => {
        this.entries = this.entries.slice(0, this.index + 1);
        this.entries.push(url.slice(url.indexOf('#') === -1 ? url.length : url.indexOf('#')));
        this.index++;
      },
      replaceState: (_s: unknown, _t: string, url: string) => {
        this.entries[this.index] = url.slice(url.indexOf('#') === -1 ? url.length : url.indexOf('#'));
      },
    };
  }
  back() {
    this.index--;
    this.dispatchEvent(new Event('popstate'));
  }
}

describe('urlHistory', () => {
  let win: FakeWindow;
  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;

  beforeEach(() => {
    saved = g.window;
    win = new FakeWindow('#overview?account=3');
    g.window = win;
  });
  afterEach(() => {
    g.window = saved;
  });

  test('tab switch pushes and keeps global keys; Back restores', () => {
    let notified = 0;
    const unsub = subscribeUrl(() => notified++);
    navigateToTab('transactions');
    expect(win.entries).toEqual(['#overview?account=3', '#transactions?account=3']);
    expect(notified).toBe(1);
    win.back();
    expect(readUrlState().tab).toBe('overview');
    expect(notified).toBe(2);
    unsub();
    navigateToTab('goals');
    expect(notified).toBe(2);
  });

  test('filter tweaks replace (no new history entry)', () => {
    navigateUrl((s) => ({ ...s, cat: 'Food & Dining' }), { mode: 'replace' });
    navigateUrl((s) => ({ ...s, entity: 2 }), { mode: 'replace' });
    expect(win.entries).toEqual(['#overview?account=3&entity=2&cat=Food%20%26%20Dining']);
  });

  test('updaters read the live URL, so back-to-back calls compose', () => {
    navigateUrl((s) => ({ ...s, account: 9 }), { mode: 'replace' });
    navigateUrl((s) => ({ ...s, cat: 'Rent' }), { mode: 'replace' });
    expect(readUrlState().account).toBe(9);
    expect(readUrlState().cat).toBe('Rent');
  });

  test('no-op navigations write nothing (double effects are harmless)', () => {
    let notified = 0;
    subscribeUrl(() => notified++);
    navigateToTab('overview');
    navigateToTab('overview');
    expect(win.entries).toEqual(['#overview?account=3']);
    expect(notified).toBe(0);
  });

  test('a push that only canonicalizes the current entry is a replace', () => {
    win.entries = ['#/overview?account=3'];
    navigateToTab('overview');
    expect(win.entries).toEqual(['#overview?account=3']);
  });

  test('profile switch strips profile-scoped keys with replaceState, then reloads', () => {
    win.entries = ['#overview?preset=year&account=3&entity=1&cat=Food&day=2026-01-02'];
    reloadForProfileSwitch();
    expect(win.entries).toEqual(['#overview?preset=year']);
    expect(win.reloads).toBe(1);
  });

  test('Back after a profile switch: an earlier entry\'s foreign ids are dropped in place (M2)', () => {
    // Profile A: two pushed entries carrying A's ids.
    win.entries = ['#overview?account=3&entity=1'];
    navigateToTab('transactions');
    navigateUrl((s) => ({ ...s, entity: 7 }), { mode: 'replace' });
    expect(win.entries).toEqual(['#overview?account=3&entity=1', '#transactions?account=3&entity=7']);
    // Switch to profile B: only the CURRENT entry is stripped.
    reloadForProfileSwitch();
    expect(win.entries).toEqual(['#overview?account=3&entity=1', '#transactions']);
    // Back lands on A's ids; B has accounts [10, 11] and entities [1, 2].
    win.back();
    expect(readUrlState().account).toBe(3);
    dropUnknownProfileIds({ accounts: [10, 11], entities: [1, 2] });
    expect(win.entries).toEqual(['#overview?entity=1', '#transactions']); // entity 1 exists in B → kept
    expect(win.index).toBe(0); // replaced, not pushed
  });

  test('dropUnknownProfileIds is a no-op when ids are known or lists are not loaded', () => {
    win.entries = ['#overview?account=3&entity=1'];
    let notified = 0;
    subscribeUrl(() => notified++);
    dropUnknownProfileIds({ accounts: [3], entities: [1] });
    dropUnknownProfileIds({ accounts: null, entities: null }); // still loading / fetch failed
    expect(win.entries).toEqual(['#overview?account=3&entity=1']);
    expect(notified).toBe(0);
  });

  test('profile switch with no hash just reloads', () => {
    win.entries = [''];
    reloadForProfileSwitch();
    expect(win.entries).toEqual(['']);
    expect(win.reloads).toBe(1);
  });
});

describe('pruneUnknownIds', () => {
  test('drops only unknown ids; null lists never prune; unchanged returns the same object', () => {
    const s = state({ account: 3, entity: 9, cat: 'Food' });
    expect(pruneUnknownIds(s, { accounts: [3], entities: [9] })).toBe(s);
    expect(pruneUnknownIds(s, { accounts: null, entities: null })).toBe(s);
    const pruned = pruneUnknownIds(s, { accounts: [], entities: [1] });
    expect(pruned.account).toBeNull();
    expect(pruned.entity).toBeNull();
    expect(pruned.cat).toBe('Food');
    expect(pruneUnknownIds(s, { accounts: [1], entities: null }).entity).toBe(9);
  });
});
