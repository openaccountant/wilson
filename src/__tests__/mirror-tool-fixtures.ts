// Shared seed for the mirror tool parity / divergence / port suites.
//
// Server db + mirror db are built from the same rows, the mirror via the sync
// engine's own raw pulls (apiTransactions / apiEntities / apiBudgetLimits /
// apiCategories) so what the mirror holds is exactly what a real sync stores.
//
// Float discipline: every amount is exactly representable (halves, quarters,
// integers) so SUM is order-insensitive. Every transaction has a UNIQUE date so
// "ORDER BY date DESC" has no ties and server/mirror row order is deterministic.
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';
import { insertTransactions, type TransactionInsert } from '../db/queries.js';
import {
  deactivateAccount,
  insertAccount,
  insertBalanceSnapshot,
  insertLoan,
} from '../db/net-worth-queries.js';
import { apiTransactions, apiEntities, apiBudgetLimits, apiCategories, apiAccounts } from '../dashboard/api.js';
import { syncBalanceSnapshotRows, syncLoanRows } from '../dashboard/sync-routes.js';
import { applySync } from '../dashboard/ui/src/store/mirror-schema.js';
import { createMirrorDb } from './mirror-helpers.js';
import type {
  MirrorTransactionRow,
  MirrorEntityRow,
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorAccountRow,
  MirrorBalanceSnapshotRow,
  MirrorLoanRow,
} from '../dashboard/ui/src/store/types.js';
import type { MirrorTestBinding } from './mirror-helpers.js';

/** The instant every parity test pins the clock to. */
export const PARITY_NOW = '2026-07-15T12:00:00';

type Seed = Omit<TransactionInsert, 'description' | 'amount' | 'date'> & { date: string; description: string; amount: number };

const NAMED: Seed[] = [
  { date: '2024-06-10', description: 'Old Hardware Store', amount: -30, category: 'Shopping' },
  { date: '2025-10-03', description: 'Whole Foods Market', amount: -85.5, category: 'Groceries' },
  { date: '2025-10-12', description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: '2025-10-20', description: 'Chipotle', amount: -18.25, category: 'Dining' },
  { date: '2026-03-02', description: 'Whole Foods Market', amount: -92.5, category: 'Groceries' },
  { date: '2026-03-05', description: 'Netflix', amount: -15.5, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-03-09', description: 'Amazon purchase', amount: -140.25, category: 'Shopping' },
  { date: '2026-03-14', description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: '2026-03-20', description: 'Transfer to savings', amount: -500, category: 'Transfer' },
  { date: '2026-04-03', description: 'Whole Foods Market', amount: -77.75, category: 'Groceries' },
  { date: '2026-04-06', description: 'Netflix', amount: -15.5, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-04-10', description: 'Electric Company', amount: -130.5, category: 'Utilities' },
  { date: '2026-04-14', description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: '2026-04-21', description: 'Adobe Creative Cloud', amount: -59.75, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-05-02', description: 'Uber trip', amount: -18.5, category: 'Transport' },
  { date: '2026-05-05', description: 'Netflix', amount: -15.5, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-05-09', description: 'Amazon purchase', amount: -64.25, category: 'Shopping' },
  { date: '2026-05-14', description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: '2026-05-17', description: 'Unknown Purchase', amount: -20 },
  { date: '2026-05-28', description: 'Bank fee', amount: -12, category: 'Fees & Interest' },
  { date: '2026-06-01', description: 'Whole Foods Market', amount: -101.5, category: 'Groceries' },
  { date: '2026-06-04', description: 'Netflix', amount: -15.5, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-06-07', description: 'Restaurant', amount: -55.25, category: 'Dining' },
  { date: '2026-06-11', description: 'Adobe Creative Cloud', amount: -59.75, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-06-14', description: 'Paycheck', amount: 3500, category: 'Income' },
  { date: '2026-06-19', description: 'Electric Company', amount: -140.25, category: 'Utilities' },
  { date: '2026-06-25', description: 'Store refund', amount: 25 },
  { date: '2026-06-28', description: 'Freelance invoice', amount: 1200, category: 'Income' },
  { date: '2026-07-02', description: 'Whole Foods Market', amount: -88.5, category: 'Groceries' },
  { date: '2026-07-04', description: 'Netflix', amount: -15.5, category: 'Subscriptions', is_recurring: 1 },
  { date: '2026-07-08', description: 'Restaurant', amount: -41.25, category: 'Dining' },
  { date: '2026-07-09', description: 'Gas Station', amount: -45.5, category: 'Transport' },
  { date: '2026-07-14', description: 'Paycheck', amount: 3500, category: 'Income' },
];

/** 120 "Coffee Shop" rows on 120 distinct days (2025-11-01 ..), so a merchant query exceeds the 100-row cap. */
function coffeeRows(): Seed[] {
  const rows: Seed[] = [];
  const start = new Date(Date.UTC(2025, 10, 1));
  for (let i = 0; i < 120; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    rows.push({ date: d.toISOString().slice(0, 10), description: 'Coffee Shop', amount: -4.25, category: 'Dining' });
  }
  return rows;
}

export interface ParityFixture {
  serverDb: Database;
  mirror: MirrorTestBinding;
}

export async function buildParityFixture(): Promise<ParityFixture> {
  const serverDb = createTestDb();
  insertTransactions(serverDb, [...NAMED, ...coffeeRows()] as TransactionInsert[]);
  const mirror = await createMirrorDb();
  await applySync(mirror, {
    profile: 'default',
    transactions: apiTransactions(serverDb, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
    entities: apiEntities(serverDb) as unknown as MirrorEntityRow[],
    budgets: apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[],
    categories: apiCategories(serverDb) as unknown as MirrorCategoryRow[],
  });
  return { serverDb, mirror };
}


/**
 * The parity fixture plus a net-worth book: assets of every cash/non-cash
 * subtype, a mortgage and an auto loan linked to their assets (equity rows), a
 * credit card, and INACTIVE accounts/loans that every tool must ignore.
 * Balances are exactly representable (halves/quarters) so SUMs are
 * order-insensitive.
 */
export async function buildNetWorthFixture(): Promise<ParityFixture> {
  const serverDb = createTestDb();
  insertTransactions(serverDb, [...NAMED, ...coffeeRows()] as TransactionInsert[]);

  const checking = insertAccount(serverDb, { name: 'Everyday Checking', account_type: 'asset', account_subtype: 'checking', institution: 'Test Bank', account_number_last4: '1234', current_balance: 4000.5 });
  const savings = insertAccount(serverDb, { name: 'Rainy Day', account_type: 'asset', account_subtype: 'savings', institution: 'Test Bank', current_balance: 12000.25 });
  insertAccount(serverDb, { name: 'Wallet', account_type: 'asset', account_subtype: 'cash', current_balance: 250 });
  insertAccount(serverDb, { name: 'Brokerage', account_type: 'asset', account_subtype: 'investment', institution: 'Broker Co', current_balance: 50000.75 });
  const house = insertAccount(serverDb, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
  const car = insertAccount(serverDb, { name: 'Car', account_type: 'asset', account_subtype: 'vehicle', current_balance: 15000 });
  const mortgage = insertAccount(serverDb, { name: 'Home Loan', account_type: 'liability', account_subtype: 'mortgage', institution: 'Lender Inc', current_balance: 250000.5 });
  const card = insertAccount(serverDb, { name: 'Visa', account_type: 'liability', account_subtype: 'credit_card', institution: 'Card Co', current_balance: 1200.75 });
  const autoLoan = insertAccount(serverDb, { name: 'Car Loan', account_type: 'liability', account_subtype: 'auto_loan', current_balance: 8000 });
  // Inactive: must not count anywhere (cash would change the forecast's starting cash).
  const oldChecking = insertAccount(serverDb, { name: 'Old Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 999 });
  const oldLoanAcct = insertAccount(serverDb, { name: 'Old Loan', account_type: 'liability', account_subtype: 'personal_loan', current_balance: 500 });
  deactivateAccount(serverDb, oldChecking);
  deactivateAccount(serverDb, oldLoanAcct);

  insertLoan(serverDb, { account_id: mortgage, original_principal: 300000, interest_rate: 6.5, term_months: 360, start_date: '2020-01-01', extra_payment: 100, linked_asset_id: house });
  insertLoan(serverDb, { account_id: autoLoan, original_principal: 20000, interest_rate: 4.25, term_months: 60, start_date: '2024-03-01', linked_asset_id: car });
  insertLoan(serverDb, { account_id: oldLoanAcct, original_principal: 1000, interest_rate: 5, term_months: 12, start_date: '2025-01-01' });

  for (const [date, a, l] of [
    ['2026-03-31', 3000.5, 1100.25],
    ['2026-05-31', 3500.5, 1150.5],
    ['2026-06-30', 4000.5, 1200.75],
  ] as const) {
    insertBalanceSnapshot(serverDb, { account_id: checking, balance: a, snapshot_date: date });
    insertBalanceSnapshot(serverDb, { account_id: savings, balance: a * 3, snapshot_date: date });
    insertBalanceSnapshot(serverDb, { account_id: card, balance: l, snapshot_date: date });
  }
  insertBalanceSnapshot(serverDb, { account_id: oldChecking, balance: 999, snapshot_date: '2026-06-30' });

  const mirror = await createMirrorDb();
  await applySync(mirror, {
    profile: 'default',
    transactions: apiTransactions(serverDb, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[],
    entities: apiEntities(serverDb) as unknown as MirrorEntityRow[],
    budgets: apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[],
    categories: apiCategories(serverDb) as unknown as MirrorCategoryRow[],
    accounts: apiAccounts(serverDb) as unknown as MirrorAccountRow[],
    balanceSnapshots: syncBalanceSnapshotRows(serverDb) as unknown as MirrorBalanceSnapshotRow[],
    loans: syncLoanRows(serverDb) as unknown as MirrorLoanRow[],
  });
  return { serverDb, mirror };
}
