import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { apiTransactions, apiEntities, apiBudgetLimits, apiCategories, apiImport, apiAccounts } from '../dashboard/api.js';
import { insertAccount, insertBalanceSnapshot, insertLoan } from '../db/net-worth-queries.js';
import { syncAccountRows, syncBalanceSnapshotRows, syncLoanRows } from '../dashboard/sync-routes.js';
import { mirrorNetWorth, mirrorStartingCash } from '../dashboard/ui/src/store/mirror-networth.js';
import { insertTransactions, setBudget } from '../db/queries.js';
import { runSync, collectSyncPayload, subagentEnabledFrom, SYNC_PULL_LIMIT, type SyncFetcher } from '../dashboard/ui/src/store/sync-engine.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { createMirrorDb, mirrorTxn, mirrorEntity, mirrorBudget, mirrorCategory, mirrorAccount, mirrorSnapshot, mirrorLoan } from './mirror-helpers.js';
import type { MirrorTransactionRow, MirrorEntityRow, MirrorBudgetRow, MirrorCategoryRow, MirrorAccountRow, MirrorBalanceSnapshotRow, MirrorLoanRow } from '../dashboard/ui/src/store/types.js';
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
    private budgets: () => MirrorBudgetRow[] = () => [],
    private categories: () => MirrorCategoryRow[] = () => [],
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
  async fetchAllBudgets(): Promise<MirrorBudgetRow[]> {
    if (this.failOnCall === this.calls) throw new TypeError('Failed to fetch');
    return this.budgets();
  }
  async fetchAllCategories(): Promise<MirrorCategoryRow[]> {
    if (this.failOnCall === this.calls) throw new TypeError('Failed to fetch');
    return this.categories();
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
    async fetchAllBudgets() {
      return apiBudgetLimits(serverDb) as unknown as MirrorBudgetRow[];
    },
    async fetchAllCategories() {
      return apiCategories(serverDb) as unknown as MirrorCategoryRow[];
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
      fetchAllBudgets: async () => apiBudgetLimits(serverDbB) as unknown as MirrorBudgetRow[],
      fetchAllCategories: async () => apiCategories(serverDbB) as unknown as MirrorCategoryRow[],
    });
    expect(result).toMatchObject({ ok: true, profile: 'profile-b', seeded: true });
    const after = await rows(db);
    expect(after).toHaveLength(1);
    expect(after[0].description).toBe('B row');
  });
});

describe('budgets and categories ride the same sync path', () => {
  test('a full pull seeds the mirror with budgets and categories from the server', async () => {
    const serverDb = createTestDb();
    insertTransactions(serverDb, [
      { date: '2026-03-05', description: 'Groceries run', amount: -50, category: 'Groceries' },
    ]);
    setBudget(serverDb, 'Groceries', 200);
    const db = await createMirrorDb();

    const result = await runSync(db, serverFetcher(serverDb));
    expect(result).toMatchObject({ ok: true, seeded: true });

    // The budget card aggregation works offline from the synced tables.
    const vsActual = (await serveApiPath(db, '/api/budgets?month=2026-03')) as Array<Record<string, unknown>>;
    expect(vsActual).toEqual([{ category: 'Groceries', monthly_limit: 200, limit: 200, months: 1, actual: 50, remaining: 150, percent_used: 25, over: false }]);
  });

  test('a failing budgets/categories pull leaves the mirror on its last good set', async () => {
    const db = await createMirrorDb();
    const goodBudget = mirrorBudget({ category: 'Groceries', monthly_limit: 200 });
    const fetcher = new FakeFetcher(
      () => 'alice',
      () => [mirrorTxn({ id: 1, external_id: 'ext-1', amount: -1 }) as unknown as MirrorTransactionRow],
      () => [mirrorEntity() as unknown as MirrorEntityRow],
      2, // second runSync's budgets pull throws a fetch-style TypeError
      () => [goodBudget],
      () => [mirrorCategory()],
    );

    await runSync(db, fetcher);
    const before = (await serveApiPath(db, '/api/budgets')) as unknown[];
    expect(before).toHaveLength(1);

    const failed = await runSync(db, fetcher);
    expect(failed).toEqual({ ok: false, error: 'Failed to fetch' });
    expect(((await serveApiPath(db, '/api/budgets')) as unknown[])).toEqual(before);
  });
});

describe('runSync: v4 account fetchers', () => {
  test('pulls accounts, balance snapshots and loans alongside the rest, in one apply', async () => {
    const serverDb = createTestDb();
    const house = insertAccount(serverDb, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
    const mortgage = insertAccount(serverDb, { name: 'Home Loan', account_type: 'liability', account_subtype: 'mortgage', current_balance: 250000.5 });
    insertLoan(serverDb, { account_id: mortgage, original_principal: 300000, interest_rate: 6.5, term_months: 360, start_date: '2020-01-01', linked_asset_id: house });
    insertBalanceSnapshot(serverDb, { account_id: house, balance: 390000, snapshot_date: '2026-06-30' });

    const db = await createMirrorDb();
    const fetcher: SyncFetcher = {
      ...serverFetcher(serverDb),
      fetchAllAccounts: async () => apiAccounts(serverDb) as unknown as MirrorAccountRow[],
      fetchAllBalanceSnapshots: async () => syncBalanceSnapshotRows(serverDb) as unknown as MirrorBalanceSnapshotRow[],
      fetchAllLoans: async () => syncLoanRows(serverDb) as unknown as MirrorLoanRow[],
    };
    const result = await runSync(db, fetcher, { netWorth: true });
    expect(result.ok).toBe(true);
    expect(((await db.prepare('SELECT name FROM accounts ORDER BY id').all()) as Array<{ name: string }>).map((r) => r.name)).toEqual(['House', 'Home Loan']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get()).toEqual({ n: 1 });
    expect(await db.prepare('SELECT account_id, linked_asset_id FROM loans').all()).toEqual([{ account_id: mortgage, linked_asset_id: house }]);
  });

  /** A plain-object fetcher (FakeFetcher methods live on the prototype) with all three v4 methods. */
  function v4Fetcher(profile = 'alice', txns: MirrorTransactionRow[] = []): SyncFetcher & { v4Calls: string[] } {
    const base = new FakeFetcher(() => profile, () => txns, () => []);
    const v4Calls: string[] = [];
    return {
      v4Calls,
      fetchActiveProfile: () => base.fetchActiveProfile(),
      fetchAllTransactions: () => base.fetchAllTransactions(),
      fetchAllEntities: () => base.fetchAllEntities(),
      fetchAllBudgets: () => base.fetchAllBudgets(),
      fetchAllCategories: () => base.fetchAllCategories(),
      fetchAllAccounts: async () => { v4Calls.push('accounts'); return [mirrorAccount()]; },
      fetchAllBalanceSnapshots: async () => { v4Calls.push('snapshots'); return [mirrorSnapshot()]; },
      fetchAllLoans: async () => { v4Calls.push('loans'); return [mirrorLoan()]; },
    };
  }

  test('the projected sync rows give the net-worth executors the same answers as the full rows', async () => {
    const serverDb = createTestDb();
    const house = insertAccount(serverDb, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', institution: 'County', account_number_last4: '9999', current_balance: 400000 });
    insertAccount(serverDb, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', institution: 'Test Bank', current_balance: 2500.25 });
    const mortgage = insertAccount(serverDb, { name: 'Home Loan', account_type: 'liability', account_subtype: 'mortgage', current_balance: 250000.5 });
    insertLoan(serverDb, { account_id: mortgage, original_principal: 300000, interest_rate: 6.5, term_months: 360, start_date: '2020-01-01', linked_asset_id: house });
    insertBalanceSnapshot(serverDb, { account_id: house, balance: 390000, snapshot_date: '2026-06-30' });

    const projected = await createMirrorDb();
    const full = await createMirrorDb();
    const base = serverFetcher(serverDb);
    await runSync(projected, {
      ...base,
      fetchAllAccounts: async () => syncAccountRows(serverDb) as unknown as MirrorAccountRow[],
      fetchAllBalanceSnapshots: async () => syncBalanceSnapshotRows(serverDb) as unknown as MirrorBalanceSnapshotRow[],
      fetchAllLoans: async () => syncLoanRows(serverDb) as unknown as MirrorLoanRow[],
    }, { netWorth: true });
    await runSync(full, {
      ...base,
      fetchAllAccounts: async () => apiAccounts(serverDb) as unknown as MirrorAccountRow[],
      fetchAllBalanceSnapshots: async () => [],
      fetchAllLoans: async () => syncLoanRows(serverDb) as unknown as MirrorLoanRow[],
    }, { netWorth: true });

    for (const action of ['summary', 'balance_sheet'] as const) {
      expect(JSON.stringify(await mirrorNetWorth(projected, action))).toBe(JSON.stringify(await mirrorNetWorth(full, action)));
    }
    expect(await mirrorStartingCash(projected)).toBe(await mirrorStartingCash(full));
    // And the mirror really holds no account number / plaid id / note.
    const row = (await projected.prepare('SELECT account_number_last4, plaid_account_id, notes FROM accounts WHERE id = @id').get({ id: house })) as Record<string, unknown>;
    expect(row).toEqual({ account_number_last4: null, plaid_account_id: null, notes: null });
  });

  test('the v4 tables are fetched ONLY when asked for: the default sync never calls the v4 fetchers', async () => {
    const db = await createMirrorDb();
    const fetcher = v4Fetcher();
    expect((await runSync(db, fetcher)).ok).toBe(true);
    expect(fetcher.v4Calls).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
    expect((await runSync(db, fetcher, { netWorth: false })).ok).toBe(true);
    expect(fetcher.v4Calls).toEqual([]);
  });

  test('turning the subagent off empties previously synced balances instead of keeping them in the browser', async () => {
    const db = await createMirrorDb();
    const fetcher = v4Fetcher();
    await runSync(db, fetcher, { netWorth: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
    await runSync(db, fetcher, { netWorth: false });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM loans').get()).toEqual({ n: 0 });
  });

  test('a failing v4 fetch does NOT fail the sync: core tables update, v4 tables keep their last good set', async () => {
    const db = await createMirrorDb();
    const fetcher = v4Fetcher('alice', [mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow]);
    await runSync(db, fetcher, { netWorth: true });
    const before = await db.prepare('SELECT id, name FROM accounts').all();
    expect(before.length).toBe(1);

    const failing: SyncFetcher = {
      ...fetcher,
      fetchAllTransactions: async () => [
        mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow,
        mirrorTxn({ id: 2, external_id: 'ext-2' }) as unknown as MirrorTransactionRow,
      ],
      fetchAllLoans: async () => { throw new TypeError('Failed to fetch'); },
    };
    const result = await runSync(db, failing, { netWorth: true });
    expect(result.ok).toBe(true);
    expect(((await db.prepare('SELECT COUNT(*) AS n FROM transactions').get()) as { n: number }).n).toBe(2);
    expect(await db.prepare('SELECT id, name FROM accounts').all()).toEqual(before);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM loans').get()).toEqual({ n: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get()).toEqual({ n: 1 });
  });

  test('a failing v4 fetch on the very first sync leaves the v4 tables empty and the sync ok', async () => {
    const db = await createMirrorDb();
    const failing: SyncFetcher = { ...v4Fetcher(), fetchAllAccounts: async () => { throw new Error('boom'); } };
    expect((await runSync(db, failing, { netWorth: true })).ok).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
  });

  test('a failing CORE fetch still fails the whole sync and leaves the mirror untouched', async () => {
    const db = await createMirrorDb();
    const fetcher = v4Fetcher('alice', [mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow]);
    await runSync(db, fetcher, { netWorth: true });
    const before = await db.prepare('SELECT id FROM accounts').all();
    const failing: SyncFetcher = { ...fetcher, fetchAllCategories: async () => { throw new TypeError('Failed to fetch'); } };
    const failed = await runSync(db, failing, { netWorth: true });
    expect(failed).toEqual({ ok: false, error: 'Failed to fetch' });
    expect(await db.prepare('SELECT id FROM accounts').all()).toEqual(before);
  });

  test('a v4 fetch that rejects after the core fetch already failed is not an unhandled rejection', async () => {
    const db = await createMirrorDb();
    const failing: SyncFetcher = {
      ...v4Fetcher(),
      fetchAllEntities: async () => { throw new TypeError('core down'); },
      fetchAllAccounts: async () => { throw new TypeError('v4 down'); },
    };
    expect(await runSync(db, failing, { netWorth: true })).toEqual({ ok: false, error: 'core down' });
  });

  test('collectSyncPayload reports whether v4 was kept, fetched or skipped', async () => {
    const f = v4Fetcher();
    const off = await collectSyncPayload(f, { netWorth: false });
    expect(off.accounts).toBeUndefined();
    expect(off.keepNetWorth).toBeUndefined();
    const on = await collectSyncPayload(f, { netWorth: true });
    expect(on.accounts?.length).toBe(1);
    expect(on.keepNetWorth).toBeUndefined();
    const broken = await collectSyncPayload({ ...f, fetchAllLoans: async () => { throw new Error('x'); } }, { netWorth: true });
    expect(broken.accounts).toBeUndefined();
    expect(broken.keepNetWorth).toBe(true);
  });

  test('subagentEnabledFrom reads only an explicit true from the local-chat config', () => {
    expect(subagentEnabledFrom({ subagent: { enabled: true, maxSteps: 3 } })).toBe(true);
    for (const v of [null, undefined, {}, { subagent: null }, { subagent: {} }, { subagent: { enabled: false } }, { subagent: { enabled: 'true' } }, { subagent: { enabled: 1 } }, 'x', 5]) {
      expect(subagentEnabledFrom(v)).toBe(false);
    }
  });

  test('fetchers that predate v4 (no account methods) still sync, with empty account tables', async () => {
    const db = await createMirrorDb();
    const fetcher = new FakeFetcher(() => 'alice', () => [mirrorTxn({ id: 1, external_id: 'ext-1' }) as unknown as MirrorTransactionRow], () => []);
    expect((await runSync(db, fetcher)).ok).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 0 });
  });
});

describe('mirror-client wiring (source pin: the module needs a browser worker, so it cannot be imported here)', () => {
  const src = require('node:fs').readFileSync(
    new URL('../dashboard/ui/src/store/mirror-client.ts', import.meta.url),
    'utf8',
  ) as string;

  test('the v4 pull goes through collectSyncPayload gated on the server subagent flag', () => {
    expect(src).toContain("fetchJson<unknown>('/api/config/local-chat')");
    expect(src).toContain('collectSyncPayload(syncFetcher, { netWorth })');
  });

  test('accounts come from the projected sync route, never the SELECT * route', () => {
    expect(src).toContain("'/api/sync/accounts'");
    expect(src).not.toMatch(/fetchJson<MirrorAccountRow\[\]>\('\/api\/accounts'\)/);
  });
});
