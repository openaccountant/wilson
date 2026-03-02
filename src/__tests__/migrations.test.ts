import { describe, expect, test } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';
import { runMigrations, getSchemaVersion, MIGRATIONS } from '../db/migrations.js';
import { ensureTestProfile } from './helpers.js';

ensureTestProfile();

describe('migration runner', () => {
  test('fresh DB: all migrations run and schema_migrations populated', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    const version = getSchemaVersion(db);
    expect(version).toBe(MIGRATIONS.length);

    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as { version: number; name: string }[];
    expect(rows.length).toBe(MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(rows[i].version).toBe(MIGRATIONS[i].version);
      expect(rows[i].name).toBe(MIGRATIONS[i].name);
    }

    db.close();
  });

  test('idempotent: calling runMigrations twice is safe', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);
    const v1 = getSchemaVersion(db);

    runMigrations(db);
    const v2 = getSchemaVersion(db);

    expect(v1).toBe(v2);
    expect(v2).toBe(MIGRATIONS.length);

    db.close();
  });

  test('getSchemaVersion returns 0 on empty DB', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // No schema_migrations table yet
    expect(getSchemaVersion(db)).toBe(0);

    db.close();
  });

  test('all expected tables are created', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('transactions');
    expect(tableNames).toContain('imports');
    expect(tableNames).toContain('budgets');
    expect(tableNames).toContain('categorization_rules');
    expect(tableNames).toContain('tax_deductions');
    expect(tableNames).toContain('chat_sessions');
    expect(tableNames).toContain('chat_history');
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('balance_snapshots');
    expect(tableNames).toContain('loans');
    expect(tableNames).toContain('schema_migrations');

    db.close();
  });

  test('transactions table has account_id column', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info('transactions')").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('account_id');
    expect(colNames).toContain('plaid_transaction_id');
    expect(colNames).toContain('merchant_name');
    expect(colNames).toContain('external_id');

    db.close();
  });

  test('indexes are created', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_transactions_date');
    expect(indexNames).toContain('idx_accounts_type');
    expect(indexNames).toContain('idx_snapshots_account_date');
    expect(indexNames).toContain('idx_loans_linked_asset');

    db.close();
  });
});
