import { describe, expect, test } from 'bun:test';
import {
  applySync,
  createMirrorSchema,
  createPersistentMirrorSchema,
  getMeta,
  isMirrorSeeded,
  resetMirrorSchema,
  setMeta,
  MIRROR_BUDGET_COLUMNS,
  MIRROR_CATEGORY_COLUMNS,
  MIRROR_SCHEMA_VERSION,
} from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import type { MirrorTransactionRow, MirrorEntityRow, MirrorBudgetRow, MirrorCategoryRow, SyncPayload } from '../dashboard/ui/src/store/types.js';
import { createMirrorDb, mirrorTxn, mirrorEntity, mirrorBudget, mirrorCategory } from './mirror-helpers.js';

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    profile: 'default',
    transactions: [],
    entities: [mirrorEntity() as unknown as MirrorEntityRow],
    budgets: [mirrorBudget() as unknown as MirrorBudgetRow],
    categories: [mirrorCategory() as unknown as MirrorCategoryRow],
    ...overrides,
  };
}

async function serveTransactions(binding: Awaited<ReturnType<typeof createMirrorDb>>, query = '') {
  const path = query ? `/api/transactions?${query}` : '/api/transactions';
  return (await serveApiPath(binding, path)) as Record<string, unknown>[];
}

describe('applySync — seed', () => {
  test('seeds an empty mirror and serves server-exact row shapes', async () => {
    const db = await createMirrorDb();
    const txn = mirrorTxn({ external_id: 'ext-1', amount: -42.5 });
    const result = await applySync(db, payload({ transactions: [txn as unknown as MirrorTransactionRow] }));

    expect(result.seeded).toBe(true);
    expect(result.upserted).toBe(1);
    expect(result.deleted).toBe(0);

    const rows = await serveTransactions(db);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('sync_key');
    expect(rows[0]).toEqual({ ...txn });
  });

  test('records schema version, profile, and last_synced_at meta', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload());
    expect(await getMeta(db, 'schema_version')).toBe(String(MIRROR_SCHEMA_VERSION));
    expect(await getMeta(db, 'profile')).toBe('default');
    expect(await getMeta(db, 'last_synced_at')).not.toBeNull();
    expect(await isMirrorSeeded(db)).toBe(true);
  });
});

describe('applySync — refresh', () => {
  test('upserts in place on external_id and adds new rows', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      transactions: [
        mirrorTxn({ id: 1, external_id: 'ext-1', amount: -10, category: 'Dining' }) as unknown as MirrorTransactionRow,
        mirrorTxn({ id: 2, external_id: 'ext-2', amount: -20 }) as unknown as MirrorTransactionRow,
      ],
    }));

    await applySync(db, payload({
      transactions: [
        mirrorTxn({ id: 1, external_id: 'ext-1', amount: -99, category: 'Utilities', entity_id: 7 }) as unknown as MirrorTransactionRow,
        mirrorTxn({ id: 3, external_id: 'ext-3', amount: -30 }) as unknown as MirrorTransactionRow,
      ],
    }));

    const rows = await serveTransactions(db);
    expect(rows).toHaveLength(2);
    const ext1 = rows.find((r) => r.external_id === 'ext-1');
    expect(ext1).toMatchObject({ id: 1, amount: -99, category: 'Utilities', entity_id: 7 });
    expect(rows.map((r) => r.external_id).sort()).toEqual(['ext-1', 'ext-3']);
  });

  test('reconciles server-side deletions against the full pulled set', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      transactions: [
        mirrorTxn({ id: 1, external_id: 'ext-1' }),
        mirrorTxn({ id: 2, external_id: 'ext-2' }),
      ],
    }));

    // ext-2 was deleted on the server: the next full pull no longer contains it.
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow] }));

    const rows = await serveTransactions(db);
    expect(rows.map((r) => r.external_id)).toEqual(['ext-1']);
  });

  test('reconciles entity deletions too', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      entities: [mirrorEntity(), mirrorEntity({ id: 2, name: 'Biz', slug: 'biz', is_default: 0 })],
    }));
    await applySync(db, payload({ entities: [mirrorEntity()] }));
    const entities = (await serveApiPath(db, '/api/entities')) as Record<string, unknown>[];
    expect(entities.map((e) => e.id)).toEqual([1]);
  });
});

describe('applySync — identity key', () => {
  test('same external_id with a different server id updates one row (no duplicate)', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 10, external_id: 'ext-1', description: 'Old' }) as unknown as MirrorTransactionRow] }));

    // Server DB rebuilt: the numeric id changed but external_id survived.
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 99, external_id: 'ext-1', description: 'New' }) as unknown as MirrorTransactionRow] }));

    const rows = await serveTransactions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 99, description: 'New' });
  });

  test('NULL external_id rows key on id:<serverId> and reconcile', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      transactions: [mirrorTxn({ id: 5, external_id: null }), mirrorTxn({ id: 6, external_id: null })] as unknown as MirrorTransactionRow[],
    }));
    let rows = await serveTransactions(db);
    expect(rows).toHaveLength(2);

    // id:6 deleted server-side.
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 5, external_id: null }) as unknown as MirrorTransactionRow] }));
    rows = await serveTransactions(db);
    expect(rows.map((r) => r.id)).toEqual([5]);

    // Same server id re-pulled → updated in place, not duplicated.
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 5, external_id: null, amount: -1 }) as unknown as MirrorTransactionRow] }));
    rows = await serveTransactions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-1);
  });
});

describe('applySync — idempotency', () => {
  test('applying the identical payload twice leaves the mirror unchanged', async () => {
    const db = await createMirrorDb();
    const p = payload({
      transactions: [mirrorTxn({ id: 1, external_id: 'ext-1' }), mirrorTxn({ id: 2, external_id: 'ext-2' })] as unknown as MirrorTransactionRow[],
    });
    await applySync(db, p);
    const first = await serveTransactions(db);

    const result = await applySync(db, p);
    const second = await serveTransactions(db);

    expect(second).toEqual(first);
    expect(result.seeded).toBe(false);
    expect(result.deleted).toBe(0);
  });
});

describe('applySync — re-seed gate', () => {
  test('schema-version marker change triggers a full re-seed', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'old-1', description: 'stale' }) as unknown as MirrorTransactionRow] }));

    // Simulate the CLI's schema having moved since this mirror was written.
    await setMeta(db, 'schema_version', String(MIRROR_SCHEMA_VERSION - 1));

    const result = await applySync(db, payload({
      transactions: [mirrorTxn({ id: 2, external_id: 'new-1', description: 'fresh' })],
    }));

    expect(result.seeded).toBe(true);
    const rows = await serveTransactions(db);
    expect(rows.map((r) => r.external_id)).toEqual(['new-1']);
    expect(await getMeta(db, 'schema_version')).toBe(String(MIRROR_SCHEMA_VERSION));
  });

  test('profile change drops and re-seeds', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ profile: 'alice', transactions: [mirrorTxn({ id: 1, external_id: 'a-1' }) as unknown as MirrorTransactionRow] }));

    const result = await applySync(db, payload({ profile: 'bob', transactions: [mirrorTxn({ id: 2, external_id: 'b-1' }) as unknown as MirrorTransactionRow] }));

    expect(result.seeded).toBe(true);
    const rows = await serveTransactions(db);
    expect(rows.map((r) => r.external_id)).toEqual(['b-1']);
    expect(await getMeta(db, 'profile')).toBe('bob');
  });

  test('an uninitialized store (no meta) is treated as needing a seed', async () => {
    const db = await createMirrorDb();
    // Wipe everything to simulate a pool directory that exists but has no tables.
    await db.exec('DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS entities; DROP TABLE IF EXISTS mirror_meta;');
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'x-1' }) as unknown as MirrorTransactionRow] }));
    const rows = await serveTransactions(db);
    expect(rows).toHaveLength(1);
  });
});

describe('applySync — restored mirror (offline reload)', () => {
  test('syncs a mirror whose connection lacks the per-connection temp tables', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'old', amount: -1 })] }));

    // Simulate the offline-reload path: the pool is reopened on a fresh
    // connection, so only the persistent tables exist — recreate them WITHOUT
    // the temp tables, then sync again.
    const restored = await createMirrorDb();
    await restored.exec('DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS budgets; DROP TABLE IF EXISTS categories; DROP TABLE IF EXISTS entities; DROP TABLE IF EXISTS mirror_meta;');
    await createPersistentMirrorSchema(restored);

    const result = await applySync(restored, payload({
      transactions: [mirrorTxn({ id: 2, external_id: 'new', amount: -2 })],
    }));
    expect(result.seeded).toBe(true);
    const rows = await serveTransactions(restored);
    expect(rows.map((r) => r.external_id)).toEqual(['new']);
  });
});

describe('resetMirrorSchema', () => {
  test('drops everything and restores a usable schema (the re-seed path)', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'e' }) as unknown as MirrorTransactionRow] }));
    await resetMirrorSchema(db);
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 2, external_id: 'f' }) as unknown as MirrorTransactionRow] }));
    const rows = await serveTransactions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe('f');
  });
});
// ── Budgets + categories tables (schema v3) ─────────────────────────────────

describe('applySync — budgets', () => {
  test('seeds budgets and serves them on the vs-actual path', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      budgets: [
        mirrorBudget({ id: 1, category: 'Groceries', monthly_limit: 200 }) as unknown as MirrorBudgetRow,
        mirrorBudget({ id: 2, category: 'Dining', monthly_limit: 100.5 }) as unknown as MirrorBudgetRow,
      ],
      categories: [mirrorCategory({ name: 'Groceries', slug: 'groceries' }) as unknown as MirrorCategoryRow],
    }));

    const rows = (await serveApiPath(db, '/api/budgets?month=2026-01')) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.category).sort()).toEqual(['Dining', 'Groceries']);
    expect(rows.find((r) => r.category === 'Groceries')).toEqual({
      category: 'Groceries',
      monthly_limit: 200,
      actual: 0,
      remaining: 200,
      percent_used: 0,
      over: false,
    });
  });

  test('monthly_limit change upserts in place (keyed on category, not id)', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      budgets: [mirrorBudget({ id: 1, category: 'Groceries', monthly_limit: 200 }) as unknown as MirrorBudgetRow],
    }));

    // Server-side setBudget keeps the row's id but rewrites the limit; the pull
    // must UPDATE the existing row, not duplicate it.
    await applySync(db, payload({
      budgets: [mirrorBudget({ id: 1, category: 'Groceries', monthly_limit: 350 }) as unknown as MirrorBudgetRow],
    }));

    const raw = await db.prepare('SELECT id, category, monthly_limit FROM budgets').all();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual({ id: 1, category: 'Groceries', monthly_limit: 350 });
  });

  test('server-side budget deletion reconciles away on the next full pull', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      budgets: [
        mirrorBudget({ category: 'Groceries' }) as unknown as MirrorBudgetRow,
        mirrorBudget({ id: 2, category: 'Dining' }) as unknown as MirrorBudgetRow,
      ],
    }));
    await applySync(db, payload({
      budgets: [mirrorBudget({ category: 'Groceries' }) as unknown as MirrorBudgetRow],
    }));
    const raw = await db.prepare('SELECT category FROM budgets ORDER BY category').all();
    expect(raw).toEqual([{ category: 'Groceries' }]);
  });
});

describe('applySync — categories', () => {
  test('seeds categories and serves a renamed row after the next full pull', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({
      categories: [mirrorCategory({ id: 1, name: 'Groceries', slug: 'groceries' }) as unknown as MirrorCategoryRow],
    }));
    let raw = await db.prepare('SELECT name FROM categories').all();
    expect(raw).toEqual([{ name: 'Groceries' }]);

    await applySync(db, payload({
      categories: [mirrorCategory({ id: 1, name: 'Supermarket', slug: 'supermarket' }) as unknown as MirrorCategoryRow],
    }));
    raw = await db.prepare('SELECT name FROM categories').all();
    expect(raw).toEqual([{ name: 'Supermarket' }]);
  });

  test('category deletion reconciles away, parent/child order does not matter', async () => {
    const db = await createMirrorDb();
    // Child (id 2) arrives BEFORE its parent — foreign_keys is OFF in the mirror.
    await applySync(db, payload({
      categories: [
        mirrorCategory({ id: 2, name: 'Coffee', slug: 'coffee', parent_id: 1, is_system: 0 }) as unknown as MirrorCategoryRow,
        mirrorCategory({ id: 1, name: 'Dining', slug: 'dining' }) as unknown as MirrorCategoryRow,
      ],
    }));
    let raw = await db.prepare('SELECT id FROM categories ORDER BY id').all();
    expect(raw).toEqual([{ id: 1 }, { id: 2 }]);

    await applySync(db, payload({
      categories: [mirrorCategory({ id: 1, name: 'Dining', slug: 'dining' }) as unknown as MirrorCategoryRow],
    }));
    raw = await db.prepare('SELECT id FROM categories ORDER BY id').all();
    expect(raw).toEqual([{ id: 1 }]);
  });
});

describe('applySync — schema v3', () => {
  test('the version marker still drives the re-seed gate', async () => {
    const db = await createMirrorDb();
    await applySync(db, payload({ transactions: [mirrorTxn({ id: 1, external_id: 'old-1' }) as unknown as MirrorTransactionRow] }));
    await setMeta(db, 'schema_version', String(MIRROR_SCHEMA_VERSION - 1));

    const result = await applySync(db, payload({
      transactions: [mirrorTxn({ id: 2, external_id: 'new-1' }) as unknown as MirrorTransactionRow],
    }));
    expect(result.seeded).toBe(true);
    expect(await getMeta(db, 'schema_version')).toBe(String(MIRROR_SCHEMA_VERSION));
    // Budgets survive the re-seed too (the payload is the full set).
    const budgets = await db.prepare('SELECT category FROM budgets').all();
    expect(budgets).toEqual([{ category: 'Groceries' }]);
  });

  test('column lists cover every mirror column (full-column rows round-trip)', async () => {
    const db = await createMirrorDb();
    const budget = mirrorBudget();
    const category = mirrorCategory({ description: 'desc' });
    await applySync(db, payload({
      budgets: [budget as unknown as MirrorBudgetRow],
      categories: [category as unknown as MirrorCategoryRow],
    }));

    const budgetCols = (await db.prepare('SELECT * FROM budgets LIMIT 1').all())[0];
    expect(Object.keys(budgetCols).sort()).toEqual([...MIRROR_BUDGET_COLUMNS].sort());
    const categoryCols = (await db.prepare('SELECT * FROM categories LIMIT 1').all())[0];
    expect(Object.keys(categoryCols).sort()).toEqual([...MIRROR_CATEGORY_COLUMNS].sort());
  });
});
