# Spike: Dashboard Offline Store — IndexedDB vs OPFS-backed sqlite-wasm

**Status:** Decision recorded 2026-09-20. The committed choice is in §6 — the human approving this PR is the checkpoint on it.
**Decided by:** docs-only spike (issue #74, decomposed from #53). No store code, no dependency changes, no sync endpoint in this PR.
**Method:** every library/runtime claim below was fetched from upstream documentation on **2026-09-20** and quoted with its URL; bundle numbers were **measured** with a scratch Vite project mirroring `src/dashboard/ui/vite.config.ts` (§5.2). Anything that could not be verified is marked `UNVERIFIED` rather than asserted.

## 1. What this spike decided

**The dashboard's offline store will be SQLite (wa-sqlite@1.0.0, synchronous build) on OPFS via its `AccessHandlePoolVFS`, delivered fully inline in the single-file build (wasm → build-time base64 → `wasmBinary`), with no COOP/COEP headers, and with all query + sync logic behind a `LocalStore` interface whose SQL is tested in-process against `bun:sqlite :memory:` under `bun:test`.**

Full rationale in §6. The rest of this document is the recorded evidence.

## 2. Context and constraints

The dashboard (`src/dashboard/ui/`, React 19 + Vite) has no local persistence or query layer — every view fetches `/api/*` live (`src/dashboard/ui/src/api.ts`), so nothing works offline. The CLI runs native `bun:sqlite` (`src/db/compat-sqlite.ts`), which cannot load in a browser. The operator's architecture note fixes the shape before any code is written:

- The store is a **read-optimized mirror** of the server's canonical SQLite database, kept fresh via sync from the dashboard server. It is not a second source of truth; the server DB remains canonical.
- **Ruled out up front** (operator decision, not revisited here):
  - the **File System Access API** (user-visible file picking, not suitable for an automatic per-profile mirror), and
  - **sharing the CLI's physical database file** (the browser cannot open it, and two writers on one SQLite file across process boundaries is not a design we want).
- Scope: the **React UI only**. The legacy fallback dashboard (`src/dashboard/html.ts`, served at `server.ts:120`) stays server-bound and is out of scope.
- The store must be **keyed per profile**: the server supports runtime profile switching (`src/dashboard/db-manager.ts`), so the browser mirror needs one storage namespace per profile name.
- **Accepted tradeoff (operator decision): the browser mirror is unencrypted at rest.** See §5.5 — it is stated in its own subsection so it cannot be missed.

## 3. The read contract the candidates are measured against

The comparison is against the dashboard's actual read shapes, not toy queries. All of these run server-side today against `bun:sqlite` through `src/db/compat-sqlite.ts` (a better-sqlite3-style shim over bun:sqlite):

| Read shape | Where | SQL features it needs |
|---|---|---|
| Transactions list + filters | `getTransactions` (`src/db/queries.ts:141`); `apiTransactions` slices to `limit` (`src/dashboard/api.ts:111`) | dynamic AND-composed predicates: `dateStart`/`dateEnd` range, `category` exact, `minAmount`/`maxAmount`, `merchant` as `description LIKE '%…%'`, `isRecurring`, `accountId`, `entityId`; `ORDER BY date DESC` |
| Client-side search (second pass) | `TransactionsTab.tsx:96` (`filtered = useMemo`) | JS `toLowerCase().includes()` over `merchant_name`/`description` — UI-side, store-agnostic |
| Daily spending | `getDailySpending` (`src/db/daily-queries.ts:48`) | `SUM(ABS(amount))`, `COUNT(*)`, `WHERE amount < 0`, `GROUP BY date`, range filter |
| Streak | `getStreak` (`src/db/daily-queries.ts:71`) | all-time daily totals + date walking in JS |
| Weekly summary | `getWeeklySummary` (`src/db/daily-queries.ts:162`) | week-window ranges, per-category grouping, top merchant |
| Budget countdown | `getBudgetCountdown` (`src/db/daily-queries.ts:237`) | per-budget sums + calendar math |
| Spending summary | `getSpendingSummary` (`src/db/queries.ts:212`) | `COALESCE(category,'Uncategorized')`, `SUM`, `GROUP BY category`, `amount < 0`, account/entity filters |
| P&L | `getProfitLoss` (`src/db/queries.ts:326`) | two grouped queries with sign/category special cases (`amount > 0 OR category = 'Income'`; exclusion set `NOT IN ('Income','Transfer')`) |
| Savings history | `getMonthlySavingsData` (`src/db/queries.ts:379`) | `strftime('%Y-%m', date)` month bucketing, `SUM(CASE WHEN …)` |
| Budget vs actual | `getBudgetVsActual` (`src/db/queries.ts:618`) | **`WITH RECURSIVE descendants` CTE rollup through `categories.parent_id`** (`queries.ts:656`) with case-insensitive `LOWER()` matching, per budget, plus a no-categories fallback |
| Mirror payload | `src/db/schema.ts` | `transactions` (24 columns incl. `external_id` UNIQUE, `plaid_transaction_id`, `updated_at` — sync keys), plus `accounts` (`schema.ts:101`), `categories` (`schema.ts:277`), `budgets` (`schema.ts:46`); adjacent read surfaces: `entities` (`schema.ts:371`), `goals`/`goal_snapshots` (`schema.ts:318`) |

Out of the mirror: `chat`/`logs`/`traces`/`interactions` tables are server-bound. Sync plumbing (**no `updatedSince` endpoint exists yet** — every route in `src/dashboard/server.ts` is a full read/write `/api/*` handler) is implementation-story work, deliberately not built in this spike.

## 4. Candidates as they would be built in this repo

- **A — IndexedDB used directly.** No dependency (a ~1–2 KB promise wrapper like `idb@8` counts as "direct" and is measured separately in §5.2). Object stores per table (`transactions`, `accounts`, `categories`, `budgets`, …) keyed per profile (database name `wilson-<profile>`); every filter becomes an index/range scan; every aggregation in §3 is rewritten in TypeScript inside the UI package. Home: `src/dashboard/ui/src/store/`.
- **B — Official SQLite WASM build** (`@sqlite.org/sqlite-wasm@3.53.4-build1`, SQLite team; SQLite is public domain). Two OPFS VFSes: `opfs` (async, SharedArrayBuffer-coordinated, multi-connection) and `opfs-sahpool` (SyncAccessHandle pool, single connection — added in SQLite v3.43, based on Roy Hashimoto's work). Home: `src/dashboard/ui/src/store/` + a wasm delivery decision (§5.2).
- **C — wa-sqlite** (`rhashimoto/wa-sqlite@1.0.0`, MIT since Feb 2023 per its README): WebAssembly SQLite with JS-implementable VFSes; the OPFS one matching this design is `AccessHandlePoolVFS` (synchronous methods, pre-opened access handles, single wa-sqlite instance). Runs inside a dedicated Worker we author ourselves (OPFS `SyncAccessHandle`s are worker-only — §5.3). Home: `src/dashboard/ui/src/store/` + inline worker.

## 5. Dimensions

### 5.1 Query expressiveness vs the read contract

**SQLite-WASM (B and C): the §3 SQL survives nearly verbatim.** The mirror can hold the same schema and the read functions can be ported with only the `bun:sqlite` binding swapped (the repo already has precedent for adapting SQLite bindings across runtimes: `src/db/compat-sqlite.ts` wraps bun:sqlite behind the better-sqlite3 API, and `daily-queries.ts`/`queries.ts` are pure SQL + thin binding calls). The `WITH RECURSIVE descendants` rollup (`queries.ts:656`), `strftime('%Y-%m', …)` month bucketing (`queries.ts:389`), `LIKE '%…%'` merchant search, and `LOWER()` case-insensitive matching all run in SQLite WASM unchanged. The sync story is likewise plain SQL: upsert mirror rows keyed on `external_id`/`plaid_transaction_id`.

**IndexedDB (A): every aggregation in §3 is rewritten in JS and held in parity by hand.** IndexedDB offers key-range scans on indexes — fine for the transactions list filters (date range, category, account) — but:
- `description LIKE '%…%'` has no index support (substring match on a non-prefix) → full-scan + JS filter per keystroke-driven query;
- `strftime` month bucketing, `SUM(CASE WHEN)` P&L splits, and the per-category groupings become hand-written reduce passes over all rows in range;
- the **budget-vs-actual recursive rollup through `categories.parent_id` becomes a hand-written graph traversal** with `LOWER()` matching — the single hardest piece of the read contract to keep behaviorally identical to `queries.ts:618`;
- `getStreak`'s date walking is already JS on both sides, so it ports trivially.

Every one of those rewrites must track future changes to `src/db/queries.ts` / `src/db/daily-queries.ts` as the server SQL evolves — a standing dual-implementation maintenance tax with no compiler or test help unless we build shared test fixtures that run both implementations against the same data (which is exactly the seam §5.6 requires anyway, so it is achievable — it is just permanent cost rather than a one-time port).

### 5.2 Bundle size under the single-file build, and wasm delivery

The server loads `src/dashboard/ui/dist/index.html` **as one string** and serves it inline at `/` (`src/dashboard/server.ts:57-58, 120`); `vite-plugin-singlefile` is in `vite.config.ts`; **there are no static-asset routes today**, so any file the store needs beyond `index.html` forces new `server.ts` routes (plus, eventually, service-worker caching for true offline).

**Measurement method:** scratch Vite project (outside the repo, no dependency changes here): Vite 6.4.3, `vite-plugin-singlefile@2.3.3` (repo pins `^2.0.3`), `target: 'esnext'`, stub entry mirroring the dashboard's shape. Candidates A: hand-written raw-IDB module (+ separately the `idb@8.0.3` wrapper). Candidates B/C: installed in the scratch project (`@sqlite.org/sqlite-wasm@3.53.4-build1`, `wa-sqlite@1.0.0`) and built under (i) the plugin's recommended config (inlines assets into the html) and (ii) `useRecommendedBuildConfig: false` + `assetsInlineLimit: 4096` (separate-asset path). Measured 2026-09-20, bun 1.4.2.

| Configuration | Files (raw B / gzip B) | Total raw / gzip |
|---|---|---|
| Baseline stub app | index.html 1,084 / 635 | 1,084 / 635 |
| **A: raw IndexedDB** (hand-written promise wrapper + filter/agg sketch) | index.html 2,214 / 1,112 | **2,214 / 1,112** (Δ +1,130 / +477 vs baseline) |
| **A: with `idb@8.0.3` wrapper** | index.html 5,712 / 2,369 | **5,712 / 2,369** (Δ +4,628 / +1,734) |
| **B: official, singlefile recommended config** | index.html 1,420,453 / 595,555 **+ `sqlite3-worker1-*.js` 1,374,072 / 576,814 — still required at runtime** (the oo1 API spawns this worker; the singlefile plugin does not inline it) | **2,794,525 / 1,172,369** — and the 849 KB wasm is base64-inlined **twice** (once per chunk, ~1.16 MB each) |
| **B: official, separate-asset path** | index.html 218,558 / 67,107 + `sqlite3.wasm` 868,907 / 403,212 + `sqlite3-worker1.js` 215,526 / 65,981 + `sqlite3-opfs-async-proxy.js` 32,505 / 10,561 | **1,335,496 / 546,861** — needs **three** new static-asset routes, not one |
| **C: wa-sqlite, wasm as separate file** | index.html 60,543 / 20,023 (all JS incl. our inline worker) + `wa-sqlite.wasm` 558,343 / 273,761 | **618,886 / 293,784** — needs **one** new static-asset route |
| **C: wa-sqlite, fully inlined** | index.html 805,090 / 366,550 | **805,090 / 366,550 — true single file** (see below) |

Delivery findings, per candidate:

- **A (IndexedDB): zero delivery cost** — nothing leaves `index.html`.
- **B (official): the single-file contract cannot be met.** The package's main entry (`dist/index.mjs`, 642,742 B unminified) internally spawns `sqlite3-worker1.mjs` via `new Worker(new URL(...))`; Vite emits that as a separate chunk the plugin refuses to inline (it is not a `<script>` in the html). Under the recommended config the build "succeeds" but the worker chunk 404s at runtime, and the wasm is base64-duplicated into both chunks (2.79 MB raw total). The separate-asset path works but requires routes for wasm + worker1 + opfs-async-proxy (three files), plus `Content-Type`/caching for each. There is no supported way to inline the worker (the package does not expose the subpath for `?worker&inline` treatment).
- **C (wa-sqlite): one extra file by default, or a true single file with a ~30-line build-time step.** Vite emits the wasm referenced via `new URL(..., import.meta.url)` as a separate asset regardless of `assetsInlineLimit` (verified: the plugin prints `NOTE: asset not inlined: assets/wa-sqlite-*.wasm`). But wa-sqlite's emscripten loader accepts `Module.wasmBinary` and recognizes `data:application/octet-stream;base64,` URLs (verified in `dist/wa-sqlite.mjs`), so a build-time script that emits the wasm as a base64 TS constant (`744,460` base64 chars = 558,343 × 4/3) and passes `wasmBinary` yields a **true single-file** build: measured index.html 805,090 B / 366,550 gzip. (The build still emits the now-unused wasm asset; it is never fetched and can be deleted post-build.) Our worker itself must be authored by us anyway (OPFS SyncAccessHandles are worker-only, §5.3), and Vite's `?worker&inline` fully inlines it — verified in the measurement.
- Sanity bands held: wasm binaries ~0.5–1 MB (wa-sqlite sync build 558 KB; official 849 KB), `idb` wrapper ~1–2 KB gzipped (+1,734), raw IDB wrapper ≈ 1 KB gzipped (+477).

### 5.3 Offline durability and persistence semantics

Verified against upstream docs (URLs + access date below); both OPFS and IndexedDB live under the same per-origin storage regime, so this dimension **does not separate** the candidates:

- **Best-effort by default; `navigator.storage.persist()` opts out of eviction.** MDN: data is "best-effort" by default, and LRU storage-pressure eviction "only applies to origins that are not persistent and skips over origins that have been granted data persistence by using navigator.storage.persist()" ([MDN Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — accessed 2026-09-20; page last modified Jan 5, 2026). `persist()` "requests permission to use persistent storage, and returns a Promise that resolves to true if permission is granted" and "The browser may or may not honor the request, depending on browser-specific rules" ([MDN StorageManager.persist()](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) — accessed 2026-09-20). MDN also notes Chrome-team research: "data is very rarely deleted by the browser" for regularly-visited origins.
- **Safari's 7-day cap.** WebKit ITP deletes "all of a website's script-writable storage after seven days of Safari use without user interaction on the site", listing IndexedDB, LocalStorage, SessionStorage, Service Worker registrations and cache ([WebKit blog, Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) — accessed 2026-09-20). MDN's current phrasing: "If an origin has no user interaction, such as click or tap, in the last seven days of browser use, its data created from script will be deleted," gated on cross-site tracking prevention being on (same MDN quotas page, accessed 2026-09-20). For this dashboard the origin is the operator's own first-party server, so the practical risk is low — but the mirror is by design **rebuildable from a full sync**, which is the real mitigation. **UNVERIFIED — whether Safari's 7-day cap applies to OPFS specifically**: the 2021 WebKit list predates OPFS shipping and does not name it; MDN's broader "data created from script" phrasing suggests it does. Treat OPFS-in-Safari eviction as unproven; the rebuild-from-sync fallback covers it either way.
- **Private/incognito modes.** MDN: "in private browsing mode … stored data is usually deleted when the private browsing mode ends" (quotas page, accessed 2026-09-20). The official SQLite WASM docs additionally warn persistence "will, when run in such a 'stealth' mode, either be more limited than the documentation suggests, or may even be completely unavailable" ([sqlite.org/wasm/doc/trunk/persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md) — accessed 2026-09-20).
- **OPFS-specific operational semantics** (from [sqlite.org/wasm/doc/trunk/persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md) — accessed 2026-09-20): the `opfs` VFS coordinates concurrency via `SharedArrayBuffer`; `opfs-sahpool` "does not support multiple simultaneous connections", has "no filesystem transparency" (client-level names are remapped into a private directory — fine for a per-profile mirror namespace), and "Installation will fail if … the VFS is already active in another browsing context in the same HTTP origin" (multi-tab note in §6). SyncAccessHandles "are only available in Worker threads, not the main UI thread" (same page) — corroborated by the MDN File System API worker examples ([MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — accessed 2026-09-20; OPFS "is private to the origin of the page and not visible to the user"). wa-sqlite's own VFS table marks `AccessHandlePoolVFS` "Full durability ✅", Worker-only context, no multiple connections, and notes the single-instance restriction enables `PRAGMA locking_mode=exclusive` + WAL ([wa-sqlite src/examples README](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison) — accessed 2026-09-20).
- **Quotas.** OPFS limits are "generous but differ per environment" (official SQLite docs); MDN quotes per-origin quotas far above any plausible mirror (Firefox best-effort 10% disk / 10 GiB group cap; Chromium 60% of disk) (both accessed 2026-09-20). A transaction mirror is orders of magnitude below these.

### 5.4 Cross-origin isolation (COOP/COEP) requirements

**Verified against current upstream documentation, not prior knowledge.** (All accessed 2026-09-20.)

- **Official build, `opfs` VFS — COOP/COEP required.** [sqlite.org/wasm/doc/trunk/persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md), section "⚠️Achtung: COOP and COEP HTTP Headers": "JavaScript's `SharedArrayBuffer` type is required for the OPFS VFS, and that class is only available if the web server includes the so-called COOP and COEP response headers when delivering scripts … Without these headers, the `SharedArrayBuffer` will not be available, so the OPFS VFS will not load." The documented values: `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Opener-Policy: same-origin` (a `credentialless` COEP is noted as possibly workable).
- **Official build, `opfs-sahpool` — not required, explicitly recommended in that case.** Same page: "clients which value performance more than concurrency, or are unable to set the COOP/COEP response headers, should use the 'opfs-sahpool' VFS." Its listed advantages include "Does not require COOP/COEP HTTP headers (and associated restrictions)" and "Easily the highest OPFS performance of the options described in this documentation"; it "should work on all major browsers released since March 2023" (the `opfs` VFS carries a Safari < 17 caveat).
- **wa-sqlite — not required.** The VFS comparison table's "No COOP/COEP requirements" row is ✅ for **all** wa-sqlite VFSes, including `AccessHandlePoolVFS` ([wa-sqlite src/examples README](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison) — accessed 2026-09-20).

**Consequence for this codebase:** the dashboard server is `Bun.serve` with a per-request `headers` record (`src/dashboard/server.ts:70-78`) shared by every response — auth, exports, profile switching included. Choosing the official `opfs` VFS would mean adding COOP/COEP to **every** response the server emits, plus auditing every cross-origin embed the UI might use. Choosing `opfs-sahpool` (official) or wa-sqlite's `AccessHandlePoolVFS` avoids the header change entirely. That is a hard requirement in a single-operator local tool, where COOP/COEP buys nothing (no third-party embeds) and risks breaking the auth/export flows for no benefit.

### 5.5 Unencrypted at rest — explicitly accepted tradeoff

**The browser mirror is unencrypted at rest. The CLI's profile database is not. This is an accepted difference, stated here so nobody discovers it later.**

- The CLI encrypts profile databases with SQLCipher on macOS — key generated/stored in the OS keychain (`src/db/encryption-key.ts`, `docs/plans/2026-04-12-001-feat-sqlcipher-encryption-plan.md`), applied via `Database.setCustomSQLite(sqlcipher.dylib)` + `PRAGMA key`. That mechanism is native dylib swapping; **neither SQLCipher nor any equivalent runs inside the browser candidates here.** IndexedDB and OPFS both store plaintext bytes under the browser's origin storage.
- Why this is accepted: the data being mirrored is exactly the data the dashboard already renders in the browser session (the same operator, same machine, same browser profile — the dashboard server itself is a localhost first-party process). The browser's origin storage is not readable by other origins, and there is no practical key-delivery path: the keychain is not accessible to a web page, and embedding a key in the single-file bundle would be security theater (the bundle is served to the same browser). Real mitigations remain available: full-disk encryption (FileVault) protects the storage at the OS layer, and the mirror is rebuildable — it can be dropped and re-synced at any time.
- Consequence worth stating: if a threat model ever requires at-rest encryption of the mirror, the answer is "do not keep a browser mirror" (or keep only non-sensitive aggregates), not "add encryption to IndexedDB/OPFS". This tradeoff does not differ between candidates A, B, and C — it does not separate them, but it must be acknowledged before implementation starts.

### 5.6 Testability under bun:test

`bun:test` has no IndexedDB and no OPFS. The repo's harness (`bun test`, `package.json:19`) runs in-process against in-memory `bun:sqlite` via `createTestDb()` helpers (`src/__tests__/helpers.ts`), and `src/__tests__/compat-sqlite.test.ts` is the precedent for testing a SQLite binding shim without a browser.

**The committed choice must include the seam**, and it does (§6): a `LocalStore` interface owned by the UI package, e.g.:

```ts
// src/dashboard/ui/src/store/types.ts (illustrative)
interface LocalStore {
  init(profileName: string): Promise<void>;
  applySync(payload: SyncPayload): Promise<void>;   // mirror tables: transactions, accounts,
                                                    // categories, budgets; adjacent: entities,
                                                    // goals/goal_snapshots
  getTransactions(filters: TransactionFilters): Promise<TransactionRow[]>;
  getDailySpending(start: string, end: string): Promise<DailySpendingRow[]>;
  getStreak(dailyBudget?: number): Promise<StreakResult>;
  getWeeklySummary(): Promise<WeeklySummaryResult>;
  getBudgetCountdown(): Promise<BudgetCountdownRow[]>;
  getSpendingSummary(start: string, end: string, accountId?: number, entityId?: number): Promise<SpendingSummaryRow[]>;
  getProfitLoss(start: string, end: string, accountId?: number, entityId?: number): Promise<ProfitLossRow>;
  getMonthlySavingsData(endMonth?: string, months?: number, accountId?: number, entityId?: number): Promise<MonthlyIncomeExpense[]>;
  getBudgetVsActual(month: string, accountId?: number, entityId?: number): Promise<BudgetVsActualRow[]>;
}
```

- **Browser implementation** (`wa-sqlite-store.ts` + worker): owns all browser-only glue — wasm instantiation, worker startup, `AccessHandlePoolVFS` setup, per-profile pool naming, `navigator.storage.persist()` request. None of it is importable under `bun:test`; all of it is isolated behind the interface.
- **Query logic stays on the mirror side of the seam, in SQL.** Because the mirror is SQLite, the read functions are the same SQL as `src/db/queries.ts`/`src/db/daily-queries.ts` executed through a thin binding — so the in-process test driver can run that identical SQL against `bun:sqlite :memory:` (through `src/db/compat-sqlite.ts`, whose param-translation shim is already covered by tests). Query parity with the server is then enforced by tests, not by hope; the only untested-under-bun surface is the wasm/VFS/worker wiring, which is intentionally minimal.
- Under candidate A the same seam is possible, but the query logic is the JS rewrites of §5.1 — the test driver would exercise the rewrites directly, with `src/db` SQL as the reference oracle. Possible, but the parity burden is permanent rather than ported once.

## 6. Decision

**Committed: wa-sqlite@1.0.0 (synchronous build) with `AccessHandlePoolVFS`, running in an inline-bundled dedicated Worker, delivered fully inside the single-file `index.html` (wasm inlined via build-time base64 → `wasmBinary`), requiring no COOP/COEP headers, with the `LocalStore` seam of §5.6 and SQL-backed query logic tested against `bun:sqlite :memory:` under `bun:test`.** Per-profile isolation = one AccessHandlePoolVFS pool directory per profile name; profile switching closes and re-opens the pool with the next profile's directory.

Rationale, tied to the dimensions:

1. **Expressiveness (§5.1) is the deciding dimension.** The read contract's hardest query — `getBudgetVsActual`'s recursive CTE rollup through `categories.parent_id` with case-insensitive matching — plus `strftime` bucketing, `LIKE` search, and eight grouped aggregations run unchanged as SQL on the mirror. IndexedDB would require hand-rewriting all of it in JS with permanent parity maintenance against `src/db/*-queries.ts`. Reusing the server's SQL is also the only approach whose correctness can be *tested* into parity under `bun:test` (§5.6), rather than maintained by review.
2. **Delivery (§5.2) works for C and cannot work for B.** Measured: wa-sqlite builds to a true single file (805,090 B raw / 366,550 gzip, +367 KB gzip over the measured baseline class of the dashboard) with a ~30-line build step; the official package cannot meet the single-file contract at all (its internal worker1 chunk cannot be inlined; the separate-asset path needs three new routes and 1.34 MB raw). The inline cost is acceptable for a local single-operator tool whose "bundle" is served from the operator's own machine.
3. **No COOP/COEP (§5.4).** Verified against current upstream docs: the official `opfs` VFS requires COOP/COEP response headers on every server response; `opfs-sahpool` and wa-sqlite's `AccessHandlePoolVFS` explicitly do not. For `Bun.serve` at `server.ts:70`, avoiding a global response-header change is worth real weight; the sahpool/AccessHandlePool trade (single connection, no multi-tab) is acceptable for a single-operator mirror and is a recorded reopen condition below.
4. **Durability (§5.3) does not separate the candidates** — OPFS and IndexedDB share the best-effort/persistent/eviction regime — so the tie-breakers are 1–3. wa-sqlite's VFS table marks AccessHandlePoolVFS full-durability ✅, and the mirror is rebuildable from sync under any eviction (Safari 7-day ITP included), so persistence semantics pose no additional risk.
5. **Unencrypted at rest (§5.5)** is accepted explicitly for the mirror and is identical across candidates; it is called out as its own subsection rather than buried, per the spike's mandate.

**Conditions that would reopen this decision:**

- **A static-asset route + service-worker caching story lands in the dashboard anyway** (e.g. for PWA work). Then the delivery path can flip from inline wasm (805 KB single file) to a separate wasm file (618,886 B total raw / 293,784 gzip — §5.2's C row) without touching the store choice, schema, or SQL. The store decision stands; only the delivery step changes.
- **Multi-tab concurrent access to the mirror becomes a requirement.** AccessHandlePoolVFS is single-connection by design (verified §5.3); today a second dashboard tab would fail pool init and should fall back to live `/api/*` fetches until coordination (Web Locks / BroadcastChannel handoff) is implemented. If true multi-tab mirrors are wanted, the alternatives are wa-sqlite's `OPFSCoopSyncVFS` or the official `opfs` VFS + COOP/COEP — a deliberate, separate decision.
- **wa-sqlite maintenance stalls** (single upstream maintainer; the official build has the SQLite team behind it). The escape hatch is a port of the same SQL to the official build's `opfs-sahpool` VFS, which is API-different but semantically equivalent (the official docs credit Hashimoto's AccessHandlePool design as its basis — §5.3). The `LocalStore` seam makes that swap an implementation change, not a redesign. Note this fallback inherits the official package's delivery problem (worker1 chunk), so it pairs naturally with the static-asset-route reopen above.
- **OPFS unavailable in the user's browser** (Safari < 16.4, private mode): not a store change — the store simply does not activate and the UI falls back to live fetches, with a full re-sync on next availability.

Rejected, with the reason recorded:

- **A (IndexedDB direct)** — rejected on expressiveness + testability-of-parity (§5.1, §5.6), despite the smallest bundle (§5.2) and zero delivery cost. If a future store only needs key-value caching of rendered responses (not the read contract), an IndexedDB cache can be layered on top later without this decision's revision.
- **B (official build, `opfs` VFS)** — rejected on COOP/COEP (§5.4) and delivery (§5.2).
- **B (official build, `opfs-sahpool`)** — rejected on delivery alone (§5.2): same worker1 architecture problem as the `opfs` VFS, and no inline path.

## 7. What implementation stories inherit (no code in this PR)

1. **Store interface + types** (`src/dashboard/ui/src/store/types.ts`): `LocalStore` per §5.6, `SyncPayload` covering the mirror tables of §3, per-profile keying rules.
2. **wa-sqlite adapter**: inline worker (`?worker&inline`) owning `AccessHandlePoolVFS` + `PRAGMA locking_mode=exclusive` + WAL (the single-instance restriction makes these free wins per the VFS docs); build-time wasm inliner (base64 → `wasmBinary`) added to the UI build; `@types` for the small wa-sqlite surface used.
3. **Sync client**: since no `updatedSince` endpoint exists (`server.ts` routes verified §3), the first sync story is either a full-snapshot bootstrap or the new endpoint — its own story, built against `LocalStore.applySync`.
4. **In-process test driver**: same SQL against `bun:sqlite :memory:` via `src/db/compat-sqlite.ts`; parity fixtures shared with `createTestDb()` helpers.
5. **Server consequences recorded, not built**: no header changes (committed choice needs none); no new static routes (inline delivery); if the reopen flips delivery to a separate wasm, `server.ts` gains exactly one route (`/assets/wa-sqlite.wasm` with `Content-Type: application/wasm`).
6. **Privacy docs**: mirror the unencrypted-at-rest acknowledgment (§5.5) into README/docs when the store lands.