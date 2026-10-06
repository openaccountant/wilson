import { EMBEDDING_DIM, normalizeVector } from '../utils/embeddings.js';

/**
 * Deterministic fake embedder for tests — no network, no model, no downloads.
 *
 * Each distinct word is assigned a fixed orthogonal basis vector of
 * EMBEDDING_DIM (first-come index assignment in a module-level map, so a word
 * always maps to the same basis vector within a test file's module instance).
 * A text's embedding is the L2-normalized sum of its words' basis vectors, so
 * word overlap directly controls dot-product similarity — ranking assertions
 * stay readable and deterministic.
 */

const wordIndex = new Map<string, number>();

function basisVectorFor(word: string, index: Map<string, number>): Float32Array {
  let idx = index.get(word);
  if (idx === undefined) {
    idx = index.size % EMBEDDING_DIM;
    index.set(word, idx);
  }
  const v = new Float32Array(EMBEDDING_DIM);
  v[idx] = 1;
  return v;
}

/** Embed one text deterministically: normalized sum of per-word basis vectors. */
export function fakeEmbedText(text: string): Float32Array {
  return embedWith(text, wordIndex);
}

function embedWith(text: string, index: Map<string, number>): Float32Array {
  const sum = new Float32Array(EMBEDDING_DIM);
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const basis = basisVectorFor(word, index);
    for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] += basis[i];
  }
  return normalizeVector(sum);
}

export interface FakeEmbedder {
  /** The injectable embed function (same shape as EmbeddingIndexOptions.embed). */
  embed: (texts: string[]) => Promise<Float32Array[]>;
  /** Every text this embedder has embedded, in request order. */
  calls: string[];
  /** How many batch calls have been made. */
  readonly batchCount: number;
}

export interface FakeEmbedderOptions {
  /** Simulate an interruption: throw once more batch calls than this have been made. */
  failAfterBatches?: number;
  /**
   * Give this embedder its own word -> basis map instead of the shared one.
   * The shared map is process-wide and wraps at EMBEDDING_DIM words, so a test
   * that embeds a big vocabulary (a whole tool registry) pushes later files
   * past 384 words without --isolate and unrelated words start colliding.
   * Not compatible with mixing in fakeEmbedText() vectors.
   */
  isolatedVocabulary?: boolean;
}

export function createFakeEmbedder(opts: FakeEmbedderOptions = {}): FakeEmbedder {
  const calls: string[] = [];
  const index = opts.isolatedVocabulary ? new Map<string, number>() : wordIndex;
  let batches = 0;
  return {
    calls,
    get batchCount() {
      return batches;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      batches++;
      if (opts.failAfterBatches !== undefined && batches > opts.failAfterBatches) {
        throw new Error(
          `FakeEmbedder: simulated interruption after ${opts.failAfterBatches} batches`
        );
      }
      calls.push(...texts);
      return texts.map((t) => embedWith(t, index));
    },
  };
}

// Re-exported so tests can build vectors for direct upsertEmbeddings calls.
export { EMBEDDING_DIM, normalizeVector };