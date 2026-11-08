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

  describe('report-style preamble stripping', () => {
    test('strips a Quicken-style title + "Report Created" preamble before the header row', () => {
      const csv = [
        'All Transactions',
        'Report Created: 2026-08-29 11:52:17 -0400',
        '',
        'Date,Payee,Category,Amount',
        '2026-02-15,GROCERY STORE,Food,-50.00',
        '2026-02-18,GAS STATION,Auto,-30.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].description).toBe('GROCERY STORE');
    });

    test('still throws the column-detection error when no real header row exists', () => {
      const csv = ['All Transactions', 'Report Created: 2026-08-29 11:52:17 -0400'].join('\n');
      expect(() => parseGenericCSV(csv)).toThrow('date column');
    });

    test('handles the real Quicken "Transaction Report" shape: BOM, filter-criteria preamble, and a "Payee/Security" column', () => {
      const csv =
        '﻿' +
        [
          'All Transactions Report Created: 2026-08-29 11:52:17 -0400',
          ',',
          'Filter Criteria:,Spending',
          ',This Year',
          ',All Accounts',
          ',All Accounts',
          ',',
          ',Scheduled,Split,Date,Payee/Security,Business,Client,Billable,Category,Amount,Account',
          ',,,2026-02-15,GROCERY STORE,,,,Food,-50.00,Checking',
          ',,,2026-02-18,GAS STATION,,,,Auto,-30.00,Checking',
        ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].description).toBe('GROCERY STORE');
      expect(txns[0].date).toBe('2026-02-15');
    });
  });

  describe('per-row account name (multi-account combined exports)', () => {
    test('captures an "Account" column into account_name', () => {
      const csv = [
        'Date,Payee,Amount,Account',
        '2026-02-15,GROCERY STORE,-50.00,Checking',
        '2026-02-18,CREDIT PAYMENT,-30.00,Credit Card',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns).toHaveLength(2);
      expect(txns[0].account_name).toBe('Checking');
      expect(txns[1].account_name).toBe('Credit Card');
    });

    test('leaves account_name undefined when there is no Account column', () => {
      const csv = 'Date,Description,Amount\n2026-02-15,TEST,-10\n';
      const txns = parseGenericCSV(csv);
      expect(txns[0].account_name).toBeUndefined();
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

    // @invariant NN-07
    test('keeps signs of a signed file that is mostly deposits (savings account)', () => {
      const csv = [
        'Date,Description,Amount',
        '2026-02-01,FAKE TRANSFER FEE (dummy),-5.00',
        '2026-02-02,FAKE DEPOSIT ONE (dummy),400.00',
        '2026-02-03,FAKE DEPOSIT TWO (dummy),250.00',
        '2026-02-04,FAKE INTEREST (dummy),1.25',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      // A negative row proves the file is already signed, so it must not be flipped
      expect(txns.find((t) => t.description === 'FAKE TRANSFER FEE (dummy)')?.amount).toBe(-5.00);
      expect(txns.find((t) => t.description === 'FAKE DEPOSIT ONE (dummy)')?.amount).toBe(400.00);
      expect(txns.find((t) => t.description === 'FAKE INTEREST (dummy)')?.amount).toBe(1.25);
    });

    // @invariant NN-07
    test('treats accounting-parentheses amounts as signed', () => {
      const csv = [
        'Date,Description,Amount',
        '2026-02-01,FAKE FEE (dummy),(5.00)',
        '2026-02-02,FAKE DEPOSIT (dummy),400.00',
        '2026-02-03,FAKE DEPOSIT TWO (dummy),250.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns.find((t) => t.description === 'FAKE FEE (dummy)')?.amount).toBe(-5.00);
      expect(txns.find((t) => t.description === 'FAKE DEPOSIT (dummy)')?.amount).toBe(400.00);
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

  describe('Debit/Credit headers', () => {
    // @invariant NN-07
    test('Debit and Credit columns keep credit rows (debit negative, credit positive)', () => {
      const csv = [
        'Date,Description,Debit,Credit',
        '2026-02-01,PURCHASE,50.00,',
        '2026-02-02,PAYCHECK,,1200.00',
        '2026-02-03,REFUND,,20.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns.map((t) => t.amount)).toEqual([-50, 1200, 20]);
    });

    test('Debit/Credit take precedence over an Amount column', () => {
      const csv = [
        'Date,Description,Amount,Debit,Credit',
        '2026-02-01,PURCHASE,50.00,50.00,',
        '2026-02-02,PAYCHECK,1200.00,,1200.00',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-50, 1200]);
    });

    // @invariant NN-07
    test('falls back to the Amount column when split Payment/Credit cells are blank', () => {
      const csv = [
        'Date,Description,Amount,Payment,Credit',
        '2026-02-01,A,-5,,',
        '2026-02-02,B,10,,',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-5, 10]);
    });

    test('falls back to Amount per row when Amount+Debit+Credit split cells are empty', () => {
      const csv = [
        'Date,Description,Amount,Debit,Credit',
        '2026-02-01,A,-5,,',
        '2026-02-02,B,10,,',
        '2026-02-03,C,-7,7.00,',
        '2026-02-04,D,9,,9.00',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-5, 10, -7, 9]);
    });
  });

  describe('Debit/Credit edge cases (review findings)', () => {
    // @invariant NN-07
    test('unsigned Amount column: fallback rows are expenses (negative), not income', () => {
      // Amount repeats the debit/credit magnitude unsigned (positive = expense), so a
      // row with only an Amount must follow that convention.
      const csv = [
        'Date,Description,Amount,Debit,Credit',
        '2026-02-01,FAKE PURCHASE (dummy),50.00,50.00,',
        '2026-02-02,FAKE PAYCHECK (dummy),1200.00,,1200.00',
        '2026-02-03,FAKE AMOUNT ONLY (dummy),30.00,,',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-50, 1200, -30]);
    });

    test('"0.00" placeholder in the unused column does not win over the real value', () => {
      const csv = [
        'Date,Description,Debit,Credit',
        '2026-02-01,FAKE PURCHASE (dummy),50.00,0.00',
        '2026-02-02,FAKE PAYCHECK (dummy),0.00,1200.00',
        '2026-02-03,FAKE REFUND (dummy),$0.00,"$20.00"',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-50, 1200, 20]);
    });

    test('"0.00" placeholders in both split cells fall back to the Amount column', () => {
      const csv = [
        'Date,Description,Amount,Debit,Credit',
        '2026-02-01,FAKE A (dummy),-5.00,0.00,0.00',
        '2026-02-02,FAKE B (dummy),10.00,0.00,0.00',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-5, 10]);
    });

    test('blank rows (no debit, no credit, no amount) are skipped, not emitted as zero', () => {
      const csv = [
        'Date,Description,Debit,Credit',
        '2026-02-01,FAKE PURCHASE (dummy),50.00,',
        '2026-02-02,FAKE BLANK (dummy),,',
        '2026-02-03,FAKE ZERO (dummy),0.00,0.00',
        '2026-02-04,FAKE PAYCHECK (dummy),,1200.00',
      ].join('\n');

      const txns = parseGenericCSV(csv);
      expect(txns.map((t) => t.description)).toEqual(['FAKE PURCHASE (dummy)', 'FAKE PAYCHECK (dummy)']);
      expect(txns.map((t) => t.amount)).toEqual([-50, 1200]);
    });

    test('blank rows are skipped when an Amount column exists but is empty too', () => {
      const csv = [
        'Date,Description,Amount,Debit,Credit',
        '2026-02-01,FAKE BLANK (dummy),,,',
        '2026-02-02,FAKE PURCHASE (dummy),-5.00,5.00,',
      ].join('\n');

      expect(parseGenericCSV(csv).map((t) => t.amount)).toEqual([-5]);
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

  test('parses amounts with $, thousands separators and parentheses', () => {
    const csv = [
      'Date,Description,Amount',
      '2026-01-01,Rent,"-1,234.56"',
      '2026-01-02,Coffee,-4.50',
      '2026-01-03,Paycheck,"$2,000.00"',
      '2026-01-04,Refund,(12.00)',
    ].join('\n');

    const txns = parseGenericCSV(csv);
    expect(txns.map((t) => [t.description, t.amount])).toEqual([
      ['Rent', -1234.56],
      ['Coffee', -4.5],
      ['Paycheck', 2000],
      ['Refund', -12],
    ]);
  });

  test('parses debit/credit columns with thousands separators', () => {
    const csv = [
      'Date,Description,Withdrawal,Deposit',
      '2026-01-01,Rent,"1,234.56",',
      '2026-01-02,Paycheck,,"$2,000.00"',
    ].join('\n');

    const txns = parseGenericCSV(csv);
    expect(txns.map((t) => t.amount)).toEqual([-1234.56, 2000]);
  });
});
