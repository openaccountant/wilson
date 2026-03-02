import { describe, expect, test } from 'bun:test';
import {
  getPrimaryFromDetailed,
  getDisplayName,
  FREEFORM_TO_PFC,
  PFC_PRIMARY,
  PFC_DETAILED,
} from '../categories/pfc-taxonomy.js';

describe('getPrimaryFromDetailed', () => {
  test('extracts FOOD_AND_DRINK from FOOD_AND_DRINK_GROCERIES', () => {
    expect(getPrimaryFromDetailed('FOOD_AND_DRINK_GROCERIES')).toBe('FOOD_AND_DRINK');
  });

  test('extracts TRANSPORTATION from TRANSPORTATION_GAS', () => {
    expect(getPrimaryFromDetailed('TRANSPORTATION_GAS')).toBe('TRANSPORTATION');
  });

  test('extracts INCOME from INCOME_SALARY', () => {
    expect(getPrimaryFromDetailed('INCOME_SALARY')).toBe('INCOME');
  });

  test('handles GOVERNMENT_AND_NON_PROFIT prefix (longest match)', () => {
    expect(getPrimaryFromDetailed('GOVERNMENT_AND_NON_PROFIT_DONATIONS')).toBe('GOVERNMENT_AND_NON_PROFIT');
  });

  test('returns exact match for primary-only codes', () => {
    expect(getPrimaryFromDetailed('OTHER')).toBe('OTHER');
  });

  test('returns OTHER for unknown codes', () => {
    expect(getPrimaryFromDetailed('TOTALLY_UNKNOWN_THING')).toBe('OTHER');
  });
});

describe('getDisplayName', () => {
  test('converts FOOD_AND_DRINK_GROCERIES to "Groceries"', () => {
    expect(getDisplayName('FOOD_AND_DRINK_GROCERIES')).toBe('Groceries');
  });

  test('converts TRANSPORTATION_TAXIS_AND_RIDE_SHARES with & for AND', () => {
    expect(getDisplayName('TRANSPORTATION_TAXIS_AND_RIDE_SHARES')).toBe('Taxis & Ride Shares');
  });

  test('converts INCOME_SALARY to "Salary"', () => {
    expect(getDisplayName('INCOME_SALARY')).toBe('Salary');
  });

  test('word casing: first letter upper, rest lower', () => {
    expect(getDisplayName('BANK_FEES_ATM_FEES')).toBe('Atm Fees');
  });
});

describe('FREEFORM_TO_PFC', () => {
  test('all mapped values are valid PFC_DETAILED codes', () => {
    const detailedSet = new Set(PFC_DETAILED as readonly string[]);
    for (const [freeform, pfc] of Object.entries(FREEFORM_TO_PFC)) {
      expect(detailedSet.has(pfc)).toBe(true);
    }
  });

  test('maps common categories', () => {
    expect(FREEFORM_TO_PFC['Dining']).toBe('FOOD_AND_DRINK_RESTAURANT');
    expect(FREEFORM_TO_PFC['Groceries']).toBe('FOOD_AND_DRINK_GROCERIES');
    expect(FREEFORM_TO_PFC['Income']).toBe('INCOME_OTHER_INCOME');
  });
});
