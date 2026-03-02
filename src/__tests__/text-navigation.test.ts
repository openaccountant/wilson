import { describe, expect, test } from 'bun:test';
import {
  findPrevWordStart,
  findNextWordEnd,
  getLineAndColumn,
  getCursorPosition,
  getLineStart,
  getLineEnd,
  getLineCount,
} from '../utils/text-navigation.js';

describe('findPrevWordStart', () => {
  test('returns 0 at start of string', () => {
    expect(findPrevWordStart('hello world', 0)).toBe(0);
  });

  test('finds start of current word', () => {
    expect(findPrevWordStart('hello world', 8)).toBe(6);
  });

  test('jumps over spaces to previous word', () => {
    expect(findPrevWordStart('hello world', 6)).toBe(0);
  });

  test('handles position at end', () => {
    expect(findPrevWordStart('hello', 5)).toBe(0);
  });
});

describe('findNextWordEnd', () => {
  test('returns length at end of string', () => {
    expect(findNextWordEnd('hello', 5)).toBe(5);
  });

  test('finds end of current word', () => {
    expect(findNextWordEnd('hello world', 0)).toBe(5);
  });

  test('jumps over spaces to next word', () => {
    expect(findNextWordEnd('hello world', 5)).toBe(11);
  });

  test('handles single character', () => {
    expect(findNextWordEnd('a', 0)).toBe(1);
  });
});

describe('getLineAndColumn', () => {
  test('position 0 is line 0, column 0', () => {
    expect(getLineAndColumn('hello', 0)).toEqual({ line: 0, column: 0 });
  });

  test('first line mid-position', () => {
    expect(getLineAndColumn('hello', 3)).toEqual({ line: 0, column: 3 });
  });

  test('second line', () => {
    expect(getLineAndColumn('hello\nworld', 8)).toEqual({ line: 1, column: 2 });
  });

  test('at newline boundary', () => {
    expect(getLineAndColumn('abc\ndef', 4)).toEqual({ line: 1, column: 0 });
  });
});

describe('getCursorPosition', () => {
  test('line 0, column 0 returns 0', () => {
    expect(getCursorPosition('hello\nworld', 0, 0)).toBe(0);
  });

  test('line 1, column 2 returns correct offset', () => {
    expect(getCursorPosition('hello\nworld', 1, 2)).toBe(8);
  });

  test('clamps column to line length', () => {
    expect(getCursorPosition('ab\ncd', 0, 100)).toBe(2);
  });
});

describe('getLineStart', () => {
  test('returns 0 on first line', () => {
    expect(getLineStart('hello', 3)).toBe(0);
  });

  test('returns position after newline on second line', () => {
    expect(getLineStart('hello\nworld', 8)).toBe(6);
  });
});

describe('getLineEnd', () => {
  test('returns string length on last line', () => {
    expect(getLineEnd('hello', 2)).toBe(5);
  });

  test('returns newline position on first line', () => {
    expect(getLineEnd('hello\nworld', 2)).toBe(5);
  });
});

describe('getLineCount', () => {
  test('single line', () => {
    expect(getLineCount('hello')).toBe(1);
  });

  test('multiple lines', () => {
    expect(getLineCount('a\nb\nc')).toBe(3);
  });

  test('empty string', () => {
    expect(getLineCount('')).toBe(1);
  });
});
