# Plan: Embed-on-write — embeddings stay fresh across import, sync, edit, and delete paths (issue #63)

Parent: #51 (local semantic memory). Blocked by #61 — **already landed on this branch** (`src/embedding-backfill.ts`, `src/db/embedding-queries.ts`, `src/utils/embeddings.ts`, `src/__tests__/fake-embedder.ts` all exist and `--index` is wired).

Slice outcome: after any import (CSV/OFX/QIF, Monarch, Firefly), any sync (Plaid, Coinbase), any edit (agent tool or dashboard PATCH), or any delete, the `embeddings` table reflects the change immediately — without the user ever running `wilson --index`. An embedding failure degrades to a log line and leaves rows for the next backfill; it never fails the import or edit.

## Verified context (this repo, this worktree)

- The embedding stack from #61: `embedTexts(texts, model?)` (`src/utils/embeddings.ts`), `transactionEmbedText({merchant_name, description})` (canonical text rule: merchant + description, single space), `upsertEmbeddings` (idempotent upsert, L2-normalizes at write, single transaction), `deleteEmbeddings(db, sourceType, sourceId)` (deletes all model variants — primitive shipped in #61 with the note "call sites come in a later slice"; **this is that slice**), `runEmbeddingIndex` (batched, resumable backfill behind `--index`).
- Embed-text-affecting columns: only `merchant_name` and `description`. Category/amount/date/notes/account/entity changes do NOT affect the vector — no hooks there.
- **The five insert paths (verified):**
  1. CSV/OFX/QIF — `importSingleFile` in `src/tools/import/csv-import.ts` step 8 → `insertTransactions` (`src/db/queries.ts`).
  2. Monarch — `src/tools/import/monarch.ts` line ~170 → `insertTransactions`.
  3. Firefly — `src/tools/import/firefly.ts` line ~282 → `insertTransactions`.
  4. Plaid sync — `syncPlaidItem` in `src/tools/import/plaid-sync.ts`: raw INSERT (added, ~line 123), raw UPDATE (modified, ~line 156) with a fallback INSERT, raw DELETE (removed, ~line 167 by `plaid_transaction_id`). Shared by the agent tool and `wilson --sync` (`src/sync.ts`).
  5. Coinbase sync — `syncCoinbaseConnection` in `src/tools/import/coinbase-sync.ts` line ~123: raw INSERT per account loop. Shared by tool and `--sync`.
  - Bonus sixth: the dashboard import endpoint `apiImport` (`src/dashboard/api.ts` line ~854) also calls `insertTransactions` — it is covered automatically because the hook sits at all four `insertTransactions` call sites (not inside the query function).
- **Update paths that touch embed text (verified):** `updateTransaction` (`src/db/queries.ts` — supports `description`; no `merchant_name`), used by the `edit_transaction` agent tool (`src/tools/query/edit-transaction.ts`) and dashboard PATCH route (`apiUpdateTransaction` → `src/dashboard/server.ts` line ~328). Plaid modified path sets `description` + `merchant_name` (pending→posted). No other code mutates those two columns (checked all `UPDATE transactions` sites: account_id/entity_id/category only elsewhere).
- **Delete paths (verified):** `deleteTransaction` (`src/db/queries.ts`) used by the `delete_transaction` tool and dashboard DELETE route; plus the raw Plaid removed-path DELETE.
- `insertTransactions` is called by exactly 4 production sites (above) and many tests — **no test consumes its return value** (verified), so changing the return shape only touches those 4 sites.
- `compat-sqlite` `stmt.run()` returns `{ changes, lastInsertRowid }` — verified empirically; pattern already used in `addRule`/`addCategory`.
- `db/transaction((fn) => {...})` runs callbacks with additional prepared statements fine (existing pattern).
- No test file consumes `insertTransactions`' count except the 4 prod sites; `src/__tests__/helpers.ts` `createTestDb()` is imported by every test file that will now trigger hooks, making it the one test seam for the fake embedder.
- bun 1.4.2 isolates `mock.module` per test file (verified empirically with a scratch suite) — new plaid/coinbase mocks cannot contaminate `sync.test.ts`, and its mocks cannot break this slice's tests.
- `syncPlaidItem` does **not** check the license (only the tool wrapper does) — it is directly callable in tests with mocked `plaid/client.js` + `plaid/store.js` (same pattern as `src/__tests__/sync.test.ts`).
- Firefly tests mock `globalThis.fetch` via `spyOn` (`firefly-import.test.ts`); Monarch tests `mock.module('monarch-money-api', ...)`.
- `logger` (`src/utils/logger.ts`) is the established structured logger (`logger.info('coinbase:accounts', { count })` style).
- Migration count is 23; **no migration needed this slice** — the `embeddings` table and all needed primitives exist.

## Design decisions

1. **Hook at call sites, not inside the query layer.** `insertTransactions`/`updateTransaction` are synchronous; embedding is async. Making them async ripples through dozens of tests; firing-and-forgetting inside a sync query function breaks test determinism and CLI exit semantics, and violates #61's "DB layer never embeds" principle. Instead: one shared async helper (`embedTransactionIds`) awaited by each of the five paths. The task explicitly sanctions this ("a post-sync sweep of that sync's new rows is an acceptable implementation as long as all five paths are covered").
2. **One helper for insert AND refresh.** `embedTransactionIds(db, ids)` re-selects the rows' *current* `(merchant_name, description)` from the DB by id and upserts vectors. Upsert-overwrite = refresh, so the edit path reuses the same function; the DB is the source of truth for what gets embedded.
3. **Ids are captured exactly via `lastInsertRowid`** inside each insert loop — never re-derived by matching (duplicate descriptions/amounts make matching ambiguous). For `insertTransactions`, the return shape becomes `{ count, ids }` (safe: no test consumes the old `number`).
4. **Degrade, never error:** `embedTransactionIds` never throws. It catches per batch; on the first failed batch it logs (`logger.warn`) and stops — remaining rows stay unembedded and `countMissingTransactionTargets` picks them up on the next `--index` run. Whole-function try/catch guards the id re-select too. The default embedder resolves the model lazily (transformers.js downloads on first pipeline use); an offline/failed download throws inside that same catch — import still succeeds.
5. **Delete hook lives inside `deleteTransaction`** because deleting the vector is a synchronous storage op (`deleteEmbeddings`), needs no async plumbing, and covers every current and future delete caller for free. This is storage maintenance, not embedding — it does not violate the "DB layer never embeds" principle.
6. **Plaid modified rows re-embed only when the text actually changed** (compare old vs new `description`/`merchant_name` via a pre-update SELECT inside the transaction) — avoids re-embedding on pure amount/pending/category churn.
7. **Test seam: a module-level embedder override + a suite-wide default fake.** `setEmbedOnWriteEmbedder(embed | null)` in the new module. `ensureTestProfile()` in `src/__tests__/helpers.ts` installs a deterministic non-recording fake once per process, so every existing test that now triggers a hook gets fast deterministic vectors with **zero churn in csv/monarch/firefly/dashboard test files**; tests that need to observe embed calls install their own recording fake (`createFakeEmbedder().embed`) at test start and never reset to `null` (prod never imports helpers, so the default stays the real engine).
8. **Backfill gains an orphan sweep** (`orphaned` count): deletes embeddings whose transaction row no longer exists. Structural safety net — even if a future delete site is missed, the next `--index` run reclaims the stale vectors and the indexed-vs-total counts stay truthful.

## Files to create

### 1. `src/utils/embed-on-write.ts` (new)

```ts
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface EmbedOnWriteOptions {
  embed?: EmbedFn;      // explicit injection wins; else the module override; else the real engine
  model?: string;       // default DEFAULT_EMBEDDING_MODEL
  batchSize?: number;   // default 32 (same as backfill)
}

export interface EmbedOnWriteResult {
  embedded: number;     // rows actually upserted this call
  failed: number;       // rows left for the next backfill run
}

/** Test/DI seam. null = use the real local engine. */
export function setEmbedOnWriteEmbedder(embed: EmbedFn | null): void;

/** Embed current (merchant_name, description) of the given transaction ids. NEVER throws. */
export async function embedTransactionIds(
  db: Database,
  ids: number[],
  opts?: EmbedOnWriteOptions
): Promise<EmbedOnWriteResult>;
```

Behavior spec for `embedTransactionIds`:
- Dedupe ids; empty → `{ embedded: 0, failed: 0 }` immediately (never touches a model).
- Re-select current rows in chunks of 500: `SELECT id, merchant_name, description FROM transactions WHERE id IN (@id0, @id1, …)` (generated param names — the compat wrapper rewrites `@x`→`$x` and prefixes keys). Rows vanished mid-flight (deleted between insert and embed) are simply skipped, not failed.
- In batches of `batchSize`: texts via `transactionEmbedText`, vectors via the resolved embedder, `upsertEmbeddings(db, …)` with `sourceType: 'transaction'`, `model`.
- First batch failure → `logger.warn('embed:on-write:failed', { model, failed, error })` → return `{ embedded, failed: rows.length - embedded }` and stop (a broken model fails every batch; don't burn time). Whole-body try/catch → same log, `{ embedded: 0, failed: unique.length }`.
- Module state: `let overrideEmbed: EmbedFn | null = null;` — resolve order `opts.embed` → `overrideEmbed` → `(texts) => embedTexts(texts, model)`. Do NOT call `pullEmbeddingModel` here (no progress UI in an import; transformers.js fetches-or-caches implicitly inside `getEmbeddingPipeline`).

## Files to modify

### 2. `src/db/queries.ts`
- `insertTransactions(db, txns): { count: number; ids: number[] }` — collect `(stmt.run(...) as { lastInsertRowid: number }).lastInsertRowid` per row inside the existing transaction; return both. Update the JSDoc.
- `deleteTransaction(db, id)` — after a successful delete, `deleteEmbeddings(db, 'transaction', id)` (import from `./embedding-queries.js`; sync call, no cycle risk beyond the pre-existing embeddings↔utils cycle which is call-time-only). Only when `changes > 0`.

### 3. `src/tools/import/csv-import.ts` (path 1, CSV/OFX/QIF)
- Step 8: `const { count, ids } = insertTransactions(database, txns);` then immediately `await embedTransactionIds(database, ids);` (importSingleFile is already async). Everything else unchanged — result messages stay byte-identical.

### 4. `src/tools/import/monarch.ts` (path 2)
- Same destructure + `await embedTransactionIds(database, ids);` right after the bulk insert (func already async).

### 5. `src/tools/import/firefly.ts` (path 3)
- Same.

### 6. `src/tools/import/plaid-sync.ts` (path 4 — insert + update + delete in one function)
- **Added inserts:** inside `insertAll`, capture each `lastInsertRowid` into `addedIds: number[]`.
- **Modified:** inside `updateAll`, per txn first `SELECT id, description, merchant_name FROM transactions WHERE plaid_transaction_id = @tid`; after a successful `updateStmt.run` (changes > 0), push `existing.id` to `changedIds` iff `existing.description !== txn.name || (existing.merchant_name ?? null) !== (txn.merchantName ?? null)`; on the fallback insert (`changes === 0`), capture `insertStmt.run(...)`'s `lastInsertRowid` into `changedIds`.
- **Removed:** inside `deleteAll`, before each per-tid DELETE, `SELECT id FROM transactions WHERE plaid_transaction_id = @tid`; collect ids into `removedIds`. After the transaction, `for (const id of removedIds) deleteEmbeddings(database, 'transaction', id);` (sync).
- After the auto-link block, before `updatePlaidCursor`: `const embedIds = [...addedIds, ...changedIds]; if (embedIds.length > 0) await embedTransactionIds(database, embedIds);` — one batched sweep covering inserts and pending→posted refreshes. `syncPlaidItem` is already async; both the agent tool and `--sync` flow through it.

### 7. `src/tools/import/coinbase-sync.ts` (path 5)
- Capture `lastInsertRowid` per row inside the per-account `insertAll` into a `insertedIds: number[]` accumulated across accounts. After the account loop, before `updateLastSyncedAt`: `if (insertedIds.length > 0) await embedTransactionIds(database, insertedIds);`

### 8. `src/tools/query/edit-transaction.ts` (manual edit update path)
- After `const success = updateTransaction(database, id, filtered);`:
  `if (success && filtered.description !== undefined) await embedTransactionIds(database, [id]);`
  (`merchant_name` isn't editable via this tool — description is the only embed-text field here. Category/date/amount/notes edits must NOT trigger re-embedding.)

### 9. `src/dashboard/api.ts` (dashboard edit + import)
- `apiUpdateTransaction` → `async`, returns `Promise<{ success: boolean; id: number }>`; after a successful update, `if (updates.description !== undefined) await embedTransactionIds(db, [id]);`
- `apiImport` → `async function apiImport(...): Promise<ImportResult>`; destructure `const { count, ids } = insertTransactions(db, txns);` and `await embedTransactionIds(db, ids);` after it. (Sync logic/dedup unchanged.)

### 10. `src/dashboard/server.ts`
- Line ~386: `const result = await apiImport(activeDb, body);`
- Line ~328: `return Response.json(await apiUpdateTransaction(activeDb, id, body), { headers });`
- DELETE route unchanged (`apiDeleteTransaction`/`deleteTransaction` stay sync; the vector delete happens inside `deleteTransaction`).

### 11. `src/db/embedding-queries.ts`
- Add `deleteOrphanedTransactionEmbeddings(db): number` —
  `DELETE FROM embeddings WHERE source_type = 'transaction' AND source_id NOT IN (SELECT id FROM transactions)` → returns `changes`. (Storage-layer SQL; keeps this module the single owner of embeddings SQL.)

### 12. `src/embedding-backfill.ts`
- `EmbeddingIndexResult` gains `orphaned: number`.
- Run `const orphaned = deleteOrphanedTransactionEmbeddings(db);` **before the `total === 0` early return** (so the sweep happens on every run, including no-ops). Include it in both return paths.

### 13. `src/__tests__/helpers.ts` — the one test seam
- In `ensureTestProfile()` (guard with a module-level `embedderInstalled` flag):
  ```ts
  setEmbedOnWriteEmbedder(async (texts) => texts.map(fakeEmbedText));
  ```
  (import `setEmbedOnWriteEmbedder` from `../utils/embed-on-write.js` and `fakeEmbedText` from `./fake-embedder.js`). Deterministic, instant, no model. Tests needing call logs override it per-test with a fresh `createFakeEmbedder()`; nobody resets to `null` (prod never imports helpers). The existing `embedding-backfill.test.ts`/`embedding-queries.test.ts`/`embedding-search.test.ts` pass explicit `embed` fakes and don't touch this seam.

### 14. `CHANGELOG.md`
- One entry under `## [Unreleased]` → `### Features` in the existing style, referencing #63: embed-on-write across import/sync/edit/delete with degrade-not-error semantics.

## Tests

New file **`src/__tests__/embed-on-write.test.ts`** — every test starts with `const fake = createFakeEmbedder(); setEmbedOnWriteEmbedder(fake.embed);` (helpers' global fake is the fallback elsewhere). Use `createTestDb()` throughout; assert on the `embeddings` table directly (`SELECT … WHERE source_type='transaction'`) and on `fake.calls`.

Mocks for the sync paths (per-file, no cross-file leakage — verified):
- Plaid: `mock.module('../plaid/client.js', () => ({ ...realPlaidClient, syncTransactions: async () => ({ added, modified, removed, nextCursor }), getBalances: async () => [] }))` (spread real so `PlaidError` identity survives); `mock.module('../plaid/store.js', () => ({ getPlaidItems: () => [], updatePlaidCursor: () => {}, updatePlaidItemError: () => {}, clearPlaidItemError: () => {}, isReauthRequired: () => false }))` — the store mock is required because `updatePlaidCursor` writes `~/.openaccountant/plaid.json`. Call `syncPlaidItem(db, makeItem(), false)` directly (no license check inside it).
- Coinbase: `mock.module('../coinbase/client.js', () => ({ getAccounts: async () => [acctWithNativeBalance], getTransactions: async () => [completedBuy, completedSell, pendingTxn] }))`; `mock.module('../coinbase/store.js', () => ({ getCoinbaseConnections: () => [], updateLastSyncedAt: () => {} }))`. Call `syncCoinbaseConnection(db, conn, false)` directly.
- Monarch/Firefly: copy the `monarch-money-api` `mock.module` pattern from `monarch-import.test.ts` and the `spyOn(globalThis, 'fetch')` pattern from `firefly-import.test.ts` (with `FIREFLY_API_URL`/`FIREFLY_API_TOKEN` env + license spy).

Test list:
1. **CSV import → vectors exist** (acceptance): temp 3-row Chase CSV → `csvImportTool.func` → `transactionsImported: 3`; embeddings count === 3; every DB row's `transactionEmbedText` appears in `fake.calls`; stored vec bytes for one row equal `fakeEmbedText(text)`.
2. **Monarch import → vectors exist**: 3 mocked txns → embeddings count === 3, text = description only (Monarch inserts have no merchant_name).
3. **Firefly import → vectors exist**: mocked fetch → embeddings exist; text is `"desc desc"` (Firefly sets merchant_name = description) — assert via `transactionEmbedText`, documenting the rule.
4. **Plaid sync added → vectors exist** (acceptance): one `added` txn (with merchantName) → 1 transaction row, 1 embedding, text = `merchant + name`; a second sync returning the same transactionId is deduped → `fake.calls` unchanged, still 1 embedding.
5. **Plaid modified → refreshed only on text change** (acceptance): seed row (`plaid_transaction_id: 'txn-1'`, description `Old Name`, merchant_name `Old Merchant Inc`) + pre-seed its embedding via `upsertEmbeddings` with `fakeEmbedText('Old Merchant Inc Old Name')`; sync returns `modified` with new name/merchant → stored vec now equals `fakeEmbedText('New Merchant Inc New Name')`; a second sync with identical name/merchant → no new embed call and vec unchanged (amount/pending churn must not re-embed). Also the fallback-insert case (modified txn not present locally) yields a fresh vector.
6. **Plaid removed → vector gone** (acceptance): seeded row + embedding; `removed: ['txn-1']` → transaction row gone AND embedding row gone.
7. **Coinbase sync → vectors exist** (acceptance): completed buy + completed sell embedded (description from `details.title`), pending/excluded txns not.
8. **Edit tool: description edit → vector refreshed; category-only edit → untouched** (acceptance): seed via `seedTestData`, pre-seed a vector for the Grocery Store row; `editTransactionTool.func({ id, description: 'Fresh Market Haul' })` → vec equals `fakeEmbedText('Fresh Market Haul')`; fresh fake + category-only edit → zero embed calls, vec unchanged.
9. **Dashboard PATCH → refreshed**: `await apiUpdateTransaction(db, id, { description: 'New' })` → vec refreshed (also pins the async signature).
10. **Delete → vector gone** (acceptance): seed row + embedding; `deleteTransaction(db, id)` → true and embedding gone; neighbor rows' embeddings untouched; repeat via `deleteTransactionTool.func`.
11. **Degrade never error — throwing embedder** (acceptance): `setEmbedOnWriteEmbedder(async () => { throw new Error('model exploded'); })`; CSV import succeeds (`success: true`, 3 transactions in DB) with **zero** embedding rows and no corrupt state; `runEmbeddingIndex` with a good fake afterwards indexes exactly those 3 rows (their texts match). Also: throwing embedder on a description edit → tool result still `success: true`, old vector left as-is (stale-but-present is the documented degrade state; `--index` does not repair text-staleness in this slice).
12. **Partial batch failure**: `createFakeEmbedder({ failAfterBatches: 1 })`, `batchSize: 2`, 5-row import → import succeeds, `embedTransactionIds` would have embedded exactly the first batch (2 rows in embeddings, 3 transactions present, nothing corrupt). Assert via table counts after `csvImportTool.func`.
13. **Empty ids no-op**: `embedTransactionIds(db, [])` → `{ embedded: 0, failed: 0 }`, zero calls (no model touch).

Extend **`src/__tests__/embedding-backfill.test.ts`**:
14. Add `orphaned: 0` to the three `toEqual` result assertions (result shape changed).
15. **Orphan sweep test**: seed tx + embedding, raw-delete the transaction row (`db.prepare('DELETE FROM transactions WHERE id = @id')` — bypassing the hook), `runEmbeddingIndex` with a fake → returns `orphaned: 1`, embedding row gone, and the run remains a no-op for embeddings (zero embed calls when nothing is missing).

Touch **`src/__tests__/dashboard-api.test.ts`**: `const result = await apiUpdateTransaction(...)` (the one call, line ~136). No other existing test files need edits (helpers' global fake covers them; `edit-transaction-tool.test.ts` has no description-edit test today — verified).

## Explicitly NOT touched

- `package.json` / `bun.lock` (pinned transformers 4.0.1), `src/utils/model.ts` `PROVIDER_MODELS`, `src/model/providers/transformers.ts`, the webgpu test files — all #61 invariants stand.
- No migration (embeddings table already at v23), no CLI surface change (`--index` output unchanged), no import tool result messages changed (existing string assertions keep passing), no semantic-search UI/tool (later slice of #51).
- Categorize/entity/account update flows (don't affect embed text).
- `src/sync.ts` (hooks live inside `syncPlaidItem`/`syncCoinbaseConnection`, so `--sync` is covered with zero changes).

## Verification

1. `bun run typecheck` — clean (the `insertTransactions` return-shape change and the two async api functions are the only signature ripples; TypeScript will flag any site missed).
2. `bun test` — all pass, including the pre-existing embedding/plaid/coinbase/monarch/firefly/csv suites untouched.
3. Manual check (real engine; needs network once for the ~90MB fp32 MiniLM download, then fully offline). Fresh profile via a scratch `HOME` so `~/.openaccountant` starts empty:

   ```bash
   export MANUAL_HOME=$(mktemp -d)
   printf 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n01/15/2026,01/16/2026,BLUE BOTTLE COFFEE,Dining,Sale,-6.75,\n01/18/2026,01/19/2026,ELECTRIC CO,Utilities,Sale,-120.00,\n' > /tmp/manual.csv
   ```
   Write `/tmp/manual-check.ts`:
   ```ts
   const { initDatabase } = await import('<repo>/src/db/database.js');
   const { initImportTool, csvImportTool } = await import('<repo>/src/tools/import/csv-import.js');
   const { semanticSearchTransactions } = await import('<repo>/src/utils/embeddings.js');
   const db = initDatabase();
   initImportTool(db);
   console.log(await csvImportTool.func({ filePath: '/tmp/manual.csv' }));
   for (const q of ['morning coffee shop', 'power company bill']) {
     console.log(q, await semanticSearchTransactions(db, q, {}, 3));
   }
   ```
   - `HOME=$MANUAL_HOME bun /tmp/manual-check.ts` — import succeeds; **without ever running `--index`**, "morning coffee shop" surfaces the BLUE BOTTLE row at rank 1.
   - Edit: `HOME=$MANUAL_HOME bun run src/index.tsx` → ask the agent to `edit_transaction` that row's description to `REI CO-OP`; re-run the check script: "morning coffee shop" no longer surfaces it, "outdoor gear purchase" does.
   - Degrade check: repeat the import into another scratch `HOME` with the network blocked (or an invalid model cache) — the import still reports success, `SELECT COUNT(*) FROM embeddings` is 0, and a later `HOME=$MANUAL_HOME bun run src/index.tsx --index` backfills exactly those rows.
4. `sqlite3`/bun one-liner after a real CSV import: `SELECT COUNT(*) FROM embeddings WHERE source_type='transaction'` equals the transaction count.

## Risks / notes for the builder

- **First import on a fresh machine downloads the model inline** (~90MB, one-time, then cached). That is required by the outcome ("searchable without ever running backfill"); it is the same single network traffic `--index` already performs. A failed download degrades to the log-and-skip path — never fails the import.
- Latency: on-write embedding runs inline in the import/sync/edit. Default batch 32; a 2,000-row CSV adds roughly tens of seconds on first import (subsequent imports are incremental). Accepted for this slice; no config knob.
- `IN (@id0, @id1, …)` param generation must go through the compat wrapper's `@`→`$` rewrite with generated keys — same mechanism as every other `@param` query in the repo.
- Keep the plaid `store.js` mock complete (all five imported names) — a missing export throws at import time of the mocked module.
- The helpers-seam fake is process-wide: if a test needs a *recording* embedder it must set its own (never `null`), since resetting would leak the real engine into later files in the same process.
- The stop-on-first-failed-batch semantics mean `failed` counts rows not yet embedded — the acceptance test asserts "zero vectors with a throwing embedder", which is the very first batch; the partial-batch test pins the rest.
- `deleteEmbeddings` inside `deleteTransaction` runs even when the caller is a test that never touched embeddings — it's a no-op `changes = 0` delete; safe.