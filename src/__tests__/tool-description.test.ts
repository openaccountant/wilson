import { describe, expect, test } from 'bun:test';
import { getToolDescription } from '../utils/tool-description.js';

describe('getToolDescription', () => {
  test('includes ticker in uppercase', () => {
    const desc = getToolDescription('get_income_statements', { ticker: 'aapl' });
    expect(desc).toContain('AAPL');
  });

  test('includes query in quotes', () => {
    const desc = getToolDescription('search_web', { query: 'bitcoin price' });
    expect(desc).toContain('"bitcoin price"');
  });

  test('formats tool name by removing get_ prefix and underscores', () => {
    const desc = getToolDescription('get_income_statements', { ticker: 'MSFT' });
    expect(desc).toContain('income statements');
  });

  test('includes period qualifier in parentheses', () => {
    const desc = getToolDescription('get_income_statements', { ticker: 'AAPL', period: 'annual' });
    expect(desc).toContain('(annual)');
  });

  test('includes date range', () => {
    const desc = getToolDescription('get_prices', {
      ticker: 'AAPL',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(desc).toContain('from 2025-01-01 to 2025-12-31');
  });

  test('includes limit with periods label', () => {
    const desc = getToolDescription('get_income_statements', { ticker: 'AAPL', limit: 5 });
    expect(desc).toContain('5 periods');
  });

  test('appends remaining args in brackets', () => {
    const desc = getToolDescription('some_tool', { custom_arg: 'value' });
    expect(desc).toContain('[custom_arg=value]');
  });

  test('combines all parts', () => {
    const desc = getToolDescription('get_income_statements', {
      ticker: 'aapl',
      period: 'annual',
      limit: 5,
    });
    expect(desc).toBe('AAPL income statements (annual) - 5 periods');
  });
});
