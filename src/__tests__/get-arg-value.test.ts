import { describe, expect, test } from 'bun:test';
import { getArgValue } from '../reports.js';

describe('getArgValue', () => {
  test('returns value after flag', () => {
    expect(getArgValue(['--format', 'csv'], '--format')).toBe('csv');
  });

  test('returns undefined if flag missing', () => {
    expect(getArgValue(['--status'], '--format')).toBeUndefined();
  });

  test('returns undefined if flag is last arg', () => {
    expect(getArgValue(['--format'], '--format')).toBeUndefined();
  });

  test('returns undefined if next arg is a flag', () => {
    expect(getArgValue(['--format', '--verbose'], '--format')).toBeUndefined();
  });

  test('works with multiple flags present', () => {
    expect(getArgValue(['--export', 'out.csv', '--format', 'xlsx'], '--format')).toBe('xlsx');
  });
});
