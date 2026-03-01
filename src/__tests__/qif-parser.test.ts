import { describe, expect, test } from 'bun:test';
import { parseQif, parseQifDate, isQifContent } from '../tools/import/parsers/qif.js';

describe('QIF Parser', () => {
  describe('Basic transactions', () => {
    const qifContent = `!Type:Bank
D03/15/2026
T-85.50
PWhole Foods Market
LFood:Groceries
MGrocery shopping
^
D03/10/2026
T3500.00
PEmployer Inc
LIncome:Salary
^
D03/20/2026
T-150.00
N1234
PJohn Smith
LPersonal
MRent payment
C*
^`;

    test('returns 3 transactions', () => {
      const txns = parseQif(qifContent);
      expect(txns).toHaveLength(3);
    });

    test('first transaction fields', () => {
      const txns = parseQif(qifContent);
      const first = txns[0];
      expect(first.date).toBe('2026-03-15');
      expect(first.description).toBe('Whole Foods Market');
      expect(first.amount).toBe(-85.50);
      expect(first.bank).toBe('qif');
      expect(first.category).toBe('Food:Groceries');
      expect(first.merchant_name).toBe('Whole Foods Market');
    });

    test('second transaction — income', () => {
      const txns = parseQif(qifContent);
      const second = txns[1];
      expect(second.amount).toBe(3500.00);
      expect(second.category).toBe('Income:Salary');
    });

    test('third transaction — check number', () => {
      const txns = parseQif(qifContent);
      const third = txns[2];
      expect(third.check_number).toBe('1234');
      expect(third.external_id).toBe('1234');
    });
  });

  describe('Split transactions', () => {
    const splitQif = `!Type:Bank
D03/25/2026
T-200.00
PCostco
SFood:Groceries
EGrocery items
$-150.00
SGeneral:Household
EHousehold supplies
$-50.00
^`;

    test('produces one entry per split', () => {
      const txns = parseQif(splitQif);
      expect(txns).toHaveLength(2);
    });

    test('split amounts are correct', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].amount).toBe(-150.00);
      expect(txns[1].amount).toBe(-50.00);
    });

    test('splits inherit parent payee', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].description).toBe('Costco');
      expect(txns[1].description).toBe('Costco');
      expect(txns[0].merchant_name).toBe('Costco');
      expect(txns[1].merchant_name).toBe('Costco');
    });

    test('splits have their own categories', () => {
      const txns = parseQif(splitQif);
      expect(txns[0].category).toBe('Food:Groceries');
      expect(txns[1].category).toBe('General:Household');
    });
  });

  describe('Date parsing', () => {
    test('M/D\'YY format', () => {
      expect(parseQifDate("1/5'26")).toBe('2026-01-05');
    });

    test('MM/DD/YYYY format', () => {
      expect(parseQifDate('01/05/2026')).toBe('2026-01-05');
    });

    test('M-D-YYYY format', () => {
      expect(parseQifDate('1-5-2026')).toBe('2026-01-05');
    });

    test('MM/DD/YYYY end of year', () => {
      expect(parseQifDate('12/31/2025')).toBe('2025-12-31');
    });

    test('M-D\'YY format', () => {
      expect(parseQifDate("3-5'26")).toBe('2026-03-05');
    });

    test('single digit month and day with full year', () => {
      expect(parseQifDate('3/5/2026')).toBe('2026-03-05');
    });
  });

  describe('Category to PFC mapping', () => {
    test('maps Food:Groceries to PFC code', () => {
      const qif = `!Type:Bank
D01/01/2026
T-50.00
PStore
LFood:Groceries
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBe('FOOD_AND_DRINK_GROCERIES');
    });

    test('unknown category has no PFC mapping', () => {
      const qif = `!Type:Bank
D01/01/2026
T-50.00
PStore
LUnknown:Something
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBeUndefined();
    });

    test('maps bare category name (Income)', () => {
      const qif = `!Type:Bank
D01/01/2026
T1000.00
PEmployer
LIncome
^`;
      const txns = parseQif(qif);
      expect(txns[0].category_detailed).toBe('INCOME_OTHER_INCOME');
    });
  });

  describe('isQifContent detection', () => {
    test('detects !Type:Bank header', () => {
      expect(isQifContent('!Type:Bank\nD01/01/2026\nT-50\n^')).toBe(true);
    });

    test('detects !Type:CCard header', () => {
      expect(isQifContent('!Type:CCard\nD01/01/2026\n')).toBe(true);
    });

    test('rejects CSV content', () => {
      expect(isQifContent('Date,Description,Amount\n01/01/2026,Store,50.00')).toBe(false);
    });

    test('detects QIF pattern without type header', () => {
      expect(isQifContent('D01/01/2026\nT-50.00\nPStore\n^')).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('missing payee uses memo as description', () => {
      const qif = `!Type:Bank
D01/01/2026
T-25.00
MSome memo note
^`;
      const txns = parseQif(qif);
      expect(txns[0].description).toBe('Some memo note');
    });

    test('missing payee and memo uses Unknown', () => {
      const qif = `!Type:Bank
D01/01/2026
T-10.00
^`;
      const txns = parseQif(qif);
      expect(txns[0].description).toBe('Unknown');
    });

    test('empty records (just ^) are skipped', () => {
      const qif = `!Type:Bank
^
D01/01/2026
T-10.00
PStore
^
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
    });

    test('credit card type header is accepted', () => {
      const qif = `!Type:CCard
D01/01/2026
T-75.00
PAmazon
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].bank).toBe('qif');
    });

    test('no trailing ^ still produces transaction', () => {
      const qif = `!Type:Bank
D06/15/2026
T-30.00
PCoffee Shop`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].description).toBe('Coffee Shop');
    });

    test('transaction with no amount defaults to 0', () => {
      const qif = `!Type:Bank
D01/01/2026
PSomething
^`;
      const txns = parseQif(qif);
      expect(txns).toHaveLength(1);
      expect(txns[0].amount).toBe(0);
    });
  });
});
