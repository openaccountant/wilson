import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setSecret, getSecret, deleteSecret } from '../utils/keychain.js';
import { logger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoinbaseAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
}

export interface CoinbaseConnection {
  keyName: string;          // "organizations/{org_id}/apiKeys/{key_id}"
  privateKey: string;       // PEM EC private key
  accounts: CoinbaseAccount[];
  linkedAt: string;
  lastSyncedAt: string | null;
}

interface CoinbaseStore {
  connections: CoinbaseConnection[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_DIR = join(homedir(), '.openaccountant');
const STORE_FILE = join(STORE_DIR, 'coinbase.json');

// ── Store I/O ────────────────────────────────────────────────────────────────

function readStore(): CoinbaseStore {
  if (!existsSync(STORE_FILE)) return { connections: [] };
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as CoinbaseStore;
  } catch {
    return { connections: [] };
  }
}

function writeStore(store: CoinbaseStore): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  chmodSync(STORE_FILE, 0o600);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function saveCoinbaseConnection(conn: CoinbaseConnection): void {
  const store = readStore();

  // Store private key in keychain when available
  const keychainOk = setSecret(`coinbase-${conn.keyName}`, conn.privateKey);
  const storeConn = keychainOk
    ? { ...conn, privateKey: '__keychain__' }
    : conn;

  const idx = store.connections.findIndex((c) => c.keyName === conn.keyName);
  if (idx >= 0) {
    store.connections[idx] = storeConn;
  } else {
    store.connections.push(storeConn);
  }
  writeStore(store);
}

export function getCoinbaseConnections(): CoinbaseConnection[] {
  const store = readStore();
  let migrated = false;

  const connections = store.connections.map((conn) => {
    if (conn.privateKey === '__keychain__') {
      const key = getSecret(`coinbase-${conn.keyName}`);
      return key ? { ...conn, privateKey: key } : conn;
    }

    // Backward compat: migrate file-stored key to keychain
    if (conn.privateKey && conn.privateKey !== '__keychain__') {
      const keychainOk = setSecret(`coinbase-${conn.keyName}`, conn.privateKey);
      if (keychainOk) {
        conn.privateKey = '__keychain__';
        migrated = true;
        logger.info('keychain:coinbase:migrated', { keyName: conn.keyName });
      }
    }

    return conn;
  });

  if (migrated) {
    writeStore(store);
  }

  return connections.map((conn) => {
    if (conn.privateKey === '__keychain__') {
      const key = getSecret(`coinbase-${conn.keyName}`);
      return key ? { ...conn, privateKey: key } : conn;
    }
    return conn;
  });
}

export function updateLastSyncedAt(keyName: string): void {
  const store = readStore();
  const conn = store.connections.find((c) => c.keyName === keyName);
  if (conn) {
    conn.lastSyncedAt = new Date().toISOString();
    writeStore(store);
  }
}

export function removeCoinbaseConnection(accountName: string): boolean {
  const store = readStore();
  const before = store.connections.length;
  const removed = store.connections.filter(
    (c) => c.accounts.some((a) => a.name.toLowerCase() === accountName.toLowerCase())
  );
  store.connections = store.connections.filter(
    (c) => !c.accounts.some((a) => a.name.toLowerCase() === accountName.toLowerCase())
  );
  if (store.connections.length < before) {
    writeStore(store);
    for (const conn of removed) {
      deleteSecret(`coinbase-${conn.keyName}`);
    }
    return true;
  }
  return false;
}
