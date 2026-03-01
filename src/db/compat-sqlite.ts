/**
 * Thin compatibility wrapper around bun:sqlite that matches the better-sqlite3 API.
 *
 * better-sqlite3 uses `@param` in SQL and plain keys `{ param: value }` in objects.
 * bun:sqlite uses `$param` in SQL and `$`-prefixed keys `{ $param: value }` in objects.
 *
 * This wrapper transparently translates between the two so all existing query code
 * works without modification.
 */
import { Database as BunDatabase } from 'bun:sqlite';

/** Rewrite `@param` to `$param` in SQL strings for bun:sqlite compatibility. */
function rewriteSQL(sql: string): string {
  return sql.replace(/@(\w+)/g, '$$$1');
}

/** Prefix plain keys with `$` for bun:sqlite binding. */
function prefixParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key.startsWith('$') ? key : `$${key}`] = value;
  }
  return out;
}

/**
 * Wraps a bun:sqlite Statement to accept better-sqlite3-style params.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunStatement = ReturnType<InstanceType<typeof BunDatabase>['prepare']>;

class CompatStatement {
  private stmt: BunStatement;

  constructor(stmt: BunStatement) {
    this.stmt = stmt;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(params?: Record<string, unknown>): any {
    const p = prefixParams(params);
    // bun:sqlite accepts Record<string, SQLQueryBindings> but types are strict;
    // cast through any since we control the param transformation
    return p ? (this.stmt as any).run(p) : this.stmt.run();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(params?: Record<string, unknown>): any[] {
    const p = prefixParams(params);
    return p ? (this.stmt as any).all(p) : this.stmt.all();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(params?: Record<string, unknown>): any {
    const p = prefixParams(params);
    return p ? (this.stmt as any).get(p) : this.stmt.get();
  }
}

/**
 * Drop-in replacement for better-sqlite3's Database class, backed by bun:sqlite.
 * Consumers use this exactly like better-sqlite3: db.prepare(), db.pragma(), db.exec().
 */
export class Database {
  private db: InstanceType<typeof BunDatabase>;

  constructor(path: string) {
    this.db = new BunDatabase(path);
  }

  /** Execute a PRAGMA statement (e.g., `pragma('journal_mode = WAL')`). */
  pragma(pragma: string): unknown {
    const rows = this.db.prepare(`PRAGMA ${pragma}`).all();
    return rows.length === 1 ? Object.values(rows[0] as Record<string, unknown>)[0] : rows;
  }

  /** Execute raw SQL (DDL, multi-statement, etc.). Uses bun:sqlite's native exec. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ['exec'](sql: string): void {
    // Delegating to bun:sqlite's exec for multi-statement SQL support
    (this.db as any).exec(sql);
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.db.prepare(rewriteSQL(sql)));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<F extends (...args: any[]) => any>(fn: F): F {
    return this.db.transaction(fn as any) as unknown as F;
  }

  close(): void {
    this.db.close();
  }
}
