/**
 * Embed-on-write — the semantic index stays fresh across every insert, edit,
 * and delete path without the user ever running `wilson --index`.
 *
 * Each path is driven end-to-end with a deterministic recording fake embedder:
 *   - insert: CSV/OFX/QIF import, Monarch, Firefly (via insertTransactions),
 *     Plaid sync (raw INSERTs incl. the modified-row fallback), Coinbase sync
 *   - update: description edit (agent tool + dashboard PATCH), Plaid
 *     pending→posted text change
 *   - delete: deleteTransaction drops the stored vectors
 *   - degrade: a throwing embedder must never fail an import or edit
 */
import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData, makeTmpPath } from './helpers.js';
import { createFakeEmbedder, fakeEmbedText } from './fake-embedder.js';
import { setEmbedOnWriteEmbedder, embedTransactionIds } from '../utils/embed-on-write.js';
import {
  upsertEmbeddings,
  deleteOrphanedTransactionEmbeddings,
  blobToVec,
  countMissingTransactionTargets,
} from '../db/embedding-queries.js';
import { insertTransactions, deleteTransaction } from '../db/queries.js';
import { runEmbeddingIndex } from '../embedding-backfill.js';
import { transactionEmbedText, DEFAULT_EMBEDDING_MODEL } from '../utils/embeddings.js';
import * as licenseModule from '../licensing/license.js';
import type { SyncedTransaction } from '../plaid/client.js';
import type { CoinbaseAccountData, CoinbaseTransaction } from '../coinbase/client.js';
import type { PlaidItem } from '../plaid/store.js';
import type { CoinbaseConnection } from '../coinbase/store.js';

// ── Mocked modules ───────────────────────────────────────────────────────────

// Mutable fixture for the (virtual) monarch-money-api mock — reassigned per test.
let monarchResult: unknown = { allTransactions: { results: [] } };

// ── Pinned module namespaces ─────────────────────────────────────────────────
// plaid/client.js and plaid/store.js are real modules that earlier test files
// (sync.test.ts, plaid-balances-tool.test.ts) resolve and mock.module first —
// bun pins a real module at first resolution, so registrations here cannot win
// that race. Per-test behavior is therefore controlled with spyOn on the
// pinned namespace objects, which the fresh tool instances below bind too.
// monarch-money-api is not installed, so it only ever exists as a virtual
// mock module — re-registration resolves cleanly per file.
const plaidClient = await import('../plaid/client.js');
const plaidStore = await import('../plaid/store.js');
const coinbaseClient = await import('../coinbase/client.js');
const coinbaseStore = await import('../coinbase/store.js');

mock.module('monarch-money-api', () => ({
  setToken: () => {},
  loginUser: async () => {},
  getTransactions: async () => monarchResult,
}));

// ── Per-test spies ───────────────────────────────────────────────────────────
type SpyHandle = { mockRestore: () => void };
let activeSpies: SpyHandle[] = [];

function spyPlaidSync(response: {
  added: SyncedTransaction[];
  modified: SyncedTransaction[];
  removed: string[];
  nextCursor: string;
}): void {
  activeSpies.push(
    spyOn(plaidClient, 'syncTransactions').mockImplementation(async () => response),
    spyOn(plaidClient, 'getBalances').mockImplementation(async () => []),
    // updatePlaidCursor writes the real ~/.openaccountant file — never in tests.
    spyOn(plaidStore, 'updatePlaidCursor').mockImplementation(() => {}),
  );
}

function spyCoinbaseSync(accounts: CoinbaseAccountData[], txns: CoinbaseTransaction[]): void {
  activeSpies.push(
    spyOn(coinbaseClient, 'getAccounts').mockImplementation(async () => accounts),
    spyOn(coinbaseClient, 'getTransactions').mockImplementation(async () => txns),
    // updateLastSyncedAt writes the real ~/.openaccountant file — never in tests.
    spyOn(coinbaseStore, 'updateLastSyncedAt').mockImplementation(() => {}),
  );
}

function restoreSpies(): void {
  for (const spy of activeSpies) spy.mockRestore();
  activeSpies = [];
}

// Import the modules under test after the mocks are registered. The sync
// tools are imported through a query-string cache-busting specifier: other
// test files (sync.test.ts) replace the plain specifier process-wide with a
// no-op stub and bun has no unmock, so a fresh instance bound to OUR mocks is
// the only way to exercise the real sync logic deterministically.
const freshQuery = '?embed-on-write-under-test';
const plaidSyncUnderTest = (await import(
  `../tools/import/plaid-sync.js${freshQuery}`
)) as typeof import('../tools/import/plaid-sync.js');
const coinbaseSyncUnderTest = (await import(
  `../tools/import/coinbase-sync.js${freshQuery}`
)) as typeof import('../tools/import/coinbase-sync.js');
const { syncPlaidItem } = plaidSyncUnderTest;
const { syncCoinbaseConnection } = coinbaseSyncUnderTest;
const { initImportTool, csvImportTool } = await import('../tools/import/csv-import.js');
const { initMonarchTool, monarchImportTool } = await import('../tools/import/monarch.js');
const { initFireflyTool, fireflyImportTool } = await import('../tools/import/firefly.js');
const { initEditTransactionTool, editTransactionTool } = await import('../tools/query/edit-transaction.js');
const { initDeleteTransactionTool, deleteTransactionTool } = await import('../tools/query/delete-transaction.js');
const { apiUpdateTransaction } = await import('../dashboard/api.js');

// Restore the plain deterministic fake when this file finishes — module state
// is process-wide, so a throwing/recording fake left behind would poison
// every test file that runs after this one.
afterAll(() => {
  setEmbedOnWriteEmbedder(async (texts) => texts.map(fakeEmbedText));
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function embeddingCount(db: Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM embeddings WHERE source_type = 'transaction'").get() as { c: number }
  ).c;
}

function getStoredVec(
  db: Database,
  sourceId: number,
  model: string = DEFAULT_EMBEDDING_MODEL
): Float32Array | undefined {
  const row = db
    .prepare(
      "SELECT vec FROM embeddings WHERE source_type = 'transaction' AND source_id = @id AND model = @model"
    )
    .get({ id: sourceId, model }) as { vec: Uint8Array } | undefined;
  return row ? blobToVec(row.vec) : undefined;
}

function rowsById(db: Database): Array<{ id: number; merchant_name: string | null; description: string }> {
  return db
    .prepare('SELECT id, merchant_name, description FROM transactions ORDER BY id')
    .all() as Array<{ id: number; merchant_name: string | null; description: string }>;
}

/** Seed a transaction row exactly like the Plaid sync path's raw INSERT would. */
function insertPlaidRow(
  database: Database,
  tid: string,
  opts: { description?: string; merchantName?: string | null; amount?: number } = {}
): number {
  const result = database
    .prepare(
      `INSERT INTO transactions (date, description, amount, source_file, plaid_transaction_id, external_id, merchant_name)
       VALUES (@date, @description, @amount, @source_file, @plaid_transaction_id, @external_id, @merchant_name)`
    )
    .run({
      date: '2026-03-01',
      description: opts.description ?? 'Old Name',
      amount: opts.amount ?? -25,
      source_file: 'plaid:Test Bank',
      plaid_transaction_id: tid,
      external_id: tid,
      merchant_name: opts.merchantName ?? null,
    });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

function makeItem(overrides: Partial<PlaidItem> = {}): PlaidItem {
  return {
    itemId: 'item-1',
    accessToken: 'access-sandbox-test',
    institutionName: 'Test Bank',
    accounts: [{ id: 'acc-1', name: 'Checking', mask: '1234' }],
    cursor: null,
    linkedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePlaidTxn(overrides: Partial<SyncedTransaction> = {}): SyncedTransaction {
  return {
    transactionId: 'plaid-txn-x',
    date: '2026-03-01',
    name: 'Test Merchant',
    amount: 10,
    category: [],
    accountId: 'acc-1',
    pending: false,
    ...overrides,
  };
}

function makeCoinbaseConn(): CoinbaseConnection {
  return {
    keyName: 'organizations/org-1/apiKeys/key-1',
    privateKey: '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----',
    accounts: [],
    linkedAt: new Date().toISOString(),
    lastSyncedAt: null,
  };
}

function writeTmp(content: string): string {
  const fp = makeTmpPath('.csv');
  writeFileSync(fp, content);
  return fp;
}

// ── Insert paths ─────────────────────────────────────────────────────────────

describe('embed-on-write: insert paths', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
    initMonarchTool(db);
    initFireflyTool(db);
  });

  afterEach(() => {
    restoreSpies();
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('CSV import: vectors exist for the new rows, stored under the default model', async () => {
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    const fp = writeTmp(
      `Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n` +
        `01/15/2026,01/16/2026,BLUE BOTTLE COFFEE,Dining,Sale,-6.75,\n` +
        `01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,\n` +
        `01/20/2026,01/21/2026,WHOLE FOODS MARKET,Groceries,Sale,-85.50,`
    );
    tmpFiles.push(fp);

    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(3);

    const txns = rowsById(db);
    expect(txns).toHaveLength(3);
    expect(embeddingCount(db)).toBe(3);

    // Every row was embedded exactly once, following the canonical text rule,
    // in id order (insertion order).
    const expected = txns.map((t) => transactionEmbedText(t));
    expect(fake.calls).toEqual(expected);
    expect(fake.batchCount).toBe(1);

    // The stored vector bytes equal the fake embedder's output for that row.
    const first = txns[0];
    expect(getStoredVec(db, first.id)).toEqual(fakeEmbedText(transactionEmbedText(first)));

    // Stored under the default model, like a backfill run would.
    const models = db.prepare('SELECT DISTINCT model FROM embeddings').all() as Array<{ model: string }>;
    expect(models).toEqual([{ model: DEFAULT_EMBEDDING_MODEL }]);
  });

  test('Monarch import: vectors exist for the new rows (no merchant_name → description only)', async () => {
    const licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
    process.env.MONARCH_TOKEN = 'test-token';
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);
    try {
      monarchResult = {
        allTransactions: {
          results: [
            { id: '1', amount: 42.67, date: '2026-01-03', pending: false, plaidName: null, notes: null, isRecurring: false, category: { name: 'Groceries' }, merchant: { name: 'Corner Market' }, account: null },
            { id: '2', amount: -3200, date: '2026-01-05', pending: false, plaidName: null, notes: null, isRecurring: false, category: { name: 'Income' }, merchant: { name: 'Acme Corp' }, account: null },
            { id: '3', amount: 14.99, date: '2026-01-07', pending: false, plaidName: null, notes: null, isRecurring: true, category: null, merchant: { name: 'StreamCo' }, account: null },
          ],
        },
      };

      const raw = await monarchImportTool.func({});
      const result = JSON.parse(raw as string);
      expect(result.data.success).toBe(true);
      expect(result.data.transactionsImported).toBe(3);

      const txns = rowsById(db);
      expect(txns).toHaveLength(3);
      expect(embeddingCount(db)).toBe(3);
      // Monarch inserts carry no merchant_name — embed text is the description.
      expect(fake.calls).toEqual(txns.map((t) => transactionEmbedText(t)));
      expect(fake.calls).toContain('Corner Market');
      expect(getStoredVec(db, txns[0].id)).toEqual(fakeEmbedText(fake.calls[0]));
    } finally {
      licenseSpy.mockRestore();
      delete process.env.MONARCH_TOKEN;
    }
  });

  test('Firefly import: vectors exist for the new rows (merchant_name = description → "d d")', async () => {
    const licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              type: 'transactions',
              id: '1',
              attributes: {
                group_title: null,
                transactions: [
                  {
                    transaction_journal_id: '101',
                    type: 'withdrawal',
                    date: '2026-01-03T00:00:00+00:00',
                    amount: '42.67',
                    description: 'Weekly groceries',
                    source_name: 'Checking',
                    destination_name: 'Corner Market',
                    category_name: 'Groceries',
                    budget_name: null,
                    bill_name: null,
                    tags: [],
                    notes: null,
                    internal_reference: null,
                    external_url: null,
                    subscription_name: null,
                  },
                ],
              },
            },
            {
              type: 'transactions',
              id: '2',
              attributes: {
                group_title: null,
                transactions: [
                  {
                    transaction_journal_id: '102',
                    type: 'deposit',
                    date: '2026-01-05T12:00:00+00:00',
                    amount: '3200.00',
                    description: 'Monthly payroll',
                    source_name: 'Acme Corp',
                    destination_name: 'Checking',
                    category_name: 'Income',
                    budget_name: null,
                    bill_name: null,
                    tags: [],
                    notes: null,
                    internal_reference: null,
                    external_url: null,
                    subscription_name: null,
                  },
                ],
              },
            },
          ],
          meta: { pagination: { total: 2, count: 2, per_page: 50, current_page: 1, total_pages: 1 } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }
      )
    );
    try {
      const raw = await fireflyImportTool.func({});
      const result = JSON.parse(raw as string);
      expect(result.data.success).toBe(true);
      expect(result.data.transactionsImported).toBe(2);

      const txns = rowsById(db);
      expect(txns).toHaveLength(2);
      expect(embeddingCount(db)).toBe(2);

      // Firefly sets merchant_name = description, so the canonical rule makes
      // the embed text "Corner Market Corner Market".
      const grocery = txns.find((t) => t.description === 'Corner Market')!;
      expect(transactionEmbedText(grocery)).toBe('Corner Market Corner Market');
      expect(fake.calls).toContain('Corner Market Corner Market');
      expect(getStoredVec(db, grocery.id)).toEqual(fakeEmbedText('Corner Market Corner Market'));
    } finally {
      licenseSpy.mockRestore();
      fetchSpy.mockRestore();
      delete process.env.FIREFLY_API_URL;
      delete process.env.FIREFLY_API_TOKEN;
    }
  });

  test('Plaid sync (added): vectors exist; a duplicate re-sync embeds nothing new', async () => {
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    const txn = makePlaidTxn({
      transactionId: 'plaid-txn-1',
      name: 'Blue Bottle Coffee',
      merchantName: 'Blue Bottle',
      amount: 6.75,
    });
    spyPlaidSync({ added: [txn], modified: [], removed: [], nextCursor: 'c1' });

    await syncPlaidItem(db, makeItem(), false);

    const row = db
      .prepare("SELECT id, amount, merchant_name, description FROM transactions WHERE plaid_transaction_id = 'plaid-txn-1'")
      .get() as { id: number; amount: number; merchant_name: string | null; description: string };
    expect(row).toBeDefined();
    expect(row.amount).toBe(-6.75); // Plaid positive=debit → OA negative
    expect(embeddingCount(db)).toBe(1);
    expect(fake.calls).toEqual([transactionEmbedText({ merchant_name: 'Blue Bottle', description: 'Blue Bottle Coffee' })]);
    expect(getStoredVec(db, row.id)).toEqual(fakeEmbedText(fake.calls[0]));

    // Second sync returning the same transactionId is deduped — no new row,
    // no new embed call.
    spyPlaidSync({ added: [{ ...txn }], modified: [], removed: [], nextCursor: 'c2' });
    await syncPlaidItem(db, makeItem(), false);
    expect(fake.calls).toHaveLength(1);
    expect(embeddingCount(db)).toBe(1);
    const count = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE plaid_transaction_id = 'plaid-txn-1'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  test('Plaid sync (modified): vector refreshed only when description/merchant changed', async () => {
    const id = insertPlaidRow(db, 'txn-1', { description: 'Old Name', merchantName: 'Old Merchant Inc' });
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Old Merchant Inc Old Name') },
    ]);

    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    // Pending → posted: description and merchant name change.
    spyPlaidSync({
      added: [],
      modified: [makePlaidTxn({ transactionId: 'txn-1', name: 'New Name', merchantName: 'New Merchant Inc', amount: 30 })],
      removed: [],
      nextCursor: 'c2',
    });
    await syncPlaidItem(db, makeItem(), false);

    expect(fake.calls).toEqual(['New Merchant Inc New Name']);
    expect(getStoredVec(db, id)).toEqual(fakeEmbedText('New Merchant Inc New Name'));

    // Second sync with identical text (pure amount churn) → no re-embed.
    const fake2 = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake2.embed);
    spyPlaidSync({
      added: [],
      modified: [makePlaidTxn({ transactionId: 'txn-1', name: 'New Name', merchantName: 'New Merchant Inc', amount: 33.5 })],
      removed: [],
      nextCursor: 'c3',
    });
    await syncPlaidItem(db, makeItem(), false);
    expect(fake2.calls).toHaveLength(0);
    expect(getStoredVec(db, id)).toEqual(fakeEmbedText('New Merchant Inc New Name'));

    // Modified transaction that does not exist locally is inserted and gets a
    // fresh vector (fallback insert path).
    const fake3 = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake3.embed);
    spyPlaidSync({
      added: [],
      modified: [makePlaidTxn({ transactionId: 'txn-fallback', name: 'Brand New Txn', amount: 15 })],
      removed: [],
      nextCursor: 'c4',
    });
    await syncPlaidItem(db, makeItem(), false);
    const fallbackRow = db
      .prepare("SELECT id FROM transactions WHERE plaid_transaction_id = 'txn-fallback'")
      .get() as { id: number };
    expect(fallbackRow).toBeDefined();
    expect(fake3.calls).toEqual(['Brand New Txn']);
    expect(getStoredVec(db, fallbackRow.id)).toEqual(fakeEmbedText('Brand New Txn'));
  });

  test('Plaid sync (removed): the transaction and its vector are both gone', async () => {
    const id = insertPlaidRow(db, 'txn-1', { description: 'Doomed Purchase' });
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Doomed Purchase') },
    ]);
    // A neighbor that must survive.
    const neighborId = insertPlaidRow(db, 'txn-2', { description: 'Survivor' });
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: neighborId, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Survivor') },
    ]);

    spyPlaidSync({ added: [], modified: [], removed: ['txn-1'], nextCursor: 'c5' });
    await syncPlaidItem(db, makeItem(), false);

    const gone = db.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = 'txn-1'").get();
    expect(gone).toBeNull();
    expect(getStoredVec(db, id)).toBeUndefined();
    // Neighbor untouched.
    expect(db.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = 'txn-2'").get()).toBeDefined();
    expect(getStoredVec(db, neighborId)).toEqual(fakeEmbedText('Survivor'));
  });

  test('Coinbase sync: completed transactions embedded; pending ones not', async () => {
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    spyCoinbaseSync(
      [
        {
          id: 'acct-1',
          name: 'BTC Wallet',
          type: 'wallet',
          currency: { code: 'BTC' },
          balance: { amount: '0.5', currency: 'BTC' },
          native_balance: { amount: '12000.00', currency: 'USD' },
        },
      ],
      [
      {
        id: 'cb-1', type: 'buy', status: 'completed',
        amount: { amount: '0.001', currency: 'BTC' }, native_amount: { amount: '25.00', currency: 'USD' },
        description: null, created_at: '2026-03-01T12:00:00Z', updated_at: '2026-03-01T12:00:00Z',
        details: { title: 'Buy Bitcoin' },
      },
      {
        id: 'cb-2', type: 'sell', status: 'completed',
        amount: { amount: '0.0005', currency: 'BTC' }, native_amount: { amount: '10.00', currency: 'USD' },
        description: null, created_at: '2026-03-02T12:00:00Z', updated_at: '2026-03-02T12:00:00Z',
        details: { title: 'Sell Bitcoin' },
      },
      {
        id: 'cb-3', type: 'buy', status: 'pending',
        amount: { amount: '0.002', currency: 'BTC' }, native_amount: { amount: '50.00', currency: 'USD' },
        description: null, created_at: '2026-03-03T12:00:00Z', updated_at: '2026-03-03T12:00:00Z',
        details: { title: 'Pending Buy' },
      },
      ]
    );

    await syncCoinbaseConnection(db, makeCoinbaseConn(), false);

    const txns = rowsById(db);
    expect(txns).toHaveLength(2); // pending excluded
    expect(txns.map((t) => t.description)).toEqual(['Buy Bitcoin', 'Sell Bitcoin']);
    expect(embeddingCount(db)).toBe(2);
    expect(fake.calls).toEqual(['Buy Bitcoin', 'Sell Bitcoin']);
    expect(getStoredVec(db, txns[0].id)).toEqual(fakeEmbedText('Buy Bitcoin'));
  });
});

// ── Update paths ─────────────────────────────────────────────────────────────

describe('embed-on-write: update paths', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initEditTransactionTool(db);
  });

  test('edit_transaction description edit refreshes the vector; category-only edit does not', async () => {
    const grocery = db
      .prepare("SELECT id FROM transactions WHERE description = 'Grocery Store' ORDER BY id LIMIT 1")
      .get() as { id: number };
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: grocery.id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Grocery Store') },
    ]);

    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    const raw = await editTransactionTool.func({ id: grocery.id, description: 'Fresh Market Haul' });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);

    expect(fake.calls).toEqual(['Fresh Market Haul']);
    expect(getStoredVec(db, grocery.id)).toEqual(fakeEmbedText('Fresh Market Haul'));

    // Category-only edit: no embed text change → zero embed calls, vector untouched.
    const fake2 = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake2.embed);
    await editTransactionTool.func({ id: grocery.id, category: 'Food' });
    expect(fake2.calls).toHaveLength(0);
    expect(getStoredVec(db, grocery.id)).toEqual(fakeEmbedText('Fresh Market Haul'));
  });

  test('dashboard PATCH description edit refreshes the vector', async () => {
    const restaurant = db
      .prepare("SELECT id FROM transactions WHERE description = 'Restaurant' ORDER BY id LIMIT 1")
      .get() as { id: number };
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: restaurant.id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Restaurant') },
    ]);

    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    const result = await apiUpdateTransaction(db, restaurant.id, { description: 'Sushi Night' });
    expect(result.success).toBe(true);
    expect(result.id).toBe(restaurant.id);

    expect(fake.calls).toEqual(['Sushi Night']);
    expect(getStoredVec(db, restaurant.id)).toEqual(fakeEmbedText('Sushi Night'));
  });
});

// ── Delete path ──────────────────────────────────────────────────────────────

describe('embed-on-write: delete path', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  test('deleteTransaction removes the vector; neighbors untouched; tool path covered too', async () => {
    const rows = db.prepare('SELECT id, description FROM transactions ORDER BY id LIMIT 2').all() as Array<{ id: number; description: string }>;
    const [target, neighbor] = rows;
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: target.id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText(target.description) },
      { sourceType: 'transaction', sourceId: neighbor.id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText(neighbor.description) },
    ]);

    expect(deleteTransaction(db, target.id)).toBe(true);
    expect(getStoredVec(db, target.id)).toBeUndefined();
    expect(getStoredVec(db, neighbor.id)).toEqual(fakeEmbedText(neighbor.description));

    // Same behavior through the agent tool.
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);
    initDeleteTransactionTool(db);
    const raw = await deleteTransactionTool.func({ id: neighbor.id });
    expect(JSON.parse(raw as string).data.success).toBe(true);
    expect(getStoredVec(db, neighbor.id)).toBeUndefined();
    expect(fake.calls).toHaveLength(0); // deletes never embed
  });

  test('deleteEmbeddings covers every stored model variant', () => {
    const row = db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number };
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: row.id, model: 'model-a', vec: fakeEmbedText('x') },
      { sourceType: 'transaction', sourceId: row.id, model: 'model-b', vec: fakeEmbedText('y') },
    ]);
    expect(deleteTransaction(db, row.id)).toBe(true);
    const left = db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_id = @id').get({ id: row.id }) as { c: number };
    expect(left.c).toBe(0);
  });
});

// ── Degrade, never error ─────────────────────────────────────────────────────

describe('embed-on-write: degrade, never error', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    db = createTestDb();
    initImportTool(db);
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('throwing embedder: CSV import still succeeds with zero vectors, nothing corrupt', async () => {
    setEmbedOnWriteEmbedder(async () => {
      throw new Error('model exploded');
    });

    const fp = writeTmp(
      `Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n` +
        `01/15/2026,01/16/2026,BLUE BOTTLE COFFEE,Dining,Sale,-6.75,\n` +
        `01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,\n` +
        `01/20/2026,01/21/2026,WHOLE FOODS MARKET,Groceries,Sale,-85.50,`
    );
    tmpFiles.push(fp);

    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(3);

    // Data is intact — nothing partial or corrupt.
    const txns = rowsById(db);
    expect(txns).toHaveLength(3);
    expect(embeddingCount(db)).toBe(0);
    const ledger = db.prepare('SELECT COUNT(*) AS c FROM imports').get() as { c: number };
    expect(ledger.c).toBe(1);

    // An edit with a pre-existing vector also degrades: the tool still
    // succeeds and the old vector is left as-is (stale-but-present is the
    // documented degrade state — --index does not repair text staleness).
    const electric = txns.find((t) => t.description === 'ELECTRIC CO')!;
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: electric.id, model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('ELECTRIC CO') },
    ]);
    initEditTransactionTool(db);
    const editRaw = await editTransactionTool.func({ id: electric.id, description: 'GREEN POWER CO' });
    expect(JSON.parse(editRaw as string).data.success).toBe(true);
    expect(getStoredVec(db, electric.id)).toEqual(fakeEmbedText('ELECTRIC CO'));

    // A later backfill run with a working embedder repairs coverage for the
    // rows the on-write hook had to skip.
    const good = createFakeEmbedder();
    setEmbedOnWriteEmbedder(good.embed);
    const indexResult = await runEmbeddingIndex({ db, embed: good.embed });
    expect(indexResult.indexed).toBe(2); // electric already has (a stale) vector
    expect(embeddingCount(db)).toBe(3);
    expect([...good.calls].sort()).toEqual(
      ['BLUE BOTTLE COFFEE', 'WHOLE FOODS MARKET'].sort()
    );
  });

  test('partial batch failure: import succeeds, exactly the first batch is embedded', async () => {
    // 70 rows → 3 batches at the default batch size of 32 (32 + 32 + 6).
    const csvRows = Array.from({ length: 70 }, (_, i) => {
      const day = String((i % 27) + 1).padStart(2, '0');
      return `01/${day}/2026,01/${day}/2026,MERCHANT ${i},Shopping,Sale,-${i + 1}.00,`;
    });
    const fp = writeTmp(`Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n${csvRows.join('\n')}`);
    tmpFiles.push(fp);

    setEmbedOnWriteEmbedder(createFakeEmbedder({ failAfterBatches: 1 }).embed);

    const raw = await csvImportTool.func({ filePath: fp });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(70);

    const txns = rowsById(db);
    expect(txns).toHaveLength(70);
    // First batch (32 rows, id order) landed before the simulated failure.
    expect(embeddingCount(db)).toBe(32);
    const stored = db
      .prepare("SELECT source_id FROM embeddings WHERE source_type = 'transaction' ORDER BY source_id")
      .all() as Array<{ source_id: number }>;
    expect(stored.map((r) => r.source_id)).toEqual(txns.slice(0, 32).map((t) => t.id));
    expect(countMissingTransactionTargets(db, DEFAULT_EMBEDDING_MODEL)).toBe(38);

    // A backfill run picks up exactly the skipped rows.
    const good = createFakeEmbedder();
    setEmbedOnWriteEmbedder(good.embed);
    const indexResult = await runEmbeddingIndex({ db, embed: good.embed });
    expect(indexResult.indexed).toBe(38);
    expect(embeddingCount(db)).toBe(70);
    expect(good.calls).toEqual(txns.slice(32).map((t) => transactionEmbedText(t)));
  });

  test('empty ids and vanished rows are no-ops that never touch a model', async () => {
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);

    await expect(embedTransactionIds(db, [])).resolves.toEqual({ embedded: 0, failed: 0 });
    expect(fake.calls).toHaveLength(0);

    // Id that doesn't exist (row deleted between insert and embed) — skipped.
    await expect(embedTransactionIds(db, [987654])).resolves.toEqual({ embedded: 0, failed: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  test('embedTransactionIds returns counts and never throws on embedder failure', async () => {
    const { ids } = insertTransactions(db, [
      { date: '2026-01-01', description: 'Row A', amount: -1 },
      { date: '2026-01-02', description: 'Row B', amount: -2 },
    ]);

    setEmbedOnWriteEmbedder(async () => {
      throw new Error('boom');
    });
    await expect(embedTransactionIds(db, ids)).resolves.toEqual({ embedded: 0, failed: 2 });

    // Duplicate ids are deduped.
    const fake = createFakeEmbedder();
    setEmbedOnWriteEmbedder(fake.embed);
    await expect(embedTransactionIds(db, [...ids, ...ids])).resolves.toEqual({ embedded: 2, failed: 0 });
    expect(fake.calls).toEqual(['Row A', 'Row B']);
    expect(embeddingCount(db)).toBe(2);
  });

  test('deleteOrphanedTransactionEmbeddings reclaims ghost vectors (backfill safety net)', () => {
    const { ids } = insertTransactions(db, [
      { date: '2026-01-01', description: 'Orphaned soon', amount: -1 },
    ]);
    upsertEmbeddings(db, [
      { sourceType: 'transaction', sourceId: ids[0], model: DEFAULT_EMBEDDING_MODEL, vec: fakeEmbedText('Orphaned soon') },
    ]);
    // Raw-delete the transaction, bypassing the delete hook.
    db.prepare('DELETE FROM transactions WHERE id = @id').run({ id: ids[0] });

    setEmbedOnWriteEmbedder(async (texts) => texts.map(fakeEmbedText));
    expect(deleteOrphanedTransactionEmbeddings(db)).toBe(1);
    expect(embeddingCount(db)).toBe(0);
  });
});