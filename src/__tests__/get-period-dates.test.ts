import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { getPeriodDates } from '../tools/query/spending-summary.js';

describe('getPeriodDates', () => {
  let realDate: DateConstructor;

  beforeAll(() => {
    realDate = globalThis.Date;
    const MockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(2026, 2, 15); // March 15, 2026
        } else {
          // @ts-ignore
          super(...args);
        }
      }
      static now() {
        return new realDate(2026, 2, 15).getTime();
      }
    } as unknown as DateConstructor;
    globalThis.Date = MockDate;
  });

  afterAll(() => {
    globalThis.Date = realDate;
  });

  test('month offset 0 returns current month', () => {
    const result = getPeriodDates('month', 0);
    expect(result.start).toBe('2026-03-01');
    expect(result.end).toBe('2026-03-31');
    expect(result.label).toBe('March 2026');
  });

  test('month offset -1 returns previous month', () => {
    const result = getPeriodDates('month', -1);
    expect(result.start).toBe('2026-02-01');
    expect(result.end).toBe('2026-02-28');
    expect(result.label).toBe('February 2026');
  });

  test('quarter offset 0 returns current quarter', () => {
    const result = getPeriodDates('quarter', 0);
    expect(result.start).toBe('2026-01-01');
    expect(result.end).toBe('2026-03-31');
    expect(result.label).toBe('Q1 2026');
  });

  test('quarter offset -1 returns previous quarter', () => {
    const result = getPeriodDates('quarter', -1);
    expect(result.start).toBe('2025-10-01');
    expect(result.end).toBe('2025-12-31');
    expect(result.label).toBe('Q4 2025');
  });

  test('year offset 0 returns current year', () => {
    const result = getPeriodDates('year', 0);
    expect(result.start).toBe('2026-01-01');
    expect(result.end).toBe('2026-12-31');
    expect(result.label).toBe('2026');
  });

  test('year offset -1 returns previous year', () => {
    const result = getPeriodDates('year', -1);
    expect(result.start).toBe('2025-01-01');
    expect(result.end).toBe('2025-12-31');
    expect(result.label).toBe('2025');
  });
});
