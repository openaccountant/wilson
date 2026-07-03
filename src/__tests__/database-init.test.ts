import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { encryptionAvailable } from '../db/sqlcipher-dylib.js';

// Activate SQLCipher before any Database is constructed in THIS process. False in
// a full `bun test` run (another file constructs a DB first), so the encrypted
// tests skip by design. Run in isolation to exercise the real key/migration path:
//   bun test src/__tests__/database-init.test.ts
const canEncrypt = encryptionAvailable();

const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

// In-memory keychain so initDatabase's per-profile key lookup never touches the
// real macOS keychain (no residue) — mirrors encryption-key.test.ts.
let store: Map<string, string> = new Map();
const mockSetSecret = mock((account: string, secret: string) => {
  store.set(account, secret);
  return true;
});
const mockGetSecret = mock((account: string) => store.get(account) ?? null);
const mockDeleteSecret = mock((account: string) => store.delete(account));
mock.module('../utils/keychain.js', () => ({
  setSecret: mockSetSecret,
  getSecret: mockGetSecret,
  deleteSecret: mockDeleteSecret,
}));

const { initDatabase } = await import('../db/database.js');

describe('initDatabase', () => {
  let workDir: string;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    store = new Map();
  });

  test(':memory: opens plain and runs migrations regardless of encryption', () => {
    const db = initDatabase(':memory:', 'mem-profile');
    // A migrated table proves runMigrations ran on the connection.
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'")
      .get();
    expect(row).toBeTruthy();
    db.close();
  });

  test.skipIf(!canEncrypt)('creates an encrypted database at rest for a fresh profile', () => {
    workDir = mkdtempSync(join(tmpdir(), 'db-init-'));
    const dbPath = join(workDir, 'data.db');

    const db = initDatabase(dbPath, 'fresh-profile');
    db.prepare(
      'INSERT INTO transactions (date, description, amount) VALUES (@date, @description, @amount)',
    ).run({ date: '2026-01-01', description: 'coffee', amount: -4.5 });
    db.close();

    // Encrypted at rest: no plaintext SQLite header on disk.
    expect(readFileSync(dbPath).subarray(0, 16).equals(PLAINTEXT_HEADER)).toBe(false);
    // A key was created under the profile-namespaced keychain account.
    expect(store.has('db-encryption-fresh-profile')).toBe(true);

    // Reopening with the same profile key reads the row back.
    const reopened = initDatabase(dbPath, 'fresh-profile');
    const count = (
      reopened.prepare('SELECT count(*) AS c FROM transactions').get() as { c: number }
    ).c;
    reopened.close();
    expect(count).toBe(1);
  });

  test.skipIf(!canEncrypt)('migrates an existing plaintext database on first encrypted open', () => {
    workDir = mkdtempSync(join(tmpdir(), 'db-init-'));
    const dbPath = join(workDir, 'data.db');

    // Simulate a pre-encryption Wilson DB: a plaintext file with real data. Use a
    // neutral table name so Wilson's own migrations (which run after the migrate)
    // don't collide with this fixture's schema.
    const plain = new BunDatabase(dbPath);
    plain.exec('CREATE TABLE legacy_notes (id INTEGER PRIMARY KEY, description TEXT)');
    plain.exec("INSERT INTO legacy_notes (description) VALUES ('legacy-row')");
    plain.close();
    expect(readFileSync(dbPath).subarray(0, 16).equals(PLAINTEXT_HEADER)).toBe(true);

    const db = initDatabase(dbPath, 'legacy-profile');
    const row = db
      .prepare("SELECT description FROM legacy_notes WHERE description = 'legacy-row'")
      .get() as { description: string } | undefined;
    db.close();

    // Data survived the migration, the file is now encrypted, and a plaintext
    // backup was left behind.
    expect(row?.description).toBe('legacy-row');
    expect(readFileSync(dbPath).subarray(0, 16).equals(PLAINTEXT_HEADER)).toBe(false);
    expect(existsSync(`${dbPath}.unencrypted-backup`)).toBe(true);
  });

  test.skipIf(!canEncrypt)('derives the profile name from the path when none is passed', () => {
    workDir = mkdtempSync(join(tmpdir(), 'db-init-'));
    // Emulate the profile layout: .../profiles/<name>/data.db
    const dbPath = join(workDir, 'profiles', 'derived', 'data.db');

    const db = initDatabase(dbPath);
    db.close();

    // Key was stored under the directory-derived profile name.
    expect(store.has('db-encryption-derived')).toBe(true);
  });
});
