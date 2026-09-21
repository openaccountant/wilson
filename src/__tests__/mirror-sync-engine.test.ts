import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { apiTransactions, apiEntities, apiImport } from '../dashboard/api.js';
import { insertTransactions } from '../db/queries.js';
import { runSync, SYNC_PULL_LIMIT, type SyncFetcher } from '../dashboard/ui/src/store/sync-engine.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { createMirrorDb, mirrorTxn, mirrorEntity } from './mirror-helpers.js';
import type { MirrorTransactionRow, MirrorEntityRow } from '../dashboard/ui/src/store/types.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * The sync engine: full-pull → applySync semantics, driven by fake fetchers.
 * Also pins the "importer arrives via sync" rule: rows written by the server's
 * POST /api/import endpoint reach the mirror only through the next runSync
 * pull — there is no importer-to-mirror write path.
 */

class FakeFetcher implements SyncFetcher {
  calls = 0;
  constructor(
    private profile: () => string,
    private transactions: () => MirrorTransactionRow[],
    private entities: () => MirrorEntityRow[],
    private failOnCall?: number,
  ) {}

  async fetchActiveProfile(): Promise<string> {
    this.calls++;
    if (this.failOnCall === this.calls) throw new TypeError('Failed to fetch');
    return this.profile();
  }
  async fetchAllTransactions(): Promise<MirrorTransactionRow[]> {
    if (this.failOnCall === this.calls) throw new TypeError('Failed to fetch');
    return this.transactions();
  }
  async fetchAllEntities(): Promise<MirrorEntityRow[]> {
    if (this.failOnCall === this.calls) throw new TypeError('Failed to fetch');
    return this.entities();
  }
}

/** A fetcher backed by a real server db through the real api handlers. */
function serverFetcher(serverDb: Database, profile = 'default'): SyncFetcher & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async fetchActiveProfile() {
      calls++;
      return profile;
    },
    async fetchAllTransactions() {
      return apiTransactions(serverDb, new URLSearchParams({ limit: String(SYNC_PULL_LIMIT) })) as unknown as MirrorTransactionRow[];
    },
    async fetchAllEntities() {
      return apiEntities(serverDb) as unknown as MirrorEntityRow[];
    },
  };
}

async function rows(db: Awaited<ReturnType<typeof createMirrorDb>>, query = 'limit=10000000') {
  return (await serveApiPath(db, `/api/transactions?${query}`)) as Record<string, unknown>[];
}

describe('runSync', () => {
  test('seeds the mirror from the fetcher, recording the profile', async () => {
    const db = await createMirrorDb();
    const fetcher = new FakeFetcher(
      () => 'alice',
      () => [mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
    );

    const result = await runSync(db, fetcher);
    expect(result).toEqual({ ok: true, profile: 'alice', seeded: true, upserted: 1, deleted: 0 });
    expect(await rows(db)).toHaveLength(1);
  });

  test('refreshes on the second pull (seeded: false, no deletions)', async () => {
    const db = await createMirrorDb();
    const data = [mirrorTxn({ id: 1, external_id: 'ext-1', amount: -1 })];
    const fetcher = new FakeFetcher(
      () => 'alice',
      () => data.map((r) => ({ ...r })) as unknown as MirrorTransactionRow[],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
    );
    await runSync(db, fetcher);
    data[0] = mirrorTxn({ id: 1, external_id: 'ext-1', amount: -2 });
    const result = await runSync(db, fetcher);
    expect(result).toMatchObject({ ok: true, seeded: false, upserted: 1, deleted: 0 });
    expect((await rows(db))[0].amount).toBe(-2);
  });

  test('server unreachable → ok:false and the mirror keeps its last good set', async () => {
    const db = await createMirrorDb();
    const data = [mirrorTxn({ id: 1, external_id: 'ext-1', amount: -1 })];
    const fetcher = new FakeFetcher(
      () => 'alice',
      () => data as unknown as MirrorTransactionRow[],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
      2, // second runSync's fetch throws a fetch-style TypeError
    );
    await runSync(db, fetcher);
    const before = await rows(db);

    const failed = await runSync(db, fetcher);
    expect(failed).toEqual({ ok: false, error: 'Failed to fetch' });
    expect(await rows(db)).toEqual(before);
  });

  test('recovers on the next successful pull', async () => {
    const db = await createMirrorDb();
    const data = [mirrorTxn({ id: 1, external_id: 'ext-1', amount: -1 })];
    const fetcher = new FakeFetcher(
      () => 'alice',
      () => data as unknown as MirrorTransactionRow[],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
      2,
    );
    await runSync(db, fetcher);
    await runSync(db, fetcher); // fails
    data[0] = mirrorTxn({ id: 1, external_id: 'ext-1', amount: -9 });
    await runSync(db, fetcher); // recovers
    expect((await rows(db))[0].amount).toBe(-9);
  });

  test('a profile switch re-seeds the mirror for the new profile', async () => {
    const db = await createMirrorDb();
    let profile = 'alice';
    let txns = [mirrorTxn({ id: 1, external_id: 'a-1', amount: -1 })];
    const fetcher = new FakeFetcher(
      () => profile,
      () => txns as unknown as MirrorTransactionRow[],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
    );
    await runSync(db, fetcher);

    profile = 'bob';
    txns = [mirrorTxn({ id: 2, external_id: 'b-1', amount: -2 })];
    const result = await runSync(db, fetcher);
    expect(result).toMatchObject({ ok: true, profile: 'bob', seeded: true });
    const after = await rows(db);
    expect(after).toHaveLength(1);
    expect(after[0].external_id).toBe('b-1');
  });
});

describe('browser statement imports reach the mirror only via sync', () => {
  test('rows committed by POST /api/import land on the next runSync pull', async () => {
    const serverDb = createTestDb();
    insertTransactions(serverDb, [
      { date: '2026-03-01', description: 'Seed row', amount: -5, external_id: 'ext-seed-1' },
    ]);
    const db = await createMirrorDb();

    // First pull: the mirror sees the pre-import state.
    const result1 = await runSync(db, serverFetcher(serverDb));
    expect(result1.ok).toBe(true);
    expect(await rows(db)).toHaveLength(1);

    // The browser statement importer writes to the SERVER db only.
    const imported = await apiImport(serverDb, {
      filename: 'browser.csv',
      transactions: [
        { date: '2026-03-02', description: 'Imported row', amount: -7.5, external_id: 'ext-imported-1' },
      ],
    });
    expect(imported.status).toBe('imported');

    // The mirror is unchanged until the next pull — no importer-to-mirror write.
    expect(await rows(db)).toHaveLength(1);

    const result2 = await runSync(db, serverFetcher(serverDb));
    expect(result2).toMatchObject({ ok: true, upserted: 2, seeded: false });
    const after = await rows(db);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.external_id).sort()).toEqual(['ext-imported-1', 'ext-seed-1']);
  });

  test('per-profile pulls stay keyed per profile', async () => {
    const serverDbA = createTestDb();
    const serverDbB = createTestDb();
    insertTransactions(serverDbA, [{ date: '2026-03-01', description: 'A row', amount: -1, external_id: 'ext-a' }]);
    insertTransactions(serverDbB, [{ date: '2026-03-01', description: 'B row', amount: -2, external_id: 'ext-b' }]);

    const db = await createMirrorDb();
    await runSync(db, serverFetcher(serverDbA, 'profile-a'));

    // Simulate the client's rekey + sync for profile-b against the same store.
    const result = await runSync(db, {
      fetchActiveProfile: async () => 'profile-b',
      fetchAllTransactions: async () =>
        apiTransactions(serverDbB, new URLSearchParams({ limit: String(SYNC_PULL_LIMIT) })) as unknown as MirrorTransactionRow[],
      fetchAllEntities: async () => apiEntities(serverDbB) as unknown as MirrorEntityRow[],
    });
    expect(result).toMatchObject({ ok: true, profile: 'profile-b', seeded: true });
    const after = await rows(db);
    expect(after).toHaveLength(1);
    expect(after[0].description).toBe('B row');
  });
});