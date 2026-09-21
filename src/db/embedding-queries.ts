import type { Database } from './compat-sqlite.js';
import { DEFAULT_EMBEDDING_MODEL, normalizeVector } from '../utils/embeddings.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Kinds of rows that can carry a semantic embedding (see the embeddings table). */
export type EmbeddingSourceType = 'chat' | 'transaction' | 'memory';

export interface EmbeddingUpsert {
  sourceType: EmbeddingSourceType;
  sourceId: number;
  model: string;
  vec: Float32Array;
}

export interface EmbeddingRow {
  id: number;
  source_type: EmbeddingSourceType;
  source_id: number;
  model: string;
  dim: number;
  vec: Uint8Array;
  created_at: string;
}

/** A transaction that has no embedding yet for a given model (resumability primitive). */
export interface MissingTransactionTarget {
  id: number;
  merchant_name: string | null;
  description: string;
}

/** Hard filters applied as a SQL prefilter before vector scoring. */
export interface SemanticTransactionFilters {
  dateStart?: string;
  dateEnd?: string;
  category?: string;
  accountId?: number;
  entityId?: number;
}

export interface SemanticTransactionResult {
  sourceId: number;
  score: number;
  date: string;
  description: string;
  merchantName: string | null;
  amount: number;
  category: string | null;
}

// ── BLOB codec ───────────────────────────────────────────────────────────────

/**
 * View a Float32Array as the Uint8Array bound as a SQLite BLOB.
 * A view (no copy) over the same buffer — bun:sqlite reads the bytes as-is.
 */
export function vecToBlob(f32: Float32Array): Uint8Array {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Convert a freshly-read BLOB back into a Float32Array.
 * Defensive copy: never assume the byteOffset or alignment of a BLOB handed
 * back by the driver, and never alias driver-owned memory.
 */
export function blobToVec(u8: Uint8Array): Float32Array {
  const out = new Float32Array(u8.byteLength / 4);
  new Uint8Array(out.buffer).set(u8);
  return out;
}

// ── Write path ───────────────────────────────────────────────────────────────

/**
 * Batched idempotent upsert, keyed on (source_type, source_id, model).
 *
 * Every vector is L2-normalized at write (defense in depth — the engine already
 * normalizes, but the storage invariant "vec is unit-norm" must hold regardless
 * of pipeline option drift). Runs in a single transaction so a batch either
 * fully lands or leaves no partial write behind.
 *
 * Returns the number of rows written.
 */
export function upsertEmbeddings(db: Database, rows: EmbeddingUpsert[]): number {
  const stmt = db.prepare(`
    INSERT INTO embeddings (source_type, source_id, model, dim, vec, created_at)
    VALUES (@sourceType, @sourceId, @model, @dim, @vec, datetime('now'))
    ON CONFLICT(source_type, source_id, model) DO UPDATE SET
      model = excluded.model,
      dim = excluded.dim,
      vec = excluded.vec,
      created_at = excluded.created_at
  `);

  const insertMany = db.transaction((items: EmbeddingUpsert[]) => {
    let count = 0;
    for (const row of items) {
      const normalized = normalizeVector(row.vec);
      stmt.run({
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        model: row.model,
        dim: normalized.length,
        vec: vecToBlob(normalized),
      });
      count++;
    }
    return count;
  });

  return insertMany(rows);
}

/**
 * Delete every model-variant embedding for one source row.
 * (Called from deleteTransaction so a deleted transaction never leaves a
 * ghost vector behind.)
 * Returns the number of rows removed.
 */
export function deleteEmbeddings(
  db: Database,
  sourceType: EmbeddingSourceType,
  sourceId: number
): number {
  const result = db.prepare(`
    DELETE FROM embeddings
    WHERE source_type = @sourceType AND source_id = @sourceId
  `).run({ sourceType, sourceId });
  return (result as { changes: number }).changes;
}

/**
 * Delete transaction embeddings whose transaction row no longer exists.
 * Structural safety net for the delete-on-write hook: even if a future delete
 * site misses its vector cleanup, the next `--index` run reclaims the stale
 * vectors so the indexed-vs-total counts stay truthful.
 * Returns the number of rows removed.
 */
export function deleteOrphanedTransactionEmbeddings(db: Database): number {
  const result = db.prepare(`
    DELETE FROM embeddings
    WHERE source_type = 'transaction'
      AND source_id NOT IN (SELECT id FROM transactions)
  `).run();
  return (result as { changes: number }).changes;
}

// ── Resumability primitives ──────────────────────────────────────────────────

/**
 * Transactions with no embedding row for `model`, oldest id first.
 * A row stored under a different model does not satisfy the check — each
 * model's vectors are tracked independently.
 */
export function getMissingTransactionTargets(
  db: Database,
  model: string,
  limit: number
): MissingTransactionTarget[] {
  return db.prepare(`
    SELECT t.id, t.merchant_name, t.description
    FROM transactions t
    LEFT JOIN embeddings e
      ON e.source_type = 'transaction' AND e.source_id = t.id AND e.model = @model
    WHERE e.id IS NULL
    ORDER BY t.id
    LIMIT @limit
  `).all({ model, limit }) as MissingTransactionTarget[];
}

/** How many transactions are still missing an embedding for `model`. */
export function countMissingTransactionTargets(db: Database, model: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM transactions t
    LEFT JOIN embeddings e
      ON e.source_type = 'transaction' AND e.source_id = t.id AND e.model = @model
    WHERE e.id IS NULL
  `).get({ model }) as { count: number };
  return row.count;
}

// ── Search ───────────────────────────────────────────────────────────────────

function dotProduct(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Top-k semantic search over transactions.
 *
 * Hard filters (date range, category, account, entity) are applied as a SQL
 * prefilter; ranking is a brute-force dot product over the surviving candidates
 * in TypeScript. sqlite-vec is deliberately deferred (see
 * docs/plans/2026-07-01-002-encryption-pivot-and-local-memory-design.md) —
 * brute force is fine at ≤100k vectors.
 *
 * Both the query vector and the stored vectors are L2-normalized, so the dot
 * product equals cosine similarity. Ties break on ascending source_id for
 * deterministic ordering. This layer never embeds — vectors in, vectors out.
 */
export function searchTransactionsSemantic(
  db: Database,
  queryVec: Float32Array,
  filters: SemanticTransactionFilters = {},
  k: number = 10,
  model: string = DEFAULT_EMBEDDING_MODEL
): SemanticTransactionResult[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { model };

  if (filters.dateStart) {
    conditions.push('t.date >= @dateStart');
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push('t.date <= @dateEnd');
    params.dateEnd = filters.dateEnd;
  }
  if (filters.category) {
    conditions.push('t.category = @category');
    params.category = filters.category;
  }
  if (filters.accountId !== undefined) {
    conditions.push('t.account_id = @accountId');
    params.accountId = filters.accountId;
  }
  if (filters.entityId !== undefined) {
    conditions.push('t.entity_id = @entityId');
    params.entityId = filters.entityId;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT t.id AS source_id, t.date, t.description, t.merchant_name, t.amount, t.category, e.vec
    FROM transactions t
    JOIN embeddings e
      ON e.source_type = 'transaction' AND e.source_id = t.id AND e.model = @model
    ${where}
  `).all(params) as Array<{
    source_id: number;
    date: string;
    description: string;
    merchant_name: string | null;
    amount: number;
    category: string | null;
    vec: Uint8Array;
  }>;

  const scored = rows.map((row) => ({
    sourceId: row.source_id,
    score: dotProduct(queryVec, blobToVec(row.vec)),
    date: row.date,
    description: row.description,
    merchantName: row.merchant_name,
    amount: row.amount,
    category: row.category,
  }));

  scored.sort((a, b) => (b.score - a.score) || (a.sourceId - b.sourceId));
  return scored.slice(0, k);
}