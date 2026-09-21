import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import { runEmbeddingIndex } from '../embedding-backfill.js';
import { transactionEmbedText, DEFAULT_EMBEDDING_MODEL } from '../utils/embeddings.js';
import { createFakeEmbedder } from './fake-embedder.js';

/** Seed `n` transactions with distinct merchant/description pairs. */
function seedTransactions(db: Database, n: number): Array<{ id: number; merchant_name: string; description: string }> {
  const rows = Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    description: `purchase number ${i}`,
    amount: -10 - i,
    merchant_name: `merchant ${i % 3}`,
  }));
  insertTransactions(db, rows);
  return (db.prepare('SELECT id, merchant_name, description FROM transactions ORDER BY id').all() as Array<{
    id: number;
    merchant_name: string;
    description: string;
  }>);
}

describe('embedding backfill resumability', () => {
  test('an interrupted run resumes without re-embedding already-vectorized rows', async () => {
    const db = createTestDb();
    const txns = seedTransactions(db, 10);

    // ── Run 1: interrupted after 2 successful batches (batch size 2 → 4 rows) ──
    const run1 = createFakeEmbedder({ failAfterBatches: 2 });
    const progress1: Array<[number, number]> = [];
    await expect(
      runEmbeddingIndex({
        db,
        embed: run1.embed,
        batchSize: 2,
        onProgress: (indexed, total) => progress1.push([indexed, total]),
      })
    ).rejects.toThrow('simulated interruption');

    const afterRun1 = db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_type = @sourceType').get({ sourceType: 'transaction' }) as { c: number };
    expect(afterRun1.c).toBe(4);
    expect(progress1).toEqual([[2, 10], [4, 10]]);

    // ── Run 2: fresh embedder finishes the job ────────────────────────────────
    const run2 = createFakeEmbedder();
    const progress2: Array<[number, number]> = [];
    const result2 = await runEmbeddingIndex({
      db,
      embed: run2.embed,
      batchSize: 2,
      onProgress: (indexed, total) => progress2.push([indexed, total]),
    });
    expect(result2).toEqual({ indexed: 6, total: 6, alreadyIndexed: 4, orphaned: 0 });
    expect(progress2).toEqual([[2, 6], [4, 6], [6, 6]]);

    const afterRun2 = db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_type = @sourceType').get({ sourceType: 'transaction' }) as { c: number };
    expect(afterRun2.c).toBe(10);

    // ── No re-embedding: run 1 + run 2 texts have zero overlap ───────────────
    const allTexts = [...run1.calls, ...run2.calls];
    expect(allTexts).toHaveLength(10);
    expect(new Set(allTexts).size).toBe(10);

    // ── Run 3: fully indexed → instant no-op with zero embed calls ───────────
    const run3 = createFakeEmbedder();
    const result3 = await runEmbeddingIndex({ db, embed: run3.embed, batchSize: 2 });
    expect(result3).toEqual({ indexed: 0, total: 0, alreadyIndexed: 10, orphaned: 0 });
    expect(run3.calls).toHaveLength(0);
    expect(run3.batchCount).toBe(0);

    db.close();
  });

  test('texts passed to the embedder follow the transactionEmbedText rule', async () => {
    const db = createTestDb();
    const txns = seedTransactions(db, 4);

    const fake = createFakeEmbedder();
    await runEmbeddingIndex({ db, embed: fake.embed, batchSize: 3 });

    // In id order — the missing-targets query orders by t.id.
    const expected = txns.map((t) => transactionEmbedText({ merchant_name: t.merchant_name, description: t.description }));
    expect(fake.calls).toEqual(expected);

    // Spot-check the rule itself: merchant + description, single space.
    expect(fake.calls[0]).toBe('merchant 0 purchase number 0');

    // And the vectors stored match the fake embedder's output for those texts.
    const stored = db.prepare('SELECT source_id, vec FROM embeddings WHERE source_type = @sourceType ORDER BY source_id').all({ sourceType: 'transaction' }) as Array<{ source_id: number; vec: Uint8Array }>;
    expect(stored).toHaveLength(4);
    db.close();
  });

  test('a fully indexed database is a no-op even for the default (real) path shape', async () => {
    const db = createTestDb();
    seedTransactions(db, 3);

    const fake = createFakeEmbedder();
    await runEmbeddingIndex({ db, embed: fake.embed, batchSize: 2 });
    expect(fake.calls).toHaveLength(3);

    const again = createFakeEmbedder();
    const result = await runEmbeddingIndex({ db, embed: again.embed, batchSize: 2 });
    expect(result).toEqual({ indexed: 0, total: 0, alreadyIndexed: 3, orphaned: 0 });
    expect(again.calls).toHaveLength(0);
    db.close();
  });

  test('orphan sweep: embeddings whose transaction row is gone are reclaimed on every run', async () => {
    const db = createTestDb();
    const txns = seedTransactions(db, 3);

    // Fully index all three rows.
    const first = createFakeEmbedder();
    await runEmbeddingIndex({ db, embed: first.embed, batchSize: 2 });
    const indexedBefore = db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_type = @sourceType').get({ sourceType: 'transaction' }) as { c: number };
    expect(indexedBefore.c).toBe(3);

    // Raw-delete an indexed transaction — bypassing the delete hook — to
    // simulate a future delete path that misses its vector cleanup.
    db.prepare('DELETE FROM transactions WHERE id = @id').run({ id: txns[0].id });

    // A run with nothing missing must still sweep the ghost vector.
    const noop = createFakeEmbedder();
    const result = await runEmbeddingIndex({ db, embed: noop.embed, batchSize: 2 });
    expect(result).toEqual({ indexed: 0, total: 0, alreadyIndexed: 2, orphaned: 1 });
    expect(noop.calls).toHaveLength(0);

    const after = db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE source_type = @sourceType').get({ sourceType: 'transaction' }) as { c: number };
    expect(after.c).toBe(2);

    // A run with missing rows reports the sweep alongside the backfill:
    // raw-delete another indexed transaction (ghost vector) while the last
    // remaining row loses its vector (needs indexing).
    db.prepare('DELETE FROM transactions WHERE id = @id').run({ id: txns[1].id });
    db.prepare("DELETE FROM embeddings WHERE source_type = 'transaction' AND source_id = @id").run({ id: txns[2].id });
    const run = createFakeEmbedder();
    const result2 = await runEmbeddingIndex({ db, embed: run.embed, batchSize: 2 });
    expect(result2.orphaned).toBe(1);
    expect(result2.indexed).toBe(1);
    expect(run.calls).toEqual([transactionEmbedText({ merchant_name: txns[2].merchant_name, description: txns[2].description })]);
    db.close();
  });

  test('defaults: model is DEFAULT_EMBEDDING_MODEL and rows are written under it', async () => {
    const db = createTestDb();
    seedTransactions(db, 2);

    const fake = createFakeEmbedder();
    await runEmbeddingIndex({ db, embed: fake.embed });

    const models = db.prepare('SELECT DISTINCT model FROM embeddings').all() as Array<{ model: string }>;
    expect(models).toEqual([{ model: DEFAULT_EMBEDDING_MODEL }]);
    db.close();
  });
});