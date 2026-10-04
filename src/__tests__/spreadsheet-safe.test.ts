import { describe, expect, test } from 'bun:test';
import { csvText, neutralizeFormula, sanitizeRow } from '../utils/spreadsheet-safe.js';

describe('neutralizeFormula', () => {
  test.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1'])('prefixes %j', (v) => {
    expect(neutralizeFormula(v)).toBe(`'${v}`);
  });

  test('leaves normal text alone', () => {
    for (const v of ['Grocery Store', '', '2026-02-15', "'=already", 'a=b', '5-3']) {
      expect(neutralizeFormula(v)).toBe(v);
    }
  });
});

describe('csvText', () => {
  test('neutralises then quotes when needed', () => {
    expect(csvText('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvText('=A1')).toBe("'=A1");
    expect(csvText('Plain, with comma')).toBe('"Plain, with comma"');
    expect(csvText('line\r\nbreak')).toBe('"line\r\nbreak"');
    expect(csvText('Groceries')).toBe('Groceries');
  });
});

describe('sanitizeRow', () => {
  test('sanitises strings only; numbers (incl. negative) are untouched', () => {
    const row = sanitizeRow({ d: '=cmd', amount: -85.5, n: null, c: 'ok' });
    expect(row).toEqual({ d: "'=cmd", amount: -85.5, n: null, c: 'ok' });
  });
});
