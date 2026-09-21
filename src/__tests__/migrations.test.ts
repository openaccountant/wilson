import { describe, expect, test } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';
import { runMigrations, getSchemaVersion, MIGRATIONS } from '../db/migrations.js';
import { insertTransactions } from '../db/queries.js';
import type { CategorizationReviewRow } from '../db/categorization-review-queries.js';
import { vecToBlob } from '../db/embedding-queries.js';
import { ensureTestProfile } from './helpers.js';

ensureTestProfile();

/**
 * Apply migrations 1..version only (bypassing runMigrations, which always
 * runs everything pending). Used to build a pre-v23 database so the v23
 * backfill can be tested against seeded data.
 */
function runMigrationsUpTo(db: Database, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')));`);
  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (@version, @name)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(m.up);
    insert.run({ version: m.version, name: m.name });
  }
}

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
    expect(tableNames).toContain('categorization_reviews');

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
    expect(indexNames).toContain('idx_categorization_reviews_pending_txn');

    db.close();
  });

  test('v24 categorization_reviews: table and backfill contents', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Build a v22 database, then seed historical categorization data so the
    // v23 backfill runs against it.
    runMigrationsUpTo(db, MIGRATIONS.length - 1);

    insertTransactions(db, [
      // Model-applied, below the 0.7 backfill threshold → must be queued
      { date: '2026-01-01', description: 'LOW CONF AUTO', amount: -10, category: 'Shopping', category_confidence: 0.6 },
      // Model-applied, above threshold → not queued
      { date: '2026-01-02', description: 'HIGH CONF AUTO', amount: -20, category: 'Dining', category_confidence: 0.9 },
      // Bank/import-provided category (NULL confidence) → deliberately not queued
      { date: '2026-01-03', description: 'BANK PROVIDED', amount: -30, category: 'Transport' },
      // Model-applied, below threshold, but user-verified → not queued
      { date: '2026-01-04', description: 'USER VERIFIED', amount: -40, category: 'Groceries', category_confidence: 0.5 },
    ]);

    const seeded = db.prepare("SELECT id, description FROM transactions ORDER BY id").all() as { id: number; description: string }[];
    const byDescription = Object.fromEntries(seeded.map((r) => [r.description, r.id]));
    db.prepare('UPDATE transactions SET user_verified = 1 WHERE id = @id')
      .run({ id: byDescription['USER VERIFIED'] });

    // Apply the pending v23 migration (and anything after it)
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(MIGRATIONS.length);

    const queue = db.prepare('SELECT * FROM categorization_reviews ORDER BY id').all() as CategorizationReviewRow[];
    expect(queue.length).toBe(1);
    expect(queue[0].transaction_id).toBe(byDescription['LOW CONF AUTO']);
    expect(queue[0].suggested_category).toBe('Shopping');
    expect(queue[0].confidence).toBe(0.6);
    expect(queue[0].status).toBe('pending');

    // Backfill flags the row but keeps its applied category — no report distortion
    const flagged = db.prepare('SELECT category, category_confidence FROM transactions WHERE id = @id')
      .get({ id: byDescription['LOW CONF AUTO'] }) as { category: string; category_confidence: number };
    expect(flagged.category).toBe('Shopping');
    expect(flagged.category_confidence).toBe(0.6);

    // Idempotent: re-running the migration runner changes nothing
    runMigrations(db);
    const queueAfter = db.prepare('SELECT * FROM categorization_reviews').all() as CategorizationReviewRow[];
    expect(queueAfter.length).toBe(1);

    db.close();
  });

  // ── Migration 23: embeddings table ────────────────────────────────────────

  test('migration 23 creates the embeddings table with the expected columns', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('embeddings');

    const cols = db.prepare("PRAGMA table_info('embeddings')").all() as { name: string; type: string; notnull: number }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(['id', 'source_type', 'source_id', 'model', 'dim', 'vec', 'created_at']);
    expect(cols.find((c) => c.name === 'vec')?.type).toBe('BLOB');

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_embeddings_source');
    expect(indexNames).toContain('idx_embeddings_model');

    const migrationRow = db.prepare(
      "SELECT version, name FROM schema_migrations WHERE version = 23"
    ).get() as { version: number; name: string };
    expect(migrationRow.name).toBe('create_embeddings');

    db.close();
  });

  test('embeddings UNIQUE(source_type, source_id, model) rejects duplicates', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const vec = new Float32Array(4).fill(0.5);
    const insert = db.prepare(
      'INSERT INTO embeddings (source_type, source_id, model, dim, vec) VALUES (@sourceType, @sourceId, @model, @dim, @vec)'
    );

    insert.run({ sourceType: 'transaction', sourceId: 1, model: 'test-model', dim: 4, vec: vecToBlob(vec) });
    expect(() =>
      insert.run({ sourceType: 'transaction', sourceId: 1, model: 'test-model', dim: 4, vec: vecToBlob(vec) })
    ).toThrow(/UNIQUE/);

    // Same source row under a different model is allowed.
    insert.run({ sourceType: 'transaction', sourceId: 1, model: 'other-model', dim: 4, vec: vecToBlob(vec) });
    // A different source_type for the same source_id is allowed.
    insert.run({ sourceType: 'chat', sourceId: 1, model: 'test-model', dim: 4, vec: vecToBlob(vec) });

    const count = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
    expect(count.c).toBe(3);

    db.close();
  });

  test('embeddings source_type CHECK constraint rejects unknown kinds', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const insert = db.prepare(
      'INSERT INTO embeddings (source_type, source_id, model, dim, vec) VALUES (@sourceType, @sourceId, @model, @dim, @vec)'
    );
    expect(() =>
      insert.run({ sourceType: 'widget', sourceId: 1, model: 'test-model', dim: 4, vec: vecToBlob(new Float32Array(4)) })
    ).toThrow(/CHECK/);

    db.close();
  });
});
