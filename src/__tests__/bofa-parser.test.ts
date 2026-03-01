import { describe, expect, test } from 'bun:test';
import { parseBofA } from '../tools/import/parsers/bofa.js';

describe('parseBofA', () => {
  describe('checking format with header stripping', () => {
    test('strips metadata lines and parses transactions', () => {
      const csv = [
        'Bank of America',
        'Account: ****1234',
        'Date Range: 02/01/2026 - 02/28/2026',
        '',
        'Date,Description,Amount,Running Bal.',
        '02/15/2026,"WHOLE FOODS MARKET #1234",-85.50,1234.50',
        '02/18/2026,"ELECTRIC COMPANY PAYMENT",-120.00,1114.50',
        '02/10/2026,"DIRECT DEPOSIT - PAYROLL",3500.00,4614.50',
      ].join('\n');

      const txns = parseBofA(csv);

      expect(txns).toHaveLength(3);

      expect(txns[0].date).toBe('2026-02-15');
      expect(txns[0].description).toBe('WHOLE FOODS MARKET #1234');
      expect(txns[0].amount).toBe(-85.50);
      expect(txns[0].bank).toBe('bofa');

      expect(txns[1].amount).toBe(-120.00);

      expect(txns[2].amount).toBe(3500.00);

      // Checking format has no external_id
      for (const txn of txns) {
        expect(txn.external_id).toBeUndefined();
      }
    });
  });

  describe('credit card format', () => {
    test('parses credit card transactions with payee and reference', () => {
      const csv = [
        'Posted Date,Reference Number,Payee,Address,Amount',
        '02/15/2026,1234567890,"AMAZON.COM","SEATTLE WA",-45.99',
        '02/18/2026,1234567891,"STARBUCKS #12345","NEW YORK NY",-5.75',
        '02/20/2026,1234567892,"PAYMENT THANK YOU","",150.00',
      ].join('\n');

      const txns = parseBofA(csv);

      expect(txns).toHaveLength(3);

      expect(txns[0].date).toBe('2026-02-15');
      expect(txns[0].description).toBe('AMAZON.COM');
      expect(txns[0].amount).toBe(-45.99);
      expect(txns[0].bank).toBe('bofa-cc');
      expect(txns[0].merchant_name).toBe('AMAZON.COM');
      expect(txns[0].external_id).toBe('1234567890');

      expect(txns[2].amount).toBe(150.00);
    });
  });

  describe('auto-detection between formats', () => {
    test('detects checking format from headers', () => {
      const csv = [
        'Date,Description,Amount,Running Bal.',
        '02/15/2026,"GROCERY STORE",-50.00,500.00',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns[0].bank).toBe('bofa');
    });

    test('detects credit card format from headers', () => {
      const csv = [
        'Posted Date,Reference Number,Payee,Address,Amount',
        '02/15/2026,9999999999,"SOME STORE","CITY ST",-25.00',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns[0].bank).toBe('bofa-cc');
    });
  });

  describe('checking format without metadata lines', () => {
    test('parses when CSV starts directly with headers', () => {
      const csv = [
        'Date,Description,Amount,Running Bal.',
        '02/01/2026,"RENT PAYMENT",-1500.00,2000.00',
        '02/05/2026,"ATM WITHDRAWAL",-200.00,1800.00',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].date).toBe('2026-02-01');
      expect(txns[0].description).toBe('RENT PAYMENT');
      expect(txns[0].amount).toBe(-1500.00);
      expect(txns[0].bank).toBe('bofa');
    });
  });

  describe('edge cases', () => {
    test('handles quoted descriptions containing commas', () => {
      const csv = [
        'Date,Description,Amount,Running Bal.',
        '02/15/2026,"PAYMENT TO JOHN, SMITH",-50.00,450.00',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('PAYMENT TO JOHN, SMITH');
      expect(txns[0].amount).toBe(-50.00);
    });

    test('handles empty address field in credit card format', () => {
      const csv = [
        'Posted Date,Reference Number,Payee,Address,Amount',
        '02/20/2026,5555555555,"ONLINE PURCHASE","",  -99.99',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('ONLINE PURCHASE');
      expect(txns[0].amount).toBe(-99.99);
    });

    test('handles amounts without decimal places', () => {
      const csv = [
        'Date,Description,Amount,Running Bal.',
        '02/15/2026,"ROUND PURCHASE",-50,500',
      ].join('\n');

      const txns = parseBofA(csv);
      expect(txns).toHaveLength(1);
      expect(txns[0].amount).toBe(-50);
    });
  });
});
