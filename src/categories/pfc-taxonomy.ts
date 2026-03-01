/**
 * Plaid Financial Categories (PFC) v2 taxonomy.
 *
 * Industry-standard category codes used by Plaid's transaction enrichment API.
 * Agent Wilson adopts PFC as its canonical taxonomy so that bank-synced
 * transactions (Pro tier) arrive pre-categorised and CSV-imported
 * transactions use the same codes for consistency.
 */

// ---------------------------------------------------------------------------
// Primary categories (18)
// ---------------------------------------------------------------------------

export const PFC_PRIMARY = [
  'INCOME',
  'FOOD_AND_DRINK',
  'TRANSPORTATION',
  'RENT_AND_UTILITIES',
  'GENERAL_MERCHANDISE',
  'ENTERTAINMENT',
  'MEDICAL',
  'PERSONAL_CARE',
  'GENERAL_SERVICES',
  'HOME_IMPROVEMENT',
  'TRAVEL',
  'LOAN_PAYMENTS',
  'LOAN_DISBURSEMENTS',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'BANK_FEES',
  'GOVERNMENT_AND_NON_PROFIT',
  'OTHER',
] as const;

export type PfcPrimary = (typeof PFC_PRIMARY)[number];

// ---------------------------------------------------------------------------
// Detailed categories (120+)
// ---------------------------------------------------------------------------

export const PFC_DETAILED = [
  // INCOME
  'INCOME_SALARY',
  'INCOME_DIVIDENDS',
  'INCOME_TAX_REFUND',
  'INCOME_GIG_ECONOMY',
  'INCOME_RENTAL',
  'INCOME_INTEREST_EARNED',
  'INCOME_RETIREMENT_PENSION',
  'INCOME_WAGES',
  'INCOME_OTHER_INCOME',

  // FOOD_AND_DRINK
  'FOOD_AND_DRINK_GROCERIES',
  'FOOD_AND_DRINK_RESTAURANT',
  'FOOD_AND_DRINK_COFFEE',
  'FOOD_AND_DRINK_FAST_FOOD',
  'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR',
  'FOOD_AND_DRINK_VENDING_MACHINES',
  'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK',

  // TRANSPORTATION
  'TRANSPORTATION_GAS',
  'TRANSPORTATION_PARKING',
  'TRANSPORTATION_PUBLIC_TRANSIT',
  'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',
  'TRANSPORTATION_TOLLS',
  'TRANSPORTATION_OTHER_TRANSPORTATION',

  // RENT_AND_UTILITIES
  'RENT_AND_UTILITIES_RENT',
  'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
  'RENT_AND_UTILITIES_INTERNET_AND_CABLE',
  'RENT_AND_UTILITIES_WATER',
  'RENT_AND_UTILITIES_TELEPHONE',
  'RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT',
  'RENT_AND_UTILITIES_OTHER_UTILITIES',

  // GENERAL_MERCHANDISE
  'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES',
  'GENERAL_MERCHANDISE_ELECTRONICS',
  'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
  'GENERAL_MERCHANDISE_DEPARTMENT_STORES',
  'GENERAL_MERCHANDISE_DISCOUNT_STORES',
  'GENERAL_MERCHANDISE_SUPERSTORES',
  'GENERAL_MERCHANDISE_SPORTING_GOODS',
  'GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS',
  'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES',
  'GENERAL_MERCHANDISE_OFFICE_SUPPLIES',
  'GENERAL_MERCHANDISE_PET_SUPPLIES',
  'GENERAL_MERCHANDISE_TOBACCO_AND_VAPE',
  'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE',

  // ENTERTAINMENT
  'ENTERTAINMENT_TV_AND_MOVIES',
  'ENTERTAINMENT_VIDEO_GAMES',
  'ENTERTAINMENT_MUSIC_AND_AUDIO',
  'ENTERTAINMENT_CASINOS_AND_GAMBLING',
  'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS',
  'ENTERTAINMENT_OTHER_ENTERTAINMENT',

  // MEDICAL
  'MEDICAL_DENTAL_CARE',
  'MEDICAL_EYE_CARE',
  'MEDICAL_PHARMACIES_AND_SUPPLEMENTS',
  'MEDICAL_PRIMARY_CARE',
  'MEDICAL_VETERINARY_SERVICES',
  'MEDICAL_MENTAL_HEALTH_CARE',
  'MEDICAL_OTHER_MEDICAL',

  // PERSONAL_CARE
  'PERSONAL_CARE_GYMS_AND_FITNESS',
  'PERSONAL_CARE_HAIR_AND_BEAUTY',
  'PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING',
  'PERSONAL_CARE_OTHER_PERSONAL_CARE',

  // GENERAL_SERVICES
  'GENERAL_SERVICES_INSURANCE',
  'GENERAL_SERVICES_AUTOMOTIVE',
  'GENERAL_SERVICES_EDUCATION',
  'GENERAL_SERVICES_CHILDCARE',
  'GENERAL_SERVICES_CONSULTING_AND_LEGAL',
  'GENERAL_SERVICES_FINANCIAL_PLANNING_AND_INVESTMENTS',
  'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',
  'GENERAL_SERVICES_STORAGE',
  'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING',
  'GENERAL_SERVICES_OTHER_GENERAL_SERVICES',

  // HOME_IMPROVEMENT
  'HOME_IMPROVEMENT_FURNITURE',
  'HOME_IMPROVEMENT_HARDWARE',
  'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE',
  'HOME_IMPROVEMENT_SECURITY',
  'HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT',

  // TRAVEL
  'TRAVEL_FLIGHTS',
  'TRAVEL_LODGING',
  'TRAVEL_RENTAL_CARS',
  'TRAVEL_OTHER_TRAVEL',

  // LOAN_PAYMENTS
  'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
  'LOAN_PAYMENTS_CAR_PAYMENT',
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',
  'LOAN_PAYMENTS_INSURANCE_PAYMENT',
  'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT',
  'LOAN_PAYMENTS_OTHER_PAYMENT',

  // LOAN_DISBURSEMENTS (no detailed sub-categories in PFC v2)

  // TRANSFER_IN
  'TRANSFER_IN_DEPOSIT',
  'TRANSFER_IN_SAVINGS',
  'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_IN_WIRE',
  'TRANSFER_IN_OTHER_TRANSFER_IN',

  // TRANSFER_OUT
  'TRANSFER_OUT_WITHDRAWAL',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
  'TRANSFER_OUT_WIRE',
  'TRANSFER_OUT_OTHER_TRANSFER_OUT',

  // BANK_FEES
  'BANK_FEES_ATM_FEES',
  'BANK_FEES_OVERDRAFT_FEES',
  'BANK_FEES_INSUFFICIENT_FUNDS',
  'BANK_FEES_INTEREST_CHARGE',
  'BANK_FEES_LATE_PAYMENT_FEES',
  'BANK_FEES_OTHER_BANK_FEES',

  // GOVERNMENT_AND_NON_PROFIT
  'GOVERNMENT_AND_NON_PROFIT_DONATIONS',
  'GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT',
  'GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES',
  'GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT',

  // OTHER
  'OTHER_OTHER',
] as const;

export type PfcDetailed = (typeof PFC_DETAILED)[number];

// ---------------------------------------------------------------------------
// Primary sorted by length descending so longest-prefix matching works.
// ---------------------------------------------------------------------------

const PRIMARY_BY_LENGTH = [...PFC_PRIMARY].sort(
  (a, b) => b.length - a.length,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary category from a detailed PFC code.
 *
 * Example: `FOOD_AND_DRINK_GROCERIES` -> `FOOD_AND_DRINK`
 */
export function getPrimaryFromDetailed(detailed: string): PfcPrimary {
  for (const primary of PRIMARY_BY_LENGTH) {
    if (detailed.startsWith(primary + '_') || detailed === primary) {
      return primary as PfcPrimary;
    }
  }
  return 'OTHER';
}

/**
 * Convert a detailed PFC code to a human-readable display name.
 *
 * Example: `FOOD_AND_DRINK_GROCERIES` -> `Groceries`
 * Example: `TRANSPORTATION_TAXIS_AND_RIDE_SHARES` -> `Taxis & Ride Shares`
 */
export function getDisplayName(detailed: string): string {
  const primary = getPrimaryFromDetailed(detailed);
  const suffix = detailed.startsWith(primary + '_')
    ? detailed.slice(primary.length + 1)
    : detailed;

  return suffix
    .split('_')
    .map((word) => (word === 'AND' ? '&' : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Freeform -> PFC migration map
// ---------------------------------------------------------------------------

/**
 * Maps legacy Agent Wilson freeform category strings (from categories.ts)
 * to their closest PFC detailed code.
 */
export const FREEFORM_TO_PFC: Record<string, PfcDetailed> = {
  'Dining': 'FOOD_AND_DRINK_RESTAURANT',
  'Groceries': 'FOOD_AND_DRINK_GROCERIES',
  'Transport': 'TRANSPORTATION_OTHER_TRANSPORTATION',
  'Shopping': 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE',
  'Subscriptions': 'ENTERTAINMENT_TV_AND_MOVIES',
  'Utilities': 'RENT_AND_UTILITIES_OTHER_UTILITIES',
  'Health': 'MEDICAL_OTHER_MEDICAL',
  'Entertainment': 'ENTERTAINMENT_OTHER_ENTERTAINMENT',
  'Travel': 'TRAVEL_OTHER_TRAVEL',
  'Education': 'GENERAL_SERVICES_EDUCATION',
  'Home': 'HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT',
  'Personal Care': 'PERSONAL_CARE_OTHER_PERSONAL_CARE',
  'Insurance': 'GENERAL_SERVICES_INSURANCE',
  'Gifts': 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES',
  'Fees & Interest': 'BANK_FEES_OTHER_BANK_FEES',
  'Income': 'INCOME_OTHER_INCOME',
  'Transfer': 'TRANSFER_OUT_OTHER_TRANSFER_OUT',
  'Other': 'OTHER_OTHER',
};
