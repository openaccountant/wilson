import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../db/compat-sqlite.js';
import { encryptionAvailable } from '../db/sqlcipher-dylib.js';

describe('Database (compat-sqlite)', () => {
  test('@param is rewritten to $param for queries', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
    // Uses @name (better-sqlite3 style) — compat layer rewrites to $name
    db.prepare('INSERT INTO test (name) VALUES (@name)').run({ name: 'Alice' });
    const row = db.prepare('SELECT name FROM test WHERE name = @name').get({ name: 'Alice' }) as { name: string };
    expect(row.name).toBe('Alice');
    db.close();
  });

  test('pragma returns value', () => {
    const db = new Database(':memory:');
    // In-memory DBs can't use WAL — returns "memory"; just verify pragma works
    const mode = db.pragma('journal_mode');
    expect(typeof mode).toBe('string');
    db.close();
  });

  test('.all() returns array of rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (val TEXT)');
    db.prepare('INSERT INTO items (val) VALUES (@v)').run({ v: 'one' });
    db.prepare('INSERT INTO items (val) VALUES (@v)').run({ v: 'two' });
    const rows = db.prepare('SELECT val FROM items ORDER BY val').all() as { val: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].val).toBe('one');
    expect(rows[1].val).toBe('two');
    db.close();
  });

  test('transaction() commits on success', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (val TEXT)');
    const insertMany = db.transaction((vals: string[]) => {
      for (const v of vals) {
        db.prepare('INSERT INTO items (val) VALUES (@v)').run({ v });
      }
    });
    insertMany(['a', 'b', 'c']);
    const rows = db.prepare('SELECT val FROM items').all();
    expect(rows).toHaveLength(3);
    db.close();
  });

  test('transaction() rolls back on error', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (val TEXT NOT NULL)');
    const insertMany = db.transaction((vals: (string | null)[]) => {
      for (const v of vals) {
        db.prepare('INSERT INTO items (val) VALUES (@v)').run({ v });
      }
    });
    try {
      insertMany(['ok', null as any]); // null will violate NOT NULL
    } catch {
      // expected
    }
    const rows = db.prepare('SELECT val FROM items').all();
    expect(rows).toHaveLength(0); // rolled back
    db.close();
  });

  test('handles multi-statement SQL', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);');
    db.prepare('INSERT INTO a (id) VALUES (1)').run();
    db.prepare('INSERT INTO b (id) VALUES (2)').run();
    expect(db.prepare('SELECT id FROM a').get()).toEqual({ id: 1 });
    expect(db.prepare('SELECT id FROM b').get()).toEqual({ id: 2 });
    db.close();
  });
});

// Encrypted-file behavior requires the SQLCipher dylib. CI Linux has none, so
// these are skipped cleanly there; macOS dev machines with `brew install
// sqlcipher` exercise the real round-trips.
const canEncrypt = encryptionAvailable();
// 64 hex chars = 32-byte raw key. Raw-hex form avoids KDF passphrase derivation.
const KEY_HEX = '2b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfe';
const WRONG_KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('Database (compat-sqlite) encrypted', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  test.skipIf(!canEncrypt)('keyed create/write/reopen round-trips', () => {
    workDir = mkdtempSync(join(tmpdir(), 'compat-enc-'));
    const dbPath = join(workDir, 'enc.db');

    const db = new Database(dbPath, { key: KEY_HEX });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'alice' });
    db.prepare('INSERT INTO t (name) VALUES (@name)').run({ name: 'bob' });
    db.close();

    const reopened = new Database(dbPath, { key: KEY_HEX });
    const rows = reopened
      .prepare('SELECT name FROM t ORDER BY id')
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['alice', 'bob']);
    reopened.close();
  });

  test.skipIf(!canEncrypt)('reopening with the wrong key throws', () => {
    workDir = mkdtempSync(join(tmpdir(), 'compat-enc-'));
    const dbPath = join(workDir, 'enc.db');

    const db = new Database(dbPath, { key: KEY_HEX });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.close();

    // Wrong key surfaces at construction because we force a page read.
    expect(() => new Database(dbPath, { key: WRONG_KEY_HEX })).toThrow();
  });

  test.skipIf(!canEncrypt)('reading an encrypted db with no key throws', () => {
    workDir = mkdtempSync(join(tmpdir(), 'compat-enc-'));
    const dbPath = join(workDir, 'enc.db');

    const db = new Database(dbPath, { key: KEY_HEX });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.close();

    // No key: the constructor does nothing special, so the failure surfaces on
    // the first page read.
    expect(() => {
      const plain = new Database(dbPath);
      plain.prepare('SELECT count(*) FROM sqlite_master').get();
    }).toThrow();
  });

  test.skipIf(!canEncrypt)('encrypted file has no plaintext SQLite header', () => {
    workDir = mkdtempSync(join(tmpdir(), 'compat-enc-'));
    const dbPath = join(workDir, 'enc.db');

    const db = new Database(dbPath, { key: KEY_HEX });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.close();

    const header = readFileSync(dbPath).subarray(0, 16);
    const plaintext = Buffer.from('SQLite format 3\0', 'latin1');
    expect(header.equals(plaintext)).toBe(false);
  });
});
