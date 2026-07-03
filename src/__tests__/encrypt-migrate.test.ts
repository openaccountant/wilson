import { afterEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlaintextSqliteFile, migrateToEncrypted } from '../db/encrypt-migrate.js';
import { encryptionAvailable } from '../db/sqlcipher-dylib.js';

// Activate SQLCipher before any Database is constructed in THIS process. In a
// full `bun test` run another test file constructs a DB first, so this is false
// and every encrypted test below skips (by design — the setCustomSQLite ordering
// constraint). Run this file in isolation to exercise the real migration:
//   bun test src/__tests__/encrypt-migrate.test.ts
const canEncrypt = encryptionAvailable();

// 64 hex chars = 32-byte raw key. Raw-hex form avoids KDF passphrase derivation.
const KEY_HEX = '2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfe';
const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Open a keyed SQLCipher connection the same way compat-sqlite.ts does. */
function openKeyed(path: string): BunDatabase {
  const db = new BunDatabase(path);
  db.exec(`PRAGMA key = "x'${KEY_HEX}'"`);
  db.exec('PRAGMA cipher_compatibility = 4');
  return db;
}

describe('isPlaintextSqliteFile', () => {
  let workDir: string;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test('returns false for a missing file', () => {
    workDir = mkdtempSync(join(tmpdir(), 'plain-hdr-'));
    expect(isPlaintextSqliteFile(join(workDir, 'nope.db'))).toBe(false);
  });

  test('returns false for a too-short / non-SQLite file', () => {
    workDir = mkdtempSync(join(tmpdir(), 'plain-hdr-'));
    const p = join(workDir, 'garbage.db');
    writeFileSync(p, 'not a database');
    expect(isPlaintextSqliteFile(p)).toBe(false);
  });

  test('returns true for a real plaintext SQLite file', () => {
    workDir = mkdtempSync(join(tmpdir(), 'plain-hdr-'));
    const p = join(workDir, 'plain.db');
    // An unkeyed DB is plaintext even when the SQLCipher dylib is loaded.
    const db = new BunDatabase(p);
    db.exec('CREATE TABLE t (id INTEGER)');
    db.close();
    expect(isPlaintextSqliteFile(p)).toBe(true);
  });

  test.skipIf(!canEncrypt)('returns false for an encrypted SQLCipher file', () => {
    workDir = mkdtempSync(join(tmpdir(), 'plain-hdr-'));
    const p = join(workDir, 'enc.db');
    const db = openKeyed(p);
    db.exec('CREATE TABLE t (id INTEGER)');
    db.close();
    expect(isPlaintextSqliteFile(p)).toBe(false);
  });
});

describe('migrateToEncrypted', () => {
  let workDir: string;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test.skipIf(!canEncrypt)('round-trips realistic rows and preserves a plaintext backup', () => {
    workDir = mkdtempSync(join(tmpdir(), 'migrate-'));
    const dbPath = join(workDir, 'data.db');

    // Build a realistic plaintext ledger.
    const plain = new BunDatabase(dbPath);
    plain.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, memo TEXT, cents INTEGER)');
    plain.exec(
      "INSERT INTO ledger (memo, cents) VALUES ('coffee', -450), ('salary', 500000), ('rent', -180000)",
    );
    plain.close();
    expect(isPlaintextSqliteFile(dbPath)).toBe(true);

    migrateToEncrypted(dbPath, KEY_HEX);

    // The database at the original path is now encrypted at rest...
    expect(readFileSync(dbPath).subarray(0, 16).equals(PLAINTEXT_HEADER)).toBe(false);
    expect(isPlaintextSqliteFile(dbPath)).toBe(false);

    // ...and reads back correctly through the key.
    const enc = openKeyed(dbPath);
    const rows = enc.query('SELECT memo, cents FROM ledger ORDER BY id').all() as {
      memo: string;
      cents: number;
    }[];
    enc.close();
    expect(rows).toEqual([
      { memo: 'coffee', cents: -450 },
      { memo: 'salary', cents: 500000 },
      { memo: 'rent', cents: -180000 },
    ]);

    // The plaintext backup is preserved and still readable as plaintext.
    const backupPath = `${dbPath}.unencrypted-backup`;
    expect(existsSync(backupPath)).toBe(true);
    expect(isPlaintextSqliteFile(backupPath)).toBe(true);
    const backup = new BunDatabase(backupPath);
    const backupCount = (
      backup.query('SELECT count(*) AS c FROM ledger').get() as { c: number }
    ).c;
    backup.close();
    expect(backupCount).toBe(3);
  });

  test.skipIf(!canEncrypt)('migrates an empty plaintext database', () => {
    workDir = mkdtempSync(join(tmpdir(), 'migrate-'));
    const dbPath = join(workDir, 'empty.db');

    // Force the file into existence as a plaintext SQLite DB with no user tables.
    const plain = new BunDatabase(dbPath);
    plain.exec('PRAGMA user_version = 0');
    plain.exec('CREATE TABLE _touch (x INTEGER)');
    plain.exec('DROP TABLE _touch');
    plain.close();
    expect(isPlaintextSqliteFile(dbPath)).toBe(true);

    migrateToEncrypted(dbPath, KEY_HEX);

    expect(isPlaintextSqliteFile(dbPath)).toBe(false);
    const enc = openKeyed(dbPath);
    // A schema query proves the key decrypts the migrated file.
    const tables = enc.query("SELECT name FROM sqlite_master WHERE type='table'").all();
    enc.close();
    expect(Array.isArray(tables)).toBe(true);
    expect(existsSync(`${dbPath}.unencrypted-backup`)).toBe(true);
  });

  test.skipIf(!canEncrypt)('leaves the original untouched and cleans up when export fails', () => {
    workDir = mkdtempSync(join(tmpdir(), 'migrate-'));
    const dbPath = join(workDir, 'corrupt.db');

    // A file with a valid plaintext header but a malformed body: isPlaintextSqliteFile
    // accepts it, but sqlcipher_export fails when it reads the corrupt pages.
    const corrupt = Buffer.concat([PLAINTEXT_HEADER, Buffer.alloc(200, 0xab)]);
    writeFileSync(dbPath, corrupt);
    expect(isPlaintextSqliteFile(dbPath)).toBe(true);

    expect(() => migrateToEncrypted(dbPath, KEY_HEX)).toThrow();

    // Original bytes are byte-for-byte unchanged; no backup or tmp artifacts left.
    expect(readFileSync(dbPath).equals(corrupt)).toBe(true);
    expect(existsSync(`${dbPath}.unencrypted-backup`)).toBe(false);
    const leftovers = readdirSync(workDir).filter((f) => f.includes('.encrypting-'));
    expect(leftovers).toEqual([]);
  });
});
