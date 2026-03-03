import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { getTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';
import * as licenseModule from '../licensing/license.js';

// Mutable reference that mock.module's getTransactions will return
let mockMonarchResult: unknown = { allTransactions: { results: [] } };

// Mock monarch-money-api before importing the tool
mock.module('monarch-money-api', () => ({
  setToken: () => {},
  loginUser: async () => {},
  getTransactions: async () => mockMonarchResult,
}));

// Import after mocking
const { initMonarchTool, monarchImportTool } = await import('../tools/import/monarch.js');

/** Build a Monarch API transaction object. */
function makeMonarchTxn(overrides: Partial<{
  id: string;
  amount: number;
  date: string;
  pending: boolean;
  plaidName: string | null;
  notes: string | null;
  isRecurring: boolean;
  category: { name: string } | null;
  merchant: { name: string } | null;
  account: { displayName: string } | null;
}> = {}) {
  return {
    id: overrides.id ?? '1',
    amount: overrides.amount ?? 42.67,
    date: overrides.date ?? '2026-01-03',
    pending: overrides.pending ?? false,
    plaidName: overrides.plaidName === undefined ? null : overrides.plaidName,
    notes: overrides.notes === undefined ? null : overrides.notes,
    isRecurring: overrides.isRecurring ?? false,
    category: overrides.category === undefined ? null : overrides.category,
    merchant: overrides.merchant === undefined ? { name: 'Corner Market' } : overrides.merchant,
    account: overrides.account === undefined ? null : overrides.account,
  };
}

const SAMPLE_TXNS = [
  makeMonarchTxn({
    id: '1',
    amount: 42.67,
    date: '2026-01-03',
    merchant: { name: 'Corner Market' },
    category: { name: 'Groceries' },
  }),
  makeMonarchTxn({
    id: '2',
    amount: -3200,
    date: '2026-01-05',
    merchant: { name: 'Acme Corp' },
    category: { name: 'Income' },
  }),
  makeMonarchTxn({
    id: '3',
    amount: 14.99,
    date: '2026-01-07',
    merchant: { name: 'StreamCo' },
    isRecurring: true,
  }),
];

describe('monarch_import tool', () => {
  let db: Database;
  let licenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initMonarchTool(db);
    licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
    process.env.MONARCH_TOKEN = 'test-token';
    mockMonarchResult = { allTransactions: { results: [] } };
  });

  afterEach(() => {
    licenseSpy.mockRestore();
    delete process.env.MONARCH_TOKEN;
    delete process.env.MONARCH_EMAIL;
    delete process.env.MONARCH_PASSWORD;
  });

  function setMonarchTxns(txns: unknown[]) {
    mockMonarchResult = { allTransactions: { results: txns } };
  }

  test('flips expense amounts to negative (Monarch positive = expense, OA negative = expense)', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);
    expect(result.data.transactionsImported).toBe(3);

    const txns = getTransactions(db);
    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery).toBeDefined();
    expect(grocery!.amount).toBe(-42.67);
    expect(grocery!.bank).toBe('monarch');
  });

  test('flips income amounts to positive (Monarch negative = income, OA positive = income)', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    const payroll = txns.find((t) => t.description === 'Acme Corp');
    expect(payroll).toBeDefined();
    expect(payroll!.amount).toBe(3200);
  });

  test('pending transactions are skipped', async () => {
    setMonarchTxns([
      makeMonarchTxn({ id: '10', pending: true, amount: 50 }),
      makeMonarchTxn({ id: '11', pending: false, amount: 25, merchant: { name: 'Shop' } }),
    ]);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(1);
    expect(result.data.skipped).toBe(1);
  });

  test('deduplication by composite key prevents re-import', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    await monarchImportTool.func({});

    // Re-import same data
    setMonarchTxns(SAMPLE_TXNS);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(0);
    expect(result.data.skipped).toBe(3);
  });

  test('empty response returns zero imports', async () => {
    setMonarchTxns([]);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(0);
    expect(result.data.message).toContain('No transactions found');
  });

  test('missing env vars returns error', async () => {
    delete process.env.MONARCH_TOKEN;
    delete process.env.MONARCH_EMAIL;
    delete process.env.MONARCH_PASSWORD;
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('credentials not configured');
  });

  test('license gate blocks without pro license', async () => {
    licenseSpy.mockReturnValue(false);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Pro feature');
  });

  test('date range is recorded in result', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.dateRange.start).toBe('2026-01-03');
    expect(result.data.dateRange.end).toBe('2026-01-07');
  });

  test('category is preserved from Monarch', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery!.category).toBe('Groceries');
  });

  test('merchant name used as description', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    expect(txns.some((t) => t.description === 'Corner Market')).toBe(true);
  });

  test('falls back to plaidName when merchant is null', async () => {
    setMonarchTxns([
      makeMonarchTxn({ id: '20', merchant: null, plaidName: 'CORNER MARKET #123' }),
    ]);
    const raw = await monarchImportTool.func({});
    const result = JSON.parse(raw as string);
    expect(result.data.transactionsImported).toBe(1);

    const txns = getTransactions(db);
    expect(txns[0].description).toBe('CORNER MARKET #123');
  });

  test('falls back to "Unknown" when both merchant and plaidName are null', async () => {
    setMonarchTxns([
      makeMonarchTxn({ id: '21', merchant: null, plaidName: null }),
    ]);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    expect(txns[0].description).toBe('Unknown');
  });

  test('isRecurring flag is preserved', async () => {
    setMonarchTxns(SAMPLE_TXNS);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    const streamCo = txns.find((t) => t.description === 'StreamCo');
    expect(streamCo!.is_recurring).toBe(1);

    const grocery = txns.find((t) => t.description === 'Corner Market');
    expect(grocery!.is_recurring).toBe(0);
  });

  test('notes are preserved', async () => {
    setMonarchTxns([
      makeMonarchTxn({ id: '30', notes: 'Business lunch', merchant: { name: 'Bistro' } }),
    ]);
    await monarchImportTool.func({});
    const txns = getTransactions(db);
    expect(txns[0].notes).toBe('Business lunch');
  });
});
