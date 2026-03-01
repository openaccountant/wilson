/**
 * Standard spending categories for Open Accountant transaction classification.
 */
export const CATEGORIES: string[] = [
  'Dining',
  'Groceries',
  'Transport',
  'Shopping',
  'Subscriptions',
  'Utilities',
  'Health',
  'Entertainment',
  'Travel',
  'Education',
  'Home',
  'Personal Care',
  'Insurance',
  'Gifts',
  'Fees & Interest',
  'Income',
  'Transfer',
  'Other',
];

/**
 * Short descriptions for each category, useful for LLM prompts and UI display.
 */
export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  'Dining': 'Restaurants, fast food, coffee shops, bars, takeout',
  'Groceries': 'Supermarkets, grocery stores, farmers markets, food delivery',
  'Transport': 'Gas, ride-share, parking, tolls, public transit, car maintenance',
  'Shopping': 'Retail, clothing, electronics, household items, online shopping',
  'Subscriptions': 'Streaming services, software, memberships, recurring digital services',
  'Utilities': 'Electric, gas, water, internet, phone, trash',
  'Health': 'Doctor visits, pharmacy, dental, vision, gym, fitness',
  'Entertainment': 'Movies, concerts, games, hobbies, sports events',
  'Travel': 'Flights, hotels, rental cars, vacation expenses',
  'Education': 'Tuition, books, courses, training, school supplies',
  'Home': 'Rent, mortgage, repairs, furniture, home improvement',
  'Personal Care': 'Haircuts, salon, skincare, spa',
  'Insurance': 'Health, auto, home, life, renters insurance premiums',
  'Gifts': 'Gifts for others, donations, charitable contributions',
  'Fees & Interest': 'Bank fees, ATM fees, credit card interest, late fees',
  'Income': 'Salary, freelance income, refunds, reimbursements',
  'Transfer': 'Account transfers, Venmo/Zelle/PayPal between own accounts',
  'Other': 'Transactions that do not fit any other category',
};
