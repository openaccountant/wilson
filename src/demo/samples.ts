/**
 * Synthetic sample transactions for the demo-table Speed Showdown.
 *
 * Ground-truth fixtures that live in the repo itself: the showdown arms are
 * only ever built from these rows (id-only API contract — see showdown.ts),
 * so a real-mode payload can never contain a row an attendee imported.
 *
 * Every field is fixed — no clock reads, no randomness — so the payload
 * exhibit is deterministic across runs and machines.
 */

export interface SampleTransaction {
  /** Stable numeric id used inside the categorization prompt. */
  id: number;
  /** Stable UI/API key, e.g. 'harborview-dental'. */
  slug: string;
  /** Fixed YYYY-MM-DD — deterministic, no clock reads. */
  date: string;
  description: string;
  amount: number;
  /** Ground truth; must be a member of CATEGORIES. */
  expectedCategory: string;
  /** Demo note shown in the picker. */
  note?: string;
}

export const SAMPLE_TRANSACTIONS: SampleTransaction[] = [
  {
    id: 1,
    slug: 'corner-market',
    date: '2026-09-14',
    description: 'CORNER MARKET #1247',
    amount: -42.67,
    expectedCategory: 'Groceries',
  },
  {
    id: 2,
    slug: 'harborview-dental',
    date: '2026-09-14',
    description: 'HARBORVIEW DENTAL GROUP',
    amount: -318.0,
    expectedCategory: 'Health',
    note: 'The $318 row — the demo pick',
  },
  {
    id: 3,
    slug: 'netflix',
    date: '2026-09-15',
    description: 'NETFLIX.COM',
    amount: -15.99,
    expectedCategory: 'Subscriptions',
  },
  {
    id: 4,
    slug: 'payroll-acme',
    date: '2026-09-15',
    description: 'PAYROLL DEPOSIT - ACME CORP',
    amount: 3200.0,
    expectedCategory: 'Income',
    note: 'Positive amount — the sign-convention case',
  },
  {
    id: 5,
    slug: 'oak-street-coffee',
    date: '2026-09-16',
    description: 'OAK STREET COFFEE',
    amount: -5.75,
    expectedCategory: 'Dining',
  },
  {
    id: 6,
    slug: 'venmo-transfer',
    date: '2026-09-16',
    description: 'VENMO - TRANSFER TO OWN ACCOUNT',
    amount: -250.0,
    expectedCategory: 'Transfer',
    note: 'Rubric rule 5 — transfers between own accounts',
  },
  {
    id: 7,
    slug: 'atm-fee',
    date: '2026-09-17',
    description: 'ATM WITHDRAWAL FEE',
    amount: -3.5,
    expectedCategory: 'Fees & Interest',
    note: 'The ampersand category',
  },
  {
    id: 8,
    slug: 'city-electric',
    date: '2026-09-17',
    description: 'CITY ELECTRIC CO AUTOPAY',
    amount: -128.5,
    expectedCategory: 'Utilities',
  },
];

/**
 * Look up a sample by its stable slug. Throws on unknown ids — the API layer
 * turns that into a 400, and nothing else can ever reach the prompt builder.
 */
export function getSampleBySlug(slug: string): SampleTransaction {
  const sample = SAMPLE_TRANSACTIONS.find((s) => s.slug === slug);
  if (!sample) {
    throw new Error(`Unknown sample slug: ${slug}`);
  }
  return sample;
}