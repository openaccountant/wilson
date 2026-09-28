# Plan: Spike — record IndexedDB vs OPFS-backed sqlite-wasm comparison and commit the dashboard offline-store technology

**Repo:** `/Users/jdfiscus/.spf/watch/wilson/worktrees/issue-74` (branch for issue #74, decomposed from #53)
**Goal:** Produce and commit one decision document — a codebase-grounded comparison of **IndexedDB used directly** vs **a SQLite-WASM layer backed by OPFS** (wa-sqlite or the official SQLite WASM build) for the dashboard's local transaction store — ending in a committed choice with rationale. This is a docs-only spike: no store implementation, no dependency changes, no sync endpoint.

## Why this exists

The dashboard (`src/dashboard/ui/`, React 19 + Vite) has no local persistence or query layer — every view fetches `/api/*` live (`src/dashboard/ui/src/api.ts`), so nothing works offline. The CLI runs native `bun:sqlite` (`src/db/compat-sqlite.ts`), which cannot load in a browser. The operator's architecture note fixes the shape before any code is written:

- The store is a **read-optimized mirror** of the server's canonical SQLite DB, kept fresh via sync from the dashboard server. It is not a second source of truth.
- **Ruled out:** the File System Access API, and sharing the CLI's physical database file.
- The store lives in the **React UI** only. The legacy fallback dashboard (`src/dashboard/html.ts`) stays server-bound and is out of scope.
- The browser mirror is **unencrypted at rest** — unlike the CLI's SQLCipher-encrypted profile DB (`docs/plans/2026-04-12-001-feat-sqlcipher-encryption-plan.md`, Track A via `Database.setCustomSQLite` + `PRAGMA key`). This tradeoff is explicitly accepted and must be stated, not buried.

Before implementation stories start, one technology must be committed on recorded evidence. The human approving the spike PR is the checkpoint on that committed choice.

## Deliverable (one file + one changelog line)

1. **`docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md`** — following the existing plan-doc convention in `docs/plans/` (`YYYY-MM-DD-NNN-<kebab-name>.md`; 001 = sqlcipher encryption, 002 = encryption pivot). Before writing, confirm the next serial number is still free: `ls docs/plans/` and `git log --oneline -- docs/plans/`. If 003 is taken, bump to 004, etc.
2. A one-line CHANGELOG entry under `## [Unreleased]` pointing at the decision doc (see how #34's PR added its line to `CHANGELOG.md`).

Nothing else in the repo changes. Do not add dependencies to the root `package.json` or `src/dashboard/ui/package.json` — candidate packages are measured in a scratch project (below). After the spike, `git diff` must show only: the new doc, `CHANGELOG.md`, and this spec copy.

## The read contract the comparison must be measured against

The doc must compare both candidates against the dashboard's **actual** read shapes (not toy queries). Ground each shape in code, citing file + function:

- **Transactions list + client-side search** — `getTransactions(db, filters)` (`src/db/queries.ts:141`): optional `dateStart`/`dateEnd`, `category` (exact), `minAmount`/`maxAmount`, `merchant` (SQL `LIKE %…%` on description), `isRecurring`, `accountId`, `entityId`; ordered `date DESC`, then sliced to `limit` (`apiTransactions`, `src/dashboard/api.ts:110`). The UI does a **second, client-side text filter** over the returned rows (`src/dashboard/ui/src/tabs/TransactionsTab.tsx:96-108`).
- **Overview aggregations** — `src/db/daily-queries.ts`: `getDailySpending` (GROUP BY date), `getStreak` (all-time daily totals + date walking), `getWeeklySummary` (week windows, by-category grouping, top merchant), `getBudgetCountdown` (per-budget sums).
- **Summaries** — `getSpendingSummary` (`queries.ts:212`), `getProfitLoss` (`queries.ts:326`), `getMonthlySavingsData` (`queries.ts:379`), and `getBudgetVsActual` (`queries.ts:618`) with its **recursive CTE rollup through the `categories` hierarchy** (`parent_id`) and case-insensitive category matching.
- **Mirror payload implication** — `transactions` columns (`src/db/schema.ts:4-31`), plus the tables the read contract touches: `accounts`, `categories`, `budgets` (and note `goals`/`goal_snapshots`, `entities` as adjacent read surfaces; chat/logs/traces/interactions are server-bound and excluded). Sync keys already in the schema: `external_id` (unique), `plaid_transaction_id`, `updated_at`. **No `updatedSince` sync endpoint exists yet** (`src/dashboard/server.ts` routes are all `/api/*` reads/writes) — the doc should note this as implementation-story work, not build it.
- **Per-profile keying** — the dashboard supports runtime profile switching (`src/dashboard/db-manager.ts`); the offline store must be keyed per profile (store name / database name = profile name).

## Required dimensions in the doc

Record each dimension for **all three variants**: (A) IndexedDB used directly (raw API; a ~1–2 KB promise wrapper like `idb` counts as "direct" if the doc says so explicitly), (B) official SQLite WASM build (`@sqlite.org/sqlite-wasm`) with OPFS, (C) wa-sqlite (`rhashimoto/wa-sqlite`) with its `opfs-sahpool` VFS.

1. **Query expressiveness vs the read contract.** How much of the SQL above survives under each option? SQLite-WASM reuses the existing SQL nearly verbatim (recursive CTE, GROUP BY, LIKE) — and `src/db/compat-sqlite.ts` is repo precedent for adapting SQLite bindings across runtimes. IndexedDB needs every filter as an index/range scan and every aggregation rewritten in JS, with the server SQL as the reference semantics — enumerate which aggregations get rewritten and who keeps them in sync with `src/db/*-queries.ts`.
2. **Bundle size under the single-file build + WASM delivery.** The server loads `src/dashboard/ui/dist/index.html` as one string and serves it inline at `/` (`src/dashboard/server.ts:53-58, 119-127`); `vite-plugin-singlefile` is in `vite.config.ts`; there are **no static-asset routes today**. Measure (see procedure below) what the single-file build actually does with a `.wasm` asset: inlined as base64 (~+33% size) vs emitted as a separate file (which forces a **new static-asset route** in `server.ts`, e.g. `/assets/sqlite3.wasm` with the right `Content-Type`, and later service-worker caching). Record raw + gzip numbers for each candidate and each delivery path.
3. **Offline durability & persistence semantics.** IndexedDB eviction rules and `navigator.storage.persist()`; OPFS durability characteristics and the operational differences between the official `opfs` VFS (synchronization via workers/SharedArrayBuffer) and wa-sqlite's `opfs-sahpool` (synchronous access handles, single connection at a time). Safari's 7-day script-writable-storage eviction (WebKit ITS) and private-mode behavior must be covered. Verify all of this against current upstream docs (next section) — cite each claim with URL + access date.
4. **Cross-origin isolation.** The official SQLite `opfs` VFS is documented to require COOP/COEP headers (SharedArrayBuffer); wa-sqlite's `opfs-sahpool` is reported not to. **Verify both against current upstream documentation, not prior knowledge**, and record the consequence for this codebase: `Bun.serve` (`src/dashboard/server.ts:70`) would need `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response headers — which change every response the server emits (auth, exports, profile switching included).
5. **Unencrypted-at-rest tradeoff.** Call out explicitly: the CLI profile DB is SQLCipher-encrypted on macOS (keychain key, `src/db/encryption-key.ts`, `docs/plans/2026-04-12-001`); the browser mirror is plaintext in the browser's origin storage. State why this is accepted (data already rendered in the browser session; same machine, same user profile; browser storage cannot practically be encrypted without a key-delivery problem). Put this in its own subsection so a maintainer cannot miss it.
6. **Testability under bun:test.** The harness has no IndexedDB and no OPFS, and `bun test` must keep passing (`package.json` scripts; `src/__tests__/` uses in-memory `bun:sqlite` via `createTestDb()` in `src/__tests__/helpers.ts`; `src/__tests__/compat-sqlite.test.ts` is the precedent for testing a binding shim). The committed choice **must include the seam**: a store interface (e.g. `init / applySync / <the read contract>`) with the browser storage implementation isolated behind it, and an in-process test driver (in-memory structures, or the same SQL against `bun:sqlite :memory:`) so query and sync logic run under `bun:test`. Record which side of the seam holds the query logic for the chosen option.

## Verification procedure for upstream claims (do this before writing)

For every library/runtime claim in the doc, fetch the current upstream source and record `URL — accessed 2026-09-20`:

- Official SQLite WASM: `https://sqlite.org/wasm/doc/trunk/vfs.md` and `.../persistence.md` — what exactly is documented for the `opfs` VFS's COOP/COEP requirement, and for `opfs-sahpool`?
- wa-sqlite: `https://github.com/rhashimoto/wa-sqlite` (README) and its demos/docs — what does it claim about `opfs-sahpool` and COOP/COEP?
- MDN: File System API / OPFS page, IndexedDB API page (storage eviction), `StorageManager.persist()`.
- WebKit blog / MDN browser-compat for Safari's 7-day eviction of script-writable storage — confirm it applies to IndexedDB/OPFS in current Safari.

Method: `curl -sL <url>` (or any available fetch) and quote the load-bearing sentence in the doc. Anything that **cannot** be verified (network unavailable, doc moved) is written in the doc as `UNVERIFIED — <claim>`, never asserted from memory. A doc with an unverified COOP/COEP claim is not done.

## Bundle measurement procedure

Measure with a throwaway Vite project outside the repo (so no dependency or lockfile changes land):

1. `mktemp -d`; scaffold Vite 6 + `vite-plugin-singlefile` with the same plugin setup as `src/dashboard/ui/vite.config.ts` (singlefile, `target: 'esnext'`).
2. **Baseline:** build a stub app; record `dist/index.html` raw + gzip.
3. **Candidate A:** add an IndexedDB-backed query module (raw API; optionally with `idb`); record delta.
4. **Candidates B/C:** add `@sqlite.org/sqlite-wasm` / `wa-sqlite`; build twice per candidate — (i) default singlefile config, listing what lands in `dist/` (is the `.wasm` a separate file? does the build warn/fail?), (ii) forced inlining (`assetsInlineLimit` maxed or the plugin's inline options) recording the base64-inflated html size.
5. Record in the doc: method, versions, numbers table, and for each path whether `server.ts` changes are required. Sanity band (verify by measuring, don't assert): wasm binaries are ~0.5–1 MB before base64; IndexedDB direct adds ~0 KB; wrappers ~1–2 KB. If your numbers are wildly off these bands, re-check the build config before recording.

## Doc structure (target shape)

Follow the tone/format of `docs/plans/2026-07-01-002-encryption-pivot-and-local-memory-design.md`: status line, vision in one paragraph, then sections. Required sections in order:

1. Status + what this spike decided.
2. Context: read-optimized mirror, ruled-out alternatives (FSA API, sharing the CLI DB file), scope (React UI only, per-profile, legacy `html.ts` excluded).
3. The read contract (cited to code, per above).
4. Candidates (A/B/C) described as they would be built **in this repo** (file homes, delivery path, dependency).
5. Dimensions table + prose per dimension (the six above, with measured numbers and cited claims).
6. **Decision** — one unambiguous committed choice, rationale tied back to the dimensions, the explicit unencrypted-at-rest acceptance, the required testability seam, and the conditions that would reopen the decision.
7. What implementation stories inherit (no code in this PR).

## Committing the choice

- The PR body must quote the Decision section verbatim — the approving human is the checkpoint on the committed choice. If they reject it, revise the doc and re-push; do not merge a doc whose decision is contested.
- The decision must be concrete enough to build against: which library (or none), which VFS/backend, which delivery path (inline vs static route), and the interface seam for tests.

## Gates

- `bun test` — passes (root; the change is docs-only, this just proves the tree is green).
- `bun run typecheck` — passes.
- `git diff --stat` shows only `docs/plans/2026-09-20-003-*.md`, `CHANGELOG.md`, and `specs/issue-74_offline-store-comparison.md`; no dependency or lockfile changes (scratch measurements happen outside the repo).
- Manual check (acceptance criterion): a maintainer reads the doc top to bottom and finds an unambiguous committed choice with the reasoning behind it — every upstream claim carries a URL + access date, bundle numbers are measured with method recorded, and the unencrypted-at-rest tradeoff has its own subsection.
- Suggested PR title: `docs: record dashboard offline-store comparison and commit store technology`.

## Explicitly out of scope

- Any store implementation, sync endpoint (`updatedSince` or snapshot), service worker/PWA, or UI changes.
- Changes to `server.ts` headers or routes (they are recorded as consequences, not built).
- Adding `@sqlite.org/sqlite-wasm`, `wa-sqlite`, or `idb` to either package.json.
- Covering chat/logs/traces/interactions surfaces in the offline store, or the legacy `html.ts` dashboard.