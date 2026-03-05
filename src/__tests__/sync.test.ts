import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';
import { runMigrations } from '../db/migrations.js';
import * as licenseModule from '../licensing/license.js';
import { ensureTestProfile } from './helpers.js';

// Ensure test profile is set for any module that needs it
ensureTestProfile();

// Create a shared test DB reference that the mock will use
let testDb: Database;

// Mock initDatabase to return our in-memory test DB
mock.module('../db/database.js', () => ({
  initDatabase: () => testDb,
}));

// Mock Plaid modules
mock.module('../plaid/store.js', () => ({
  getPlaidItems: () => [],
}));

mock.module('../plaid/client.js', () => ({
  getBalances: async () => [],
  hasLocalPlaidCreds: () => false,
}));

mock.module('../tools/import/plaid-sync.js', () => ({
  initPlaidSyncTool: () => {},
  syncPlaidItem: async () => ({ added: 0, linked: 0, skipped: 0 }),
}));

// Mutable reference for monarch mock
let mockMonarchResult: unknown = { allTransactions: { results: [] } };
let mockMonarchShouldThrow: string | null = null;

mock.module('monarch-money-api', () => ({
  setToken: () => {},
  loginUser: async () => {},
  getTransactions: async () => {
    if (mockMonarchShouldThrow) throw new Error(mockMonarchShouldThrow);
    return mockMonarchResult;
  },
}));

// Import mocked modules for per-test spying
const plaidStore = await import('../plaid/store.js');
const plaidSync = await import('../tools/import/plaid-sync.js');
const plaidClient = await import('../plaid/client.js');

// Import sync after mocks are set up
const { runSync } = await import('../sync.js');

describe('runSync', () => {
  let licenseSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'PLAID_CLIENT_ID', 'PLAID_SECRET',
    'MONARCH_TOKEN', 'MONARCH_EMAIL', 'MONARCH_PASSWORD',
    'FIREFLY_API_URL', 'FIREFLY_API_TOKEN',
  ];

  beforeEach(() => {
    // Create fresh in-memory DB for each test
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);

    // Save and clear env
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    mockMonarchResult = { allTransactions: { results: [] } };
    mockMonarchShouldThrow = null;
    licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => {
    licenseSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    // Restore env
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function getLogOutput(): string {
    return consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
  }

  function getErrorOutput(): string {
    return consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
  }

  test('exits with error when no pro license', async () => {
    licenseSpy.mockReturnValue(false);
    await expect(runSync()).rejects.toThrow('process.exit');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Bank sync requires Open Accountant Pro')
    );
  });

  test('Pro user with no env vars still has Plaid via proxy', async () => {
    // Pro users always have Plaid available via proxy, even without local creds
    spyOn(plaidStore, 'getPlaidItems').mockReturnValue([]);
    await runSync();
    const output = getLogOutput();
    // Plaid section runs (via proxy) but no items linked
    expect(output).toContain('[Plaid] No bank accounts linked');
  });

  test('runs only Plaid when only Plaid is configured', async () => {
    process.env.PLAID_CLIENT_ID = 'test';
    process.env.PLAID_SECRET = 'test';

    spyOn(plaidStore, 'getPlaidItems').mockReturnValue([
      { accessToken: 'tok', itemId: 'item1', institutionName: 'Test Bank', institutionId: 'ins1', cursor: null },
    ] as any);
    spyOn(plaidSync, 'syncPlaidItem').mockResolvedValue({
      institution: 'Test Bank', added: 5, linked: 2, skipped: 1, accountsCreated: 0, accountsUpdated: 0,
    } as any);

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Plaid] Syncing Test Bank...');
    expect(output).toContain('5 new transactions');
    expect(output).toContain('Sync complete');
  });

  test('runs only Monarch when only Monarch is configured', async () => {
    process.env.MONARCH_TOKEN = 'test-token';

    mockMonarchResult = { allTransactions: { results: [] } };

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Monarch] Syncing...');
    expect(output).toContain('Sync complete');
  });

  test('runs only Firefly when only Firefly is configured', async () => {
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';

    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [],
        meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.api+json' },
      }),
    );

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Firefly] Syncing...');
    expect(output).toContain('Sync complete');

    fetchSpy.mockRestore();
  });

  test('error in one integration does not block others', async () => {
    process.env.MONARCH_TOKEN = 'test-token';
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';

    // Monarch throws when getTransactions is called
    mockMonarchShouldThrow = 'Monarch API down';

    // Firefly returns empty
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [],
        meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.api+json' },
      }),
    );

    await runSync();
    const output = getLogOutput();

    // Firefly should still have run
    expect(output).toContain('[Firefly] Syncing...');
    // Summary should mention failure
    expect(output).toContain('failed');

    fetchSpy.mockRestore();
  });

  test('supports MONARCH_EMAIL + MONARCH_PASSWORD auth', async () => {
    process.env.MONARCH_EMAIL = 'user@example.com';
    process.env.MONARCH_PASSWORD = 'secret';

    mockMonarchResult = { allTransactions: { results: [] } };

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Monarch] Syncing...');
  });

  test('Plaid sync with balances logs new account creation', async () => {
    process.env.PLAID_CLIENT_ID = 'test';
    process.env.PLAID_SECRET = 'test';

    spyOn(plaidStore, 'getPlaidItems').mockReturnValue([
      { accessToken: 'tok', itemId: 'item1', institutionName: 'Test Bank', institutionId: 'ins1', cursor: null },
    ] as any);
    spyOn(plaidSync, 'syncPlaidItem').mockResolvedValue({
      institution: 'Test Bank', added: 3, linked: 1, skipped: 0, accountsCreated: 1, accountsUpdated: 0,
    } as any);

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Plaid] Syncing Test Bank...');
    expect(output).toContain('3 new transactions');
    expect(output).toContain('1 new account(s) created');
    expect(output).toContain('1 transactions auto-linked');
  });

  test('Monarch returns transactions that get inserted into DB', async () => {
    process.env.MONARCH_TOKEN = 'test-token';

    mockMonarchResult = {
      allTransactions: {
        results: [
          {
            id: 'mon-1',
            amount: 50.00,
            date: '2026-03-01',
            pending: false,
            plaidName: null,
            notes: null,
            isRecurring: false,
            category: { name: 'Groceries' },
            merchant: { name: 'Trader Joes' },
            account: null,
          },
          {
            id: 'mon-2',
            amount: 25.00,
            date: '2026-03-02',
            pending: false,
            plaidName: null,
            notes: null,
            isRecurring: false,
            category: { name: 'Dining' },
            merchant: { name: 'Pizza Place' },
            account: null,
          },
        ],
      },
    };

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Monarch] Syncing...');

    // Verify transactions were inserted
    const txns = testDb.prepare("SELECT * FROM transactions WHERE bank = 'monarch'").all() as any[];
    expect(txns).toHaveLength(2);
    expect(txns[0].description).toBe('Trader Joes');
    // Monarch positive = expense, OA negates: amount should be negative
    expect(txns[0].amount).toBe(-50.00);
  });

  test('Firefly returns transactions with attributes that get inserted', async () => {
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';

    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          {
            type: 'transactions',
            id: '1',
            attributes: {
              group_title: null,
              transactions: [
                {
                  transaction_journal_id: 'j1',
                  type: 'withdrawal',
                  date: '2026-03-01T00:00:00Z',
                  amount: '100.00',
                  description: 'Grocery shopping',
                  source_name: 'Checking',
                  destination_name: 'Whole Foods',
                  category_name: 'Groceries',
                  budget_name: null,
                  bill_name: null,
                  tags: ['food'],
                  notes: null,
                  internal_reference: null,
                  external_url: null,
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
                  transaction_journal_id: 'j2',
                  type: 'deposit',
                  date: '2026-03-02T00:00:00Z',
                  amount: '3000.00',
                  description: 'Salary',
                  source_name: 'Employer',
                  destination_name: 'Checking',
                  category_name: 'Income',
                  budget_name: null,
                  bill_name: null,
                  tags: null,
                  notes: null,
                  internal_reference: null,
                  external_url: null,
                },
              ],
            },
          },
        ],
        meta: { pagination: { total: 2, count: 2, per_page: 50, current_page: 1, total_pages: 1 } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.api+json' },
      }),
    );

    await runSync();
    const output = getLogOutput();
    expect(output).toContain('[Firefly] Syncing...');

    const txns = testDb.prepare("SELECT * FROM transactions WHERE bank = 'firefly' ORDER BY date").all() as any[];
    expect(txns).toHaveLength(2);
    // Withdrawal: destination_name used as description, amount negated
    expect(txns[0].description).toBe('Whole Foods');
    expect(txns[0].amount).toBe(-100.00);
    expect(txns[0].category).toBe('Groceries');
    // Deposit: source_name used as description, amount positive
    expect(txns[1].description).toBe('Employer');
    expect(txns[1].amount).toBe(3000.00);

    fetchSpy.mockRestore();
  });

  test('Firefly pagination fetches all pages', async () => {
    process.env.FIREFLY_API_URL = 'https://firefly.example.com';
    process.env.FIREFLY_API_TOKEN = 'test-token';

    let callCount = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: URL | RequestInfo) => {
      callCount++;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const page = new URL(url).searchParams.get('page') ?? '1';

      if (page === '1') {
        return new Response(JSON.stringify({
          data: [{
            type: 'transactions',
            id: '1',
            attributes: {
              group_title: null,
              transactions: [{
                transaction_journal_id: 'p1-j1',
                type: 'withdrawal',
                date: '2026-03-01T00:00:00Z',
                amount: '50.00',
                description: 'Page 1 txn',
                source_name: 'Checking',
                destination_name: 'Store A',
                category_name: null,
                budget_name: null,
                bill_name: null,
                tags: null,
                notes: null,
                internal_reference: null,
                external_url: null,
              }],
            },
          }],
          meta: { pagination: { total: 2, count: 1, per_page: 1, current_page: 1, total_pages: 2 } },
        }), { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }) as unknown as Response;
      } else {
        return new Response(JSON.stringify({
          data: [{
            type: 'transactions',
            id: '2',
            attributes: {
              group_title: null,
              transactions: [{
                transaction_journal_id: 'p2-j1',
                type: 'withdrawal',
                date: '2026-03-02T00:00:00Z',
                amount: '75.00',
                description: 'Page 2 txn',
                source_name: 'Checking',
                destination_name: 'Store B',
                category_name: null,
                budget_name: null,
                bill_name: null,
                tags: null,
                notes: null,
                internal_reference: null,
                external_url: null,
              }],
            },
          }],
          meta: { pagination: { total: 2, count: 1, per_page: 1, current_page: 2, total_pages: 2 } },
        }), { status: 200, headers: { 'Content-Type': 'application/vnd.api+json' } }) as unknown as Response;
      }
    }) as unknown as typeof fetch);

    await runSync();

    // Should have fetched 2 pages
    expect(callCount).toBe(2);

    const txns = testDb.prepare("SELECT * FROM transactions WHERE bank = 'firefly' ORDER BY date").all() as any[];
    expect(txns).toHaveLength(2);
    expect(txns[0].description).toBe('Store A');
    expect(txns[1].description).toBe('Store B');

    fetchSpy.mockRestore();
  });
});
