# Plan: Local embedding engine, embeddings store, and batched backfill (issue #61)

Parent: #51 (local semantic memory, Track B of `docs/plans/2026-07-01-002-encryption-pivot-and-local-memory-design.md`).
Slice outcome: a user running the new local index command watches every existing transaction in their library get a locally-computed semantic embedding stored in their profile database — with the model's one-time download and per-batch progress visible — and nothing but that model download ever leaves the machine.

## Context (verified in repo)

- transformers.js machinery already exists and is pinned exactly: `@huggingface/transformers` `4.0.1` in `package.json` (exact pin, no range — `transformers-webgpu-ep.test.ts` asserts installed == pinned; **do not bump**). Models cache to `~/.openaccountant/models/` (`src/model/providers/transformers.ts` `cacheDir`, also set in `pullTransformersModel` in `src/utils/model-downloader.ts`).
- Only a `text-generation` pipeline path exists today (`src/model/providers/transformers.ts` `getOrCreatePipeline`, and `pullTransformersModel`). There is no `feature-extraction` usage anywhere — we add the first one.
- Migrations: registry in `src/db/migrations.ts`, SQL constants in `src/db/schema.ts`. Versions 1–22 taken; **version 22 = `add_goal_target_percent`**. Precedent: migration-only columns (v21 `ENTITY_ID_COLUMNS`, v22) live only in the migration, never re-declared in CREATE statements.
- DB access is `src/db/compat-sqlite.ts` (better-sqlite3-style wrapper over `bun:sqlite`; `@param` → `$param` rewritten automatically). `bun:sqlite` binds `Uint8Array` as BLOB and reads BLOBs back as `Uint8Array`.
- Query-layer naming convention: `src/db/memory-queries.ts`, `src/db/entity-queries.ts` — so the embeddings query module is `src/db/embedding-queries.ts`.
- Headless flag commands live at src root wired in `src/index.tsx` (`--sync` → `src/sync.ts` `runSync()`, `--export` → `runExport()`). Tests use `src/__tests__/helpers.ts` `createTestDb()` (in-memory DB, migrations run).
- Chat model catalog: `src/utils/model.ts` `PROVIDER_MODELS` — feeding it an embedding model would push it through the text-generation pipeline. **The embedding model must NOT be added there.**

## Model decision

`onnx-community/all-MiniLM-L6-v2-ONNX` — 384-dim, Apache-2.0, full quantization lineup, and the model the pinned library's own `feature-extraction` docs use as the example. The design doc's primary candidate `ibm-granite/granite-embedding-small-english-r2` ships no ONNX weights and cannot be loaded by transformers.js (verified against the HF Hub API). The design doc deliberately plans for model switches (per-model vectors + `model` column + re-index), so this is a swappable constant, not a hardcode.

## Files to create / modify

### 1. `src/db/schema.ts` — add constants (no changes to existing ones)

```ts
export const EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK(source_type IN ('chat','transaction','memory')),
  source_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, model)
);
`;

export const EMBEDDINGS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
`;
```

- `vec` holds a serialized L2-normalized `Float32Array`. `dim` is recorded per row so a future model switch is diagnosable.
- No FK to transactions (embeddings outlive row deletes via the explicit delete hook; keeps the table generic over source types, per the design doc).

### 2. `src/db/migrations.ts` — migration 23

Import `EMBEDDINGS_TABLE` and `EMBEDDINGS_INDEXES`, append:

```ts
{ version: 23, name: 'create_embeddings', up: EMBEDDINGS_TABLE + EMBEDDINGS_INDEXES },
```

Fresh installs run all migrations in order (existing runner test enforces this); existing DBs get only v23. No `ALTER TABLE` anywhere — no v22-style duplicate-column trap.

### 3. `src/utils/embeddings.ts` (new) — the local embedding engine

- `export const DEFAULT_EMBEDDING_MODEL = 'onnx-community/all-MiniLM-L6-v2-ONNX';` — single swappable constant.
- `export const EMBEDDING_DIM = 384;`
- `getEmbeddingPipeline(modelId = DEFAULT_EMBEDDING_MODEL)` — singleton per model id (same pattern as `pipelineCache` in `src/model/providers/transformers.ts`): sets `env.cacheDir = join(homedir(), '.openaccountant', 'models')` and `env.backends.onnx.wasm.proxy = false` (identical to the existing setup), then `pipeline('feature-extraction', modelId, { device: 'cpu', dtype: 'q8' })`. CPU/WASM only — per the pre-agreed design doc, WASM matches/beats WebGPU on single short strings; no WebGPU dispatch, no `checkWebGpuAvailable`, no `WEBGPU_MODEL_PATTERNS` involvement. Suppress `console.log/warn/info` around pipeline creation like the text-gen path does (keeps TUI output clean).
- `embedTexts(texts: string[], modelId?)` → `Promise<Float32Array[]>` — calls the pipeline with `{ pooling: 'mean', normalize: true }`, slices each row out of the returned tensor into its own `Float32Array`, then **re-normalizes each vector defensively** (see `normalizeVector`) so unit norm is guaranteed even if pipeline options drift.
- `normalizeVector(v: Float32Array): Float32Array` — pure helper; divides by L2 norm (zero vector returned as-is).
- `transactionEmbedText(t: { merchant_name?: string | null; description: string }): string` — `[t.merchant_name, t.description].filter(Boolean).join(' ')` trimmed; the single canonical embed-text rule (merchant_name + description) used by BOTH backfill and search, so vectors stay comparable.
- `semanticSearchTransactions(db, queryText, filters, k, model?)` — thin convenience wrapper: embeds `queryText` via `embedTexts([queryText])` then delegates to `searchTransactionsSemantic` in the DB layer. (The DB layer itself never embeds — see below.)

Text-generation pipeline path untouched: no edits to `src/model/providers/transformers.ts`.

### 4. `src/utils/model-downloader.ts` — feature-extraction twin of the pre-download helper

Add `pullEmbeddingModel(modelId = DEFAULT_EMBEDDING_MODEL, onProgress?: (pct: number) => void)`. Copy of `pullTransformersModel` with two deltas: `pipeline('feature-extraction', modelId, { device: 'cpu', dtype: 'q8', progress_callback })` and dtype/option parity with the engine. Extract the duplicated env setup (`cacheDir`, `wasm.proxy = false`) into a small private `configureTransformersEnv()` used by both helpers so the cache dir stays defined in exactly one place. The existing `pullTransformersModel` keeps its signature and behavior — no chat-model regressions.

### 5. `src/db/embedding-queries.ts` (new) — storage + search query layer

BLOB codec (private helpers): `vecToBlob(f32: Float32Array): Uint8Array` (view over the same buffer) and `blobToVec(u8: Uint8Array): Float32Array` (defensive copy — `new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength).buffer, 0, u8.byteLength / 4)` — never assume byteOffset/alignment of a freshly-read BLOB).

API (all take `db: Database` first, matching the other `*-queries.ts` modules; **none of them embed** — vectors in, vectors out — so every function is testable with a fake embedder or no embedder at all):

- `upsertEmbeddings(db, rows: EmbeddingUpsert[])` where `EmbeddingUpsert = { sourceType: 'chat'|'transaction'|'memory'; sourceId: number; model: string; vec: Float32Array }`. Normalizes each vec at write (defense in depth), stores `dim = vec.length`, wraps `INSERT ... ON CONFLICT(source_type, source_id, model) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec, created_at=excluded.created_at` in a single prepared statement inside `db.transaction()` (see `insertTransactions` in `queries.ts` for the pattern). Idempotent: same inputs → same single row.
- `deleteEmbeddings(db, sourceType, sourceId)` — removes all model-variants for that source row (call sites for transaction deletion come in a later slice; the primitive ships now).
- `getMissingTransactionTargets(db, model, limit)` — resumability primitive:
  ```sql
  SELECT t.id, t.merchant_name, t.description
  FROM transactions t
  LEFT JOIN embeddings e
    ON e.source_type = 'transaction' AND e.source_id = t.id AND e.model = @model
  WHERE e.id IS NULL
  ORDER BY t.id
  LIMIT @limit
  ```
- `countMissingTransactionTargets(db, model)` — same LEFT JOIN, `SELECT COUNT(*)`; drives progress totals.
- `searchTransactionsSemantic(db, queryVec: Float32Array, filters: SemanticTransactionFilters, k: number, model = DEFAULT_EMBEDDING_MODEL)` — hard filters as **SQL prefilter** (mirroring `getTransactions` in `queries.ts`): `dateStart`/`dateEnd` (`date >= @dateStart` / `date <= @dateEnd`), `category` (`category = @category`), `accountId` (`account_id = @accountId`), `entityId` (`entity_id = @entityId`), joined to embeddings for the model:
  ```sql
  SELECT t.id AS source_id, t.date, t.description, t.merchant_name, t.amount, t.category, e.vec
  FROM transactions t
  JOIN embeddings e ON e.source_type = 'transaction' AND e.source_id = t.id AND e.model = @model
  [WHERE hard filters]
  ```
  Then in TypeScript: dot product `queryVec · blobToVec(row.vec)` for each candidate (query vectors are normalized by the engine; stored vectors are normalized at write, so dot product == cosine), sort score descending with tie-break on `source_id` ascending for determinism, `slice(0, k)`. Returns `{ sourceId, score, date, description, merchantName, amount, category }[]`. sqlite-vec is deliberately deferred (brute force is fine at ≤100k vectors per the design doc) — add a code comment saying so.
- `searchMemorySemantic` / chat-source search: **out of scope for this slice** — the table and source_type union exist so later slices extend without migration.

### 6. `src/embedding-backfill.ts` (new, src root — sibling of `src/sync.ts`) — the backfill runner

```ts
export interface EmbeddingIndexOptions {
  db: Database;
  embed?: (texts: string[]) => Promise<Float32Array[]>; // injectable; default: local engine's embedTexts
  model?: string;                                       // default: DEFAULT_EMBEDDING_MODEL
  batchSize?: number;                                   // default: 32
  onModelDownload?: (pct: number) => void;
  onProgress?: (indexed: number, total: number) => void;
}
export async function runEmbeddingIndex(opts): Promise<{ indexed: number; total: number; alreadyIndexed: number }>
```

Algorithm:
1. `total = countMissingTransactionTargets(db, model)`; if 0 → return immediately (no-op; the CLI prints "All N transactions already indexed" — re-run on a fully indexed DB completes instantly with zero embed calls).
2. Model download progress first: before the first batch, ensure the model is available with download progress — `pullEmbeddingModel(model, onModelDownload)`. When the model is already cached this resolves without network traffic (transformers.js resolves from the cache dir).
3. Batch loop: `getMissingTransactionTargets(db, model, batchSize)` → build texts via `transactionEmbedText` → `embed(texts)` → `upsertEmbeddings` (single transaction per batch, so an interruption can only ever lose the in-flight batch, never corrupt a partial write) → `onProgress(done, total)` → repeat until the fetch returns nothing. `done` accumulates; because each upserted row disappears from the missing set, **resumability is structural**: an interrupted run resumes exactly where it stopped and never re-embeds stored rows.
4. Return counts. Batch size 32: MiniLM on WASM handles 32 short strings in well under a second.

The injectable `embed` is what makes the resumability test possible without downloading the real model.

### 7. `src/index.tsx` — wire the `wilson --index` command

Follow the `--sync` pattern exactly: `else if (args.includes('--index')) { const { runEmbeddingIndex } = await import('./embedding-backfill.js'); ... }` with `initDatabase()` inside the backfill command path (same as `runSync` does), plain console progress (headless flag commands don't use the TUI — matches `--sync`): download lines 0–100%, then one in-place-updated progress line per batch (`\rIndexing 64/1204 (5%)`), final newline + summary (`Indexed 1204 transactions · model onnx-community/all-MiniLM-L6-v2-ONNX · dim 384`). Update the `--help` text list. Naming note: the design doc's eventual surface is `wilson memory index`; `runEmbeddingIndex()` is written so a future subcommand can wrap it without changes.

### 8. Docs

- `README.md`: add `wilson --index` to the command list with a one-line description (local semantic index — runs entirely on-device).
- `CHANGELOG.md`: entry under `## [Unreleased]` → `### Features`, in the existing style, referencing issue #61.

## Tests (all in `src/__tests__/`, using `createTestDb()` from `helpers.ts`)

Fake embedder (shared helper defined in the tests, e.g. in `embedding-search.test.ts` and imported by the others): deterministic, no network, no model. Vocabulary→orthogonal-basis scheme: map each word to a fixed basis vector of `EMBEDDING_DIM` (word hash → index), `embed(text) = normalizeVector(sum of basis vectors for its words)`. Word overlap then directly controls dot-product similarity, making ranking assertions readable and deterministic. Log every text it embeds so tests can assert what was (and wasn't) embedded.

1. **`embedding-queries.test.ts`** — write path:
   - upsert writes L2-normalized vectors: insert a deliberately unnormalized vec, read the BLOB back, assert `‖v‖₂ ≈ 1` and `dim` column == 384 (or the vec length).
   - upsert is idempotent per (source_type, source_id, model): upsert twice with different vecs → still exactly one row for the triple, vec equals the second write.
   - BLOB round-trip: values survive `vecToBlob`/`blobToVec` exactly (all 384 floats bit-identical).
   - `deleteEmbeddings` removes all variants for (source_type, source_id) and leaves other rows alone.
   - `getMissingTransactionTargets` returns exactly the transactions with no row for the given model, and stops returning them after upsert (a different-model row does not satisfy the missing check).
2. **`embedding-search.test.ts`** — with the fake embedder:
   - ranking order matches dot-product order: seed transactions whose texts share 2 / 1 / 0 words with the query; assert scores strictly decreasing in that order.
   - hard filters actually prefilter: date range, `accountId`, `category` each exclude seeded rows that would otherwise rank high (assert both on results and, once, by checking the returned candidate set changes when the filter is dropped).
   - limit `k` respected: more matching rows than k → exactly k results, top-k by score.
   - determinism tie-break: two identical-score rows return in ascending id order.
   - rows from a different `model` never leak into results.
3. **`migrations.test.ts`** (extend the existing file) — migration 23:
   - after `runMigrations`, `embeddings` exists in `sqlite_master` with the expected columns.
   - UNIQUE constraint rejects a duplicate (source_type, source_id, model) — raw `INSERT` twice expects a constraint error.
   - fresh-install ordering is already enforced by the existing "all migrations run" test (now MIGRATIONS.length = 23); assert `getSchemaVersion(db) === MIGRATIONS.length` still holds implicitly via that test.
4. **`embedding-backfill.test.ts`** — resumability (the acceptance-critical one), with a fake embedder + in-memory DB seeded with N transactions (e.g. 10, batch size 2 → 5 batches):
   - run with an `embed` that throws after 2 successful batches → error propagates; DB holds exactly 4 embedded rows.
   - re-run with a fresh fake embedder → completes; total embedded == N.
   - **no re-embedding**: the union of texts requested by run 1 and run 2 contains no duplicates (assert on the two call logs).
   - no-op: a third full run makes zero `embed` calls and returns `{ indexed: 0 }`.
   - embed-text rule: assert the texts passed to the fake embedder equal `transactionEmbedText` output (merchant + description, single space).

## Verification

1. `bun run typecheck` — clean.
2. `bun test` — all pass, including the unchanged `webgpu-model-path.test.ts` and `transformers-webgpu-ep.test.ts`.
3. Manual check (needs network once, for the ~23–90MB model download):
   - On a profile with transactions: `bun run src/index.tsx --index` — model download shows progress first, then per-batch progress.
   - `sqlite3`/bun one-liner: `SELECT COUNT(*) FROM embeddings WHERE source_type='transaction'` equals the transaction count.
   - Re-run the command → completes instantly as a no-op ("All N transactions already indexed").
   - Unplug the network after the model is cached → indexing still works end-to-end (delete a few embedding rows to force work, re-run).
4. Confirm nothing but the model download leaves the machine: no other `fetch` in the new code paths (embedding inference is in-process ONNX; storage is the local profile DB).

## Do NOT touch

- `package.json` / `bun.lock` — the exact `4.0.1` pin and `onnxruntime-node` lockfile resolution are asserted by `transformers-webgpu-ep.test.ts`; no dependency bump, no new deps (sqlite-vec deliberately deferred).
- `src/utils/model.ts` `PROVIDER_MODELS` — no embedding-model entry in the `/model` chat catalog (that picker selects the agent's chat model; an embedding model selected there would run a text-generation pipeline against it). No new `webgpu`-tagged entries anywhere.
- `src/model/providers/transformers.ts` text-generation path and both webgpu test files — must pass unchanged.
- Migrations 1–22 and the CREATE-vs-ALTER precedent (v22 note in `schema.ts`).

## Non-goals (later slices of #51)

Embed-on-write hooks, `search_memory` agent tool, chat/memory source indexing, semantic relevance-selection swap, Ollama/OpenAI embedding providers (this slice is local-only by design — "nothing but that model download ever leaves the machine"), sqlite-vec, MCP exposure.

## Risks / notes for the builder

- transformers.js `feature-extraction` with `normalize: true` returns unit-norm rows already; we still re-normalize at write so the storage-layer invariant ("vec BLOB is L2-normalized") holds regardless of pipeline option drift — that's why the test asserts on the stored BLOB, not on pipeline output.
- Batched `extractor(texts, ...)` returns a `[N, dim]` tensor; slice rows off `output.data` using `output.dims` — verify dims order (`[N, dim]` for string-array input) on first integration.
- `dtype: 'q8'` for MiniLM is the library docs' recommended quantized option (~23MB) and keeps WASM fast; if integration shows any issue, dropping the explicit dtype (fp32 default, ~90MB) is the fallback — dim and behavior are identical.
- First `feature-extraction` import also loads `onnxruntime-node` in the same process as any text-generation pipeline — no known conflict (both go through the same module), but keep the embedding pipeline in its own singleton cache keyed by model id so chat and embedding models can coexist.
- The `--index` command calls `initDatabase()` itself (like `runSync`), so it works both standalone and under cron; no license gate — this is a local, free feature consistent with the privacy story.