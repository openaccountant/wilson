// ── Offline mirror store: shared types ───────────────────────────────────────
//
// Everything in src/dashboard/ui/src/store/ except the browser-only glue
// (wa-sqlite-adapter.ts, mirror-worker.ts, mirror-client.ts) must stay free of
// browser APIs and of any import that reaches `bun:sqlite` — the UI tsconfig
// must not transitively typecheck src/db/compat-sqlite.ts, and root bun:test
// imports these modules directly (see src/__tests__/mirror-*.test.ts).

/**
 * Structural subset of the better-sqlite3-style API the store uses.
 *
 * The mirror store depends on this shape instead of src/db/compat-sqlite.ts's
 * `Database` class because that module imports `bun:sqlite`, whose types are
 * unavailable to the UI package. Under bun:test the same shape is provided by a
 * BEGIN/COMMIT wrapper over the compat Database (see
 * src/__tests__/mirror-helpers.ts); in the browser the wa-sqlite adapter
 * implements it over AccessHandlePoolVFS.
 *
 * Statement/database methods return the value OR a Promise of it (`MaybePromise`):
 * bun:sqlite is synchronous while wa-sqlite's JS API is promise-based, and
 * callers `await` unconditionally so one implementation serves both backends.
 */
export type MaybePromise<T> = T | Promise<T>;

export type SqlParams = Record<string, unknown>;
export type SqlRow = Record<string, unknown>;

export interface SqliteStatement {
  run(params?: SqlParams): MaybePromise<{ changes: number }>;
  all(params?: SqlParams): MaybePromise<SqlRow[]>;
  get(params?: SqlParams): MaybePromise<SqlRow | undefined>;
}

export interface SqliteBinding {
  prepare(sql: string): SqliteStatement;
  /** Raw SQL execution (DDL, multi-statement scripts, PRAGMAs). */
  exec(sql: string): MaybePromise<void>;
  /** Run `fn` inside a transaction; rollback on throw. `fn` may be async. */
  transaction<T>(fn: () => MaybePromise<T>): MaybePromise<T>;
  /** Execute a PRAGMA statement, e.g. `pragma('journal_mode = WAL')`. */
  pragma(sql: string): MaybePromise<unknown>;
  close(): MaybePromise<void>;
}

// ── Row shapes ───────────────────────────────────────────────────────────────
//
// Structural copies of the server row shapes. The source of truth for the
// columns is the DDL: `TRANSACTIONS_TABLE` / `ENTITIES_TABLE` in
// src/db/schema.ts. These are deliberately copies — a type-only import of
// src/db/queries.ts / entity-queries.ts would still drag `bun:sqlite` types
// into the UI typecheck via their sibling imports.

/** Mirrors the server `transactions` table (see TRANSACTIONS_TABLE). */
export interface MirrorTransactionRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  category_confidence: number | null;
  user_verified: number;
  source_file: string | null;
  bank: string | null;
  account_last4: string | null;
  is_recurring: number;
  tags: string | null;
  notes: string | null;
  plaid_transaction_id: string | null;
  account_name: string | null;
  merchant_name: string | null;
  category_detailed: string | null;
  external_id: string | null;
  payment_channel: string | null;
  pending: number;
  authorized_date: string | null;
  account_id: number | null;
  entity_id: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** Mirrors the server `entities` table (see ENTITIES_TABLE). */
export interface MirrorEntityRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/**
 * One full pull from the server, applied to the mirror in a single transaction.
 * The schema version is a store constant (MIRROR_SCHEMA_VERSION), not wire data.
 */
export interface SyncPayload {
  profile: string;
  transactions: MirrorTransactionRow[];
  entities: MirrorEntityRow[];
}

/** Status of the browser-side mirror, consumed by the UI. */
export interface MirrorState {
  /** False when the mirror could not start (no OPFS, private mode, pool lock). */
  available: boolean;
  profile: string | null;
  /** True once a mirror (current session or restored from storage) has data. */
  seeded: boolean;
  lastSyncedAt: string | null;
  /** False while the server is unreachable (mirror is the data source). */
  online: boolean;
}

/** What the mirror worker reports after init / setProfile / applySync. */
export interface MirrorStatus {
  profile: string;
  seeded: boolean;
  lastSyncedAt: string | null;
}