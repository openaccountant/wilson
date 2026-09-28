import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertTransactions, getTransactions } from '../db/queries.js';
import { upsertEmbeddings } from '../db/embedding-queries.js';
import { DEFAULT_EMBEDDING_MODEL, transactionEmbedText } from '../utils/embeddings.js';
import { fakeEmbedText, createFakeEmbedder } from './fake-embedder.js';
import { apiSemanticSearch, type SemanticSearchResponse } from '../dashboard/api.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Seed one transaction per entry and return a description → id map so tests
 * can reference rows without assuming autoincrement ordering.
 * (insertTransactions has no account_id/entity_id fields, so those are set via
 * UPDATE — descriptions are unique within each test. account_id/entity_id have
 * FKs, so callers must create the referenced accounts/entities first.)
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
  const setStmt = db.prepare(
    'UPDATE transactions SET account_id = @accountId, entity_id = @entityId WHERE description = @description'
  );
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

/** Look up a seeded id, failing loudly if the key is absent. */
function idOf(map: Map<string, number>, description: string): number {
  const id = map.get(description);
  if (id === undefined) throw new Error(`no seeded transaction with description "${description}"`);
  return id;
}

/** FK rows for account/entity filters (transactions.account_id/entity_id are FKs). */
function seedFilterParents(db: Database): void {
  const insertAccount = db.prepare(
    'INSERT INTO accounts (id, name, account_type, account_subtype) VALUES (@id, @name, @type, @subtype)'
  );
  insertAccount.run({ id: 7, name: 'Checking A', type: 'depository', subtype: 'checking' });
  insertAccount.run({ id: 9, name: 'Checking B', type: 'depository', subtype: 'checking' });
  const insertEntity = db.prepare('INSERT INTO entities (id, name, slug) VALUES (@id, @name, @slug)');
  insertEntity.run({ id: 3, name: 'Beta LLC', slug: 'beta-llc' });
  insertEntity.run({ id: 4, name: 'Gamma Inc', slug: 'gamma-inc' });
}

/** Embed every seeded transaction with the fake embedder (what `wilson --index` would store). */
function indexAll(db: Database, map: Map<string, number>, model = DEFAULT_EMBEDDING_MODEL): void {
  indexDescriptions(db, map, [...map.keys()], model);
}

/** Embed only the listed descriptions. */
function indexDescriptions(
  db: Database,
  map: Map<string, number>,
  descriptions: string[],
  model = DEFAULT_EMBEDDING_MODEL
): void {
  const rows = getTransactions(db) as Array<{
    id: number;
    description: string;
    merchant_name: string | null;
  }>;
  const wanted = new Set(descriptions);
  const upserts = rows
    .filter((t) => map.has(t.description) && wanted.has(t.description))
    .map((t) => ({
      sourceType: 'transaction' as const,
      sourceId: t.id,
      model,
      vec: fakeEmbedText(transactionEmbedText({ merchant_name: t.merchant_name, description: t.description })),
    }));
  if (upserts.length > 0) upsertEmbeddings(db, upserts);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('apiSemanticSearch', () => {
  test('ranking is dot-product order and scores equal the recomputed dot products', async () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop' },    // shares 2 words with the query
      { description: 'coffee beans wholesale' },  // shares 1 word
      { description: 'airline ticket purchase' }, // shares 0 words
    ]);
    indexAll(db, ids);

    const fake = createFakeEmbedder();
    const query = 'coffee shops downtown';
    const res = await apiSemanticSearch(db, new URLSearchParams({ q: query }), fake.embed);

    // Embed seam: exactly one call, one text — the query only.
    expect(fake.batchCount).toBe(1);
    expect(fake.calls).toEqual([query]);

    // Order is dot-product order, strictly decreasing.
    expect(res.results.map((r) => r.id)).toEqual([
      idOf(ids, 'downtown coffee shop'),
      idOf(ids, 'coffee beans wholesale'),
      idOf(ids, 'airline ticket purchase'),
    ]);
    for (let i = 1; i < res.results.length; i++) {
      expect(res.results[i - 1].score).toBeGreaterThan(res.results[i].score);
    }

    // Each score equals the dot product of the query vector and the indexed
    // document vector (fakeEmbedText → word-overlap similarity).
    const qVec = fakeEmbedText(query);
    const rows = getTransactions(db) as Array<{
      id: number;
      description: string;
      merchant_name: string | null;
    }>;
    for (const r of res.results) {
      const row = rows.find((t) => t.id === r.id);
      expect(row).toBeDefined();
      const expected = dot(qVec, fakeEmbedText(transactionEmbedText({ merchant_name: row!.merchant_name, description: row!.description })));
      expect(r.score).toBeCloseTo(expected, 6);
    }
    expect(res.results[0].score).toBeCloseTo(dot(qVec, fakeEmbedText('downtown coffee shop')), 6);
    db.close();
  });

  test('the filter set (date range + account + category + entity) actually constrains results', async () => {
    const db = createTestDb();
    seedFilterParents(db);
    const ids = seed(db, [
      // Fully matching row.
      { description: 'coffee morning run', date: '2026-01-10', category: 'Dining', account_id: 7, entity_id: 3 },
      // Each of these shares the query's high-score words but violates exactly one filter.
      { description: 'coffee morning walk', date: '2026-02-20', category: 'Dining', account_id: 7, entity_id: 3 }, // outside date range
      { description: 'coffee morning brew', date: '2026-01-11', category: 'Groceries', account_id: 7, entity_id: 3 }, // wrong category
      { description: 'coffee morning jog', date: '2026-01-12', category: 'Dining', account_id: 9, entity_id: 3 }, // wrong account
      { description: 'coffee morning swim', date: '2026-01-13', category: 'Dining', account_id: 7, entity_id: 4 }, // wrong entity
    ]);
    indexAll(db, ids);

    const q = 'coffee morning run';
    const targetId = idOf(ids, 'coffee morning run');

    // Unfiltered: all five come back.
    const unfiltered = await apiSemanticSearch(db, new URLSearchParams({ q }), createFakeEmbedder().embed);
    expect(unfiltered.results).toHaveLength(5);

    // Each filter individually excludes its violating row (params go through
    // the real URLSearchParams parsing path).
    const dateFiltered = await apiSemanticSearch(
      db,
      new URLSearchParams({ q, start: '2026-01-01', end: '2026-01-31' }),
      createFakeEmbedder().embed
    );
    expect(dateFiltered.results.map((r) => r.id)).not.toContain(idOf(ids, 'coffee morning walk'));
    expect(dateFiltered.results.map((r) => r.id)).toContain(targetId);

    const categoryFiltered = await apiSemanticSearch(
      db,
      new URLSearchParams({ q, category: 'Dining' }),
      createFakeEmbedder().embed
    );
    expect(categoryFiltered.results.map((r) => r.id)).not.toContain(idOf(ids, 'coffee morning brew'));
    expect(categoryFiltered.results.map((r) => r.id)).toContain(targetId);

    const accountFiltered = await apiSemanticSearch(
      db,
      new URLSearchParams({ q, accountId: '7' }),
      createFakeEmbedder().embed
    );
    expect(accountFiltered.results.map((r) => r.id)).not.toContain(idOf(ids, 'coffee morning jog'));
    expect(accountFiltered.results.map((r) => r.id)).toContain(targetId);

    const entityFiltered = await apiSemanticSearch(
      db,
      new URLSearchParams({ q, entityId: '3' }),
      createFakeEmbedder().embed
    );
    expect(entityFiltered.results.map((r) => r.id)).not.toContain(idOf(ids, 'coffee morning swim'));
    expect(entityFiltered.results.map((r) => r.id)).toContain(targetId);

    // The full filter set returns only the fully matching row.
    const full = await apiSemanticSearch(
      db,
      new URLSearchParams({
        q,
        start: '2026-01-01',
        end: '2026-01-31',
        category: 'Dining',
        accountId: '7',
        entityId: '3',
      }),
      createFakeEmbedder().embed
    );
    expect(full.results.map((r) => r.id)).toEqual([targetId]);
    db.close();
  });

  test('limit is respected (top-k by score)', async () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'coffee morning fix' },
      { description: 'coffee afternoon fix' },
      { description: 'coffee evening fix' },
      { description: 'coffee late fix' },
      { description: 'totally unrelated thing' },
    ]);
    indexAll(db, ids);

    const res = await apiSemanticSearch(
      db,
      new URLSearchParams({ q: 'coffee morning fix', limit: '3' }),
      createFakeEmbedder().embed
    );
    expect(res.results).toHaveLength(3);
    expect(res.results.map((r) => r.id)).not.toContain(idOf(ids, 'totally unrelated thing'));
    for (let i = 1; i < res.results.length; i++) {
      expect(res.results[i - 1].score).toBeGreaterThanOrEqual(res.results[i].score);
    }
    expect(res.results[0].id).toBe(idOf(ids, 'coffee morning fix'));
    db.close();
  });

  test('empty index resolves to a well-formed empty response, not an error', async () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop' },
      { description: 'coffee beans wholesale' },
      { description: 'airline ticket purchase' },
      { description: 'totally unrelated thing' },
    ]);
    // No indexing at all.

    const res = await apiSemanticSearch(
      db,
      new URLSearchParams({ q: 'coffee shops' }),
      createFakeEmbedder().embed
    );
    expect(res.results).toEqual([]);
    expect(res.indexed).toBe(0);
    expect(res.total).toBe(ids.size);
    expect(res.model).toBe(DEFAULT_EMBEDDING_MODEL);
    db.close();
  });

  test('response rows are full transaction rows + score, in ranked order', async () => {
    const db = createTestDb();
    seedFilterParents(db);
    const ids = seed(db, [
      {
        description: 'downtown coffee shop run',
        merchant_name: 'Downtown Coffee',
        amount: -4.5,
        category: 'Dining',
        date: '2026-01-15',
        account_id: 7,
        entity_id: 3,
      },
      { description: 'coffee beans wholesale' },
      { description: 'airline ticket purchase' },
    ]);
    // category_detailed is not an insertTransactions field — set it directly.
    db.prepare('UPDATE transactions SET category_detailed = @v WHERE description = @d')
      .run({ v: 'Coffee Shop', d: 'downtown coffee shop run' });
    indexAll(db, ids);

    const res = await apiSemanticSearch(
      db,
      new URLSearchParams({ q: 'downtown coffee shop' }),
      createFakeEmbedder().embed
    );
    expect(res.results.length).toBe(3);

    const top = res.results[0];
    expect(top.id).toBe(idOf(ids, 'downtown coffee shop run'));
    expect(top.merchant_name).toBe('Downtown Coffee');
    expect(top.description).toBe('downtown coffee shop run');
    expect(top.category).toBe('Dining');
    expect(top.category_detailed).toBe('Coffee Shop');
    expect(top.account_id).toBe(7);
    expect(top.entity_id).toBe(3);
    expect(top.pending).toBe(0);
    expect(top.date).toBe('2026-01-15');
    expect(top.amount).toBeCloseTo(-4.5, 6);
    expect(typeof top.score).toBe('number');

    // Enrichment preserved the dot-product ranking (2 / 1 / 0 shared words).
    expect(res.results.map((r) => r.id)).toEqual([
      idOf(ids, 'downtown coffee shop run'),
      idOf(ids, 'coffee beans wholesale'),
      idOf(ids, 'airline ticket purchase'),
    ]);
    db.close();
  });

  test('coverage counts: indexed lags total until fully indexed, and orphans never inflate it', async () => {
    const db = createTestDb();
    const descriptions = [
      'alpha coffee shop',
      'beta coffee shop',
      'gamma coffee shop',
      'delta unrelated',
      'epsilon unrelated',
      'zeta unrelated',
    ];
    const ids = seed(db, descriptions.map((d) => ({ description: d })));

    // Half indexed → indexed = total/2, and the search response reports it.
    indexDescriptions(db, ids, descriptions.slice(0, 3));
    const partial = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee shop' }), createFakeEmbedder().embed);
    expect(partial.total).toBe(6);
    expect(partial.indexed).toBe(3);
    expect(partial.indexed).toBeLessThan(partial.total);

    // Fully indexed → indexed === total.
    indexDescriptions(db, ids, descriptions.slice(3));
    const full = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee shop' }), createFakeEmbedder().embed);
    expect(full.indexed).toBe(6);
    expect(full.total).toBe(6);

    // Orphan an embedding row by deleting its transaction directly: `indexed`
    // must still count only transactions that exist (total - missing), never
    // the embeddings table (which now holds an orphan).
    db.prepare('DELETE FROM transactions WHERE id = @id').run({ id: idOf(ids, 'alpha coffee shop') });
    const afterOrphan = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee shop' }), createFakeEmbedder().embed);
    expect(afterOrphan.total).toBe(5);
    expect(afterOrphan.indexed).toBe(5);
    expect(afterOrphan.indexed).toBe(afterOrphan.total);
    db.close();
  });

  test('the injected embedder is called exactly once with the query, and its vector drives the search', async () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'target row one' },
      { description: 'target row two' },
      { description: 'unrelated third' },
    ]);
    // Index one row with a fixed vector and one with an unrelated vector.
    const fixed = fakeEmbedText('unique marker words');
    upsertEmbeddings(db, [
      {
        sourceType: 'transaction',
        sourceId: idOf(ids, 'target row one'),
        model: DEFAULT_EMBEDDING_MODEL,
        vec: fixed,
      },
      {
        sourceType: 'transaction',
        sourceId: idOf(ids, 'target row two'),
        model: DEFAULT_EMBEDDING_MODEL,
        vec: fakeEmbedText('completely different content'),
      },
    ]);

    const embedCalls: string[][] = [];
    const embed = async (texts: string[]) => {
      embedCalls.push([...texts]);
      return texts.map(() => fixed);
    };

    const res = await apiSemanticSearch(db, new URLSearchParams({ q: 'anything at all' }), embed);
    expect(embedCalls).toEqual([['anything at all']]);
    // The search used the embedder's returned vector: the row indexed with it
    // ranks first at similarity 1, and top-k search still returns every
    // candidate (there is no score threshold) — so the other row appears with
    // its (zero) score against the fixed vector.
    expect(res.results).toHaveLength(2);
    expect(res.results[0].id).toBe(idOf(ids, 'target row one'));
    expect(res.results[0].score).toBeCloseTo(1, 6);
    expect(res.results[1].id).toBe(idOf(ids, 'target row two'));
    expect(res.results[1].score).toBeCloseTo(dot(fixed, fakeEmbedText('completely different content')), 6);
    db.close();
  });

  test('empty or blank q: no embed call, well-formed response with counts', async () => {
    const db = createTestDb();
    const ids = seed(db, [
      { description: 'downtown coffee shop' },
      { description: 'airline ticket purchase' },
    ]);
    indexAll(db, ids);

    const fake = createFakeEmbedder();
    for (const params of [new URLSearchParams(), new URLSearchParams({ q: '   ' })]) {
      const res: SemanticSearchResponse = await apiSemanticSearch(db, params, fake.embed);
      expect(res.results).toEqual([]);
      expect(res.indexed).toBe(2);
      expect(res.total).toBe(2);
      expect(res.model).toBe(DEFAULT_EMBEDDING_MODEL);
    }
    expect(fake.batchCount).toBe(0);
    db.close();
  });
});