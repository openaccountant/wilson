import { beforeAll, describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { Database } from '../db/compat-sqlite.js';
import { apiTransactions, apiEntities, apiImport } from '../dashboard/api.js';
import { insertTransactions } from '../db/queries.js';
import { createEntity, updateEntity } from '../db/entity-queries.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { applySync, createMirrorSchema } from '../dashboard/ui/src/store/mirror-schema.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { MirrorTestBinding } from './mirror-helpers.js';
import type { MirrorTransactionRow, MirrorEntityRow } from '../dashboard/ui/src/store/types.js';

/**
 * THE offline-parity gate: for a matrix of queries, the mirror must return
 * deep-equal rows to what the server's own handlers return for the same query.
 * Offline, the UI receives exactly serveApiPath's output, so deep equality with
 * apiTransactions/apiEntities IS the acceptance criterion "same results the
 * server would return for the same query".
 *
 * Setup: one server db with accounts, entities, linked transactions (some with
 * external_ids, one NULL-external row, one row with every column set), and one
 * browser-imported statement (apiImport). The mirror is seeded from the
 * server's own unbounded responses — exactly what the sync engine pulls.
 */

const serverDb: Database = createTestDb();
let mirrorBinding: MirrorTestBinding;

const accountId = insertAccount(serverDb, {
  name: 'Everyday Checking',
  account_type: 'asset',
  account_subtype: 'checking',
  institution: 'Test Bank',
  account_number_last4: '1234',
});

const bizEntityId = createEntity(serverDb, { name: 'Side Business', color: '#3b82f6' });

// Most rows carry external_ids (like real imports); one is NULL-external
// (legacy row) to exercise the id:<serverId> sync-key fallback.
insertTransactions(serverDb, [
  { date: '2026-03-01', description: 'WHOLE FOODS MARKET', amount: -85.5, category: 'Groceries', merchant_name: 'Whole Foods', external_id: 'ext-grocery-1', account_name: 'Everyday Checking', bank: 'Test Bank', account_last4: '1234' },
  { date: '2026-03-02', description: 'TRADER JOES', amount: -42.25, category: 'Groceries', merchant_name: 'Trader Joes', external_id: 'ext-grocery-2', account_name: 'Everyday Checking', bank: 'Test Bank', account_last4: '1234' },
  { date: '2026-03-03', description: 'Blue Bottle Coffee', amount: -6.75, category: 'Dining', merchant_name: 'Blue Bottle', external_id: 'ext-coffee-1' },
  { date: '2026-03-04', description: 'CLIENT INVOICE 1042', amount: 1200.0, category: 'Income', external_id: 'ext-invoice-1', is_recurring: 0 },
  { date: '2026-03-05', description: 'ADOBE SUBSCRIPTION', amount: -59.99, category: 'Subscriptions', merchant_name: 'Adobe', external_id: 'ext-sub-1', is_recurring: 1 },
  { date: '2026-03-06', description: 'Uber trip', amount: -18.4, category: 'Transport', merchant_name: 'Uber' },
  { date: '2026-03-07', description: 'Electric Company', amount: -120.0, category: 'Utilities', external_id: 'ext-util-1' },
  { date: '2026-02-15', description: 'Costco run', amount: -210.1, category: 'Groceries', external_id: 'ext-grocery-3' },
  { date: '2026-03-08', description: 'Paycheck', amount: 3500.0, category: 'Income', external_id: 'ext-pay-1' },
]);

// Link some rows to the account and to entities, like the server pipelines do.
serverDb.prepare(
  `UPDATE transactions SET account_id = @accountId WHERE bank = 'Test Bank'`
).run({ accountId });
serverDb.prepare(
  `UPDATE transactions SET entity_id = @entityId WHERE category = 'Income'`
).run({ entityId: bizEntityId });

// One row written with EVERY column explicitly — catches any column missing
// from the mirror's upsert list.
serverDb.prepare(`
  INSERT INTO transactions (
    date, description, amount, category, category_confidence, user_verified,
    source_file, bank, account_last4, is_recurring, tags, notes,
    plaid_transaction_id, account_name, merchant_name, category_detailed,
    external_id, payment_channel, pending, authorized_date, account_id,
    entity_id, created_at, updated_at
  ) VALUES (
    '2026-03-09', 'Full column row', -1.234, 'Other', 0.87, 1,
    'stmt.pdf', 'Test Bank', '9999', 0, 'a,b', 'some notes',
    'plaid-txn-xyz', 'Full Name', 'Full Col Merchant', 'Other>Stuff',
    'ext-full-1', 'shop', 1, '2026-03-08', @accountId,
    @entityId, '2026-03-09 01:02:03', '2026-03-09 04:05:06'
  )
`).run({ accountId, entityId: bizEntityId });


// The mirror is seeded in beforeAll, exactly the way the sync engine does it:
// from the server's own unbounded apiTransactions/apiEntities responses.
beforeAll(async () => {
  // A statement imported through the browser importer (POST /api/import path) —
  // the mirror must see these rows on its next sync pull, never via a direct write.
  await apiImport(serverDb, {
    filename: 'browser-statement.csv',
    bank: 'Browser Bank',
    transactions: [
      { date: '2026-03-10', description: 'BROWSER IMPORT A', amount: -12.0, external_id: 'ext-browser-1' },
      { date: '2026-03-11', description: 'BROWSER IMPORT B', amount: -34.5, external_id: 'ext-browser-2' },
    ],
  });

  // The mirror store carries its own schema (server DDL constants + the
  // entity_id/sync_key ALTERs) — a bare database, not a migrated server db.
  mirrorBinding = new MirrorTestBinding(new Database(':memory:'));
  await createMirrorSchema(mirrorBinding);
  const transactions = apiTransactions(
    serverDb,
    new URLSearchParams({ limit: String(10_000_000) })
  ) as unknown as MirrorTransactionRow[];
  const entities = apiEntities(serverDb) as unknown as MirrorEntityRow[];
  await applySync(mirrorBinding, { profile: 'default', transactions, entities });
});

const parityQueries: string[] = [
  '',                                        // no params → default limit 100
  'limit=10000000',                          // the full pull
  'limit=3',                                 // limit slicing
  'limit=500',                               // the tab's limit
  'limit=',                                  // NaN edge → empty on both sides
  'start=2026-03-02&end=2026-03-07',         // date window
  'start=2026-03-01&end=2026-03-31&limit=10000000',
  'category=Groceries&limit=10000000',       // exact category
  'category=Nope&limit=10000000',            // no matches
  'merchant=groc&limit=10000000',            // LIKE, case-insensitive
  'merchant=WHOLE&limit=10000000',           // LIKE against stored case
  'merchant=zzz&limit=10000000',             // no matches
  `accountId=${accountId}&limit=10000000`,  // account filter
  'accountId=999&limit=10000000',
  `entityId=${bizEntityId}&limit=10000000`,  // entity filter
  'entityId=999&limit=10000000',
  'start=2026-03-01&end=2026-03-31&category=Groceries&merchant=joes&limit=10000000',
  `accountId=${accountId}&category=Groceries&limit=10000000`,
  `entityId=${bizEntityId}&start=2026-01-01&end=2026-12-31&limit=2`,
  'isRecurring=true&limit=10000000',         // not parsed by apiTransactions, but harmless
];

describe('mirror parity with the server for the same query', () => {
  test.each(parityQueries)('/api/transactions?%s', async (query) => {
    const fromServer = apiTransactions(serverDb, new URLSearchParams(query));
    const fromMirror = await serveApiPath(mirrorBinding, `/api/transactions?${query}`);
    expect(fromMirror).toEqual(fromServer);
  });

  test('/api/entities', async () => {
    const fromServer = apiEntities(serverDb);
    const fromMirror = (await serveApiPath(mirrorBinding, '/api/entities')) as MirrorEntityRow[];
    expect(fromMirror).toEqual(fromServer);
  });

  test('ordering is date DESC for unfiltered pulls', async () => {
    const rows = (await serveApiPath(mirrorBinding, '/api/transactions?limit=10000000')) as { date: string }[];
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

// Entity renames must not drift: the mirror copies getEntities' SQL verbatim.
describe('mirror entity list tracks the server', () => {
  test('after a rename the next full pull serves the new name', async () => {
    updateEntity(serverDb, bizEntityId, { name: 'Consulting LLC' });
    const transactions = apiTransactions(serverDb, new URLSearchParams({ limit: String(10_000_000) })) as unknown as MirrorTransactionRow[];
    const entities = apiEntities(serverDb) as unknown as MirrorEntityRow[];
    await applySync(mirrorBinding, { profile: 'default', transactions, entities });

    const fromMirror = (await serveApiPath(mirrorBinding, '/api/entities')) as MirrorEntityRow[];
    expect(fromMirror).toEqual(apiEntities(serverDb));
    const renamed = fromMirror.find((e) => e.id === bizEntityId);
    expect(renamed?.name).toBe('Consulting LLC');
  });
});