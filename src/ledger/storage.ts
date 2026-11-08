/**
 * Storage seam. The engine only needs this subset of a SQLite handle, which
 * bun:sqlite's Database satisfies directly. A wa-sqlite (browser Worker)
 * adapter only has to implement these four calls synchronously.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface LedgerStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface LedgerDatabase {
  /** Execute one or more SQL statements with no result. */
  exec(sql: string): unknown;
  prepare(sql: string): LedgerStatement;
  /**
   * Whether a transaction is open on this connection (bun:sqlite provides it).
   * When it is reported false, the outermost withTransaction uses BEGIN
   * IMMEDIATE; when absent, withTransaction falls back to a SAVEPOINT.
   */
  readonly inTransaction?: boolean;
}

let savepointSeq = 0;

/**
 * Runs fn atomically. The outermost call takes the write lock up front with
 * BEGIN IMMEDIATE: every write path reads before it writes, and in WAL mode a
 * DEFERRED transaction whose snapshot went stale fails its first write with
 * SQLITE_BUSY_SNAPSHOT (busy_timeout cannot help), whereas BEGIN IMMEDIATE
 * waits for the lock. Nested calls, and calls inside a caller's transaction,
 * use SAVEPOINTs. It does not rely on a driver-specific transaction helper.
 */
export function withTransaction<T>(db: LedgerDatabase, fn: () => T): T {
  if (db.inTransaction === false) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  const name = `ledger_sp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}
