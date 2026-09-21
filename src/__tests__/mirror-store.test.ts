import { describe, expect, test } from 'bun:test';
import {
  applySync,
  createMirrorSchema,
  createPersistentMirrorSchema,
  getMeta,
  isMirrorSeeded,
  resetMirrorSchema,
  setMeta,
  MIRROR_SCHEMA_VERSION,
} from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import type { MirrorTransactionRow, MirrorEntityRow, SyncPayload } from '../dashboard/ui/src/store/types.js';
import { createMirrorDb, mirrorTxn, mirrorEntity } from './mirror-helpers.js';

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    profile: 'default',
    transactions: [],
    entities: [mirrorEntity() as unknown as MirrorEntityRow],
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
    await restored.exec('DROP TABLE IF EXISTS transactions; DROP TABLE IF EXISTS entities; DROP TABLE IF EXISTS mirror_meta;');
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