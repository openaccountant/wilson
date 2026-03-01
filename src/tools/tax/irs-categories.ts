/**
 * IRS Schedule C deduction categories for self-employed individuals.
 */
export const IRS_CATEGORIES = [
  'Advertising',
  'Car and truck expenses',
  'Commissions and fees',
  'Contract labor',
  'Depreciation',
  'Employee benefit programs',
  'Insurance (other than health)',
  'Interest (mortgage)',
  'Interest (other)',
  'Legal and professional services',
  'Office expense',
  'Pension and profit-sharing plans',
  'Rent or lease (vehicles/equipment)',
  'Rent or lease (other)',
  'Repairs and maintenance',
  'Supplies',
  'Taxes and licenses',
  'Travel',
  'Meals (business)',
  'Utilities',
  'Wages',
  'Other expenses',
] as const;

export type IrsCategory = (typeof IRS_CATEGORIES)[number];
