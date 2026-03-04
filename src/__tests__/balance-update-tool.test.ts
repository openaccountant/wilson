import { describe, test, expect, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { initBalanceUpdateTool, balanceUpdateTool } from '../tools/net-worth/balance-update.js';

describe('balance-update tool', () => {
  let db: Database;
  let accountId: number;

  beforeEach(() => {
    db = createTestDb();
    accountId = insertAccount(db, {
      name: 'Checking',
      account_type: 'asset',
      account_subtype: 'checking',
      current_balance: 1000,
    });
    initBalanceUpdateTool(db);
  });

  test('update existing account returns success with change amount', async () => {
    const result = JSON.parse(await balanceUpdateTool.func({ accountId, balance: 1500 })).data;
    expect(result.message).toContain('Checking');
    expect(result.message).toContain('$1500.00');
    expect(result.message).toContain('+$500.00');
    expect(result.previousBalance).toBe(1000);
    expect(result.newBalance).toBe(1500);
    expect(result.change).toBe(500);

    // Verify the account balance was actually updated
    const row = db.prepare('SELECT current_balance FROM accounts WHERE id = @id').get({ id: accountId }) as { current_balance: number };
    expect(row.current_balance).toBe(1500);
  });

  test('update with decrease shows negative change', async () => {
    const result = JSON.parse(await balanceUpdateTool.func({ accountId, balance: 750 })).data;
    expect(result.message).toContain('-$250.00');
    expect(result.change).toBe(-250);
  });

  test('non-existent account returns error', async () => {
    const result = JSON.parse(await balanceUpdateTool.func({ accountId: 99999, balance: 500 })).data;
    expect(result.error).toContain('not found');
  });

  test('creates balance snapshot on update', async () => {
    await balanceUpdateTool.func({ accountId, balance: 2000 });
    const snapshot = db.prepare(
      'SELECT balance, source FROM balance_snapshots WHERE account_id = @accountId ORDER BY id DESC LIMIT 1'
    ).get({ accountId }) as { balance: number; source: string };
    expect(snapshot.balance).toBe(2000);
    expect(snapshot.source).toBe('manual');
  });

  test('custom source is recorded in snapshot', async () => {
    await balanceUpdateTool.func({ accountId, balance: 3000, source: 'plaid' });
    const snapshot = db.prepare(
      'SELECT source FROM balance_snapshots WHERE account_id = @accountId ORDER BY id DESC LIMIT 1'
    ).get({ accountId }) as { source: string };
    expect(snapshot.source).toBe('plaid');
  });
});
