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
    expect(consoleErrorSpy).toHaveBeenCalledWith('Bank sync requires a Pro license.');
  });

  test('prints setup instructions when no integrations configured', async () => {
    await runSync();
    const output = getLogOutput();
    expect(output).toContain('No integrations configured');
    expect(output).toContain('PLAID_CLIENT_ID');
    expect(output).toContain('MONARCH_TOKEN');
    expect(output).toContain('FIREFLY_API_URL');
  });

  test('runs only Plaid when only Plaid is configured', async () => {
    process.env.PLAID_CLIENT_ID = 'test';
    process.env.PLAID_SECRET = 'test';

    spyOn(plaidStore, 'getPlaidItems').mockReturnValue([
      { accessToken: 'tok', itemId: 'item1', institutionName: 'Test Bank', institutionId: 'ins1', cursor: null },
    ] as any);
    spyOn(plaidSync, 'syncPlaidItem').mockResolvedValue({ added: 5, linked: 2, skipped: 1 } as any);
    spyOn(plaidClient, 'getBalances').mockResolvedValue([]);

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
});
