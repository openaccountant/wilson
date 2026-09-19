import { describe, expect, test, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';

// Module mocks must not leak into other test files (bun shares the module
// registry across files within a run).
afterAll(() => {
  mock.restore();
});
import type { PlaidItem } from '../plaid/store.js';

/**
 * Tests for Plaid duplicate-Item detection by institution_id:
 *  - `findDuplicateItem` (link-server) — id-first matching with name fallback
 *  - `ensureInstitutionId` (plaid-sync) — one-time backfill migration
 *
 * Heavy modules (Plaid SDK, real store file, keychain, browser, logger) are mocked
 * using the same mock.module pattern as sync.test.ts.
 */

// ── Mock state (closures captured by the mock factories below) ──────────────

let mockInstitutionIdResult: string | null = 'ins_109508';
let mockInstitutionIdShouldThrow = false;
const getItemInstitutionIdCalls: Array<{ accessToken: string; useProxy: boolean }> = [];

// ── Module mocks (must run before importing the modules under test) ─────────

mock.module('../plaid/client.js', () => ({
  // link-server surface
  createLinkToken: async () => 'link-token',
  createUpdateLinkToken: async () => 'link-token',
  exchangePublicToken: async () => ({ accessToken: 'tok', itemId: 'item-x' }),
  getItemInfo: async () => ({ institutionName: 'Mock Bank', institutionId: null, accounts: [] }),
  hasLocalPlaidCreds: () => false,
  // plaid-sync surface
  syncTransactions: async () => ({ added: [], modified: [], removed: [], nextCursor: '' }),
  getBalances: async () => [],
  getItemInstitutionId: async (accessToken: string, useProxy = false) => {
    getItemInstitutionIdCalls.push({ accessToken, useProxy });
    if (mockInstitutionIdShouldThrow) throw new Error('plaid unavailable');
    return mockInstitutionIdResult;
  },
  PlaidError: class PlaidError extends Error {
    constructor(message: string, public errorType: string, public errorCode: string, public statusCode: number) {
      super(message);
    }
  },
}));

mock.module('../plaid/store.js', () => ({
  savePlaidItem: () => {},
  getPlaidItems: () => [] as PlaidItem[],
  removePlaidItemById: () => false,
  removePlaidItem: () => false,
  findPlaidItem: () => undefined,
  updatePlaidCursor: () => {},
  updatePlaidItemError: () => {},
  clearPlaidItemError: () => {},
  isReauthRequired: () => false,
}));

mock.module('../utils/browser.js', () => ({
  openBrowser: () => false,
}));

mock.module('../utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ── Imports under test (after mocks) ────────────────────────────────────────

const linkServer = await import('../plaid/link-server.js');
const plaidStore = await import('../plaid/store.js');
const plaidSync = await import('../tools/import/plaid-sync.js');

const { findDuplicateItem } = linkServer;
const { ensureInstitutionId } = plaidSync;

function makeItem(overrides: Partial<PlaidItem> = {}): PlaidItem {
  return {
    itemId: 'item-existing',
    accessToken: 'tok',
    institutionName: 'First National Bank',
    accounts: [],
    cursor: null,
    linkedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── findDuplicateItem ────────────────────────────────────────────────────────

describe('findDuplicateItem', () => {
  test('matches by institutionId even when institution names differ', () => {
    const existing = makeItem({ itemId: 'item-old', institutionId: 'ins_109508', institutionName: 'First National Bank' });
    const newItem = { itemId: 'item-new', institutionId: 'ins_109508', institutionName: 'First National Bank, N.A.' };
    expect(findDuplicateItem([existing], newItem)).toBe(existing);
  });

  test('does NOT match when both have ids and the ids differ, even if names are identical', () => {
    const existing = makeItem({ itemId: 'item-old', institutionId: 'ins_1', institutionName: 'Same Name' });
    const newItem = { itemId: 'item-new', institutionId: 'ins_2', institutionName: 'Same Name' };
    expect(findDuplicateItem([existing], newItem)).toBeUndefined();
  });

  test('name fallback: legacy existing item (no institutionId) with same name matches', () => {
    const existing = makeItem({ itemId: 'item-old', institutionId: undefined, institutionName: 'First National Bank' });
    const newItem = { itemId: 'item-new', institutionId: 'ins_109508', institutionName: 'First National Bank' };
    expect(findDuplicateItem([existing], newItem)).toBe(existing);
  });

  test('name fallback: new item without institutionId matches same-named existing', () => {
    const existing = makeItem({ itemId: 'item-old', institutionId: 'ins_9', institutionName: 'First National Bank' });
    const newItem = { itemId: 'item-new', institutionId: null, institutionName: 'First National Bank' };
    expect(findDuplicateItem([existing], newItem)).toBe(existing);
  });

  test('never matches an existing item with the same itemId (same-Item re-link is an upsert)', () => {
    const existing = makeItem({ itemId: 'item-same', institutionId: 'ins_109508', institutionName: 'First National Bank' });
    const newItem = { itemId: 'item-same', institutionId: 'ins_109508', institutionName: 'First National Bank' };
    expect(findDuplicateItem([existing], newItem)).toBeUndefined();
  });

  test('no id on either side and names differ — no match', () => {
    const existing = makeItem({ itemId: 'item-old', institutionId: undefined, institutionName: 'Alpha Bank' });
    const newItem = { itemId: 'item-new', institutionId: null, institutionName: 'Beta Bank' };
    expect(findDuplicateItem([existing], newItem)).toBeUndefined();
  });

  test('existing item with institutionId null is only matched by name, never by id', () => {
    // null !== null must not be treated as an id match — different names ⇒ no match
    const existingNullId = makeItem({ itemId: 'item-old', institutionId: null, institutionName: 'Other Bank' });
    const newItem = { itemId: 'item-new', institutionId: 'ins_109508', institutionName: 'First National Bank' };
    expect(findDuplicateItem([existingNullId], newItem)).toBeUndefined();

    // ...but the same null-id existing item is still matched by name fallback
    const sameNamedNullId = makeItem({ itemId: 'item-old2', institutionId: null, institutionName: 'First National Bank' });
    expect(findDuplicateItem([sameNamedNullId], newItem)).toBe(sameNamedNullId);
  });
});

// ── ensureInstitutionId ──────────────────────────────────────────────────────

describe('ensureInstitutionId', () => {
  let saveSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockInstitutionIdResult = 'ins_109508';
    mockInstitutionIdShouldThrow = false;
    getItemInstitutionIdCalls.length = 0;
    saveSpy = spyOn(plaidStore, 'savePlaidItem').mockImplementation(() => {});
  });

  afterEach(() => {
    saveSpy.mockRestore();
  });

  test('legacy item (institutionId undefined) is backfilled and saved', async () => {
    const item = makeItem({ itemId: 'item-legacy', accessToken: 'tok-real', institutionId: undefined });

    await ensureInstitutionId(item, false);

    expect(getItemInstitutionIdCalls).toEqual([{ accessToken: 'tok-real', useProxy: false }]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]![0]).toBe(item);
    expect(item.institutionId).toBe('ins_109508');
  });

  test('item that already has an institutionId is left alone', async () => {
    const item = makeItem({ itemId: 'item-set', accessToken: 'tok-real', institutionId: 'ins_1' });

    await ensureInstitutionId(item, false);

    expect(getItemInstitutionIdCalls).toHaveLength(0);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(item.institutionId).toBe('ins_1');
  });

  test('Plaid returning null is persisted as null so the migration does not retry', async () => {
    mockInstitutionIdResult = null;
    const item = makeItem({ itemId: 'item-null', accessToken: 'tok-real', institutionId: undefined });

    await ensureInstitutionId(item, false);

    expect(getItemInstitutionIdCalls).toHaveLength(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(item.institutionId).toBeNull();

    // Second run: already migrated, no more API calls
    await ensureInstitutionId(item, false);
    expect(getItemInstitutionIdCalls).toHaveLength(1);
  });

  test('API failure never throws and leaves institutionId undefined for retry', async () => {
    mockInstitutionIdShouldThrow = true;
    const item = makeItem({ itemId: 'item-fail', accessToken: 'tok-real', institutionId: undefined });

    await expect(ensureInstitutionId(item, false)).resolves.toBeUndefined();

    expect(getItemInstitutionIdCalls).toHaveLength(1);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(item.institutionId).toBeUndefined();
  });

  test('keychain placeholder token is skipped without an API call', async () => {
    const item = makeItem({ itemId: 'item-kc', accessToken: '__keychain__', institutionId: undefined });

    await ensureInstitutionId(item, false);

    expect(getItemInstitutionIdCalls).toHaveLength(0);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(item.institutionId).toBeUndefined();
  });
});