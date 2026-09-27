/**
 * Embed-on-write — keep the semantic index fresh at the moment data changes.
 *
 * Every path that inserts, text-edits, or deletes a transaction fires the
 * matching hook here, so semantic search reflects an import/sync/edit/delete
 * immediately — without the user ever running `wilson --index`:
 *
 *   - inserts: awaited after each bulk insert (CSV/OFX/QIF, Monarch, Firefly
 *     via insertTransactions; Plaid and Coinbase via their own sync loops)
 *   - updates: awaited when a transaction's embed text (merchant_name /
 *     description) changes — manual edits and Plaid pending→posted
 *   - deletes: `deleteTransaction` drops the stored vectors synchronously
 *     (storage maintenance, not embedding — lives in db/queries.ts)
 *
 * Degrade, never error: an embedding failure (missing model, failed download,
 * inference error) is logged and the affected rows are simply left for the
 * next backfill run — an import or edit must never fail because of the
 * index. Search coverage stays truthful via the indexed-vs-total counts
 * (`countMissingTransactionTargets`).
 *
 * Like the backfill (src/embedding-backfill.ts), the DB layer is never
 * touched by the model: ids go in, vectors come out of the embedder and are
 * stored by `upsertEmbeddings`. The DB is the source of truth for the embed
 * text — rows are re-selected by id, so the same helper covers inserts and
 * text refreshes (upsert-overwrite = refresh).
 */

import type { Database } from '../db/compat-sqlite.js';
import { upsertEmbeddings } from '../db/embedding-queries.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  embedTexts,
  transactionEmbedText,
} from './embeddings.js';
import { logger } from './logger.js';

/** Same shape as EmbeddingIndexOptions.embed — tests inject a deterministic fake. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbedOnWriteOptions {
  /** Explicit injection wins; else the module override; else the real local engine. */
  embed?: EmbedFn;
  /** Embedding model id — defaults to DEFAULT_EMBEDDING_MODEL. */
  model?: string;
  /** Rows per embed call — default 32 (same as the backfill). */
  batchSize?: number;
}

export interface EmbedOnWriteResult {
  /** Rows actually upserted by this call. */
  embedded: number;
  /** Rows left for the next `--index` backfill run. */
  failed: number;
}

const DEFAULT_BATCH_SIZE = 32;
/** Rows per id re-select round trip (SQL `IN` list size). */
const SELECT_CHUNK = 500;

/** Test/DI seam. null = use the real local engine. */
let overrideEmbed: EmbedFn | null = null;

export function setEmbedOnWriteEmbedder(embed: EmbedFn | null): void {
  overrideEmbed = embed;
}

/**
 * Embed the current (merchant_name, description) of the given transaction ids
 * and upsert the vectors under `model`. NEVER throws — an embedding failure is
 * logged ('embed:on-write:failed') and the not-yet-embedded rows are left for
 * the next backfill run. Rows that vanished between insert and embed are
 * simply skipped.
 */
export async function embedTransactionIds(
  db: Database,
  ids: number[],
  opts: EmbedOnWriteOptions = {}
): Promise<EmbedOnWriteResult> {
  // Dedupe (callers may hand us an id twice, e.g. insert + refresh sweeps).
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return { embedded: 0, failed: 0 }; // never touches a model
  }

  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const embed =
    opts.embed ?? overrideEmbed ?? ((texts: string[]) => embedTexts(texts, model));

  try {
    // Re-select the rows' current embed text — the DB is the source of truth,
    // so this single path covers fresh inserts and text-editing refreshes.
    const rows: Array<{ id: number; merchant_name: string | null; description: string }> = [];
    for (let start = 0; start < unique.length; start += SELECT_CHUNK) {
      const chunk = unique.slice(start, start + SELECT_CHUNK);
      const params: Record<string, unknown> = {};
      const marks = chunk.map((id, i) => {
        params[`id${i}`] = id;
        return `@id${i}`;
      });
      const found = db
        .prepare(
          `SELECT id, merchant_name, description FROM transactions WHERE id IN (${marks.join(', ')}) ORDER BY id`
        )
        .all(params) as Array<{ id: number; merchant_name: string | null; description: string }>;
      rows.push(...found);
    }

    if (rows.length === 0) {
      return { embedded: 0, failed: 0 };
    }

    let embedded = 0;
    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize);
      try {
        const texts = batch.map((r) => transactionEmbedText(r));
        const vectors = await embed(texts);
        if (vectors.length !== batch.length) {
          throw new Error(
            `Embedder returned ${vectors.length} vectors for ${batch.length} texts`
          );
        }
        upsertEmbeddings(
          db,
          batch.map((r, i) => ({
            sourceType: 'transaction' as const,
            sourceId: r.id,
            model,
            vec: vectors[i],
          }))
        );
        embedded += batch.length;
      } catch (err) {
        // First failed batch stops the sweep — a broken model fails every
        // batch, so don't burn time. Remaining rows stay for the backfill.
        const failed = rows.length - embedded;
        logger.warn('embed:on-write:failed', {
          model,
          embedded,
          failed,
          reason: err instanceof Error ? err.message : String(err),
        });
        return { embedded, failed };
      }
    }

    return { embedded, failed: 0 };
  } catch (err) {
    // The id re-select (or anything unexpected) — same degrade contract.
    logger.warn('embed:on-write:failed', {
      model,
      embedded: 0,
      failed: unique.length,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { embedded: 0, failed: unique.length };
  }
}