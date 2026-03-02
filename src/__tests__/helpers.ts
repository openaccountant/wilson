import * as os from 'os';
import * as path from 'path';
import { Database } from '../db/compat-sqlite.js';
import {
  ALL_SCHEMA,
  SAFE_MIGRATIONS,
  ALL_INDEXES,
} from '../db/schema.js';
import { insertTransactions, setBudget } from '../db/queries.js';
import { setActiveProfilePaths, getActiveProfile } from '../profile/index.js';

/**
 * Ensure a test profile is set so modules that call getActiveProfile() don't throw.
 * Uses a temp directory. Safe to call multiple times (idempotent).
 */
export function ensureTestProfile(): void {
  try {
    getActiveProfile();
  } catch {
    const tmpDir = path.join(os.tmpdir(), `oa-test-profile-${process.pid}`);
    setActiveProfilePaths({
      name: 'test',
      root: tmpDir,
      database: path.join(tmpDir, 'data.db'),
      settings: path.join(tmpDir, 'settings.json'),
      scratchpad: path.join(tmpDir, 'scratchpad'),
      cache: path.join(tmpDir, 'cache'),
    });
  }
}

export function createTestDb(): Database {
  ensureTestProfile();
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

/** Temp file path for filesystem tests. */
export function makeTmpPath(ext: string): string {
  return path.join(os.tmpdir(), `wilson-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** Seed transactions that trigger spike detection in anomaly tests. */
export function seedSpikeData(db: Database, merchant: string): void {
  const baseDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const txns = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(baseDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    txns.push({ date: d.toISOString().slice(0, 10), description: merchant, amount: -25, category: 'Other' });
  }
  txns.push({ date: new Date().toISOString().slice(0, 10), description: merchant, amount: -250, category: 'Other' });
  insertTransactions(db, txns);
}
