import { describe, test, expect } from 'bun:test';
import {
  isAssetSubtype,
  isLiabilitySubtype,
  getAccountTypeForSubtype,
  ASSET_SUBTYPES,
  LIABILITY_SUBTYPES,
  ACCOUNT_SUBTYPES,
  SUBTYPE_LABELS,
  AMORTIZABLE_SUBTYPES,
} from '../tools/net-worth/account-types.js';

describe('account-types', () => {
  describe('isAssetSubtype', () => {
    test('returns true for all asset subtypes', () => {
      for (const subtype of ASSET_SUBTYPES) {
        expect(isAssetSubtype(subtype)).toBe(true);
      }
    });

    test('returns false for liability subtypes', () => {
      for (const subtype of LIABILITY_SUBTYPES) {
        expect(isAssetSubtype(subtype)).toBe(false);
      }
    });

    test('returns false for unknown string', () => {
      expect(isAssetSubtype('unknown')).toBe(false);
      expect(isAssetSubtype('')).toBe(false);
    });
  });

  describe('isLiabilitySubtype', () => {
    test('returns true for all liability subtypes', () => {
      for (const subtype of LIABILITY_SUBTYPES) {
        expect(isLiabilitySubtype(subtype)).toBe(true);
      }
    });

    test('returns false for asset subtypes', () => {
      for (const subtype of ASSET_SUBTYPES) {
        expect(isLiabilitySubtype(subtype)).toBe(false);
      }
    });

    test('returns false for unknown string', () => {
      expect(isLiabilitySubtype('unknown')).toBe(false);
      expect(isLiabilitySubtype('')).toBe(false);
    });
  });

  describe('getAccountTypeForSubtype', () => {
    test('returns asset for asset subtypes', () => {
      expect(getAccountTypeForSubtype('checking')).toBe('asset');
      expect(getAccountTypeForSubtype('savings')).toBe('asset');
      expect(getAccountTypeForSubtype('investment')).toBe('asset');
      expect(getAccountTypeForSubtype('real_estate')).toBe('asset');
      expect(getAccountTypeForSubtype('vehicle')).toBe('asset');
      expect(getAccountTypeForSubtype('cash')).toBe('asset');
      expect(getAccountTypeForSubtype('crypto')).toBe('asset');
      expect(getAccountTypeForSubtype('other_asset')).toBe('asset');
    });

    test('returns liability for liability subtypes', () => {
      expect(getAccountTypeForSubtype('mortgage')).toBe('liability');
      expect(getAccountTypeForSubtype('auto_loan')).toBe('liability');
      expect(getAccountTypeForSubtype('student_loan')).toBe('liability');
      expect(getAccountTypeForSubtype('personal_loan')).toBe('liability');
      expect(getAccountTypeForSubtype('credit_card')).toBe('liability');
      expect(getAccountTypeForSubtype('heloc')).toBe('liability');
      expect(getAccountTypeForSubtype('medical_debt')).toBe('liability');
      expect(getAccountTypeForSubtype('other_liability')).toBe('liability');
    });
  });

  describe('constants', () => {
    test('ACCOUNT_SUBTYPES contains all asset and liability subtypes', () => {
      for (const subtype of ASSET_SUBTYPES) {
        expect(ACCOUNT_SUBTYPES).toContain(subtype);
      }
      for (const subtype of LIABILITY_SUBTYPES) {
        expect(ACCOUNT_SUBTYPES).toContain(subtype);
      }
      expect(ACCOUNT_SUBTYPES.length).toBe(ASSET_SUBTYPES.length + LIABILITY_SUBTYPES.length);
    });

    test('SUBTYPE_LABELS has entry for every subtype', () => {
      for (const subtype of ACCOUNT_SUBTYPES) {
        expect(typeof SUBTYPE_LABELS[subtype]).toBe('string');
        expect(SUBTYPE_LABELS[subtype].length).toBeGreaterThan(0);
      }
    });

    test('AMORTIZABLE_SUBTYPES are all liability subtypes', () => {
      for (const subtype of AMORTIZABLE_SUBTYPES) {
        expect(isLiabilitySubtype(subtype)).toBe(true);
      }
    });
  });
});
