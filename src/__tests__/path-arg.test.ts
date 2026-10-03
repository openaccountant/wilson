import { describe, expect, test } from 'bun:test';
import { parseFilePathArg } from '../utils/path-arg.js';

describe('parseFilePathArg', () => {
  test('leaves a plain unescaped path untouched', () => {
    expect(parseFilePathArg('/Users/jd/Downloads/statement.csv')).toBe(
      '/Users/jd/Downloads/statement.csv',
    );
  });

  test('strips surrounding double quotes', () => {
    expect(parseFilePathArg('"/Users/jd/Downloads/statement.csv"')).toBe(
      '/Users/jd/Downloads/statement.csv',
    );
  });

  test('strips surrounding single quotes', () => {
    expect(parseFilePathArg("'/Users/jd/Downloads/statement.csv'")).toBe(
      '/Users/jd/Downloads/statement.csv',
    );
  });

  test('unescapes shell-style backslash escapes (apostrophe and space)', () => {
    expect(
      parseFilePathArg(
        "/Users/jd/Documents/Jd\\'s\\ Finances-export-2026-08-29.csv",
      ),
    ).toBe("/Users/jd/Documents/Jd's Finances-export-2026-08-29.csv");
  });

  test('unescapes backslashes inside surrounding quotes too', () => {
    expect(
      parseFilePathArg(
        "\"/Users/jd/Documents/Jd\\'s\\ Finances-export-2026-08-29.csv\"",
      ),
    ).toBe("/Users/jd/Documents/Jd's Finances-export-2026-08-29.csv");
  });

  test('strips a leading @ left over from file-search autocomplete', () => {
    expect(parseFilePathArg('@/Users/jd/Downloads/statement.csv')).toBe(
      '/Users/jd/Downloads/statement.csv',
    );
  });

  test('trims surrounding whitespace', () => {
    expect(parseFilePathArg('  /Users/jd/Downloads/statement.csv  ')).toBe(
      '/Users/jd/Downloads/statement.csv',
    );
  });
});
