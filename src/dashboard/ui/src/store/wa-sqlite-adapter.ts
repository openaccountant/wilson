// ── Browser-only: wa-sqlite + AccessHandlePoolVFS adapter ────────────────────
//
// Builds a SqliteBinding over wa-sqlite 1.0.0's synchronous wasm build with the
// AccessHandlePoolVFS OPFS pool (the committed store technology, see
// docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md §6). One pool
// directory per profile isolates mirrors; the single-connection restriction is
// why the store runs inside a dedicated worker (mirror-worker.ts).
//
// Verified import paths against the installed wa-sqlite@1.0.0 package:
//   - factory:            'wa-sqlite/dist/wa-sqlite.mjs' (default export, emscripten module factory)
//   - API + constants:    'wa-sqlite' (main = src/sqlite-api.js; exports Factory, SQLiteError, constants)
//   - OPFS VFS:           'wa-sqlite/src/examples/AccessHandlePoolVFS.js' (class AccessHandlePoolVFS)
// Nothing under bun:test imports this module — only the worker does.

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';
import type { MaybePromise, SqlParams, SqliteBinding, SqliteStatement, SqlRow } from './types.js';

// Extra OPFS pool slots beyond the VFS default of 6: the WAL setup needs the
// main db + -wal + -shm files and SQLite opens temp-db/journal files for the
// sync reconcile temp tables. Cheap to over-provision (each slot is one empty
// OPFS file).
const EXTRA_POOL_CAPACITY = 12;
const MIRROR_DB_PATH = '/mirror.sqlite3';

/** Per-profile OPFS pool directory (per-profile mirror keying). */
export function poolDirectoryName(profile: string): string {
  return `wilson-mirror-${encodeURIComponent(profile)}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Prefix plain param keys with '@' — wa-sqlite's bind_collection looks up
 * object bindings by the parameter name INCLUDING the prefix character. */
function atKeys(params?: SqlParams): { [index: string]: SQLiteCompatibleType | null } {
  if (!params) return {};
  const out: { [index: string]: SQLiteCompatibleType | null } = {};
  for (const [key, value] of Object.entries(params)) {
    out[key.startsWith('@') ? key : `@${key}`] = (value ?? null) as SQLiteCompatibleType | null;
  }
  return out;
}

export interface WaSqliteHandle {
  binding: SqliteBinding;
  /** Close the database connection and release the OPFS pool. */
  close(): Promise<void>;
}

export async function createWaSqliteHandle(profile: string, wasmBase64: string): Promise<WaSqliteHandle> {
  // Nothing is fetched at runtime: the wasm bytes come from the build-time
  // virtual module (wasmBinary is an emscripten Module option).
  const emModule = await SQLiteESMFactory({ wasmBinary: base64ToBytes(wasmBase64) });
  const sqlite3 = SQLite.Factory(emModule);

  const vfs = new AccessHandlePoolVFS(poolDirectoryName(profile));
  await vfs.isReady;
  await vfs.addCapacity(EXTRA_POOL_CAPACITY);
  sqlite3.vfs_register(vfs as unknown as Parameters<typeof sqlite3.vfs_register>[0], false);

  const db = await sqlite3.open_v2(
    MIRROR_DB_PATH,
    SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
    vfs.name
  );

  // Single connection on the pool → these are free wins (wa-sqlite VFS docs).
  // foreign_keys is intentionally OFF: the mirror carries only the
  // transactions/entities DDL, whose account references point at parent tables
  // the mirror does not hold — enforcing FKs would break every linked insert.
  await sqlite3.exec(db, 'PRAGMA locking_mode = exclusive;');
  await sqlite3.exec(db, 'PRAGMA journal_mode = WAL;');

  // Cache of compiled statements, keyed by SQL text. wa-sqlite's prepare is
  // async, so the promise is cached and statement calls await it. SQL is
  // transferred via wa-sqlite's string API (prepare_v2 takes a str_value
  // pointer, not a raw JS string).
  const statements = new Map<string, Promise<number>>();

  async function getStmt(sql: string): Promise<number> {
    let pending = statements.get(sql);
    if (pending === undefined) {
      pending = (async () => {
        const str = sqlite3.str_new(db, sql);
        try {
          const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(str));
          if (!prepared) throw new Error(`wa-sqlite: failed to prepare: ${sql.slice(0, 80)}`);
          return prepared.stmt;
        } finally {
          sqlite3.str_finish(str);
        }
      })();
      statements.set(sql, pending);
      // Keep the cache clean if compilation fails.
      pending.catch(() => statements.delete(sql));
    }
    return pending;
  }

  function readRow(stmt: number): SqlRow {
    const row: SqlRow = {};
    const n = sqlite3.column_count(stmt);
    for (let i = 0; i < n; i++) {
      row[sqlite3.column_name(stmt, i)] = sqlite3.column(stmt, i);
    }
    return row;
  }

  function makeStatement(sql: string): SqliteStatement {
    return {
      async run(params?: SqlParams) {
        const stmt = await getStmt(sql);
        try {
          sqlite3.bind_collection(stmt, atKeys(params));
          const rc = await sqlite3.step(stmt);
          if (rc !== SQLite.SQLITE_DONE) {
            throw new Error(`wa-sqlite: unexpected step result ${rc} for: ${sql.slice(0, 80)}`);
          }
          return { changes: sqlite3.changes(db) };
        } finally {
          await sqlite3.reset(stmt);
        }
      },
      async all(params?: SqlParams) {
        const stmt = await getStmt(sql);
        const rows: SqlRow[] = [];
        try {
          sqlite3.bind_collection(stmt, atKeys(params));
          while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            rows.push(readRow(stmt));
          }
          return rows;
        } finally {
          await sqlite3.reset(stmt);
        }
      },
      async get(params?: SqlParams) {
        const stmt = await getStmt(sql);
        try {
          sqlite3.bind_collection(stmt, atKeys(params));
          const rc = await sqlite3.step(stmt);
          if (rc === SQLite.SQLITE_ROW) return readRow(stmt);
          if (rc === SQLite.SQLITE_DONE) return undefined;
          throw new Error(`wa-sqlite: unexpected step result ${rc} for: ${sql.slice(0, 80)}`);
        } finally {
          await sqlite3.reset(stmt);
        }
      },
    };
  }

  const binding: SqliteBinding = {
    prepare(sql: string): SqliteStatement {
      return makeStatement(sql);
    },
    async exec(sql: string): Promise<void> {
      await sqlite3.exec(db, sql);
    },
    async transaction<T>(fn: () => MaybePromise<T>): Promise<T> {
      await sqlite3.exec(db, 'BEGIN');
      try {
        const result = await fn();
        await sqlite3.exec(db, 'COMMIT');
        return result;
      } catch (err) {
        try {
          await sqlite3.exec(db, 'ROLLBACK');
        } catch {
          // Connection may already have rolled back; surface the original error.
        }
        throw err;
      }
    },
    async pragma(sql: string): Promise<unknown> {
      let value: unknown;
      await sqlite3.exec(db, sql, (row) => {
        value ??= row[0];
      });
      return value;
    },
    async close(): Promise<void> {
      for (const pending of statements.values()) {
        try {
          sqlite3.finalize(await pending);
        } catch {
          // Statement may already be finalized during teardown.
        }
      }
      statements.clear();
      await sqlite3.close(db);
    },
  };

  return {
    binding,
    async close(): Promise<void> {
      await binding.close();
      await vfs.close();
    },
  };
}