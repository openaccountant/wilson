import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setSecret, getSecret, deleteSecret } from '../utils/keychain.js';
import { logger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlaidAccount {
  id: string;
  name: string;
  mask: string;
}

export interface PlaidItem {
  itemId: string;
  accessToken: string;
  institutionName: string;
  accounts: PlaidAccount[];
  /** Cursor for incremental transaction sync */
  cursor: string | null;
  linkedAt: string;
  errorState?: { code: string; message: string; detectedAt: string } | null;
}

interface PlaidStore {
  items: PlaidItem[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_DIR = join(homedir(), '.openaccountant');
const STORE_FILE = join(STORE_DIR, 'plaid.json');

// ── Store I/O ────────────────────────────────────────────────────────────────

function readStore(): PlaidStore {
  if (!existsSync(STORE_FILE)) return { items: [] };
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as PlaidStore;
  } catch {
    return { items: [] };
  }
}

function writeStore(store: PlaidStore): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  // Restrict permissions — access tokens are sensitive
  chmodSync(STORE_FILE, 0o600);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a linked Plaid item (bank connection).
 * Stores access token in OS keychain when available; falls back to file storage.
 */
export function savePlaidItem(item: PlaidItem): void {
  const store = readStore();

  // Attempt to store access token in keychain
  const keychainOk = setSecret(`plaid-${item.itemId}`, item.accessToken);

  // Store item in JSON — omit access token if keychain succeeded
  const storeItem = keychainOk
    ? { ...item, accessToken: '__keychain__' }
    : item;

  const idx = store.items.findIndex((i) => i.itemId === item.itemId);
  if (idx >= 0) {
    store.items[idx] = storeItem;
  } else {
    store.items.push(storeItem);
  }
  writeStore(store);
}

/**
 * Get all linked Plaid items.
 * Resolves access tokens from keychain when stored there; migrates legacy file-stored tokens.
 */
export function getPlaidItems(): PlaidItem[] {
  const store = readStore();
  let migrated = false;

  const items = store.items.map((item) => {
    if (item.accessToken === '__keychain__') {
      // Resolve from keychain
      const token = getSecret(`plaid-${item.itemId}`);
      if (token) {
        return { ...item, accessToken: token };
      }
      logger.info('keychain:plaid:missing', { itemId: item.itemId });
      return item;
    }

    // Backward compat: token is in the JSON — migrate to keychain
    if (item.accessToken && item.accessToken !== '__keychain__') {
      const keychainOk = setSecret(`plaid-${item.itemId}`, item.accessToken);
      if (keychainOk) {
        item.accessToken = '__keychain__';
        migrated = true;
        logger.info('keychain:plaid:migrated', { itemId: item.itemId });
      }
    }

    return item;
  });

  // Persist the migration (strip tokens from file)
  if (migrated) {
    writeStore(store);
  }

  // Re-resolve migrated items
  return items.map((item) => {
    if (item.accessToken === '__keychain__') {
      const token = getSecret(`plaid-${item.itemId}`);
      return token ? { ...item, accessToken: token } : item;
    }
    return item;
  });
}

/**
 * Update the sync cursor for an item after a successful sync.
 */
export function updatePlaidCursor(itemId: string, cursor: string): void {
  const store = readStore();
  const item = store.items.find((i) => i.itemId === itemId);
  if (item) {
    item.cursor = cursor;
    writeStore(store);
  }
}

/**
 * Remove a linked Plaid item by institution name.
 */
export function removePlaidItem(institutionName: string): boolean {
  const store = readStore();
  const before = store.items.length;
  const removed = store.items.filter(
    (i) => i.institutionName.toLowerCase() === institutionName.toLowerCase()
  );
  store.items = store.items.filter(
    (i) => i.institutionName.toLowerCase() !== institutionName.toLowerCase()
  );
  if (store.items.length < before) {
    writeStore(store);
    // Clean up keychain entries for removed items
    for (const item of removed) {
      deleteSecret(`plaid-${item.itemId}`);
    }
    return true;
  }
  return false;
}

/**
 * Find a Plaid item by institution name (case-insensitive).
 */
export function findPlaidItem(institutionName: string): PlaidItem | undefined {
  const store = readStore();
  return store.items.find(
    (i) => i.institutionName.toLowerCase() === institutionName.toLowerCase()
  );
}

/**
 * Save an error state for a Plaid item (e.g. ITEM_LOGIN_REQUIRED).
 */
export function updatePlaidItemError(itemId: string, error: { code: string; message: string }): void {
  const store = readStore();
  const item = store.items.find((i) => i.itemId === itemId);
  if (item) {
    item.errorState = { code: error.code, message: error.message, detectedAt: new Date().toISOString() };
    writeStore(store);
  }
}

/**
 * Clear the error state for a Plaid item (e.g. after successful re-auth).
 */
export function clearPlaidItemError(itemId: string): void {
  const store = readStore();
  const item = store.items.find((i) => i.itemId === itemId);
  if (item) {
    item.errorState = null;
    writeStore(store);
  }
}

/**
 * Check if a Plaid item is approaching the 12-month reauthorization deadline.
 * Returns true if the item was linked 11+ months ago.
 */
export function isReauthRequired(item: PlaidItem): boolean {
  const linked = new Date(item.linkedAt);
  const now = new Date();
  const months = (now.getFullYear() - linked.getFullYear()) * 12 + now.getMonth() - linked.getMonth();
  return months >= 11; // Warn 1 month before 12-month expiry
}
