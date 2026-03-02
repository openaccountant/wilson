import type { Database } from './compat-sqlite.js';
import {
  TRANSACTIONS_TABLE,
  IMPORTS_TABLE,
  BUDGETS_TABLE,
  CATEGORIZATION_RULES_TABLE,
  TAX_DEDUCTIONS_TABLE,
  CHAT_SESSIONS_TABLE,
  CHAT_HISTORY_TABLE,
  ACCOUNTS_TABLE,
  BALANCE_SNAPSHOTS_TABLE,
  LOANS_TABLE,
  ALL_INDEXES,
  LOGS_TABLE,
  LLM_TRACES_TABLE,
  OBSERVABILITY_INDEXES,
} from './schema.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Migration {
  version: number;
  name: string;
  up: string;
}

// ── Migration Registry ───────────────────────────────────────────────────────

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'create_transactions',        up: TRANSACTIONS_TABLE },
  { version: 2, name: 'create_imports',              up: IMPORTS_TABLE },
  { version: 3, name: 'create_budgets',              up: BUDGETS_TABLE },
  { version: 4, name: 'create_categorization_rules', up: CATEGORIZATION_RULES_TABLE },
  { version: 5, name: 'create_tax_deductions',       up: TAX_DEDUCTIONS_TABLE },
  { version: 6, name: 'create_chat_tables',          up: CHAT_SESSIONS_TABLE + CHAT_HISTORY_TABLE },
  { version: 7, name: 'create_accounts',             up: ACCOUNTS_TABLE },
  { version: 8, name: 'create_balance_snapshots',    up: BALANCE_SNAPSHOTS_TABLE },
  { version: 9, name: 'create_loans',                up: LOANS_TABLE },
  { version: 10, name: 'create_indexes',             up: ALL_INDEXES },
  { version: 11, name: 'create_observability_tables', up: LOGS_TABLE + LLM_TRACES_TABLE },
  { version: 12, name: 'create_observability_indexes', up: OBSERVABILITY_INDEXES },
];

// ── Migration Runner ─────────────────────────────────────────────────────────

/**
 * Run all pending migrations. Idempotent — safe to call on every startup.
 */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  const insertStmt = db.prepare(
    'INSERT INTO schema_migrations (version, name) VALUES (@version, @name)'
  );

  for (const migration of pending) {
    const runOne = db.transaction(() => {
      db.exec(migration.up);
      insertStmt.run({ version: migration.version, name: migration.name });
    });
    runOne();
  }
}

/**
 * Get the current schema version (highest applied migration).
 * Returns 0 if no migrations have been applied.
 */
export function getSchemaVersion(db: Database): number {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
