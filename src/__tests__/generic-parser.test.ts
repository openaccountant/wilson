import { describe, expect, test } from 'bun:test';
import { parseGenericCSV } from '../tools/import/parsers/generic.js';

describe('parseGenericCSV', () => {
  describe('column auto-detection', () => {
    test('detects "Date", "Description", "Amount" headers', () => {
      const csv = [
        'Date,Description,Amount',
        '2026-02-15,GROCERY STORE,-50.00',
        '2026-02-18,GAS STATION,-30.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].bank).toBe('generic');
    });

    test('detects "Transaction Date", "Merchant", "Transaction Amount"', () => {
      const csv = [
        'Transaction Date,Merchant,Transaction Amount',
        '02/15/2026,STORE,-25.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('STORE');
    });

    test('throws when missing date column', () => {
      const csv = 'Name,Amount\nFoo,-10\n';
      expect(() => parseGenericCSV(csv)).toThrow('date column');
    });

    test('throws when missing description column', () => {
      const csv = 'Date,Value\n2026-01-01,10\n';
      expect(() => parseGenericCSV(csv)).toThrow('description column');
    });

    test('throws when missing amount/debit/credit column', () => {
      const csv = 'Date,Description\n2026-01-01,Test\n';
      expect(() => parseGenericCSV(csv)).toThrow('amount');
    });
  });

  describe('sign convention detection', () => {
    test('negates when >60% of amounts are positive (bank uses positive=expense)', () => {
      const csv = [
        'Date,Description,Amount',
        '2026-02-01,STORE A,50.00',
        '2026-02-02,STORE B,30.00',
        '2026-02-03,STORE C,20.00',
        '2026-02-04,STORE D,10.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      // All positive -> should negate to our convention (negative = expense)
      expect(txns.every((t) => t.amount < 0)).toBe(true);
    });

    test('keeps sign when most amounts already negative', () => {
      const csv = [
        'Date,Description,Amount',
        '2026-02-01,STORE A,-50.00',
        '2026-02-02,STORE B,-30.00',
        '2026-02-03,STORE C,-20.00',
        '2026-02-04,INCOME,500.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      const store = txns.find((t) => t.description === 'STORE A');
      expect(store?.amount).toBe(-50.00);
    });
  });

  describe('separate debit/credit columns', () => {
    test('handles Withdrawal and Deposit columns', () => {
      // Use "Withdrawal"/"Deposit" headers which match DEBIT/CREDIT_PATTERNS
      // but NOT AMOUNT_PATTERNS, so hasSeparateDebitCredit is true
      const csv = [
        'Date,Description,Withdrawal,Deposit',
        '2026-02-01,PURCHASE,50.00,',
        '2026-02-02,REFUND,,200.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].amount).toBe(-50.00); // withdrawal = negative
      expect(txns[1].amount).toBe(200.00);  // deposit = positive
    });
  });

  describe('date format normalization', () => {
    test('handles YYYY-MM-DD as-is', () => {
      const csv = 'Date,Description,Amount\n2026-02-15,TEST,-10\n';
      const txns = parseGenericCSV(csv);
      expect(txns[0].date).toBe('2026-02-15');
    });

    test('converts YYYY/MM/DD', () => {
      const csv = 'Date,Description,Amount\n2026/02/15,TEST,-10\n';
      const txns = parseGenericCSV(csv);
      expect(txns[0].date).toBe('2026-02-15');
    });

    test('converts MM/DD/YYYY', () => {
      const csv = 'Date,Description,Amount\n02/15/2026,TEST,-10\n';
      const txns = parseGenericCSV(csv);
      expect(txns[0].date).toBe('2026-02-15');
    });

    test('detects DD/MM/YYYY when day > 12', () => {
      const csv = 'Date,Description,Amount\n15/02/2026,TEST,-10\n';
      const txns = parseGenericCSV(csv);
      expect(txns[0].date).toBe('2026-02-15');
    });
  });

  test('empty CSV returns empty array', () => {
    const csv = 'Date,Description,Amount\n';
    const txns = parseGenericCSV(csv);
    expect(txns).toHaveLength(0);
  });

  test('skips rows with missing date or description', () => {
    const csv = [
      'Date,Description,Amount',
      ',STORE,-10',
      '2026-01-01,,-20',
      '2026-01-02,VALID,-30',
    ].join('\n');

    const txns = parseGenericCSV(csv);
    expect(txns).toHaveLength(1);
    expect(txns[0].description).toBe('VALID');
  });
});
