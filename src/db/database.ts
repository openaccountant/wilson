import { Database } from './compat-sqlite.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ALL_SCHEMA, SAFE_MIGRATIONS, ALL_INDEXES } from './schema.js';
import { getActiveProfile } from '../profile/active.js';

export function initDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getActiveProfile().database;
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const sql of ALL_SCHEMA) {
    db.exec(sql);
  }

  // Run safe migrations (ALTER TABLE) — ignore "duplicate column" errors
  for (const sql of SAFE_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column')) {
        throw err;
      }
    }
  }

  // Create indexes AFTER migrations so columns like plaid_transaction_id exist
  for (const sql of ALL_INDEXES) {
    db.exec(sql);
  }

  return db;
}
