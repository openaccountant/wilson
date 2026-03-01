import { Database } from '../db/compat-sqlite.js';
import {
  ALL_SCHEMA,
  SAFE_MIGRATIONS,
  ALL_INDEXES,
} from '../db/schema.js';
import { insertTransactions, setBudget } from '../db/queries.js';

export function createTestDb(): Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Tables
  for (const sql of ALL_SCHEMA) db.exec(sql);
  // Migrations (ALTER TABLE) before indexes
  for (const sql of SAFE_MIGRATIONS) {
    try { db.exec(sql); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column')) throw err;
    }
  }
  // Indexes (depend on migration columns like plaid_transaction_id)
  for (const sql of ALL_INDEXES) db.exec(sql);
  return db;
}

export function seedTestData(db: Database): void {
  insertTransactions(db, [
    { date: '2026-02-15', description: 'Grocery Store', amount: -85.50, category: 'Groceries' },
    { date: '2026-02-18', description: 'Electric Company', amount: -120.00, category: 'Utilities' },
    { date: '2026-02-20', description: 'Restaurant', amount: -45.00, category: 'Dining' },
    { date: '2026-02-25', description: 'Unknown Purchase', amount: -30.00 },
    { date: '2026-03-01', description: 'Grocery Store', amount: -92.00, category: 'Groceries' },
    { date: '2026-03-05', description: 'Gas Station', amount: -55.00, category: 'Transportation' },
    { date: '2026-01-10', description: 'Paycheck', amount: 3500.00, category: 'Income' },
  ]);
  setBudget(db, 'Groceries', 200);
  setBudget(db, 'Dining', 100);
}
