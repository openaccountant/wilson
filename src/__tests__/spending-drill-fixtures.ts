// Seeded fixture for the spending-drill endpoint tests (unit + parity).
//
// Fixed absolute dates (Jan–Jun 2026) with a deliberate GAP month (April has
// no transactions at all → outside coverage → null in series / compare), and
// binary-exact amounts (halves, quarters, integers) so SUM is order-insensitive
// across SQLite engines.
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { createEntity } from '../db/entity-queries.js';

export interface DrillFixture {
  db: Database;
  accountId: number;
  bizEntityId: number;
  defaultEntityId: number;
}

const FF = 'FOOD_AND_DRINK_FAST_FOOD';
const REST = 'FOOD_AND_DRINK_RESTAURANT';

export function seedDrillFixture(db: Database = createTestDb()): DrillFixture {
  insertTransactions(db, [
    // January (coverage starts 2026-01-10)
    { date: '2026-01-10', description: 'CHIPOTLE 1234', merchant_name: 'Chipotle', amount: -20, category: 'Dining', category_detailed: FF },
    { date: '2026-01-12', description: 'TRADER JOES #123', merchant_name: 'Trader Joes', amount: -50, category: 'Groceries' },
    // February: groceries only (Dining covered-but-zero)
    { date: '2026-02-03', description: 'TRADER JOES #123', merchant_name: 'Trader Joes', amount: -40, category: 'Groceries' },
    // March
    { date: '2026-03-05', description: 'KFC', amount: -10, category: 'Dining', category_detailed: FF },
    // April: NOTHING (gap month)
    // May: the main period
    { date: '2026-05-02', description: 'CHIPOTLE 1234', merchant_name: 'Chipotle', amount: -15.5, category: 'Dining', category_detailed: FF },
    { date: '2026-05-03', description: 'CHIPOTLE 5678', merchant_name: 'Chipotle', amount: -12.25, category: 'Dining', category_detailed: FF },
    { date: '2026-05-04', description: 'Fancy Bistro', merchant_name: '  ', amount: -80, category: 'Dining', category_detailed: REST },
    { date: '2026-05-05', description: 'KFC', amount: -9.75, category: 'Dining' },
    { date: '2026-05-16', description: "Joe's Diner", amount: -7.5, category: 'Dining', category_detailed: REST },
    { date: '2026-05-06', description: 'TRADER JOES #123', merchant_name: 'Trader Joes', amount: -60.5, category: 'Groceries' },
    // One Uncategorized bucket: NULL, blank and the literal label
    { date: '2026-05-07', description: 'Mystery', amount: -5 },
    { date: '2026-05-08', description: 'Blank cat', amount: -4.5, category: '' },
    { date: '2026-05-09', description: 'Literal', amount: -3.25, category: 'Uncategorized' },
    // Never spending: card payment + transfer (excludedTotal), negative-stored
    // paycheck (Income — not spend, not "transfers & card payments"), income,
    // a refund inside a spending category
    { date: '2026-05-10', description: 'CARD PAYMENT', amount: -250, category: 'Credit Card' },
    { date: '2026-05-11', description: 'To savings', amount: -100, category: 'Transfer' },
    { date: '2026-05-12', description: 'Paycheck (stored negative)', amount: -1500, category: 'Income' },
    { date: '2026-05-13', description: 'Paycheck', amount: 3000, category: 'Income' },
    { date: '2026-05-14', description: 'Grocery refund', amount: 12.5, category: 'Groceries' },
    // Entity / account scoped rows, and a REAL category literally named 'Other'
    { date: '2026-05-15', description: 'Amazon', merchant_name: 'Amazon', amount: -30, category: 'Shopping' },
    { date: '2026-05-20', description: 'DELTA AIR', merchant_name: 'Delta', amount: -200, category: 'Travel', category_detailed: 'TRAVEL_FLIGHTS' },
    { date: '2026-05-21', description: 'Misc', amount: -1, category: 'Other' },
    // June (coverage ends 2026-06-01)
    { date: '2026-06-01', description: 'CHIPOTLE 1234', merchant_name: 'Chipotle', amount: -8, category: 'Dining', category_detailed: FF },
  ]);

  const accountId = insertAccount(db, {
    name: 'Travel Card',
    account_type: 'liability',
    account_subtype: 'credit_card',
    institution: 'Test Bank',
    account_number_last4: '9999',
  });
  db.prepare(`UPDATE transactions SET account_id = @id WHERE category = 'Travel'`).run({ id: accountId });

  const bizEntityId = createEntity(db, { name: 'Side Business', color: '#3b82f6' });
  db.prepare(`UPDATE transactions SET entity_id = @id WHERE category = 'Shopping'`).run({ id: bizEntityId });
  const defaultEntityId = (db.prepare('SELECT id FROM entities WHERE is_default = 1').get() as { id: number }).id;
  // Explicit default-entity row; every other row stays entity_id NULL, which
  // the default entity also owns on the dashboard.
  db.prepare(`UPDATE transactions SET entity_id = @id WHERE category = 'Travel'`).run({ id: defaultEntityId });

  return { db, accountId, bizEntityId, defaultEntityId };
}
