import type { AccountSubtype } from '../tools/net-worth/account-types.js';

const PLAID_SUBTYPE_MAP: Record<string, AccountSubtype> = {
  'depository/checking': 'checking',
  'depository/savings': 'savings',
  'depository/money market': 'savings',
  'depository/cd': 'savings',
  'credit/credit card': 'credit_card',
  'loan/mortgage': 'mortgage',
  'loan/auto': 'auto_loan',
  'loan/student': 'student_loan',
  'loan/personal': 'personal_loan',
  'loan/home equity': 'heloc',
  'investment/401k': 'investment',
  'investment/ira': 'investment',
  'investment/brokerage': 'investment',
  'investment/roth': 'investment',
};

/**
 * Map a Plaid account type/subtype pair to our AccountSubtype taxonomy.
 */
export function mapPlaidTypeToSubtype(
  plaidType: string,
  plaidSubtype: string,
): AccountSubtype {
  const key = `${plaidType}/${plaidSubtype}`.toLowerCase();
  return (
    PLAID_SUBTYPE_MAP[key] ??
    (plaidType === 'loan' || plaidType === 'credit' ? 'other_liability' : 'other_asset')
  );
}
