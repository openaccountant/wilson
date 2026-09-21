// ── Offline mirror: schema + sync application ────────────────────────────────
//
// The mirror is a read-only copy of the server's transactions, entities,
// budgets, and categories tables (exactly what the dashboard reads: the
// transactions tab, plus the overview cards' aggregations). The server
// database stays canonical: sync is the only ingest path, and nothing ever
// writes back.
//
// Pure module — no browser glue, no bun:sqlite import — so the same code runs
// under bun:test (against bun:sqlite via a SqliteBinding wrapper) and inside
// the dashboard's mirror worker (against wa-sqlite + AccessHandlePoolVFS).

import {
  BUDGETS_TABLE,
  CATEGORIES_TABLE,
  ENTITIES_TABLE,
  TRANSACTIONS_TABLE,
} from '../../../../db/schema.js';
import type {
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorEntityRow,
  MirrorTransactionRow,
  SqliteBinding,
  SyncPayload,
} from './types.js';

/**
 * The mirror-side schema-version marker.
 *
 * There is no server endpoint exposing the CLI's schema version (every route in
 * src/dashboard/server.ts is an /api handler), so the marker lives here. Bump it
 * whenever the DDL the mirror carries (TRANSACTIONS_TABLE / ENTITIES_TABLE /
 * BUDGETS_TABLE / CATEGORIES_TABLE) or the SyncPayload shape changes — i.e.
 * whenever the CLI's schema moves — and the next sync will drop the mirror and
 * re-seed it from scratch.
 */
export const MIRROR_SCHEMA_VERSION = 3;

// Column lists for the upsert statements. Must match the DDL above (the mirror
// parity test seeds every column explicitly and fails if one is dropped).
export const MIRROR_TXN_COLUMNS = [
  'id',
  'date',
  'description',
  'amount',
  'category',
  'category_confidence',
  'user_verified',
  'source_file',
  'bank',
  'account_last4',
  'is_recurring',
  'tags',
  'notes',
  'plaid_transaction_id',
  'account_name',
  'merchant_name',
  'category_detailed',
  'external_id',
  'payment_channel',
  'pending',
  'authorized_date',
  'account_id',
  // entity_id comes from the server's migration 21, not TRANSACTIONS_TABLE —
  // keep it in the list so the upsert carries it.
  'entity_id',
  // revision comes from the server's migration 25, not TRANSACTIONS_TABLE —
  // keep it in the list so the upsert carries it.
  'revision',
  'created_at',
  'updated_at',
] as const;

export const MIRROR_ENTITY_COLUMNS = [
  'id',
  'name',
  'slug',
  'description',
  'color',
  'is_default',
  'created_at',
  'updated_at',
] as const;

export const MIRROR_BUDGET_COLUMNS = [
  'id',
  'category',
  'monthly_limit',
  // entity_id comes from the server's migration 21, not BUDGETS_TABLE —
  // keep it in the list so the upsert carries it.
  'entity_id',
  'created_at',
  'updated_at',
] as const;

export const MIRROR_CATEGORY_COLUMNS = [
  'id',
  'name',
  'slug',
  'parent_id',
  'description',
  'is_system',
  'sort_order',
  'created_at',
  'updated_at',
] as const;

/**
 * Persistent half of the mirror schema: main tables + meta. Idempotent only on
 * a fresh database — the ALTERs fail on an existing mirror, which is why the
 * re-seed gate always drops first. The temp tables are per-connection and live
 * in createMirrorSchema / applySync.
 */
export async function createPersistentMirrorSchema(db: SqliteBinding): Promise<void> {
  await db.exec(`
    ${TRANSACTIONS_TABLE}
    ALTER TABLE transactions ADD COLUMN entity_id INTEGER REFERENCES entities(id);
    ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE transactions ADD COLUMN sync_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mirror_tx_sync_key ON transactions(sync_key);
    CREATE INDEX IF NOT EXISTS idx_mirror_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_mirror_tx_category ON transactions(category);
    CREATE INDEX IF NOT EXISTS idx_mirror_tx_account_id ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_mirror_tx_entity_id ON transactions(entity_id);
    ${ENTITIES_TABLE}
    ${BUDGETS_TABLE}
    ALTER TABLE budgets ADD COLUMN entity_id INTEGER REFERENCES entities(id);
    ${CATEGORIES_TABLE}
    CREATE INDEX IF NOT EXISTS idx_mirror_categories_parent ON categories(parent_id);
    CREATE TABLE IF NOT EXISTS mirror_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Per-connection half: the reconcile temp tables. TEMP tables are scoped to the
 * connection, not persisted in the pool — a restored mirror (pool reopened
 * after a reload) has persistent tables but no temp tables.
 */
export async function ensureConnectionSchema(db: SqliteBinding): Promise<void> {
  await db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS sync_incoming (sync_key TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sync_incoming_entities (id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sync_incoming_budgets (category TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS sync_incoming_categories (id INTEGER PRIMARY KEY);
  `);
}

/**
 * Create the full mirror schema on a fresh database (persistent + connection).
 * Reuses the server's own DDL constants verbatim so the mirror tables have
 * parity with the server by construction, then adds the columns the server
 * itself adds by migration (entity_id on transactions AND budgets — migration
 * 21's ENTITY_ID_COLUMNS also alters accounts, which the mirror does not hold,
 * so the transactions/budgets lines are repeated here; revision — migration
 * 25's TRANSACTION_REVISION_COLUMN, same reasoning; a future column migration
 * means bumping MIRROR_SCHEMA_VERSION and adding its ALTER here) plus the
 * mirror-only bits: the sync_key identity column, its unique index, a few
 * read-path indexes, the meta table, and the reconcile temp tables.
 */
export async function createMirrorSchema(db: SqliteBinding): Promise<void> {
  await createPersistentMirrorSchema(db);
  await ensureConnectionSchema(db);
}

/** Drop everything (including the meta table) and recreate the schema. */
export async function resetMirrorSchema(db: SqliteBinding): Promise<void> {
  await db.exec(`
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS budgets;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS entities;
    DROP TABLE IF EXISTS mirror_meta;
  `);
  await createMirrorSchema(db);
}

export async function getMeta(db: SqliteBinding, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM mirror_meta WHERE key = @key')
    .get({ key });
  return row ? String(row.value) : null;
}

export async function setMeta(db: SqliteBinding, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO mirror_meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = @value`
    )
    .run({ key, value });
}

/** getMeta that treats an uninitialized mirror (missing tables) as "no meta". */
async function readMetaSafe(db: SqliteBinding, key: string): Promise<string | null> {
  try {
    return await getMeta(db, key);
  } catch {
    return null;
  }
}

export interface ApplySyncResult {
  /** True when the mirror was dropped and re-seeded (first sync, version bump, profile change). */
  seeded: boolean;
  /** Transaction rows applied from the payload. */
  upserted: number;
  /** Mirror rows removed because the server no longer has them. */
  deleted: number;
}

function transactionSyncKey(row: MirrorTransactionRow): string {
  // Upsert identity. The server enforces uniqueness among non-null external_ids
  // via the partial unique index idx_transactions_external_id, so external_id is
  // the stable key — it survives a server-side DB rebuild where numeric ids do
  // not. Rows with NULL external_id (legacy/edge) fall back to the server PK,
  // which is stable per profile. Every payload row therefore has a unique
  // sync_key: non-null external_ids are unique server-side, and null-external
  // rows key on unique server PKs.
  return row.external_id ?? `id:${row.id}`;
}

function buildTransactionUpsertSql(): string {
  const cols = MIRROR_TXN_COLUMNS as readonly string[];
  const allCols = [...cols, 'sync_key'];
  const placeholders = allCols.map((c) => `@${c}`).join(', ');
  // DO UPDATE reassigns every column (id included) from the incoming row so
  // mirror ids track server ids across a server-side DB rebuild.
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO transactions (${allCols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(sync_key) DO UPDATE SET ${updates}`;
}

function buildEntityUpsertSql(): string {
  const cols = MIRROR_ENTITY_COLUMNS as readonly string[];
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO entities (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

function buildBudgetUpsertSql(): string {
  const cols = MIRROR_BUDGET_COLUMNS as readonly string[];
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  // Keyed on category: UNIQUE in BUDGETS_TABLE → valid conflict target, and the
  // same identity the server's setBudget upsert uses.
  return `INSERT INTO budgets (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(category) DO UPDATE SET ${updates}`;
}

function buildCategoryUpsertSql(): string {
  const cols = MIRROR_CATEGORY_COLUMNS as readonly string[];
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO categories (${cols.join(', ')}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

/**
 * Apply one full server pull to the mirror in a single transaction.
 *
 * Because each pull is the COMPLETE set, this both refreshes existing rows
 * (upsert on sync_key / entity id) and reconciles deletions: anything the
 * server no longer returns disappears from the mirror.
 */
export async function applySync(db: SqliteBinding, payload: SyncPayload): Promise<ApplySyncResult> {
  // Re-seed gate. One rule covers first run (meta absent), a schema-version bump
  // (stored marker differs), and profile consistency (stored profile differs).
  const storedVersion = await readMetaSafe(db, 'schema_version');
  const storedProfile = await readMetaSafe(db, 'profile');
  const seeded =
    storedVersion !== String(MIRROR_SCHEMA_VERSION) || storedProfile !== payload.profile;

  // TEMP tables live per connection, not in the pool — a restored mirror (pool
  // reopened after a reload) has main tables but no temp tables, so make sure
  // they exist before the reconcile step touches them.
  await ensureConnectionSchema(db);

  const txnUpsertSql = buildTransactionUpsertSql();
  const entityUpsertSql = buildEntityUpsertSql();
  const budgetUpsertSql = buildBudgetUpsertSql();
  const categoryUpsertSql = buildCategoryUpsertSql();

  return await db.transaction(async () => {
    if (seeded) {
      await resetMirrorSchema(db);
    }

    // Clear the reconcile temp tables (they persist for the connection).
    await db.prepare('DELETE FROM temp.sync_incoming').run();
    await db.prepare('DELETE FROM temp.sync_incoming_entities').run();
    await db.prepare('DELETE FROM temp.sync_incoming_budgets').run();
    await db.prepare('DELETE FROM temp.sync_incoming_categories').run();

    const insertIncomingKey = db.prepare(
      `INSERT INTO temp.sync_incoming (sync_key) VALUES (@syncKey)
       ON CONFLICT(sync_key) DO NOTHING`
    );
    const insertIncomingEntity = db.prepare(
      `INSERT INTO temp.sync_incoming_entities (id) VALUES (@id)
       ON CONFLICT(id) DO NOTHING`
    );
    const insertIncomingBudget = db.prepare(
      `INSERT INTO temp.sync_incoming_budgets (category) VALUES (@category)
       ON CONFLICT(category) DO NOTHING`
    );
    const insertIncomingCategory = db.prepare(
      `INSERT INTO temp.sync_incoming_categories (id) VALUES (@id)
       ON CONFLICT(id) DO NOTHING`
    );
    const upsertTxn = db.prepare(txnUpsertSql);
    const upsertEntity = db.prepare(entityUpsertSql);
    const upsertBudget = db.prepare(budgetUpsertSql);
    const upsertCategory = db.prepare(categoryUpsertSql);

    for (const row of payload.transactions) {
      const syncKey = transactionSyncKey(row);
      await insertIncomingKey.run({ syncKey });
      const params: Record<string, unknown> = { sync_key: syncKey };
      for (const col of MIRROR_TXN_COLUMNS as readonly string[]) {
        params[col] = row[col as keyof MirrorTransactionRow] ?? null;
      }
      await upsertTxn.run(params);
    }
    const upserted = payload.transactions.length;

    for (const row of payload.entities) {
      await insertIncomingEntity.run({ id: row.id });
      const params: Record<string, unknown> = {};
      for (const col of MIRROR_ENTITY_COLUMNS as readonly string[]) {
        params[col] = row[col as keyof MirrorEntityRow] ?? null;
      }
      await upsertEntity.run(params);
    }

    for (const row of payload.budgets ?? []) {
      await insertIncomingBudget.run({ category: row.category });
      const params: Record<string, unknown> = {};
      for (const col of MIRROR_BUDGET_COLUMNS as readonly string[]) {
        params[col] = row[col as keyof MirrorBudgetRow] ?? null;
      }
      await upsertBudget.run(params);
    }

    // Categories may arrive in any parent/child order: foreign_keys stays OFF in
    // the mirror (parent integrity is the server's concern; the mirror is
    // read-only), so upserting children before parents is fine.
    for (const row of payload.categories ?? []) {
      await insertIncomingCategory.run({ id: row.id });
      const params: Record<string, unknown> = {};
      for (const col of MIRROR_CATEGORY_COLUMNS as readonly string[]) {
        params[col] = row[col as keyof MirrorCategoryRow] ?? null;
      }
      await upsertCategory.run(params);
    }

    // Reconcile deletions against the full pulled set: temp tables instead of a
    // giant NOT IN (@...) param list avoids SQLite variable limits and keeps the
    // SQL identical across bindings.
    const txnDelete = await db
      .prepare('DELETE FROM transactions WHERE sync_key NOT IN (SELECT sync_key FROM sync_incoming)')
      .run();
    const entityDelete = await db
      .prepare('DELETE FROM entities WHERE id NOT IN (SELECT id FROM sync_incoming_entities)')
      .run();
    const budgetDelete = await db
      .prepare('DELETE FROM budgets WHERE category NOT IN (SELECT category FROM sync_incoming_budgets)')
      .run();
    const categoryDelete = await db
      .prepare('DELETE FROM categories WHERE id NOT IN (SELECT id FROM sync_incoming_categories)')
      .run();
    const deleted =
      Number((txnDelete as { changes: number }).changes ?? 0) +
      Number((entityDelete as { changes: number }).changes ?? 0) +
      Number((budgetDelete as { changes: number }).changes ?? 0) +
      Number((categoryDelete as { changes: number }).changes ?? 0);

    await setMeta(db, 'schema_version', String(MIRROR_SCHEMA_VERSION));
    await setMeta(db, 'profile', payload.profile);
    await setMeta(db, 'last_synced_at', new Date().toISOString());

    return { seeded, upserted, deleted };
  });
}

/** True when the mirror holds a current-schema dataset (restored from storage or synced). */
export async function isMirrorSeeded(db: SqliteBinding): Promise<boolean> {
  const version = await readMetaSafe(db, 'schema_version');
  return version === String(MIRROR_SCHEMA_VERSION);
}