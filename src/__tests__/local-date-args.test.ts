import { describe, expect, test } from 'bun:test';
import { namedMonth, resolveLocalDateArgs } from '../agent/local-date-args.js';

/**
 * Local models call spending_summary with the CURRENT period even when the
 * user named another month (granite: "biggest expenses in August 2026" ->
 * {period: 'month'} in October). The agent fills the month in instead of
 * hoping the model does. Pinned at now = 2026-10-03.
 */

const NOW = new Date('2026-10-03T12:00:00');

describe('namedMonth', () => {
  test('a month with its year', () => {
    expect(namedMonth('What were my biggest expenses in August 2026?', NOW)).toBe('2026-08');
    expect(namedMonth('spending for march, 2025', NOW)).toBe('2025-03');
  });

  test('a bare month is the most recent one that is not in the future', () => {
    expect(namedMonth('what did I spend in August?', NOW)).toBe('2026-08');
    expect(namedMonth('what did I spend in October?', NOW)).toBe('2026-10');
    expect(namedMonth('what did I spend in December?', NOW)).toBe('2025-12');
  });

  test('"may" counts only with a year or after in/for/during/of/since', () => {
    expect(namedMonth('May I see my spending?', NOW)).toBeNull();
    expect(namedMonth('spending in May', NOW)).toBe('2026-05');
    expect(namedMonth('May 2025 spending', NOW)).toBe('2025-05');
  });

  test('no month, or several different months: nothing to resolve', () => {
    expect(namedMonth('what are my biggest expenses?', NOW)).toBeNull();
    expect(namedMonth('compare July and August', NOW)).toBeNull();
    expect(namedMonth('August vs August 2026', NOW)).toBe('2026-08');
  });
});

describe('resolveLocalDateArgs', () => {
  const query = 'What were my biggest expenses in August 2026?';

  test('spending_summary for the current month gets the named month', () => {
    expect(resolveLocalDateArgs(query, 'spending_summary', { period: 'month', compareWithPrevious: true }, NOW)).toEqual({
      period: 'month',
      compareWithPrevious: true,
      month: '2026-08',
    });
  });

  test('spending_summary with no period gets month and the period', () => {
    expect(resolveLocalDateArgs(query, 'spending_summary', {}, NOW)).toEqual({ period: 'month', month: '2026-08' });
  });

  test('unchanged: the current month, another period, an explicit month, other tools, no month named', () => {
    const args = { period: 'month', compareWithPrevious: true };
    expect(resolveLocalDateArgs('biggest expenses in October?', 'spending_summary', args, NOW)).toBe(args);
    const quarter = { period: 'quarter' };
    expect(resolveLocalDateArgs(query, 'spending_summary', quarter, NOW)).toBe(quarter);
    const explicit = { period: 'month', month: '2026-07' };
    expect(resolveLocalDateArgs(query, 'spending_summary', explicit, NOW)).toBe(explicit);
    const search = { query: 'expenses' };
    expect(resolveLocalDateArgs(query, 'transaction_search', search, NOW)).toBe(search);
    expect(resolveLocalDateArgs('biggest expenses?', 'spending_summary', args, NOW)).toBe(args);
  });
});
