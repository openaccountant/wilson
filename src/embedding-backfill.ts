/**
 * Local semantic index backfill — the engine behind `wilson --index`.
 *
 * Indexes every existing transaction that is missing an embedding for the
 * active model: batched, resumable, with progress reporting. The model's
 * one-time download is the only network traffic; inference and storage are
 * entirely on-device.
 *
 * Resumability is structural: each upserted row disappears from the
 * missing-embeddings set, so an interrupted run resumes exactly where it
 * stopped and never re-embeds stored rows. Each batch upserts in a single
 * transaction, so an interruption can only ever lose the in-flight batch.
 *
 * Written so a future `wilson memory index` subcommand can wrap
 * runEmbeddingIndex() without changes.
 */

import type { Database } from './db/compat-sqlite.js';
import {
  countMissingTransactionTargets,
  getMissingTransactionTargets,
  upsertEmbeddings,
} from './db/embedding-queries.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  embedTexts,
  transactionEmbedText,
} from './utils/embeddings.js';
import { pullEmbeddingModel } from './utils/model-downloader.js';

export interface EmbeddingIndexOptions {
  db: Database;
  /** Injectable embedder — defaults to the local engine's embedTexts. Tests use a deterministic fake so no model is ever downloaded. */
  embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** Embedding model id — defaults to DEFAULT_EMBEDDING_MODEL. */
  model?: string;
  /** Transactions per batch — default 32 (MiniLM on WASM handles 32 short strings well under a second). */
  batchSize?: number;
  /** Progress 0–100 for the model's one-time download (default embedder path only). */
  onModelDownload?: (pct: number) => void;
  /** Progress after each batch: (rows indexed so far this run, total rows this run targets). */
  onProgress?: (indexed: number, total: number) => void;
}

export interface EmbeddingIndexResult {
  /** Rows embedded by this run. */
  indexed: number;
  /** Rows this run set out to index (the missing count at run start). */
  total: number;
  /** Transactions that already had an embedding for this model. */
  alreadyIndexed: number;
}

/**
 * Index every transaction missing an embedding for `model`.
 * A re-run on a fully indexed database is a no-op: it makes zero embed calls
 * (and never touches the model) and returns immediately.
 */
export async function runEmbeddingIndex(
  opts: EmbeddingIndexOptions
): Promise<EmbeddingIndexResult> {
  const { db } = opts;
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const batchSize = opts.batchSize ?? 32;
  const embed =
    opts.embed ?? ((texts: string[]) => embedTexts(texts, model));

  // ── No-op check ─────────────────────────────────────────────────────────
  const total = countMissingTransactionTargets(db, model);
  if (total === 0) {
    const allTransactions = countTransactions(db);
    return { indexed: 0, total: 0, alreadyIndexed: allTransactions };
  }

  // ── Model availability first (download progress before any batch work) ──
  // Only on the default (local engine) path — an injected embedder manages its
  // own model, so tests with a fake embedder never touch the real one.
  if (!opts.embed) {
    await pullEmbeddingModel(model, opts.onModelDownload);
  }

  // ── Batched backfill ────────────────────────────────────────────────────
  let done = 0;
  for (;;) {
    const targets = getMissingTransactionTargets(db, model, batchSize);
    if (targets.length === 0) break;

    const texts = targets.map((t) => transactionEmbedText(t));
    const vectors = await embed(texts);
    if (vectors.length !== targets.length) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for ${targets.length} texts`
      );
    }

    upsertEmbeddings(
      db,
      targets.map((t, i) => ({
        sourceType: 'transaction' as const,
        sourceId: t.id,
        model,
        vec: vectors[i],
      }))
    );

    done += targets.length;
    opts.onProgress?.(done, total);
  }

  const allTransactions = countTransactions(db);
  return { indexed: done, total, alreadyIndexed: allTransactions - total };
}

function countTransactions(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as {
    count: number;
  };
  return row.count;
}