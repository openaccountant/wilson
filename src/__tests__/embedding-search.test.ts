import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertTransactions, getTransactions } from '../db/queries.js';
import { searchTransactionsSemantic, upsertEmbeddings } from '../db/embedding-queries.js';
import { DEFAULT_EMBEDDING_MODEL, transactionEmbedText } from '../utils/embeddings.js';
import { fakeEmbedText } from './fake-embedder.js';

/**
 * Seed one transaction per entry and return a description → id map so tests
 * can reference rows without assuming autoincrement ordering.
 * (insertTransactions has no account_id/entity_id fields, so those are set via
 * UPDATE — descriptions are unique within each test.)
 */
function seed(
  db: Database,
  rows: Array<{
    description: string;
    merchant_name?: string;
    amount?: number;
    date?: string;
    category?: string;
    account_id?: number;
    entity_id?: number;
  }>
): Map<string, number> {
  insertTransactions(
    db,
    rows.map((r) => ({
      date: r.date ?? '2026-01-15',
      description: r.description,
      amount: r.amount ?? -10,
      category: r.category,
      merchant_name: r.merchant_name,
    }))
  );
  const setStmt = db.prepare('UPDATE transactions SET account_id = @accountId, entity_id = @entityId WHERE description = @description');
  for (const r of rows) {
    if (r.account_id !== undefined || r.entity_id !== undefined) {
      setStmt.run({ accountId: r.account_id ?? null, entityId: r.entity_id ?? null, description: r.description });
    }
  }
  const map = new Map<string, number>();
  for (const t of getTransactions(db) as Array<{ id: number; description: string }>) {
    map.set(t.description, t.id);
  }
  return map;
}

/** Look up a seeded id, failing loudly if the key is absent (no undefined leaking into assertions). */
function idOf(map: Map<string, number>, description: string): number {
  const id = map.get(description);
  if (id === undefined) throw new Error(`no seeded transaction with description "${description}"`);
  return id;
}

/** Embed every seeded transaction with the fake embedder under the given model. */
function indexDescriptions(db: Database, map: Map<string, number>, model = DEFAULT_EMBEDDING_MODEL): void {
  const rows = getTransactions(db) as Array<{ id: number; description: string; merchant_name: string | null }>;
  upsertEmbeddings(
    db,
    rows
      .filter((t) => map.has(t.description))
      .map((t) => ({
        sourceType: 'transaction' as const,
        sourceId: t.id,
        model,
        vec: fakeEmbedText(transactionEmbedText({ merchant_name: t.merchant_name, description: t.description })),
      }))
  );
}

describe('semantic transaction search', () => {
  test('ranking order matches dot-product order (more shared words rank higher)', () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop' },   // shares 3 words with query
      { description: 'coffee beans wholesale' }, // shares 1 word
      { description: 'airline ticket purchase' },// shares 0 words
    ]);
    indexDescriptions(db, ids);

    const results = searchTransactionsSemantic(db, fakeEmbedText('downtown coffee shop'), {}, 10);

    expect(results.map((r) => r.sourceId)).toEqual([idOf(ids, 'downtown coffee shop'), idOf(ids, 'coffee beans wholesale'), idOf(ids, 'airline ticket purchase')]);
    // Scores strictly decreasing, and match the raw dot products.
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
    expect(results[0].score).toBeCloseTo(1, 6); // identical text → cosine 1
    expect(results[2].score).toBeCloseTo(0, 6); // no shared words → 0
    db.close();
  });

  test('date range prefilter excludes rows that would otherwise rank high', () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop', date: '2026-01-15' },
      { description: 'downtown coffee house', date: '2026-02-20' },
      { description: 'downtown coffee bar', date: '2026-03-05' },
    ]);
    indexDescriptions(db, ids);

    const query = fakeEmbedText('downtown coffee shop');
    const unfiltered = searchTransactionsSemantic(db, query, {}, 10);
    expect(unfiltered.map((r) => r.sourceId)).toContain(idOf(ids, 'downtown coffee house'));

    const filtered = searchTransactionsSemantic(db, query, { dateStart: '2026-01-01', dateEnd: '2026-01-31' }, 10);
    expect(filtered.map((r) => r.sourceId)).toEqual([idOf(ids, 'downtown coffee shop')]);
    db.close();
  });

  test('accountId prefilter only returns that account rows', () => {
    const db = createTestDb();
    // transactions.account_id has an FK to accounts(id) — create the rows first.
    const insertAccount = db.prepare(
      'INSERT INTO accounts (id, name, account_type, account_subtype) VALUES (@id, @name, @type, @subtype)'
    );
    insertAccount.run({ id: 7, name: 'Checking A', type: 'depository', subtype: 'checking' });
    insertAccount.run({ id: 9, name: 'Checking B', type: 'depository', subtype: 'checking' });

    const ids = seed(db, [
      { description: 'grocery run big', account_id: 7 },
      { description: 'grocery run small', account_id: 9 },
      { description: 'grocery run other' }, // NULL account_id
    ]);
    indexDescriptions(db, ids);

    const query = fakeEmbedText('grocery run big');
    const results = searchTransactionsSemantic(db, query, { accountId: 7 }, 10);
    expect(results.map((r) => r.sourceId)).toEqual([idOf(ids, 'grocery run big')]);
    db.close();
  });

  test('category prefilter only returns that category rows', () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'coffee morning fix', category: 'Dining' },
      { description: 'coffee beans home', category: 'Groceries' },
      { description: 'coffee machine repair', category: 'Other' },
    ]);
    indexDescriptions(db, ids);

    const query = fakeEmbedText('coffee morning fix');
    const results = searchTransactionsSemantic(db, query, { category: 'Dining' }, 10);
    expect(results.map((r) => r.sourceId)).toEqual([idOf(ids, 'coffee morning fix')]);
    db.close();
  });

  test('limit k is respected (top-k by score)', () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'coffee morning fix' },
      { description: 'coffee afternoon fix' },
      { description: 'coffee evening fix' },
      { description: 'coffee late fix' },
      { description: 'totally unrelated thing' },
    ]);
    indexDescriptions(db, ids);

    const results = searchTransactionsSemantic(db, fakeEmbedText('coffee morning fix'), {}, 3);
    expect(results).toHaveLength(3);
    // The zero-overlap row must not make the top 3.
    expect(results.map((r) => r.sourceId)).not.toContain(idOf(ids, 'totally unrelated thing'));
    // And they are the top-3 by score (strictly decreasing).
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    expect(results[0].score).toBeCloseTo(1, 6);
    db.close();
  });

  test('identical-score rows tie-break on ascending source_id', () => {
    const db = createTestDb();
    // Three transactions with identical texts → identical vectors → identical scores.
    seed(db, [
      { description: 'identical words here', date: '2026-01-15' },
      { description: 'identical words here', date: '2026-01-16' },
      { description: 'identical words here', date: '2026-01-17' },
    ]);
    indexDescriptions(db, new Map([['identical words here', 0]]));

    const results = searchTransactionsSemantic(db, fakeEmbedText('identical words here'), {}, 10);
    expect(results).toHaveLength(3);
    // The tie condition actually holds.
    for (const r of results) {
      expect(r.score).toBeCloseTo(results[0].score, 12);
    }
    // And ties return in ascending id order.
    const returnedIds = results.map((r) => r.sourceId);
    expect([...returnedIds].sort((a, b) => a - b)).toEqual(returnedIds);
    db.close();
  });

  test('rows from a different model never leak into results', () => {
    const db = createTestDb();
    const ids = seed(db, [{ description: 'downtown coffee shop' }]);
    indexDescriptions(db, ids, 'other-embedding-model');

    const results = searchTransactionsSemantic(db, fakeEmbedText('downtown coffee shop'), {}, 10);
    expect(results).toHaveLength(0);

    // And search under that model finds it.
    const underOther = searchTransactionsSemantic(db, fakeEmbedText('downtown coffee shop'), {}, 10, 'other-embedding-model');
    expect(underOther).toHaveLength(1);
    expect(underOther[0].sourceId).toBe(idOf(ids, 'downtown coffee shop'));
    db.close();
  });

  test('result rows carry the transaction fields', () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop', merchant_name: 'Downtown Coffee', amount: -4.5, category: 'Dining', date: '2026-01-15' },
    ]);
    indexDescriptions(db, ids);

    const [row] = searchTransactionsSemantic(db, fakeEmbedText('downtown coffee shop'), {}, 10);
    expect(row).toBeDefined();
    expect(row.sourceId).toBe(idOf(ids, 'downtown coffee shop'));
    expect(row.description).toBe('downtown coffee shop');
    expect(row.merchantName).toBe('Downtown Coffee');
    expect(row.amount).toBeCloseTo(-4.5, 6);
    expect(row.category).toBe('Dining');
    expect(row.date).toBe('2026-01-15');
    db.close();
  });
});