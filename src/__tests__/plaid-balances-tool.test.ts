import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import * as license from '../licensing/license.js';
import { createTestDb } from './helpers.js';
import type { Database } from '../db/compat-sqlite.js';

// Mock Plaid store and client
let mockPlaidItems: Array<{ itemId: string; accessToken: string; institutionName: string; accounts: unknown[]; cursor: string | null; linkedAt: string }> = [];
let mockBalances: Array<{
  accountId: string; name: string; mask: string; type: string; subtype: string;
  balanceCurrent: number | null; balanceAvailable: number | null; isoCurrencyCode: string | null;
}> = [];

mock.module('../plaid/store.js', () => ({
  getPlaidItems: () => mockPlaidItems,
  savePlaidItem: () => {},
  removePlaidItem: () => {},
}));

mock.module('../plaid/client.js', () => ({
  getBalances: async () => mockBalances,
  hasLocalPlaidCreds: () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
  PlaidError: class PlaidError extends Error {},
}));

import { initPlaidBalancesTool, plaidBalancesTool } from '../tools/import/plaid-balances.js';

describe('plaid-balances tool', () => {
  let db: Database;
  let licenseSpy: ReturnType<typeof spyOn>;
  const origClientId = process.env.PLAID_CLIENT_ID;
  const origSecret = process.env.PLAID_SECRET;

  beforeEach(() => {
    db = createTestDb();
    initPlaidBalancesTool(db);
    mockPlaidItems = [];
    mockBalances = [];
    licenseSpy = spyOn(license, 'hasLicense').mockReturnValue(false);
    process.env.PLAID_CLIENT_ID = 'test-client-id';
    process.env.PLAID_SECRET = 'test-secret';
  });

  afterEach(() => {
    licenseSpy.mockRestore();
    if (origClientId !== undefined) process.env.PLAID_CLIENT_ID = origClientId;
    else delete process.env.PLAID_CLIENT_ID;
    if (origSecret !== undefined) process.env.PLAID_SECRET = origSecret;
    else delete process.env.PLAID_SECRET;
  });

  test('returns error when no pro license', async () => {
    licenseSpy.mockReturnValue(false);
    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);
    expect(parsed.data.error).toContain('Pro feature');
  });

  test('returns not configured when no local creds and no pro license', async () => {
    // First call returns false (not pro) then true won't matter — upsell returned first
    licenseSpy.mockReturnValue(false);
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;

    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);
    expect(parsed.data.error).toContain('Pro feature');
  });

  test('Pro user without local creds uses proxy path (no not-configured error)', async () => {
    licenseSpy.mockReturnValue(true);
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    mockPlaidItems = [];

    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);
    // Pro users without local creds use the API proxy — should not see "not configured"
    expect(parsed.data.message).toContain('No bank accounts linked');
  });

  test('returns no accounts when no items linked', async () => {
    licenseSpy.mockReturnValue(true);
    mockPlaidItems = [];

    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);
    expect(parsed.data.message).toContain('No bank accounts linked');
  });

  test('returns balances and upserts accounts', async () => {
    licenseSpy.mockReturnValue(true);
    mockPlaidItems = [
      {
        itemId: 'item-1',
        accessToken: 'access-token-1',
        institutionName: 'Test Bank',
        accounts: [],
        cursor: null,
        linkedAt: '2026-01-01',
      },
    ];
    mockBalances = [
      {
        accountId: 'acc-1',
        name: 'Checking',
        mask: '1234',
        type: 'depository',
        subtype: 'checking',
        balanceCurrent: 5000.00,
        balanceAvailable: 4800.00,
        isoCurrencyCode: 'USD',
      },
      {
        accountId: 'acc-2',
        name: 'Savings',
        mask: '5678',
        type: 'depository',
        subtype: 'savings',
        balanceCurrent: 10000.00,
        balanceAvailable: 10000.00,
        isoCurrencyCode: 'USD',
      },
    ];

    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);

    expect(parsed.data.balances).toHaveLength(1);
    expect(parsed.data.balances[0].institution).toBe('Test Bank');
    expect(parsed.data.balances[0].accounts).toHaveLength(2);
    expect(parsed.data.message).toContain('2 accounts');
    expect(parsed.data.accountsCreated).toBe(2);
  });

  test('handles accounts with null balance', async () => {
    licenseSpy.mockReturnValue(true);
    mockPlaidItems = [
      {
        itemId: 'item-1',
        accessToken: 'at-1',
        institutionName: 'Bank',
        accounts: [],
        cursor: null,
        linkedAt: '2026-01-01',
      },
    ];
    mockBalances = [
      {
        accountId: 'acc-null',
        name: 'Credit Card',
        mask: '9999',
        type: 'credit',
        subtype: 'credit card',
        balanceCurrent: null,
        balanceAvailable: null,
        isoCurrencyCode: 'USD',
      },
    ];

    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);

    // Account with null balance should not be upserted
    expect(parsed.data.accountsCreated).toBe(0);
    expect(parsed.data.balances[0].accounts).toHaveLength(1);
  });

  test('updates existing accounts on second call', async () => {
    licenseSpy.mockReturnValue(true);
    mockPlaidItems = [
      {
        itemId: 'item-1',
        accessToken: 'at-1',
        institutionName: 'Bank',
        accounts: [],
        cursor: null,
        linkedAt: '2026-01-01',
      },
    ];
    mockBalances = [
      {
        accountId: 'acc-repeat',
        name: 'Checking',
        mask: '1234',
        type: 'depository',
        subtype: 'checking',
        balanceCurrent: 1000,
        balanceAvailable: 900,
        isoCurrencyCode: 'USD',
      },
    ];

    // First call - creates
    await plaidBalancesTool.func({});

    // Second call - updates
    mockBalances[0].balanceCurrent = 2000;
    const result = await plaidBalancesTool.func({});
    const parsed = JSON.parse(result);
    expect(parsed.data.accountsUpdated).toBe(1);
  });
});
