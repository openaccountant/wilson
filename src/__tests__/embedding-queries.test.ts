import { describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import {
  blobToVec,
  deleteEmbeddings,
  getMissingTransactionTargets,
  upsertEmbeddings,
  vecToBlob,
  type EmbeddingUpsert,
} from '../db/embedding-queries.js';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIM } from '../utils/embeddings.js';
import { EMBEDDING_DIM as FAKE_DIM, fakeEmbedText } from './fake-embedder.js';

function upsert(db: Database, row: Omit<EmbeddingUpsert, 'model'> & { model?: string }) {
  return upsertEmbeddings(db, [{ ...row, model: row.model ?? DEFAULT_EMBEDDING_MODEL }]);
}

function readVec(db: Database, sourceId: number, model = DEFAULT_EMBEDDING_MODEL): { dim: number; vec: Float32Array } {
  const row = db
    .prepare(
      'SELECT dim, vec FROM embeddings WHERE source_type = @sourceType AND source_id = @sourceId AND model = @model'
    )
    .get({ sourceType: 'transaction', sourceId, model }) as { dim: number; vec: Uint8Array };
  expect(row).toBeDefined();
  return { dim: row.dim, vec: blobToVec(row.vec) };
}

function norm(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  return Math.sqrt(sumSq);
}

describe('embeddings write path', () => {
  test('upsert stores an L2-normalized vector even when handed an unnormalized one', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-01-05', description: 'Coffee shop', amount: -4.5 }]);

    // Deliberately unnormalized: a legit unit vector scaled by 5 (norm 5).
    const unnormalized = fakeEmbedText('Coffee shop').map((x) => x * 5);

    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: unnormalized });

    const stored = readVec(db, 1);
    expect(stored.dim).toBe(FAKE_DIM);
    expect(norm(stored.vec)).toBeCloseTo(1, 6);
    db.close();
  });

  test('upsert is idempotent per (source_type, source_id, model)', () => {
    const db = createTestDb();
    insertTransactions(db, [{ date: '2026-01-05', description: 'Hardware store', amount: -30 }]);

    const first = fakeEmbedText('Hardware store');
    const second = fakeEmbedText('Hardware store paint');

    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: first });
    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: second });

    const rows = db
      .prepare(
        "SELECT COUNT(*) AS c FROM embeddings WHERE source_type = 'transaction' AND source_id = 1 AND model = @model"
      )
      .get({ model: DEFAULT_EMBEDDING_MODEL }) as { c: number };
    expect(rows.c).toBe(1);

    // The surviving row holds the second write.
    const stored = readVec(db, 1);
    const expected = fakeEmbedText('Hardware store paint');
    expect(stored.vec.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(stored.vec[i]).toBeCloseTo(expected[i], 6);
    }
    db.close();
  });

  test('BLOB round-trip preserves every float exactly', () => {
    const v = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      // Deterministic spread of magnitudes, signs, tiny and large values.
      v[i] = ((i % 13) - 6) * Math.pow(10, (i % 7) - 3);
    }
    const back = blobToVec(vecToBlob(v));
    expect(back.length).toBe(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      expect(Object.is(back[i], v[i])).toBe(true);
    }
  });

  test('deleteEmbeddings removes all model-variants for one source row and leaves others', () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-01-05', description: 'Alpha', amount: -1 },
      { date: '2026-01-06', description: 'Beta', amount: -2 },
    ]);

    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: fakeEmbedText('Alpha'), model: 'model-a' });
    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: fakeEmbedText('Alpha'), model: 'model-b' });
    upsert(db, { sourceType: 'transaction', sourceId: 2, vec: fakeEmbedText('Beta'), model: 'model-a' });
    upsert(db, { sourceType: 'chat', sourceId: 1, vec: fakeEmbedText('Alpha'), model: 'model-a' });

    const removed = deleteEmbeddings(db, 'transaction', 1);
    expect(removed).toBe(2);

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
    expect(remaining.c).toBe(2);

    const txn2 = db
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE source_type = 'transaction' AND source_id = 2")
      .get() as { c: number };
    expect(txn2.c).toBe(1);
    const chat1 = db
      .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE source_type = 'chat' AND source_id = 1")
      .get() as { c: number };
    expect(chat1.c).toBe(1);
    db.close();
  });

  test('getMissingTransactionTargets returns exactly the transactions missing a row for the given model', () => {
    const db = createTestDb();
    insertTransactions(db, [
      { date: '2026-01-05', description: 'Alpha', amount: -1 },
      { date: '2026-01-06', description: 'Beta', amount: -2 },
      { date: '2026-01-07', description: 'Gamma', amount: -3 },
    ]);

    // All three missing for model-a.
    let missing = getMissingTransactionTargets(db, 'model-a', 10);
    expect(missing.map((t) => t.id)).toEqual([1, 2, 3]);

    // model-b has no rows at all, so transaction 1 is still missing for it —
    // a different-model row does not satisfy the missing check.
    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: fakeEmbedText('Alpha'), model: 'model-a' });
    missing = getMissingTransactionTargets(db, 'model-b', 10);
    expect(missing.map((t) => t.id)).toEqual([1, 2, 3]);

    // model-a now only misses 2 and 3; limit truncates.
    missing = getMissingTransactionTargets(db, 'model-a', 10);
    expect(missing.map((t) => t.id)).toEqual([2, 3]);
    missing = getMissingTransactionTargets(db, 'model-a', 1);
    expect(missing.map((t) => t.id)).toEqual([2]);

    // After embedding model-b for transaction 1, model-b misses only 2, 3.
    upsert(db, { sourceType: 'transaction', sourceId: 1, vec: fakeEmbedText('Alpha'), model: 'model-b' });
    missing = getMissingTransactionTargets(db, 'model-b', 10);
    expect(missing.map((t) => t.id)).toEqual([2, 3]);
    db.close();
  });
});