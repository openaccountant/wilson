# Plan: Semantic search box in the dashboard Transactions view (issue #62)

Parent: #51 (local semantic memory). Decomposed slice outcome: a dashboard user types a natural phrase like "coffee shops" into the Transactions search, and — because no description contains that substring — the UI fetches semantic matches from the dashboard server, which embeds the query with the local on-device engine, prefilters candidates with the same SQL filters the transactions endpoint accepts, ranks by dot product, and returns transactions with visible similarity scores. Substring search behavior is unchanged whenever it produces matches, and the UI shows a one-line coverage hint (naming `wilson --index`) whenever indexed vectors lag the transaction count.

**Blocker #61 is already satisfied in this worktree** — commit `64a4763` shipped the local embedding engine, the embeddings store, and the batched backfill. Every primitive this slice needs exists and is tested; there is **no new migration, no schema change, and no embedding-machinery work** here. This slice is: one endpoint + one UI fallback behavior + docs.

## Context (verified in repo)

- Search primitive, ready to call: `semanticSearchTransactions(db, queryText, filters, k, model)` in `src/utils/embeddings.ts` — embeds the query via the on-device `feature-extraction` pipeline (singleton, CPU/WASM, fp32, model cache `~/.openaccountant/models/`) and delegates to the DB layer. The lower-level `searchTransactionsSemantic(db, queryVec, filters, k, model)` in `src/db/embedding-queries.ts` applies `dateStart/dateEnd/category/accountId/entityId` as a SQL prefilter, scores with a dot product (both sides L2-normalized → cosine similarity in [-1, 1]), ties break on ascending `source_id`, slices to `k`. It returns `{ sourceId, score, date, description, merchantName, amount, category }` — **not** the full transaction row the UI renders.
- Coverage primitive: `countMissingTransactionTargets(db, model)` in `src/db/embedding-queries.ts` — count of transactions with no embedding row for a model. `indexed = total - missing` stays consistent even with orphaned embedding rows from deleted transactions (no deletion hook yet — later slice per #61).
- Dashboard API layer: `src/dashboard/api.ts` — plain functions `(db, params: URLSearchParams) => data`, e.g. `apiTransactions` parses `start/end/category/merchant/accountId/entityId/limit`. Tests call these functions directly with `createTestDb()` (`src/__tests__/dashboard-api.test.ts` is the pattern).
- Dashboard routes: `src/dashboard/server.ts` — inline `if (path === '/api/...')` branches inside `Bun.serve` fetch. `/api/transactions/:id` is matched by the regex `^\/api\/transactions\/(\d+)$` — `/api/transactions/search` does not collide ("search" is not digits).
- DB layer never embeds ("vectors in, vectors out") and **must stay that way** — the query-time embed happens in the dashboard api layer, which is also the injection seam for tests.
- Transactions UI: `src/dashboard/ui/src/tabs/TransactionsTab.tsx` — server fetch `/api/transactions?start&end&limit=500[&accountId&category&entityId]` (global filters from `useAppState()`), then **client-side** substring filter (`search` vs `merchant_name`/`description`, case-insensitive) plus a **tab-local** category dropdown (`categoryFilter`) that also filters client-side. Empty state: "No transactions match your filters."
- UI plumbing: `src/dashboard/ui/src/api.ts` (`api<T>(path, options)` — JSON + Bearer token), `src/dashboard/ui/src/hooks/useApi.ts` (fetch-on-path-change with a `cancelled` flag — the stale-response pattern to copy), `src/dashboard/ui/src/types.ts` (the `Transaction` interface the table renders; raw DB rows already satisfy it — `pending` is 0/1 and the UI only truthiness-checks it).
- UI build: `src/dashboard/ui` is its own npm package (`npm run build` = `tsc -b && vite build`, vite alias `@` → `./src`, dev proxy `/api` → `localhost:3141`). Root tsconfig **excludes** `src/dashboard/ui`, so UI typecheck only runs via the UI package's `tsc -b`.
- Fake embedder exists: `src/__tests__/fake-embedder.ts` — `fakeEmbedText(text)` maps words to orthogonal basis vectors (word overlap ⇒ dot-product similarity), `createFakeEmbedder()` returns an injectable `embed(texts)`. `src/__tests__/embedding-search.test.ts` has the seed helper pattern (insertTransactions + UPDATE for account_id/entity_id) to copy.
- Query-layer naming convention: `*-queries.ts`; dashboard handlers are `api*` functions. The command to name in UI copy is `wilson --index` (already in `--help` text and README).
- The embeddings model constant: `DEFAULT_EMBEDDING_MODEL` from `src/utils/embeddings.ts`. Do not add it to `PROVIDER_MODELS` (chat catalog).

## Design decisions

1. **Endpoint lives in the api layer, embedding seam is a parameter.** `apiSemanticSearch(db, params, embed?)` is async (query embedding is async). Tests inject the fake embedder; the server route passes nothing and gets the real local engine. This is the only injection point needed — the server route stays a thin `Response.json(await ...)` wrapper, and no test ever touches the real model (no network, no download).
2. **Row enrichment happens in the api layer, not the DB layer.** `searchTransactionsSemantic` deliberately returns a narrow projection. The api layer fetches the full `transactions` rows for the top-k ids (one query, named params) and merges `score` on, preserving ranking order. The UI table then renders semantic rows with the exact same markup as substring rows. `src/db/embedding-queries.ts` is not modified.
3. **Endpoint filters mirror `apiTransactions` param names exactly** (`start`, `end`, `category`, `accountId`, `entityId`) plus `q` and `limit` (default 25). The tab sends the same global-filter params it already builds in `apiPath`; the tab-local `categoryFilter` keeps composing client-side (same predicate applied to semantic results).
4. **UI rule: substring first, semantic only on a zero-match fallback.** While client-side substring filtering over the fetched page produces ≥1 row, behavior is byte-for-byte today's. Only when the query is ≥2 chars and produces zero substring rows while data is non-empty does the UI fetch semantic results. The moment substring matches reappear (e.g. the user types more characters), semantic results are discarded. Semantic matches are visibly marked and each row shows its score.
5. **Coverage hint is data-driven.** The response carries `indexed` and `total`; the hint renders iff `indexed < total`, naming the command. When a semantic query returns zero results and coverage is partial, the same hint explains why — semantic results never silently look empty.

## Files to create / modify

### 1. `src/dashboard/api.ts` — add `apiSemanticSearch`

```ts
export interface SemanticSearchResponse {
  results: Array<Record<string, unknown> & { score: number }>; // full transaction rows + score
  indexed: number;
  total: number;
  model: string;
}

export async function apiSemanticSearch(
  db: Database,
  params: URLSearchParams,
  embed?: (texts: string[]) => Promise<Float32Array[]>
): Promise<SemanticSearchResponse>
```

Behavior:
- Parse `q` (trim), `limit` (int, default 25), and the filter set with the **same helpers/param names as `apiTransactions`**: `start`→`dateStart`, `end`→`dateEnd`, `category`, `parseAccountId`→`accountId`, `parseEntityId`→`entityId`.
- Coverage counts first: `total = COUNT(*) FROM transactions`; `missing = countMissingTransactionTargets(db, DEFAULT_EMBEDDING_MODEL)`; `indexed = Math.max(0, total - missing)`. (Never count the embeddings table directly — orphans from deleted transactions would make `indexed > total`.)
- Empty/absent `q` → return `{ results: [], indexed, total, model }` (well-formed, no embed call).
- Embed the query: `const embedFn = embed ?? embedTexts;` then `const [queryVec] = await embedFn([q]);` — exactly one embed call, one text. **No transaction text is embedded at query time** (vectors already indexed by `--index`).
- Rank: `const hits = searchTransactionsSemantic(db, queryVec, filters, limit, DEFAULT_EMBEDDING_MODEL);` (imported from `../db/embedding-queries.js`). An empty index naturally yields `[]` via the JOIN — no special-casing.
- Enrich: fetch full rows for the hit ids in one statement with named params built dynamically (the compat-sqlite wrapper only accepts named params — no positional spread):
  ```ts
  const placeholders = hits.map((_, i) => `@id${i}`).join(',');
  const rows = db.prepare(`SELECT * FROM transactions WHERE id IN (${placeholders})`)
    .all(Object.fromEntries(hits.map((h, i) => [`id${i}`, h.sourceId])));
  ```
  Build `id → row` map, then `results = hits.map(h => ({ ...byId.get(h.sourceId), score: h.score }))` — preserves dot-product order; a missing row (deleted mid-flight) is skipped defensively.
- Return `{ results, indexed, total, model: DEFAULT_EMBEDDING_MODEL }`.

Imports to add: `countMissingTransactionTargets`, `searchTransactionsSemantic` from `../db/embedding-queries.js`; `embedTexts`, `DEFAULT_EMBEDDING_MODEL` from `../utils/embeddings.js`. Keep the module free of any top-level side effects — the pipeline must only load lazily on the first real query.

### 2. `src/dashboard/server.ts` — register the route

Next to the `/api/transactions` branch (before the `/api/transactions/:id` regex block for readability; no functional ordering constraint):

```ts
if (path === '/api/transactions/search') {
  return Response.json(await apiSemanticSearch(activeDb, url.searchParams), { headers });
}
```

Add `apiSemanticSearch` to the import list from `./api.js`. Auth: like all read routes, it sits behind the existing auth middleware — no per-route write check (it's read-only).

### 3. `src/dashboard/ui/src/types.ts` — response types

```ts
// Matches GET /api/transactions/search response
export interface SemanticSearchMatch extends Transaction {
  score: number;
}
export interface SemanticSearchResponse {
  results: SemanticSearchMatch[];
  indexed: number;
  total: number;
  model: string;
}
```

### 4. `src/dashboard/ui/src/hooks/useSemanticSearch.ts` (new) — debounced fallback fetch

```ts
export function useSemanticSearch(
  path: string | null,   // null = semantic fallback not active → no fetch
  deps: unknown[]
): { data: SemanticSearchResponse | null; loading: boolean; error: string | null }
```

Copy the `useApi` stale-response pattern (`cancelled` flag in the effect cleanup). Debounce ~300ms after the last path change before fetching (`setTimeout` + clear in cleanup); skip when `path` is null or the query segment is unchanged. `loading` is true from path change until settle, so the UI can show a "searching" state instead of flickering the empty state. On error, surface the message but never block the substring flow. Keep the hook dumb: no state about which mode the table is in — the tab decides.

### 5. `src/dashboard/ui/src/tabs/TransactionsTab.tsx` — the behavior

- **Substring path unchanged.** Keep the `filtered` memo and its rendering exactly as-is.
- **Fallback trigger:** compute
  ```ts
  const query = search.trim();
  const semanticActive = query.length >= 2 && data != null && data.length > 0
    && !loading && filtered.length === 0;
  ```
  When `semanticActive`, build the semantic path with the **same params as `apiPath`** plus `q=${encodeURIComponent(query)}` and `limit=25`; pass it (or `null`) to `useSemanticSearch`. Gate `!loading` so the fallback doesn't fire while the page's transactions are still loading.
- **Which table renders:** semantic results render only while `semanticActive` (and the moment `filtered.length > 0` again, the substring table takes over). Apply the tab-local `categoryFilter` to semantic results with the same predicate (`tx.category !== categoryFilter` drops the row) so the category filter keeps composing in both modes.
- **Rendering:** extract the existing row JSX into a local `TxRow` component (props: `tx`, `entities`, `onUpdate`) used by both tables so the two paths can't drift. In the semantic table add:
  - a header line: `Semantic matches for “{query}”` plus a small badge (e.g. `semantic`, rounded chip using existing tailwind tokens like `bg-border text-text-muted text-[10px] uppercase` — same family as the `pending` chip);
  - a per-row score chip next to the merchant: `Math.round(tx.score * 100)%` (cosine similarity; scores can be negative — display the raw rounded value, no clamping of data);
  - keep the standard column layout so it reads as the same table.
- **Coverage hint:** when `semantic.data` is present and `indexed < total`, render one line under the search box:
  `Semantic index covers {indexed} of {total} transactions — run wilson --index to index the rest.`
  (small `text-text-muted text-xs`, command styled as inline code). Show it in both the results table and the semantic-zero-results state, so a partial index never silently looks empty.
- **Semantic loading / empty / error states:** loading → a subtle "Searching semantically…" line (or pulse block, matching the existing skeleton style); zero results with full coverage → the ordinary empty-state card with wording noting no semantic matches; error → the ordinary empty state plus the error text in small muted type (substring UX must never regress or block).
- The count line (`{filtered.length} of {data.length} transactions`) stays about the substring view; in semantic mode show `{n} semantic matches` instead. The search input's placeholder can stay.

### 6. Docs

- `CHANGELOG.md`: entry under `## [Unreleased]` → `### Features`, existing style, referencing issue #62 — semantic search in the dashboard Transactions view: zero-substring-match queries fall back to on-device embedding search (dot-product ranking, visible scores, same filter set, coverage hint naming `wilson --index`); nothing but the one-time model download ever leaves the machine.
- `README.md`: if there is a dashboard-features list, add one line for semantic transaction search (on-device). Optional; CHANGELOG is the required one.

## Tests

New file `src/__tests__/dashboard-semantic-search.test.ts` — pattern: `createTestDb()` from `helpers.ts`, the `seed()` helper style from `embedding-search.test.ts` (insertTransactions + UPDATE for account_id/entity_id), fake embedder from `fake-embedder.ts`, **all tests inject the fake embedder — the real pipeline is never imported in tests**. Index fixtures via `upsertEmbeddings` with `fakeEmbedText(transactionEmbedText({...}))` (same as the existing search tests) so vectors match what `--index` would store.

1. **Ranking is dot-product order** — seed three transactions sharing 2 / 1 / 0 words with the query (word-overlap ⇒ score ordering with this embedder), index all, search with the fake embedder; assert the returned order and that scores are strictly decreasing; assert each score equals the dot product of `fakeEmbedText(query)` and `fakeEmbedText(transactionEmbedText(row))` recomputed in the test (float tolerance ~1e-6).
2. **The filter set actually constrains** — seed rows that would score high but sit outside each filter; assert each filter individually excludes its target: `start`/`end` date range, `accountId`, `category`, `entityId`; then assert the full filter set returns only the fully-matching row. Mirror the param passing through `URLSearchParams` (test the real parsing path, not the filters object).
3. **Limit respected** — seed 5 indexed matches, `limit=3` → exactly 3 results and they are the top-3 by score.
4. **Empty index → well-formed empty response, no error** — seed transactions but index none; assert resolve (no throw) with `results: []`, `indexed: 0`, `total: <seeded count>`, `model: DEFAULT_EMBEDDING_MODEL`.
5. **Response rows are full transaction rows + score** — assert `merchant_name`, `category`, `category_detailed`, `account_id`, `entity_id`, `pending`, `description`, `amount`, `date` are present on a result alongside `score`, and the order matches step 1's ranking (enrichment did not reorder).
6. **Coverage counts** — index exactly half the seeded rows → `indexed < total` and `indexed === Math.floor(total/2)`; index the rest → `indexed === total`. Also: orphan an embedding row (delete its transaction directly) and assert `indexed` still counts only transactions that exist (`indexed = total - missing` invariant).
7. **Embed seam** — assert the injected embed was called exactly once with `[query]` (and not with document texts), and that the search used its returned vector (a fake embedder variant that returns a fixed vector finds only the transaction indexed with that same fixed vector).
8. **Empty/blank `q`** → no embed call, empty results, counts still populated.

Optional (cheap, keeps route wiring honest): extend `src/__tests__/dashboard-server.test.ts` with one route test hitting `/api/transactions/search?q=…` on a server with an **empty** index — asserts 200 + well-formed empty response without ever triggering a model load (no embeddings exist, so no embed call happens… note: the query embed DOES happen on this path — do not add this route test unless the builder injects an embedder; if that's awkward, skip it — api-level coverage above satisfies the acceptance criterion, and the route is a one-line `Response.json` wrapper proven by the neighboring routes).

## Verification

1. `bun run typecheck` — clean (root tsc excludes the UI dir; it covers `src/dashboard/api.ts` + `server.ts`).
2. `bun test` — all green, including the untouched `embedding-search.test.ts`, `embedding-backfill.test.ts`, `dashboard-api.test.ts`, `dashboard-server.test.ts`.
3. `cd src/dashboard/ui && npm run build` — `tsc -b && vite build` pass (run `npm ci` first if `node_modules` is missing in this worktree).
4. Manual check (network only for the one-time model download if not already cached):
   - Seed or use a profile with transactions; `bun run src/index.tsx --index` to index them (instant no-op if already indexed).
   - `bun run src/index.tsx --dashboard`, open Transactions:
     - Type "coffee shops" → Starbucks / Blue Bottle / similar coffee vendors appear ranked with score chips and the `semantic` marker, even though no description contains "coffee".
     - Type an exact merchant substring (e.g. "Starbucks") → today's substring table renders, no semantic marker, behavior identical to before.
     - Delete a chunk of `embeddings` rows (`DELETE FROM embeddings WHERE source_type='transaction' AND id % 2 = 0`) → the coverage hint appears with the right counts and names `wilson --index`; with an empty index, a semantic query shows the hint instead of silently empty results.
     - Re-index (`--index` is resumable) → hint disappears.
5. Privacy assertion: `grep -rn "fetch(" src/dashboard/api.ts src/utils/embeddings.ts` — no new outbound calls; query and transaction text are embedded in-process; the only network touch in the whole path remains the one-time model download inside the pinned transformers.js loader.

## Do NOT touch

- `package.json` / `bun.lock` — the exact `@huggingface/transformers` `4.0.1` pin is asserted by `transformers-webgpu-ep.test.ts`; no new deps.
- `src/db/embedding-queries.ts` and `src/utils/embeddings.ts` — the primitives are done and tested; the slice consumes them (row enrichment lives in the api layer).
- `src/utils/model.ts` `PROVIDER_MODELS`, both webgpu test files, the text-generation pipeline path, migrations 1–23 (no new migration — the `embeddings` table exists).
- Today's substring filtering, the global filter state (`useAppState`), and the `/api/transactions` endpoint — the fallback must be strictly additive.

## Non-goals (later slices of #51)

Embed-on-write hooks (new/edited transactions are searchable only after the next `--index` run — the coverage hint already tells the user this honestly), semantic search in the agent tools / MCP, chat & memory source search, sqlite-vec, an index-progress or warmup endpoint, embedding-model switch UI, dashboard UI component tests (the repo has no UI test runner — verification for the UI is typecheck + build + the manual checklist).

## Risks / notes for the builder

- **First semantic query is slow-ish.** The dashboard process lazily loads the ONNX pipeline on the first `q` (a few seconds; plus one-time download if the model was never cached). The UI loading state covers it; no warmup endpoint in this slice. If it feels broken in manual testing, that's expected on the very first query only.
- **Scores are cosine similarities in [-1, 1]** (both vectors unit-norm). Display `Math.round(score * 100)` and don't clamp; a score near 0.3–0.6 is a normal "related" match for MiniLM, not a bug.
- **`pending` is a raw 0/1** in DB rows; the UI type says `boolean` and only truthiness-checks it — raw rows already flow through `/api/transactions` today, so passing raw rows + `score` changes nothing.
- **Named params only** in the enrichment query: the `compat-sqlite` wrapper rewrites `@x` → `$x` and takes a single params object; there is no positional-args overload. Build `@id0, @id1, …` dynamically.
- **The substring view is a page (limit=500), not the whole ledger** — semantic search intentionally searches the *full* filtered ledger (SQL prefilter, no 500-row cap), so it can surface matches the substring page never fetched. That's a feature; the coverage hint and score chips make it visible, but the count line may legitimately differ between modes.
- Keep the semantic fetch keyed on the **full query string** (not per-keystroke fetches): debounce handles typing; the substring path stays instant and free.
- The endpoint is read-only and safe for `viewer` role — no RBAC branch needed beyond the existing auth middleware.