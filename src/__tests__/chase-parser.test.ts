import { describe, expect, test } from 'bun:test';
import { parseChaseCSV } from '../tools/import/parsers/chase.js';

describe('parseChaseCSV', () => {
  test('parses standard Chase credit card CSV', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,AMAZON.COM,Shopping,Sale,-45.99',
      '02/18/2026,02/19/2026,STARBUCKS,Food & Drink,Sale,-5.75',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns).toHaveLength(2);
    expect(txns[0].date).toBe('2026-02-15');
    expect(txns[0].description).toBe('AMAZON.COM');
    expect(txns[0].amount).toBe(-45.99);
    expect(txns[0].bank).toBe('chase');
  });

  test('normalizes MM/DD/YYYY to YYYY-MM-DD', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '01/05/2026,01/06/2026,TEST,Other,Sale,-10.00',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns[0].date).toBe('2026-01-05');
  });

  test('keeps amounts as-is (negative = expense)', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,PURCHASE,Other,Sale,-100.00',
      '02/20/2026,02/21/2026,PAYMENT RECEIVED,Payment,Payment,500.00',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns[0].amount).toBe(-100.00);
    expect(txns[1].amount).toBe(500.00);
  });

  test('skips rows with missing fields', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,,Shopping,Sale,-10.00',
      ',02/16/2026,STORE,Shopping,Sale,-10.00',
      '02/15/2026,02/16/2026,STORE,Shopping,Sale,',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns).toHaveLength(0);
  });

  test('skips rows with NaN amount', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,STORE,Shopping,Sale,not-a-number',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns).toHaveLength(0);
  });

  test('trims description whitespace', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '02/15/2026,02/16/2026,  TRIMMED STORE  ,Other,Sale,-25.00',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns[0].description).toBe('TRIMMED STORE');
  });

  test('handles single-digit month/day', () => {
    const csv = [
      'Transaction Date,Post Date,Description,Category,Type,Amount',
      '1/5/2026,1/6/2026,TEST,Other,Sale,-10.00',
    ].join('\n');

    const txns = parseChaseCSV(csv);
    expect(txns[0].date).toBe('2026-01-05');
  });

  test('empty CSV returns empty array', () => {
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount\n';
    const txns = parseChaseCSV(csv);
    expect(txns).toHaveLength(0);
  });
});
