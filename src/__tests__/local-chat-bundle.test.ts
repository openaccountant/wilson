import { describe, expect, test } from 'bun:test';
import {
  projectTransactions,
  buildBundle,
  isoDaysAgo,
  BUNDLE_START_MARKER,
  BUNDLE_END_MARKER,
  type BundleTxn,
} from '../dashboard/ui/src/hybrid/core.js';
import { CURRENT_MESSAGE_MARKER } from '../utils/history-context.js';
import { daysAgo } from './helpers.js';

/**
 * The pre-fetched context bundle: narrow field projection (date, description,
 * amount, category only), a bounded recent-transactions window, the size guard
 * for a 0.6B-class context window, and framing in the repo's injected-context
 * marker style. Pure logic — no DOM, no fetch.
 */

function row(date: string, amount = -10, description = 'TXN', category: string | null = 'Groceries') {
  return { date, description, amount, category, merchant_name: 'SHOULD-NOT-LEAK', id: 999, pending: false };
}

describe('projectTransactions', () => {
  test('keeps only date | description | amount | category (no extra fields leak)', () => {
    const out = projectTransactions([row(daysAgo(1))], { days: 30, limit: 10 });
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]).sort()).toEqual(['amount', 'category', 'date', 'description']);
  });

  test('keeps only rows inside the last N days (window bound)', () => {
    const inWindow = row(daysAgo(29));
    const tooOld = row(daysAgo(31));
    const out = projectTransactions([tooOld, inWindow], { days: 30, limit: 100 });
    expect(out.map((r) => r.date)).toEqual([daysAgo(29)]);
  });

  test('cutoff day itself is included (inclusive window)', () => {
    const out = projectTransactions([row(daysAgo(30))], { days: 30, limit: 100 });
    expect(out).toHaveLength(1);
  });

  test('caps at limit, keeping the most recent rows', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(daysAgo(10 - i)));
    // Input is newest-first (API contract: ORDER BY date DESC)
    const out = projectTransactions(rows, { days: 30, limit: 3 });
    expect(out).toHaveLength(3);
    // Kept the 3 most recent, returned oldest-first (chronological)
    expect(out.map((r) => r.date)).toEqual([daysAgo(8), daysAgo(9), daysAgo(10)]);
  });

  test('returns chronological (oldest-first) order for the size guard', () => {
    const rows = [row(daysAgo(1)), row(daysAgo(2)), row(daysAgo(3))];
    const out = projectTransactions(rows, { days: 30, limit: 10 });
    expect(out.map((r) => r.date)).toEqual([daysAgo(3), daysAgo(2), daysAgo(1)]);
  });

  test('null category is preserved as null', () => {
    const out = projectTransactions([row(daysAgo(1), -5, 'TXN', null)], { days: 30, limit: 10 });
    expect(out[0].category).toBeNull();
  });
});

describe('isoDaysAgo', () => {
  test('matches the repo test helper date math', () => {
    expect(isoDaysAgo(7)).toBe(daysAgo(7));
    expect(isoDaysAgo(0)).toBe(daysAgo(0));
  });
});

describe('buildBundle framing', () => {
  const weekly = {
    thisWeek: { total: 123.45, topCategory: 'Groceries' },
    lastWeek: { total: 98.76, topCategory: 'Dining' },
    change: { amount: 24.69, percent: 25 },
  };

  test('uses the repo marker style and reuses CURRENT_MESSAGE_MARKER verbatim', () => {
    const bundle = buildBundle([row(daysAgo(1))], weekly, { days: 30, limit: 200, maxChars: 6000 });
    expect(bundle.text).toContain(BUNDLE_START_MARKER);
    expect(bundle.text).toContain(BUNDLE_END_MARKER);
    expect(bundle.text.split('\n')).toContain(CURRENT_MESSAGE_MARKER);
  });

  test('renders period, counts, weekly summary, and projected rows', () => {
    const txns = projectTransactions(
      [row(daysAgo(2), -54.21, 'SAFEWAY #1234', 'Groceries'), row(daysAgo(1), -12, 'COFFEE BAR', 'Dining')],
      { days: 30, limit: 200 },
    );
    const bundle = buildBundle(txns, weekly, { days: 30, limit: 200, maxChars: 6000 });

    expect(bundle.text).toContain(`Period: ${isoDaysAgo(30)}..${isoDaysAgo(0)} (last 30 days, 2 of 2 transactions shown)`);
    expect(bundle.text).toContain('Weekly spending: this week $123.45 (top: Groceries), last week $98.76 (top: Dining), change $24.69 (+25%)');
    expect(bundle.text).toContain(`Transactions (date | description | amount | category):`);
    expect(bundle.text).toContain(`${daysAgo(2)} | SAFEWAY #1234 | -54.21 | Groceries`);
    expect(bundle.text).toContain(`${daysAgo(1)} | COFFEE BAR | -12.00 | Dining`);
    expect(bundle.rowCount).toBe(2);
    expect(bundle.totalRows).toBe(2);
    expect(bundle.truncated).toBe(false);
  });

  test('negative weekly change renders with a minus sign', () => {
    const down = {
      thisWeek: { total: 50, topCategory: null },
      lastWeek: { total: 100, topCategory: null },
      change: { amount: -50, percent: -50 },
    };
    const bundle = buildBundle([], down, { days: 30, limit: 200, maxChars: 6000 });
    expect(bundle.text).toContain('change -$50.00 (-50%)');
    expect(bundle.text).toContain('(top: none)');
  });

  test('weekly summary is optional', () => {
    const bundle = buildBundle([row(daysAgo(1))], null, { days: 30, limit: 200, maxChars: 6000 });
    expect(bundle.text).not.toContain('Weekly spending');
    expect(bundle.text).toContain(BUNDLE_START_MARKER);
  });
});

describe('buildBundle size guard (0.6B context window)', () => {
  test('drops the OLDEST rows first, keeps markers and weekly summary, never exceeds maxChars', () => {
    // 200 rows × ~60 chars each ≈ 12k chars vs a 2500-char budget.
    const txns: BundleTxn[] = Array.from({ length: 200 }, (_, i) => ({
      date: daysAgo(200 - i), // oldest first (chronological), as projectTransactions returns
      description: `TXN ${i}`,
      amount: -10,
      category: 'Groceries',
    }));
    const weekly = {
      thisWeek: { total: 5, topCategory: 'Groceries' },
      lastWeek: { total: 6, topCategory: 'Dining' },
      change: { amount: -1, percent: -17 },
    };
    const bundle = buildBundle(txns, weekly, { days: 400, limit: 200, maxChars: 2500 });

    expect(bundle.truncated).toBe(true);
    expect(bundle.text.length).toBeLessThanOrEqual(2500);
    expect(bundle.rowCount).toBeLessThan(200);
    expect(bundle.totalRows).toBe(200);

    const lines = bundle.text.split('\n');
    expect(lines[0]).toBe(BUNDLE_START_MARKER);
    expect(lines).toContain(CURRENT_MESSAGE_MARKER);
    expect(lines.at(-1)).toBe(CURRENT_MESSAGE_MARKER);
    expect(bundle.text).toContain('Weekly spending:');
    expect(bundle.text).toContain('Weekly spending: this week $5.00 (top: Groceries)');
    expect(bundle.text).toContain('[Older transactions were dropped to fit the local context window.]');

    // Oldest dropped first: the kept rows are the most recent ones.
    const keptDates = lines.filter((l) => l.startsWith('2')).map((l) => l.slice(0, 10));
    expect(keptDates.length).toBe(bundle.rowCount);
    expect(new Date(keptDates[0]!).getTime()).toBeGreaterThan(new Date(daysAgo(200 - 5)).getTime());
  });

  test('within budget nothing is dropped and no truncation note appears', () => {
    const txns: BundleTxn[] = Array.from({ length: 5 }, (_, i) => ({
      date: daysAgo(5 - i),
      description: `TXN ${i}`,
      amount: -10,
      category: null,
    }));
    const bundle = buildBundle(txns, null, { days: 30, limit: 200, maxChars: 6000 });
    expect(bundle.truncated).toBe(false);
    expect(bundle.rowCount).toBe(5);
    expect(bundle.text).not.toContain('were dropped');
  });

  test('hard cap holds even when the framing alone exceeds maxChars', () => {
    const bundle = buildBundle([], null, { days: 30, limit: 200, maxChars: 40 });
    expect(bundle.text.length).toBeLessThanOrEqual(40);
  });
});