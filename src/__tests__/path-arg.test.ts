import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { expandHome, parseFilePathArg } from '../utils/path-arg.js';

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
        'darwin',
      ),
    ).toBe("/Users/jd/Documents/Jd's Finances-export-2026-08-29.csv");
  });

  test('unescapes backslashes inside surrounding quotes too', () => {
    expect(
      parseFilePathArg(
        "\"/Users/jd/Documents/Jd\\'s\\ Finances-export-2026-08-29.csv\"",
        'darwin',
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

describe('parseFilePathArg on Windows', () => {
  test('keeps backslash separators instead of unescaping them', () => {
    expect(parseFilePathArg('C:\\Users\\jd\\Downloads\\statement.csv', 'win32')).toBe(
      'C:\\Users\\jd\\Downloads\\statement.csv',
    );
  });

  test('still strips quotes and the autocomplete @', () => {
    expect(parseFilePathArg('"@C:\\Users\\jd\\My Files\\a.csv"', 'win32')).toBe(
      'C:\\Users\\jd\\My Files\\a.csv',
    );
  });
});

describe('expandHome', () => {
  const home = join('/home', 'tester');
  test('expands ~ alone and ~/ and ~\\ prefixes', () => {
    expect(expandHome('~', home)).toBe(home);
    expect(expandHome('~/report.md', home)).toBe(join(home, 'report.md'));
    expect(expandHome('~\\report.md', home)).toBe(join(home, 'report.md'));
  });

  test('leaves other paths, including ~user, untouched', () => {
    expect(expandHome('/tmp/report.md', home)).toBe('/tmp/report.md');
    expect(expandHome('~other/report.md', home)).toBe('~other/report.md');
  });
});
