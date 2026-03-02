import { describe, expect, test } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';

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
