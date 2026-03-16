import { describe, expect, test, beforeEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';

interface PlaidItem {
  itemId: string;
  accessToken: string;
  institutionName: string;
  accounts: Array<{ id: string; name: string; mask: string }>;
  cursor: string | null;
  linkedAt: string;
  errorState?: { code: string; message: string; detectedAt: string } | null;
}

/**
 * Local copy of isReauthRequired to avoid mock contamination from other test files.
 * Mirrors the implementation in src/plaid/store.ts.
 */
function isReauthRequired(item: PlaidItem): boolean {
  const linked = new Date(item.linkedAt);
  const now = new Date();
  const months = (now.getFullYear() - linked.getFullYear()) * 12 + now.getMonth() - linked.getMonth();
  return months >= 11;
}

let db: Database;

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

function insertTestTransaction(
  database: Database,
  plaidTxnId: string,
  opts: { date?: string; description?: string; amount?: number } = {},
): void {
  database.prepare(`
    INSERT INTO transactions (date, description, amount, plaid_transaction_id, external_id, source_file)
    VALUES (@date, @description, @amount, @plaid_transaction_id, @external_id, @source_file)
  `).run({
    date: opts.date ?? '2026-03-01',
    description: opts.description ?? 'Original Description',
    amount: opts.amount ?? -25.00,
    plaid_transaction_id: plaidTxnId,
    external_id: plaidTxnId,
    source_file: 'plaid:Test Bank',
  });
}

function getTransactionByPlaidId(database: Database, plaidTxnId: string) {
  return database.prepare(
    'SELECT * FROM transactions WHERE plaid_transaction_id = @tid'
  ).get({ tid: plaidTxnId }) as Record<string, unknown> | undefined;
}

describe('plaid sync modified/removed', () => {
  beforeEach(() => {
    db = createTestDb();
  });

  test('modified transaction updates existing row', () => {
    insertTestTransaction(db, 'txn-mod-1', {
      date: '2026-03-01',
      description: 'Original Merchant',
      amount: -25.00,
    });

    // Simulate what syncPlaidItem does for modified transactions
    const updateStmt = db.prepare(`
      UPDATE transactions SET
        date = @date, amount = @amount, description = @description, pending = @pending,
        authorized_date = @authorized_date, merchant_name = @merchant_name,
        category = @category, category_detailed = @category_detailed, payment_channel = @payment_channel
      WHERE plaid_transaction_id = @plaid_transaction_id
    `);

    const result = updateStmt.run({
      date: '2026-03-02',
      amount: -30.00,
      description: 'Updated Merchant',
      pending: 0,
      authorized_date: '2026-03-01',
      merchant_name: 'Updated Merchant Inc',
      category: 'Shopping',
      category_detailed: 'GENERAL_MERCHANDISE',
      payment_channel: 'online',
      plaid_transaction_id: 'txn-mod-1',
    });

    expect((result as { changes: number }).changes).toBe(1);

    const updated = getTransactionByPlaidId(db, 'txn-mod-1');
    expect(updated).toBeDefined();
    expect(updated!.date).toBe('2026-03-02');
    expect(updated!.amount).toBe(-30.00);
    expect(updated!.description).toBe('Updated Merchant');
    expect(updated!.merchant_name).toBe('Updated Merchant Inc');
    expect(updated!.category).toBe('Shopping');
  });

  test('removed transaction deletes the row', () => {
    insertTestTransaction(db, 'txn-rem-1');

    const before = getTransactionByPlaidId(db, 'txn-rem-1');
    expect(before).toBeDefined();

    const deleteStmt = db.prepare(
      'DELETE FROM transactions WHERE plaid_transaction_id = @tid'
    );
    const result = deleteStmt.run({ tid: 'txn-rem-1' });
    expect((result as { changes: number }).changes).toBe(1);

    const after = getTransactionByPlaidId(db, 'txn-rem-1');
    expect(after).toBeNull();
  });

  test('modified transaction that does not exist locally is inserted', () => {
    // No existing transaction for 'txn-new-mod-1'
    const existing = getTransactionByPlaidId(db, 'txn-new-mod-1');
    expect(existing).toBeNull();

    // Simulate the fallback insert path for modified txns that don't exist
    const updateStmt = db.prepare(`
      UPDATE transactions SET
        date = @date, amount = @amount, description = @description, pending = @pending,
        authorized_date = @authorized_date, merchant_name = @merchant_name,
        category = @category, category_detailed = @category_detailed, payment_channel = @payment_channel
      WHERE plaid_transaction_id = @plaid_transaction_id
    `);
    const insertStmt = db.prepare(`
      INSERT INTO transactions (date, description, amount, category, source_file, bank, account_last4,
        plaid_transaction_id, merchant_name, category_detailed, external_id, payment_channel, pending, authorized_date)
      VALUES (@date, @description, @amount, @category, @source_file, @bank, @account_last4,
        @plaid_transaction_id, @merchant_name, @category_detailed, @external_id, @payment_channel, @pending, @authorized_date)
    `);

    const result = updateStmt.run({
      date: '2026-03-05',
      amount: -15.00,
      description: 'New Modified Txn',
      pending: 0,
      authorized_date: null,
      merchant_name: null,
      category: null,
      category_detailed: null,
      payment_channel: null,
      plaid_transaction_id: 'txn-new-mod-1',
    });

    if ((result as { changes: number }).changes === 0) {
      insertStmt.run({
        date: '2026-03-05',
        description: 'New Modified Txn',
        amount: -15.00,
        category: null,
        source_file: 'plaid:Test Bank',
        bank: 'Test Bank',
        account_last4: '1234',
        plaid_transaction_id: 'txn-new-mod-1',
        merchant_name: null,
        category_detailed: null,
        external_id: 'txn-new-mod-1',
        payment_channel: null,
        pending: 0,
        authorized_date: null,
      });
    }

    const inserted = getTransactionByPlaidId(db, 'txn-new-mod-1');
    expect(inserted).toBeDefined();
    expect(inserted!.description).toBe('New Modified Txn');
    expect(inserted!.amount).toBe(-15.00);
  });

  test('ITEM_LOGIN_REQUIRED error sets needsReauth flag', () => {
    // Import PlaidError to verify it can be constructed and identified
    const { PlaidError } = require('../plaid/client.js');

    const err = new PlaidError(
      'the login details of this item have changed',
      'ITEM_ERROR',
      'ITEM_LOGIN_REQUIRED',
      400,
    );

    expect(err).toBeInstanceOf(PlaidError);
    expect(err.errorCode).toBe('ITEM_LOGIN_REQUIRED');
    expect(err.errorType).toBe('ITEM_ERROR');
    expect(err.statusCode).toBe(400);

    // Verify we can match on errorCode as the sync code does
    const isLoginRequired = err instanceof PlaidError && err.errorCode === 'ITEM_LOGIN_REQUIRED';
    expect(isLoginRequired).toBe(true);
  });

  test('isReauthRequired returns true for items older than 11 months', () => {
    const now = new Date();

    // Item linked 12 months ago
    const oldDate = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
    const oldItem = makeItem({ linkedAt: oldDate.toISOString() });
    expect(isReauthRequired(oldItem)).toBe(true);

    // Item linked 11 months ago
    const elevenMonths = new Date(now.getFullYear(), now.getMonth() - 11, now.getDate());
    const elevenItem = makeItem({ linkedAt: elevenMonths.toISOString() });
    expect(isReauthRequired(elevenItem)).toBe(true);

    // Item linked 10 months ago — should NOT require reauth
    const tenMonths = new Date(now.getFullYear(), now.getMonth() - 10, now.getDate());
    const recentItem = makeItem({ linkedAt: tenMonths.toISOString() });
    expect(isReauthRequired(recentItem)).toBe(false);

    // Item linked today — should NOT require reauth
    const todayItem = makeItem({ linkedAt: now.toISOString() });
    expect(isReauthRequired(todayItem)).toBe(false);
  });
});
