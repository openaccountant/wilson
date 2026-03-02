import { describe, expect, test } from 'bun:test';
import { parseAmexCSV } from '../tools/import/parsers/amex.js';

describe('parseAmexCSV', () => {
  test('parses standard Amex CSV', () => {
    const csv = [
      'Date,Description,Amount',
      '02/15/2026,WHOLE FOODS MARKET,85.50',
      '02/18/2026,UBER TRIP,25.00',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns).toHaveLength(2);
    expect(txns[0].date).toBe('2026-02-15');
    expect(txns[0].description).toBe('WHOLE FOODS MARKET');
    expect(txns[0].bank).toBe('amex');
  });

  test('negates amounts (Amex positive = expense → negative internally)', () => {
    const csv = [
      'Date,Description,Amount',
      '02/15/2026,PURCHASE,85.50',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns[0].amount).toBe(-85.50);
  });

  test('handles Amex credits (negative amount → positive internally)', () => {
    const csv = [
      'Date,Description,Amount',
      '02/20/2026,REFUND,-50.00',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns[0].amount).toBe(50.00);
  });

  test('normalizes date format', () => {
    const csv = [
      'Date,Description,Amount',
      '1/5/2026,TEST,10.00',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns[0].date).toBe('2026-01-05');
  });

  test('skips rows with missing Date', () => {
    const csv = [
      'Date,Description,Amount',
      ',STORE,85.50',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns).toHaveLength(0);
  });

  test('skips rows with NaN amount', () => {
    const csv = [
      'Date,Description,Amount',
      '02/15/2026,STORE,abc',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns).toHaveLength(0);
  });

  test('handles extra columns (Card Member, Account #)', () => {
    const csv = [
      'Date,Description,Card Member,Account #,Amount',
      '02/15/2026,TARGET,JOHN DOE,12345,42.00',
    ].join('\n');

    const txns = parseAmexCSV(csv);
    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-42.00);
  });

  test('empty CSV returns empty array', () => {
    const csv = 'Date,Description,Amount\n';
    const txns = parseAmexCSV(csv);
    expect(txns).toHaveLength(0);
  });
});
