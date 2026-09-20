# Plan: Offline transactions — sync-fed local mirror serves the transactions tab without a server

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-75` (`@openaccountant/wilson`, Bun + TypeScript)
**Parent:** #53 (decomposed) · **This slice:** #75 · **Blocked-by #74 is satisfied** — the store technology is committed in `docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md` (§6 Decision). This slice is the first implementation story that decision doc's §7 hands off.

## Outcome

After this lands, a dashboard user with no live server connection can still browse, search, and filter their transactions with the same filters and results they get online. Entity assignment while offline shows an explicit "requires connection" state instead of failing silently.

## Committed technology (do not revisit)

Per the decision doc §6: **wa-sqlite@1.0.0 (synchronous build) with `AccessHandlePoolVFS`, running in an inline-bundled dedicated Worker, delivered fully inside the single-file `index.html`** (wasm inlined at build time via base64 → `wasmBinary`), **no COOP/COEP headers, no static-asset routes**, per-profile pool isolation, and all query + sync logic behind a `LocalStore`-style seam whose SQL is tested in-process against `bun:sqlite :memory:` under `bun:test`. The store is a **read-only mirror** — the server DB stays canonical; offline writes are never queued (that is the "read-only spec per decision" in the task).

## Architecture at a glance

```
 dashboard server (Bun.serve, unchanged)
   │  GET /api/transactions?limit=10000000   (full set — unbounded query, no server change)
   │  GET /api/entities                      (small; the tab's entity column needs it)
   │  GET /api/profiles                      (active profile → mirror key)
   ▼
 SyncEngine (pure, bun-tested)  ── applySync(payload) ──▶  Mirror db (wa-sqlite + AccessHandlePoolVFS,
   │                                                       inside an inline Worker, one OPFS pool
   │                                                       directory per profile)
   ▲
 fetch seam `api()` (src/dashboard/ui/src/api.ts)
   network-first; on network-level failure:
     GET  + mirrored path + mirror seeded  → serve identical rows from the mirror
     write                                  → throw RequiresConnectionError (no mirror writes, ever)
   ▼
 TransactionsTab (browse / search / filter work offline; entity assign shows requires-connection)
```

Transactions imported through the browser statement importer (`POST /api/import`, #71) land in the **server** DB; the mirror ingests them on its **next sync pull**. There is deliberately **no importer-to-mirror write** — sync is the only ingest path into the mirror.

## Scope

**In:** mirror store (transactions + entities tables — exactly what the transactions tab reads), sync engine, fetch-seam fallback, offline entity-assignment state, wasm-inline build step, tests, CHANGELOG/README notes.
**Out:** mirroring summary/pnl/budgets/savings/accounts (other tabs keep failing offline with today's error states), service worker/PWA, offline write queue, chat/logs/traces surfaces, legacy `html.ts` dashboard, server-side endpoint changes (none needed), COOP/COEP headers (not needed — verify, don't add).

## Work items

### A. Shared pure read layer (behavior-preserving server extraction)

The mirror must return byte-for-byte the JSON the server returns for the same query. Rather than duplicating parsing/SQL blindly, extract the two small pure pieces both sides use. Neither new module may import anything (they must be safe for the UI bundle — see "Why the UI cannot import `src/db/*`" below).

1. **`src/db/transaction-where.ts` (NEW, zero imports)**
   - Move `TransactionFilters` here (the interface now lives in `queries.ts`).
   - Extract `buildTransactionWhere(filters): { whereSql: string; params: Record<string, unknown> }` **verbatim** from `getTransactions`' condition-building block (`src/db/queries.ts:141-190`): `dateStart`→`date >= @dateStart`, `dateEnd`→`date <= @dateEnd`, `category`→`category = @category`, `minAmount`→`amount >= @minAmount`, `maxAmount`→`amount <= @maxAmount`, `merchant`→`description LIKE @merchant` with `%…%` wrapping, `isRecurring`→`is_recurring = @isRecurring` (1/0), `accountId`→`account_id = @accountId`, `entityId`→`entity_id = @entityId`; conditions joined with `' AND '`, `whereSql = 'WHERE ' + joined` or `''`.
2. **`src/db/queries.ts` (MODIFY, no behavior change)**
   - `getTransactions` becomes: `const { whereSql, params } = buildTransactionWhere(filters); SELECT * FROM transactions ${whereSql} ORDER BY date DESC`.
   - Re-export the moved type so existing imports keep working: `export type { TransactionFilters } from './transaction-where.js';` (dashboard/api.ts and tools import it from `queries.js` today).
   - Existing `queries.test.ts` + `dashboard-api.test.ts` are the regression guard.
3. **`src/dashboard/transactions-query.ts` (NEW, pure — imports only the type above)**
   - `parseTransactionListParams(params: URLSearchParams): { filters: TransactionFilters; limit: number }` extracted **verbatim** from `apiTransactions` (`src/dashboard/api.ts:110-125`), including the exact edge behavior: `limit = parseInt(params.get('limit') ?? '100', 10)` (NaN preserved when `limit=` is empty — parity means replicating, not fixing), accountId/entityId via truthy-check + `parseInt`, `start`/`end`/`category`/`merchant` string truthy-checks.
4. **`src/dashboard/api.ts` (MODIFY, no behavior change)**
   - `apiTransactions` uses `parseTransactionListParams` + `getTransactions` + `txns.slice(0, limit)` exactly as today.

### B. Mirror store core (pure — runs under bun:test AND inside the worker)

Home: `src/dashboard/ui/src/store/` (per decision doc §7.1). Every module in B and C must be **browser-glue-free**: no `window`, `document`, `fetch`, `Worker`, `navigator`, OPFS, or wa-sqlite imports — root tests import them from `src/__tests__/` (precedent: `local-chat-bundle.test.ts` imports `../dashboard/ui/src/hybrid/core.js`).

5. **`src/dashboard/ui/src/store/types.ts` (NEW)**
   - `SqliteBinding` — structural interface for the **subset** of the better-sqlite3-style API the store uses: `prepare(sql) → { run(p?) → { changes: number }; all(p?) → Row[]; get(p?) → Row | undefined }`, `transaction(fn) → wrapped`, `pragma(sql) → unknown`, `close()`. Comment why it exists: the UI tsconfig must not transitively typecheck `src/db/compat-sqlite.ts` (which imports `bun:sqlite`, unavailable to the UI package), so the store depends on a structural shape, not the compat class.
   - `MirrorTransactionRow` / `MirrorEntityRow` — structural copies of the server row shapes (`transactions` table per `src/db/schema.ts:4-31`; `entities` per `schema.ts:370-383`). Copy the interfaces; do **not** `import type` from `src/db/queries.js`/`entity-queries.js` (type-only imports still drag `bun:sqlite` types into the UI typecheck). Add a comment pointing at the schema DDL as the source of truth.
   - `SyncPayload { profile: string; transactions: MirrorTransactionRow[]; entities: MirrorEntityRow[] }` — the schema version is a store constant, not wire data.
   - `MirrorState { available: boolean; profile: string | null; seeded: boolean; lastSyncedAt: string | null; online: boolean }`.
6. **`src/dashboard/ui/src/store/mirror-schema.ts` (NEW — the heart)**
   - `MIRROR_SCHEMA_VERSION = 1` — the **mirror-side schema-version marker**. There is no server endpoint exposing the CLI's schema version (verified: all routes in `server.ts` are `/api/*` handlers), so the marker is this constant. Maintenance rule in the doc comment: bump it whenever the DDL the mirror carries (via `TRANSACTIONS_TABLE`/`ENTITIES_TABLE`) or the sync payload shape changes — i.e., when the CLI's schema moves — and the next sync re-seeds from scratch.
   - Reuse the **server's own DDL constants** for mirror-table parity by construction: import `TRANSACTIONS_TABLE` and `ENTITIES_TABLE` from `src/db/schema.js` (pure string constants — check: `schema.ts` has zero imports). Mirror DDL = `TRANSACTIONS_TABLE` + `ALTER TABLE transactions ADD COLUMN sync_key TEXT;` + `CREATE UNIQUE INDEX idx_mirror_tx_sync_key ON transactions(sync_key);` + `ENTITIES_TABLE` + `mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)` + temp table `sync_incoming (sync_key TEXT PRIMARY KEY)` (+ `sync_incoming_entities (id INTEGER PRIMARY KEY)` for the reconcile step).
   - `getMeta(db, key)` / `setMeta(db, key, value)`.
   - `applySync(db: SqliteBinding, payload: SyncPayload): { seeded: boolean; upserted: number; deleted: number }` — the whole operation in **one transaction**:
     1. **Re-seed gate:** if stored meta `schema_version !== MIRROR_SCHEMA_VERSION` **or** meta `profile !== payload.profile` (or meta absent) → `DROP TABLE IF EXISTS transactions/entities/mirror_meta`, recreate schema, proceed as a full seed. This single rule covers first run, version-bump re-seed, and profile consistency.
     2. **Upsert transactions** keyed on their identity: `sync_key = row.external_id ?? \`id:${row.id}\``. Justification comment: the server enforces uniqueness among non-null external_ids via the partial unique index `idx_transactions_external_id` (`schema.ts:441`); rows with NULL external_id (legacy/edge) fall back to the server PK, which is stable per profile. One prepared statement per row: `INSERT INTO transactions (<all mirrored columns>, sync_key) VALUES (@…, @sync_key) ON CONFLICT(sync_key) DO UPDATE SET <col>=@col, …` — include `id` in the SET so mirror row ids track server ids across a server-side DB rebuild (external_id is what survives a rebuild; that is why the upsert key is external_id, per the task).
     3. **Reconcile deletions** against the full pulled set: insert every payload `sync_key` into temp `sync_incoming` (and every entity `id` into `sync_incoming_entities`), then `DELETE FROM transactions WHERE sync_key NOT IN (SELECT sync_key FROM sync_incoming)` and `DELETE FROM entities WHERE id NOT IN (SELECT id FROM sync_incoming_entities)`. Because each pull is the **complete** set, this makes server-side deletions disappear from the mirror. (Temp tables instead of a giant `NOT IN (@…)` param list — avoids SQLite variable limits and dialect risk.)
     4. **Upsert entities** on `id` (same pattern; the set is small).
     5. `setMeta` `schema_version` / `profile` / `last_synced_at`.
   - Every payload row is guaranteed a unique `sync_key` (non-null external_ids are unique server-side; null-external rows key on unique server PKs) — state that invariant in a comment.
7. **`src/dashboard/ui/src/store/mirror-reads.ts` (NEW)**
   - `mirrorGetTransactions(db, filters): MirrorTransactionRow[]` — `const { whereSql, params } = buildTransactionWhere(filters)` (import from `src/db/transaction-where.js`) + `SELECT * FROM transactions ${whereSql} ORDER BY date DESC` — **identical composition to `getTransactions`**, then `stripSyncKey(row)` each result so served rows are shape-identical to server JSON (SELECT * on the mirror includes the extra `sync_key` column; stripping removes it).
   - `mirrorGetEntities(db)` — `SELECT * FROM entities ORDER BY is_default DESC, name ASC` (verbatim copy of `getEntities` in `src/db/entity-queries.ts:38` — that module can't be imported by the UI because it type-imports `queries.js` → `bun:sqlite` drag; the parity test pins the copy).
   - `serveApiPath(db, path: string): unknown | null` — route `/api/transactions?…` (parse with `parseTransactionListParams` from `src/dashboard/transactions-query.js` → `mirrorGetTransactions` → `rows.slice(0, limit)`, replicating `apiTransactions` exactly, NaN limit included) and `/api/entities` → `mirrorGetEntities(db)`. Anything else → `null` (caller keeps the original error).

### C. Sync engine (pure)

8. **`src/dashboard/ui/src/store/sync-engine.ts` (NEW)**
   - `SYNC_PULL_LIMIT = 10_000_000` — the unbounded query: `apiTransactions` does `txns.slice(0, limit)` with no cap, so a huge limit returns the full set; **no server change needed** (verified against `src/dashboard/api.ts:125`).
   - `SyncFetcher { fetchActiveProfile(): Promise<string>; fetchAllTransactions(): Promise<MirrorTransactionRow[]>; fetchAllEntities(): Promise<MirrorEntityRow[]> }` — the browser client implements it with authed `api()` calls (`/api/profiles`, `/api/transactions?limit=${SYNC_PULL_LIMIT}`, `/api/entities`); tests implement it with fakes.
   - `runSync(db, fetcher): Promise<SyncResult>` — fetch profile + both payloads → `applySync(db, payload)`; return `{ ok: true, seeded, upserted, deleted, profile }`. On any fetch rejection: return `{ ok: false }` **without mutating mirror data** (the mirror keeps serving its last good set); the client flips `online=false`. Idempotent; a profile change mid-stream is handled by `applySync`'s meta gate (drop + re-seed into the same pool after the client rekeys — see D).

### D. Browser glue (isolated — nothing under bun:test imports these)

9. **`src/dashboard/ui/package.json` (MODIFY)** — add `"wa-sqlite": "1.0.0"` (exact version per the decision doc's measurement) to `dependencies`; run `npm install` in `src/dashboard/ui` so `package-lock.json` updates (that lockfile change is committed). Root `package.json`/`bun.lock` untouched.
10. **`src/dashboard/ui/vite.config.ts` (MODIFY)** — add a `waSqliteWasmInline()` plugin (define it inline in the config or as a sibling `wasm-inline-plugin.ts`): `resolveId`/`load` hooks for `virtual:wa-sqlite-wasm` that read `node_modules/wa-sqlite/dist/wa-sqlite.wasm` (resolve relative to the ui package via `createRequire`) and emit `export default "<base64>"`. **Nothing else changes in the config or server:**
    - No COOP/COEP headers — wa-sqlite's `AccessHandlePoolVFS` explicitly needs none (decision doc §5.4).
    - No static-asset route — the wasm rides inside the single-file bundle (decision doc §5.2, measured 805 KB single file); `server.ts` and the dev proxy (`/api`, `/assets` already proxied) stay as they are.
    - This is the task's "Backend delivery" item resolved by **verification, not code**: build, then confirm `dist/` contains only `index.html` and no separate `.wasm` asset needs serving.
11. **`src/dashboard/ui/src/vite-env.d.ts` (NEW)** — `/// <reference types="vite/client" />` so `?worker&inline` imports typecheck.
12. **`src/dashboard/ui/src/store/virtual-wasm.d.ts` (NEW)** — declare `module 'virtual:wa-sqlite-wasm' { const wasmBase64: string; export default wasmBase64; }`.
13. **`src/dashboard/ui/src/store/sql-params.ts` (NEW, pure — testable)** — `extractNamedParams(sql): string[]`: the ordered `@name` tokens of a SQL string. The wa-sqlite adapter uses it to bind params objects positionally (wa-sqlite's API differs from bun:sqlite's named binding); tested under bun so the only untested part of the adapter is the raw wa-sqlite call surface.
14. **`src/dashboard/ui/src/store/wa-sqlite-adapter.ts` (NEW, browser-only)** — build a `SqliteBinding` over wa-sqlite + `AccessHandlePoolVFS`:
    - Init wa-sqlite with `wasmBinary` = decoded bytes of the virtual module (nothing fetched at runtime).
    - Pool directory per profile: `wilson-mirror-` + `encodeURIComponent(profileName)` (per-profile keying per decision doc §6). One pool open at a time; `setProfile` closes and reopens with the next profile's directory.
    - On open: `PRAGMA locking_mode=exclusive`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON` (the single-connection restriction makes these free wins, per the VFS docs recorded in the decision doc §5.3).
    - Implement `prepare().run/all/get` with `@name` → positional binding via `extractNamedParams`; implement `transaction(fn)` (BEGIN/COMMIT/ROLLBACK) and `pragma()`. Verify the exact wa-sqlite import paths (`wa-sqlite` main entry + `wa-sqlite/src/examples/AccessHandlePoolVFS.js`) against the installed package at implementation time and record them in the module header.
15. **`src/dashboard/ui/src/store/mirror-worker.ts` (NEW, browser-only)** — the dedicated Worker (bundled with `?worker&inline` so it lives inside the single-file build). Owns the single wa-sqlite connection and all OPFS/wasm glue (SyncAccessHandles are worker-only — decision doc §5.3). Message protocol: `{ id, type: 'init' | 'applySync' | 'serve' | 'setProfile', … }` — `init` builds the adapter + mirror schema for a profile; `applySync` runs `applySync`; `serve` runs `serveApiPath` and returns the rows; `setProfile` closes/reopens the pool (fresh/empty until the next sync seeds it).
16. **`src/dashboard/ui/src/store/mirror-client.ts` (NEW, browser-only singleton)**
    - `initMirror(): Promise<MirrorState>` — idempotent (module-level promise; React StrictMode double-mounts in dev): spawn the inline worker, init with the **last-known profile** (persisted in `localStorage` under `wilson_mirror_profile` on every successful sync — this is what makes an offline *reload* open the right profile's mirror; fall back to `'default'`), and fire-and-forget `navigator.storage.persist()` (decision doc §5.3). Any failure (no OPFS, private mode, **second tab losing the pool lock**) → `available: false`; the app silently degrades to network-only, exactly the fallback posture recorded in the decision doc §6.
    - `syncMirror(): Promise<void>` — runs `runSync` over RPC with in-flight dedupe; success → `online: true`, persist `lastKnownProfile`; network failure → `online: false` (mirror data retained).
    - `tryMirror(path): Promise<unknown | null>` — await `ensureReady` (cap ~4 s so an offline reload waits out worker/wasm boot), then RPC `serve`; `null` when unavailable / never seeded / not a mirrored path.
    - `getMirrorState()` + `subscribeMirrorState(listener)` for UI status.
17. **`src/dashboard/ui/src/hooks/useMirrorSync.ts` (NEW)** — `useMirrorSync()`: on mount `initMirror()` + `syncMirror()`, then `setInterval(syncMirror, 60_000)` (full-set pulls are cheap at dashboard scale; the constant is tunable); cleanup on unmount. Also export `useMirrorStatus()` (useSyncExternalStore over `subscribeMirrorState`). **`src/dashboard/ui/src/App.tsx` (MODIFY):** call `useMirrorSync()` once at the top level.

### E. The single fetch seam

18. **`src/dashboard/ui/src/store/offline-writes.ts` (NEW, pure — testable)**
    - `class RequiresConnectionError extends Error`.
    - `isNetworkError(err): boolean` — fetch's `TypeError` ("Failed to fetch"), "fetch failed", "NetworkError" — i.e. connection-level failure, NOT HTTP status errors.
    - `classifyWriteError(err): 'requires-connection' | 'failed'` — `RequiresConnectionError`/network errors → `'requires-connection'`; anything else (401/403/400/500) → `'failed'`.
    - `resolveFetchOutcome({ isWrite, networkError, mirrored }): 'return-mirror' | 'throw-requires-connection' | 'rethrow'` — the decision helper `api()` calls, so the seam's logic is fully bun-testable: GET + network error + non-null mirror result → return mirror; write + network error → requires-connection; otherwise rethrow the original.
19. **`src/dashboard/ui/src/api.ts` (MODIFY — the one seam, keep it thin)**
    - Keep header/token construction and the success path exactly as today.
    - On `!res.ok`: unchanged (throw `API <status>` — the server is reachable; never fall back, never claim "requires connection" for HTTP errors).
    - On network-level rejection: compute `resolveFetchOutcome` — for GETs on mirrored paths call `tryMirror(path)` and return the result; writes throw `RequiresConnectionError`; anything else rethrows the original error. Writes are **never** served from the mirror.
    - `authedFetch` (hybrid chat) untouched.

### F. Transactions tab

20. **`src/dashboard/ui/src/tabs/TransactionsTab.tsx` (MODIFY)**
    - `EntityCell.handleChange`: replace `catch { /* silent */ }` with `classifyWriteError(err)` → render an inline status next to the select: `'requires-connection'` → "Requires connection — assignment not saved" (amber), `'failed'` → "Save failed" (red). The optimistic `onUpdate` already fires only on success, so the controlled select self-reverts on failure. The select stays enabled offline (entities are mirrored, so the column still renders) — the *attempt* surfaces the state, which is exactly the manual check.
    - Offline pill: when `useMirrorStatus().online === false && seeded`, show a small "Offline — showing synced data" pill beside the tab title (clarifies where the rows came from during the manual check; tiny).
    - Browsing/search/filter code paths need no logic changes — they consume whatever `api()` returns.

### G. Tests (root `src/__tests__/`, bun:test; CI runs each file in its own process)

21. **`src/__tests__/mirror-store.test.ts`** — `applySync` semantics over `bun:sqlite :memory:` (helper `createMirrorDb()` = `new Database(':memory:')` + `createMirrorSchema`, living in `mirror-schema.ts` so tests and worker share it):
    - Seed: empty mirror + payload → rows served with server-exact shape (no `sync_key` field), meta records version/profile/last_synced_at.
    - Refresh: edited amount/category/entity_id on an existing external_id updates in place; brand-new rows appear.
    - Reconcile: payload missing a previously synced external_id → row deleted (server-side deletion doesn't linger).
    - Upsert key: same external_id with a *different* server id (server DB rebuilt) → one mirror row, updated (no duplicate).
    - NULL external_id rows: keyed on `id:<serverId>`; reconcile works for them too.
    - Idempotency: applying the identical payload twice → unchanged row count.
    - Schema-version re-seed: pre-seed mirror with meta `schema_version = MIRROR_SCHEMA_VERSION - 1` → next `applySync` drops and re-seeds (old rows gone, payload rows present).
    - Profile change: stored `profile` ≠ payload `profile` → drop + re-seed.
22. **`src/__tests__/mirror-parity.test.ts`** — **the offline-parity gate** (acceptance criterion 2): build one server db via `createTestDb()` plus seeded rows carrying external_ids, entities, and account linkage; build a mirror db seeded from the server's own unbounded response (`apiTransactions(serverDb, {limit:huge})` + `apiEntities(serverDb)`). Then for a matrix of query-param sets assert **deep equality** between `apiTransactions(serverDb, params)` and `serveApiPath(mirrorDb, '/api/transactions?' + params)`: bare limit; start/end window; category; merchant LIKE (including case behavior); accountId; entityId; filter combinations; ordering (date DESC); limit slicing (500); NaN-limit edge. Plus `/api/entities` parity vs `apiEntities`. This is what "offline results = server results for the same query" means mechanically: offline the UI receives exactly `serveApiPath` output.
23. **`src/__tests__/mirror-sync-engine.test.ts`** — engine with fake fetchers:
    - Seed-then-refresh flow end-to-end; per-profile keying recorded.
    - Server down (fetcher throws a TypeError-like) → `{ ok: false }`, mirror data untouched; recovery on the next successful pull.
    - Profile switch mid-stream → re-seed for the new profile.
    - **Importer via sync:** insert rows "server-side" (mimicking what `POST /api/import` does — `insertTransactions` with derived external_ids), then a subsequent `runSync` ingests them — asserting the mirror only ever changed through sync, never by a direct write call.
24. **`src/__tests__/mirror-fallback.test.ts`** — seam logic: `isNetworkError` variants (TypeError vs HTTP-shaped errors); `classifyWriteError` mapping; `resolveFetchOutcome` for GET-mirrored / GET-unmirrored / write / no-mirror cases; `serveApiPath` returns `null` for unknown paths. Together with 21–23 this covers acceptance criteria 1–3's testable logic.

### H. Docs

25. **`CHANGELOG.md`** — one `feat:` bullet under `## [Unreleased] → ### Features` (repo convention).
26. **`README.md`** — short "Offline transactions" note (dashboard loads the last-synced mirror when the server is unreachable; entity assignment stays online-only) **including the unencrypted-at-rest acknowledgment**, mirroring decision doc §7.6.

## Design decisions worth remembering

- **Parity strategy.** The mirror does not re-import `src/db` modules (their `import type` chains pull `bun:sqlite` types into the UI typecheck). Instead: the *shared pure pieces* (`buildTransactionWhere`, `parseTransactionListParams`) are extracted once and used by both sides, the DDL constants are shared verbatim, and the residual copies (`SELECT * … ORDER BY date DESC`, `getEntities`' SQL, the slice-to-limit) are pinned by `mirror-parity.test.ts` deep-equality against the real server functions. Drift fails CI, not production.
- **Why `sync_key` exists.** The task's upsert key is `external_id`, but the column is nullable (partial unique index). `external_id ?? 'id:<serverId>'` keeps the mandated key for the 99% case and gives null rows a deterministic identity. The mirror's extra column is stripped from served rows so JSON parity holds.
- **Schema-version marker is mirror-side by necessity.** No server endpoint exposes the CLI schema version and the task forbids server changes; the constant lives in `mirror-schema.ts` with an explicit bump rule.
- **Fallback triggers only on connection-level failure.** HTTP errors (401/403/404/5xx) mean the server answered; serving mirror data or "requires connection" for those would lie. Fetch rejections (connection refused/reset — the "stop the server" manual check) trigger fallback.
- **Offline reload works** because `lastKnownProfile` is persisted client-side and `tryMirror` waits (≤4 s) for worker init before giving up; a previously-seeded mirror serves immediately, and the interval pull refreshes when the server returns.
- **Entity list is mirrored** even though it is not transaction data: the tab's Entity column and the assignment dropdown render from `/api/entities`; without them the offline assignment state could never be triggered.

## Verification

1. Fresh worktree: `bun install` (root) — and `cd src/dashboard/ui && npm install` (pulls wa-sqlite).
2. `bun run typecheck` — root tsconfig **and** the UI typecheck (`cd src/dashboard/ui && npx tsc -b` or via `npm run build`) must both pass; the store modules must not drag `bun:sqlite` types into the UI.
3. `bun test` — full suite, including the four new test files (CI runs each file in its own process; mirror that locally when iterating: `bun test src/__tests__/mirror-store.test.ts` etc.).
4. UI build: `cd src/dashboard/ui && npm run build` → confirm `dist/index.html` is the only artifact that matters (no emitted `.wasm` file needing a server route), and that it contains the inline worker + wasm base64.
5. Manual check (acceptance criterion 5): `bun run src/index.tsx --dashboard` (or `wilson --dashboard`) with a seeded profile → load the dashboard online → confirm the transactions tab works → stop the server (Ctrl-C on a standalone instance or kill the process) → reload the page → the transactions tab still browses, searches, and filters with the same data; assigning an entity shows the requires-connection state; restart the server → next interval sync restores online behavior (new pill gone, assignments succeed).
6. `git diff --stat` sanity: changes confined to `src/db/`, `src/dashboard/`, `src/__tests__/mirror-*.test.ts`, `CHANGELOG.md`, `README.md`.

## Risks / notes for the builder

- **wa-sqlite import paths** (`wa-sqlite` main entry, `src/examples/AccessHandlePoolVFS.js`, `dist/wa-sqlite.wasm`) must be verified against the installed 1.0.0 package — the decision doc measured the dist layout but the builder should confirm the exact export names from `node_modules/wa-sqlite` before wiring the adapter.
- **The only code under bun:test is the pure layer** (B, C, E's helpers, F's classifier). The wa-sqlite/worker/OPFS wiring is intentionally untested by CI (per decision doc §5.6) — the manual check is its gate. Keep mirror SQL to a conservative SQLite subset so the same strings behave identically under bun's SQLite and wa-sqlite's build.
- **Multi-tab:** a second tab cannot win the `AccessHandlePoolVFS` pool lock → `initMirror` must treat init failure as "mirror unavailable", never crash, never retry-loop.
- **Local bun is 1.3.14, CI pins 1.4.2** (`.bun-version`); nothing here should be 1.4-only, but avoid brand-new bun APIs.
- **Don't "fix" the NaN-limit edge while extracting `parseTransactionListParams`** — parity with `apiTransactions` includes replicating it; a test pins it.
- `MIRROR_SCHEMA_VERSION` starts at 1; nothing else in the repo needs bumping with it.
- Suggested PR title: `feat: offline transactions — sync-fed local mirror serves the dashboard transactions tab without a server`.