import { describe, expect, test } from 'bun:test';
import {
  alignedMonthCount,
  computeCompareWindow,
  isValidYmd,
  monthBounds,
  monthSpan,
  trailingMonthsWindow,
  windowHasCoverage,
} from '../db/compare-window.js';

// Pure drill date math shared by server, mirror and UI (src/db/compare-window.ts).

describe('computeCompareWindow — prev', () => {
  test('a complete calendar month compares against the previous calendar month', () => {
    expect(computeCompareWindow({ start: '2026-10-01', end: '2026-10-31' }, 'prev', '2026-11-15')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
      partial: false,
      elapsedDays: 31,
      periodDays: 31,
    });
  });

  test('PARTIAL month: same number of elapsed days at the start of the prior month', () => {
    // "This month" on Oct 3 → Sep 1–3, not all of September.
    expect(computeCompareWindow({ start: '2026-10-01', end: '2026-10-31' }, 'prev', '2026-10-03')).toEqual({
      start: '2026-09-01',
      end: '2026-09-03',
      partial: true,
      elapsedDays: 3,
      periodDays: 31,
    });
  });

  test('elapsed days longer than the prior month clamp to its end (Mar 1–30 vs Feb)', () => {
    const w = computeCompareWindow({ start: '2026-03-01', end: '2026-03-31' }, 'prev', '2026-03-30');
    expect(w).toMatchObject({ start: '2026-02-01', end: '2026-02-28', partial: true, elapsedDays: 30 });
  });

  test('the range end day itself counts as elapsed (asOf = end → complete)', () => {
    const w = computeCompareWindow({ start: '2026-10-01', end: '2026-10-31' }, 'prev', '2026-10-31');
    expect(w).toMatchObject({ start: '2026-09-01', end: '2026-09-30', partial: false });
  });

  test('a quarter compares against the previous quarter; a year against the previous year', () => {
    expect(computeCompareWindow({ start: '2026-07-01', end: '2026-09-30' }, 'prev', '2027-01-01')).toMatchObject({
      start: '2026-04-01',
      end: '2026-06-30',
    });
    expect(computeCompareWindow({ start: '2026-01-01', end: '2026-12-31' }, 'prev', '2027-01-01')).toMatchObject({
      start: '2025-01-01',
      end: '2025-12-31',
    });
  });

  test('partial year (Jan 1–Dec 31 on Oct 3) → prior year Jan 1 through the same elapsed day count', () => {
    const w = computeCompareWindow({ start: '2026-01-01', end: '2026-12-31' }, 'prev', '2026-10-03');
    // 2026-01-01..2026-10-03 = 276 days; 2025-01-01 + 275 days = 2025-10-03.
    expect(w).toMatchObject({ start: '2025-01-01', end: '2025-10-03', partial: true, elapsedDays: 276 });
  });

  test('a non-month-aligned range compares against the same number of days immediately before it', () => {
    expect(computeCompareWindow({ start: '2026-05-10', end: '2026-05-19' }, 'prev', '2026-06-01')).toMatchObject({
      start: '2026-04-30',
      end: '2026-05-09',
      partial: false,
      periodDays: 10,
    });
  });

  test('a partial non-aligned range keeps only the elapsed days', () => {
    expect(computeCompareWindow({ start: '2026-05-10', end: '2026-05-19' }, 'prev', '2026-05-12')).toMatchObject({
      start: '2026-04-30',
      end: '2026-05-02',
      partial: true,
      elapsedDays: 3,
    });
  });

  test('crossing a year boundary', () => {
    expect(computeCompareWindow({ start: '2026-01-01', end: '2026-01-31' }, 'prev', '2026-02-10')).toMatchObject({
      start: '2025-12-01',
      end: '2025-12-31',
    });
  });
});

describe('computeCompareWindow — yoy', () => {
  test('same dates one year earlier', () => {
    expect(computeCompareWindow({ start: '2026-10-01', end: '2026-10-31' }, 'yoy', '2026-12-01')).toMatchObject({
      start: '2025-10-01',
      end: '2025-10-31',
      partial: false,
    });
  });

  test('partial yoy: same elapsed days a year earlier', () => {
    expect(computeCompareWindow({ start: '2026-10-01', end: '2026-10-31' }, 'yoy', '2026-10-03')).toMatchObject({
      start: '2025-10-01',
      end: '2025-10-03',
      partial: true,
    });
  });

  test('Feb 29 falls back to Feb 28', () => {
    expect(computeCompareWindow({ start: '2028-02-01', end: '2028-02-29' }, 'yoy', '2028-03-10')).toMatchObject({
      start: '2027-02-01',
      end: '2027-02-28',
    });
  });
});

describe('computeCompareWindow — no comparison possible', () => {
  test('a range that has not started yet', () => {
    expect(computeCompareWindow({ start: '2026-11-01', end: '2026-11-30' }, 'prev', '2026-10-03')).toBeNull();
  });

  test('malformed or inverted input', () => {
    expect(computeCompareWindow({ start: '2026-02-30', end: '2026-03-31' }, 'prev', '2026-10-03')).toBeNull();
    expect(computeCompareWindow({ start: '2026-03-31', end: '2026-03-01' }, 'prev', '2026-10-03')).toBeNull();
    expect(computeCompareWindow({ start: '2026-03-01', end: '2026-03-31' }, 'prev', 'today')).toBeNull();
  });
});

describe('windowHasCoverage — null (no data) vs covered', () => {
  const coverage = { start: '2026-01-10', end: '2026-06-01', months: ['2026-01', '2026-02', '2026-03', '2026-05', '2026-06'] };

  test('a window inside a covered month is covered (even a day with no transactions)', () => {
    expect(windowHasCoverage({ start: '2026-02-20', end: '2026-02-20' }, coverage)).toBe(true);
  });

  test('a window entirely before the first import / after the last has no coverage', () => {
    expect(windowHasCoverage({ start: '2025-05-01', end: '2025-05-31' }, coverage)).toBe(false);
    expect(windowHasCoverage({ start: '2026-01-01', end: '2026-01-09' }, coverage)).toBe(false);
    expect(windowHasCoverage({ start: '2026-06-02', end: '2026-06-30' }, coverage)).toBe(false);
  });

  test('a window inside a gap month (nothing imported) has no coverage', () => {
    expect(windowHasCoverage({ start: '2026-04-01', end: '2026-04-30' }, coverage)).toBe(false);
  });

  test('a window that overlaps coverage at all is covered', () => {
    expect(windowHasCoverage({ start: '2025-12-01', end: '2026-01-15' }, coverage)).toBe(true);
    expect(windowHasCoverage({ start: '2026-04-20', end: '2026-05-02' }, coverage)).toBe(true);
  });

  test('nothing imported → nothing covered', () => {
    expect(windowHasCoverage({ start: '2026-01-01', end: '2026-12-31' }, { start: null, end: null, months: [] })).toBe(false);
  });
});

describe('month helpers', () => {
  test('monthSpan is inclusive and crosses years', () => {
    expect(monthSpan('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthSpan('2026-02', '2026-02')).toEqual(['2026-02']);
    expect(monthSpan('2026-03', '2026-02')).toEqual([]);
    expect(monthSpan('bad', '2026-02')).toEqual([]);
  });

  test('trailingMonthsWindow anchors 12 whole months on the anchor month', () => {
    expect(trailingMonthsWindow('2026-06-01')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
    expect(trailingMonthsWindow('2026-02-14', 3)).toEqual({ start: '2025-12-01', end: '2026-02-28' });
    expect(trailingMonthsWindow('nope')).toBeNull();
  });

  test('alignedMonthCount detects whole-month ranges', () => {
    expect(alignedMonthCount({ start: '2026-01-01', end: '2026-03-31' })).toBe(3);
    expect(alignedMonthCount({ start: '2026-01-02', end: '2026-03-31' })).toBeNull();
    expect(alignedMonthCount({ start: '2026-01-01', end: '2026-03-30' })).toBeNull();
  });

  test('monthBounds / isValidYmd', () => {
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthBounds('2026-13')).toBeNull();
    expect(isValidYmd('2026-02-28')).toBe(true);
    expect(isValidYmd('2026-02-29')).toBe(false);
    expect(isValidYmd('2026-2-28')).toBe(false);
    expect(isValidYmd('0099-01-01')).toBe(false);
  });
});
