// Test-side SqliteBinding over the better-sqlite3-style compat Database, for
// driving the (browser-shared) mirror store modules under bun:test.
//
// Why a wrapper instead of the Database itself: the mirror code runs its whole
// apply inside `await db.transaction(async () => …)`. bun:sqlite transactions
// do NOT support async callbacks — the BEGIN/COMMIT happen around the first
// synchronous slice, so partial work from before an await leaks out of the
// transaction. This wrapper executes BEGIN/COMMIT/ROLLBACK explicitly around
// the awaited fn, which is correct for a single connection with no interleaving
// (exactly the wa-sqlite adapter's semantics).
import { Database } from '../db/compat-sqlite.js';
import type {
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorEntityRow,
  MirrorTransactionRow,
  SqliteBinding,
  SqliteStatement,
} from '../dashboard/ui/src/store/types.js';

export class MirrorTestBinding implements SqliteBinding {
  constructor(private readonly db: Database) {}

  prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql) as unknown as SqliteStatement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(sql: string): unknown {
    return this.db.pragma(sql);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction was open; surface the original error.
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Fresh in-memory mirror with the mirror schema created. */
export async function createMirrorDb(): Promise<MirrorTestBinding> {
  const binding = new MirrorTestBinding(new Database(':memory:'));
  const { createMirrorSchema } = await import('../dashboard/ui/src/store/mirror-schema.js');
  await createMirrorSchema(binding);
  return binding;
}

/** Full-shape MirrorTransactionRow with per-test overrides. */
export function mirrorTxn(overrides: Partial<MirrorTransactionRow> = {}): MirrorTransactionRow {
  return {
    id: 1,
    date: '2026-01-15',
    description: 'Test Merchant',
    amount: -12.34,
    category: 'Groceries',
    category_confidence: null,
    user_verified: 0,
    source_file: null,
    bank: null,
    account_last4: null,
    is_recurring: 0,
    tags: null,
    notes: null,
    plaid_transaction_id: null,
    account_name: null,
    merchant_name: null,
    category_detailed: null,
    external_id: null,
    payment_channel: null,
    pending: 0,
    authorized_date: null,
    account_id: null,
    entity_id: null,
    revision: 1,
    created_at: '2026-01-15 12:00:00',
    updated_at: '2026-01-15 12:00:00',
    ...overrides,
  } as MirrorTransactionRow;
}

/** Full-shape MirrorEntityRow with per-test overrides. */
export function mirrorEntity(overrides: Partial<MirrorEntityRow> = {}): MirrorEntityRow {
  return {
    id: 1,
    name: 'Personal',
    slug: 'personal',
    description: 'Personal finances',
    color: '#22c55e',
    is_default: 1,
    created_at: '2026-01-15 12:00:00',
    updated_at: '2026-01-15 12:00:00',
    ...overrides,
  } as MirrorEntityRow;
}

/** Full-shape MirrorBudgetRow with per-test overrides. */
export function mirrorBudget(overrides: Partial<MirrorBudgetRow> = {}): MirrorBudgetRow {
  return {
    id: 1,
    category: 'Groceries',
    monthly_limit: 200,
    entity_id: null,
    created_at: '2026-01-15 12:00:00',
    updated_at: '2026-01-15 12:00:00',
    ...overrides,
  } as MirrorBudgetRow;
}

/** Full-shape MirrorCategoryRow with per-test overrides. */
export function mirrorCategory(overrides: Partial<MirrorCategoryRow> = {}): MirrorCategoryRow {
  return {
    id: 1,
    name: 'Groceries',
    slug: 'groceries',
    parent_id: null,
    description: 'Supermarkets, grocery stores',
    is_system: 1,
    sort_order: 2,
    created_at: '2026-01-15 12:00:00',
    updated_at: '2026-01-15 12:00:00',
    ...overrides,
  } as MirrorCategoryRow;
}