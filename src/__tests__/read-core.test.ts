import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPeriodDatesAt, parseNaturalQueryAt, formatSearchResults, READ_CORE_CATEGORY_FALLBACK } from '../tools/read-core/index.js';
import { getPeriodDates } from '../tools/query/spending-summary.js';
import { CATEGORIES } from '../tools/categorize/categories.js';

const CATS = ['Dining', 'Groceries', 'Transport', 'Fees & Interest', 'Income'];

describe('getPeriodDatesAt', () => {
  const now = new Date('2026-07-15T12:00:00');

  test.each([
    ['month', 0, { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' }],
    ['month', -1, { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' }],
    ['month', -4, { start: '2026-03-01', end: '2026-03-31', label: 'March 2026' }],
    ['month', -7, { start: '2025-12-01', end: '2025-12-31', label: 'December 2025' }],
    ['quarter', 0, { start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026' }],
    ['quarter', -1, { start: '2026-04-01', end: '2026-06-30', label: 'Q2 2026' }],
    ['quarter', -3, { start: '2025-10-01', end: '2025-12-31', label: 'Q4 2025' }],
    ['year', 0, { start: '2026-01-01', end: '2026-12-31', label: '2026' }],
    ['year', -1, { start: '2025-01-01', end: '2025-12-31', label: '2025' }],
  ] as const)('%s offset %i', (period, offset, expected) => {
    expect(getPeriodDatesAt(period, offset, now)).toEqual(expected);
  });

  test('year boundary: previous quarter and month from February', () => {
    const feb = new Date('2026-02-10T09:00:00');
    expect(getPeriodDatesAt('quarter', -1, feb)).toEqual({ start: '2025-10-01', end: '2025-12-31', label: 'Q4 2025' });
    expect(getPeriodDatesAt('month', -2, feb)).toEqual({ start: '2025-12-01', end: '2025-12-31', label: 'December 2025' });
    expect(getPeriodDatesAt('quarter', 3, feb)).toEqual({ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
  });

  test('leap-year February end', () => {
    expect(getPeriodDatesAt('month', 0, new Date('2028-02-10T00:00:00')).end).toBe('2028-02-29');
  });

  test('agrees with the server getPeriodDates at the same instant', () => {
    for (const period of ['month', 'quarter', 'year'] as const) {
      for (const offset of [-5, -1, 0, 1]) {
        expect(getPeriodDatesAt(period, offset, new Date())).toEqual(getPeriodDates(period, offset));
      }
    }
  });
});

describe('parseNaturalQueryAt', () => {
  const now = new Date('2026-07-15T12:00:00');

  test('category + month name', () => {
    expect(parseNaturalQueryAt('dining in January', now, CATS)).toEqual({
      category: 'Dining',
      dateStart: '2026-01-01',
      dateEnd: '2026-01-31',
    });
  });

  test('month with explicit year', () => {
    expect(parseNaturalQueryAt('Amazon purchases in March 2025', now, CATS)).toEqual({
      dateStart: '2025-03-01',
      dateEnd: '2025-03-31',
      // The server parser keeps the bare year as a residual word (copied faithfully; parity-pinned).
      merchant: 'Amazon 2025',
    });
  });

  test('last month rolls over the year in January', () => {
    const jan = new Date('2026-01-20T00:00:00');
    expect(parseNaturalQueryAt('last month', jan, CATS)).toEqual({ dateStart: '2025-12-01', dateEnd: '2025-12-31' });
  });

  test('this month / this year / last year', () => {
    expect(parseNaturalQueryAt('this month', now, CATS)).toEqual({ dateStart: '2026-07-01', dateEnd: '2026-07-31' });
    expect(parseNaturalQueryAt('this year', now, CATS)).toEqual({ dateStart: '2026-01-01', dateEnd: '2026-12-31' });
    expect(parseNaturalQueryAt('last year', now, CATS)).toEqual({ dateStart: '2025-01-01', dateEnd: '2025-12-31' });
  });

  test('amount filters are expense-signed', () => {
    expect(parseNaturalQueryAt('over $100', now, CATS)).toEqual({ maxAmount: -100 });
    expect(parseNaturalQueryAt('under $20', now, CATS)).toEqual({ minAmount: -20 });
  });

  test('recurring and subscription set isRecurring; recurring is a stopword', () => {
    expect(parseNaturalQueryAt('recurring charges', now, CATS)).toEqual({ isRecurring: true });
    expect(parseNaturalQueryAt('Netflix subscription', now, CATS)).toEqual({ isRecurring: true, merchant: 'Netflix subscription' });
  });

  test('a matched category suppresses merchant extraction', () => {
    expect(parseNaturalQueryAt('Groceries at Whole Foods', now, CATS)).toEqual({ category: 'Groceries' });
  });

  test('category names with punctuation match', () => {
    expect(parseNaturalQueryAt('fees & interest', now, CATS).category).toBe('Fees & Interest');
  });

  test('empty query yields no filters', () => {
    expect(parseNaturalQueryAt('', now, CATS)).toEqual({});
  });

  test('now is injected, not read from the clock', () => {
    const a = parseNaturalQueryAt('last month', new Date('2020-03-05T00:00:00'), CATS);
    expect(a).toEqual({ dateStart: '2020-02-01', dateEnd: '2020-02-29' });
  });
});

describe('formatSearchResults', () => {
  test('empty', () => {
    expect(formatSearchResults([])).toBe('No transactions found matching your query.');
  });
});

describe('read-core category fallback', () => {
  test('is the server CATEGORIES list', () => {
    expect(READ_CORE_CATEGORY_FALLBACK).toEqual(CATEGORIES);
  });
});

describe('read-core import rule', () => {
  const dir = join(import.meta.dir, '..', 'tools', 'read-core');
  const ALLOWED = new Set([
    '../../db/transaction-where.js',
    '../../db/overview-sql.js',
    '../categorize/categories.js',
  ]);

  test('has the expected modules', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(files).toEqual(['forecast-math.ts', 'format.ts', 'index.ts', 'nl-query.ts', 'period.ts']);
  });

  test('imports nothing outside the allowlist and itself', () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      // Side-effect and dynamic imports are not allowed at all.
      expect(src).not.toMatch(/(^|\n)\s*import\s+['"]/);
      expect(src).not.toMatch(/\bimport\(/);
      expect(src).not.toMatch(/\brequire\(/);
      for (const spec of specs) {
        const ok = ALLOWED.has(spec) || /^\.\/[a-z-]+\.js$/.test(spec);
        if (!ok) throw new Error(`${file} imports disallowed module ${spec}`);
      }
    }
  });
});
