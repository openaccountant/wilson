/**
 * Local embedding engine — the feature-extraction path through the pinned
 * transformers.js machinery (@huggingface/transformers 4.0.1).
 *
 * Runs entirely on-device: inference is in-process ONNX (CPU/WASM backend) and
 * models cache to ~/.openaccountant/models/ — the only network traffic ever
 * involved is the model's one-time download. Per the local-memory design doc,
 * CPU/WASM matches or beats WebGPU on single short strings, so there is no
 * WebGPU dispatch and no adapter check on this path.
 *
 * The DB layer (src/db/embedding-queries.ts) never embeds — vectors in, vectors
 * out — so storage and search are testable without any model.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Database } from '../db/compat-sqlite.js';
import {
  searchTransactionsSemantic,
  type SemanticTransactionFilters,
  type SemanticTransactionResult,
} from '../db/embedding-queries.js';

/**
 * The default local embedding model: 384-dim, Apache-2.0, full quantization
 * lineup, and the model the pinned library's own feature-extraction docs use
 * as the example. Deliberately a swappable constant — the design doc plans for
 * model switches (per-model vectors in the embeddings table + re-index).
 *
 * NOTE: do NOT add this model to the /model chat catalog (PROVIDER_MODELS in
 * src/utils/model.ts). That picker selects the agent's chat model, and an
 * embedding model selected there would be run through the text-generation
 * pipeline. It also does not belong in WEBGPU_MODEL_PATTERNS — this path is
 * CPU/WASM by design.
 */
export const DEFAULT_EMBEDDING_MODEL = 'onnx-community/all-MiniLM-L6-v2-ONNX';

/** Output dimensionality of the default embedding model. */
export const EMBEDDING_DIM = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any;

// Singleton cache: model id → in-flight/loaded pipeline. Keyed by model id so
// an embedding model and a chat model (src/model/providers/transformers.ts
// keeps its own cache) can coexist in one process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const embeddingPipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

/**
 * Get (or create) the feature-extraction pipeline for a model id.
 * The in-flight load is cached, so concurrent callers share one download/load.
 */
export async function getEmbeddingPipeline(
  modelId: string = DEFAULT_EMBEDDING_MODEL
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const cached = embeddingPipelineCache.get(modelId);
  if (cached) return cached;

  const load = (async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    configureTransformersEnv(env);

    // Suppress library console output during load (keeps TUI/headless output
    // clean) — same approach as the text-generation path.
    const noop = () => {};
    const origLog = console.log;
    const origWarn = console.warn;
    const origInfo = console.info;
    console.log = noop;
    console.warn = noop;
    console.info = noop;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pipe: any;
    try {
      // CPU/WASM only. dtype is pinned to fp32: the all-MiniLM-L6-v2-ONNX repo
      // ships fp32/fp16/q4/q4f16 files but no `model_quantized.onnx`, and q8 is
      // also the library's implicit wasm default — requesting it (explicitly or
      // implicitly) fails with "Could not locate file". fp32 is the docs'
      // fallback; dim and behavior are identical to the quantized variants.
      pipe = await pipeline('feature-extraction', modelId, { device: 'cpu', dtype: 'fp32' });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.info = origInfo;
    }
    return pipe;
  })();

  // A failed load must not poison the cache — drop it so a later call can retry.
  load.catch(() => {
    embeddingPipelineCache.delete(modelId);
  });

  embeddingPipelineCache.set(modelId, load);
  return load;
}

/** Point transformers.js at the shared on-device model cache dir. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function configureTransformersEnv(env: any): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env.cacheDir = join(homedir(), '.openaccountant', 'models');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = false;
  }
}

/**
 * L2-normalize a vector (pure — returns a new Float32Array).
 * A zero (or non-finite-norm) vector is returned as-is.
 */
export function normalizeVector(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || !Number.isFinite(norm)) return new Float32Array(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * The single canonical embed-text rule for transactions — merchant_name plus
 * description, joined with a single space. Used by BOTH the backfill and
 * search, so query and document vectors stay comparable.
 */
export function transactionEmbedText(t: {
  merchant_name?: string | null;
  description: string;
}): string {
  return [t.merchant_name, t.description]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
    .trim();
}

/**
 * Embed texts locally with the feature-extraction pipeline
 * (`pooling: 'mean', normalize: true`), returning one L2-normalized
 * Float32Array per input, in input order.
 */
export async function embedTexts(
  texts: string[],
  modelId: string = DEFAULT_EMBEDDING_MODEL
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const extractor = await getEmbeddingPipeline(modelId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output: any = await extractor(texts, { pooling: 'mean', normalize: true });

  const data = output.data as Float32Array;
  const dims = output.dims as number[];
  if (!data || !dims || dims.length !== 2) {
    throw new Error(
      `Unexpected feature-extraction output shape (dims=${JSON.stringify(dims)}); expected [N, dim].`
    );
  }
  const dim = dims[dims.length - 1];
  const n = data.length / dim;
  if (!Number.isInteger(n)) {
    throw new Error(`Feature-extraction output length ${data.length} is not a multiple of dim ${dim}.`);
  }

  const vectors: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    // Slice each row out of the flat [N, dim] tensor, then re-normalize
    // defensively so the unit-norm invariant holds even if pipeline options
    // ever drift from `normalize: true`.
    vectors.push(normalizeVector(data.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

/**
 * Convenience wrapper: embed `queryText` locally, then run the dot-product
 * top-k search in the DB layer (which applies the hard filters as a SQL
 * prefilter). The DB layer itself never embeds.
 */
export async function semanticSearchTransactions(
  db: Database,
  queryText: string,
  filters: SemanticTransactionFilters = {},
  k: number = 10,
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<SemanticTransactionResult[]> {
  const [queryVec] = await embedTexts([queryText], model);
  return searchTransactionsSemantic(db, queryVec, filters, k, model);
}