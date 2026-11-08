// @invariant NN-01 NN-10
/**
 * Embed-on-write must never download the embedding model on its own, and must
 * never hold up the write it follows.
 *
 * Breaker finding (embed-lazy): the first dashboard import on a fresh profile
 * blocked 46–105 s while transformers.js fetched ~97 MB from huggingface.co —
 * an outbound request with nothing configured (NN-01) and a write latency
 * failure (NN-10). The model is fetched only by the explicit `wilson --index`
 * command; until it is on disk, writes skip embedding (rows stay for the
 * backfill) and semantic search says it needs the model.
 */
import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import { fakeEmbedText } from './fake-embedder.js';
import { setEmbedOnWriteEmbedder, embedTransactionIds } from '../utils/embed-on-write.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingModelNotDownloadedError,
  embedTexts,
  getEmbeddingPipeline,
  isEmbeddingModelCached,
  semanticSearchTransactions,
} from '../utils/embeddings.js';
import { getCardEmbedder } from '../agent/tool-cards.js';
import { apiImport, apiSemanticSearch, apiUpdateTransaction } from '../dashboard/api.js';

// Restore the plain deterministic fake for every file that runs after this one.
afterAll(() => {
  setEmbedOnWriteEmbedder(async (texts) => texts.map(fakeEmbedText));
});

const modelDir = join(homedir(), '.openaccountant', 'models', DEFAULT_EMBEDDING_MODEL);

function firstId(db: Database): number {
  return (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: number }).id;
}

describe('embed-on-write: no model download unless the model is already local', () => {
  let db: Database;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    rmSync(modelDir, { recursive: true, force: true });
    // The real engine, not the preload fake — this is what production runs.
    setEmbedOnWriteEmbedder(null);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('test: network is off');
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(modelDir, { recursive: true, force: true });
  });

  test('isEmbeddingModelCached reflects the transformers.js file cache layout', () => {
    expect(isEmbeddingModelCached()).toBe(false);
    mkdirSync(join(modelDir, 'onnx'), { recursive: true });
    writeFileSync(join(modelDir, 'onnx', 'model.onnx'), 'FAKE');
    expect(isEmbeddingModelCached()).toBe(true);
  });

  test('an uncached model is skipped: no fetch, rows left for the backfill', async () => {
    const id = firstId(db);
    const result = await embedTransactionIds(db, [id]);
    expect(result).toEqual({ embedded: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('semantic search says it needs the model instead of downloading it', async () => {
    const res = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee' }));
    expect(res.modelReady).toBe(false);
    expect(res.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an injected embedder still runs (tests and the backfill own their model)', async () => {
    const res = await apiSemanticSearch(db, new URLSearchParams({ q: 'coffee' }), async (t) => t.map(fakeEmbedText));
    expect(res.modelReady).toBe(true);
  });
});

describe('local embedding engine: downloads only on an explicit allowDownload', () => {
  let db: Database;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    rmSync(modelDir, { recursive: true, force: true });
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('test: network is off');
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(modelDir, { recursive: true, force: true });
  });

  test('embedTexts refuses an uncached model without a network request', async () => {
    await expect(embedTexts(['coffee'])).rejects.toBeInstanceOf(EmbeddingModelNotDownloadedError);
    await expect(getEmbeddingPipeline()).rejects.toBeInstanceOf(EmbeddingModelNotDownloadedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the error says how to get the model', async () => {
    await expect(embedTexts(['coffee'])).rejects.toThrow(/wilson --index/);
  });

  test('local-model tool selection (getCardEmbedder) never fetches the model', async () => {
    await expect(getCardEmbedder()(['import a bank statement'])).rejects.toBeInstanceOf(
      EmbeddingModelNotDownloadedError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('semanticSearchTransactions never fetches the model', async () => {
    await expect(semanticSearchTransactions(db, 'coffee')).rejects.toBeInstanceOf(
      EmbeddingModelNotDownloadedError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('embed-on-write: never blocks the dashboard write', () => {
  let db: Database;
  let release: () => void = () => {};

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    // An embedder that hangs until released — stands in for a slow model load.
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setEmbedOnWriteEmbedder(async (texts) => {
      await gate;
      return texts.map(fakeEmbedText);
    });
  });

  afterEach(() => release());

  function within<T>(p: Promise<T>, ms = 500): Promise<T | 'timeout'> {
    return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
  }

  test('apiImport returns before embedding finishes', async () => {
    const out = await within(apiImport(db, {
      filename: 'lazy.csv',
      transactions: [{ date: '2026-03-02', description: 'Lazy Coffee', amount: -4.5 }],
    }));
    expect(out).not.toBe('timeout');
    expect((out as { status: string }).status).toBe('imported');
  });

  test('apiUpdateTransaction returns before embedding finishes', async () => {
    const id = firstId(db);
    const out = await within(apiUpdateTransaction(db, id, { description: 'Renamed' }));
    expect(out).toEqual({ success: true, id });
  });
});
