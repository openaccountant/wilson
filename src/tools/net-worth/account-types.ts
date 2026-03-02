// ── Account Type Taxonomy ────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ['asset', 'liability'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ASSET_SUBTYPES = [
  'checking',
  'savings',
  'investment',
  'real_estate',
  'vehicle',
  'cash',
  'crypto',
  'other_asset',
] as const;

export const LIABILITY_SUBTYPES = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
  'credit_card',
  'heloc',
  'medical_debt',
  'other_liability',
] as const;

export type AssetSubtype = (typeof ASSET_SUBTYPES)[number];
export type LiabilitySubtype = (typeof LIABILITY_SUBTYPES)[number];
export type AccountSubtype = AssetSubtype | LiabilitySubtype;

export const ACCOUNT_SUBTYPES: readonly AccountSubtype[] = [
  ...ASSET_SUBTYPES,
  ...LIABILITY_SUBTYPES,
];

export const AMORTIZABLE_SUBTYPES: readonly LiabilitySubtype[] = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'personal_loan',
];

export const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  checking: 'Checking',
  savings: 'Savings',
  investment: 'Investment',
  real_estate: 'Real Estate',
  vehicle: 'Vehicle',
  cash: 'Cash',
  crypto: 'Crypto',
  other_asset: 'Other Asset',
  mortgage: 'Mortgage',
  auto_loan: 'Auto Loan',
  student_loan: 'Student Loan',
  personal_loan: 'Personal Loan',
  credit_card: 'Credit Card',
  heloc: 'HELOC',
  medical_debt: 'Medical Debt',
  other_liability: 'Other Liability',
};

export function isAssetSubtype(subtype: string): subtype is AssetSubtype {
  return (ASSET_SUBTYPES as readonly string[]).includes(subtype);
}

export function isLiabilitySubtype(subtype: string): subtype is LiabilitySubtype {
  return (LIABILITY_SUBTYPES as readonly string[]).includes(subtype);
}

export function getAccountTypeForSubtype(subtype: AccountSubtype): AccountType {
  return isAssetSubtype(subtype) ? 'asset' : 'liability';
}
