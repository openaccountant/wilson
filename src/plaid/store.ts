import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
 */
export function savePlaidItem(item: PlaidItem): void {
  const store = readStore();
  // Replace existing item with same itemId
  const idx = store.items.findIndex((i) => i.itemId === item.itemId);
  if (idx >= 0) {
    store.items[idx] = item;
  } else {
    store.items.push(item);
  }
  writeStore(store);
}

/**
 * Get all linked Plaid items.
 */
export function getPlaidItems(): PlaidItem[] {
  return readStore().items;
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
  store.items = store.items.filter(
    (i) => i.institutionName.toLowerCase() !== institutionName.toLowerCase()
  );
  if (store.items.length < before) {
    writeStore(store);
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
