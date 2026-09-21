# Plan: Offline overview — the eight approved overview cards compute from the local mirror

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-76` (`@openaccountant/wilson`, Bun + TypeScript)
**Parent:** #53 (decomposed) · **This slice:** #76 · **Blocked-by #75 is satisfied** — the sync-fed local mirror landed as PR #105 (commit `4ff32f3` in this worktree). Everything below builds on that code as it exists today.

## Outcome

After this lands, a dashboard user with no live server connection still sees their approved overview cards — **heatmap, streak, weekly summary, budget countdown, savings sparkline, category donut, P&L, and budget bars** — populated from the local mirror instead of error states (or silently-wrong zeros). Cards outside the approved scope (Alerts, Liabilities, Cash Forecast) degrade to an explicit "unavailable offline" state. The core testable claim: **for identical seed data, each local computation matches its server endpoint's output**, pinned by aggregation-equivalence tests.

## Committed technology (do not revisit)

Per `docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md` §6 and the landed #105 implementation: **wa-sqlite@1.0.0 (synchronous build) + `AccessHandlePoolVFS`, inline worker, wasm inlined at build time, per-profile OPFS pools, all store logic pure modules tested against `bun:sqlite :memory:` under `bun:test`**. The mirror is a read-only mirror; sync is the only ingest path; offline writes never queue. The decision doc §3 is literally the read contract this slice implements (daily spending, streak, weekly summary, budget countdown, spending summary, P&L, savings history, budget-vs-actual rollup). Since the store committed to SQLite-WASM, the task's directive applies: **reuse the server's aggregation SQL** — do not rewrite it in JS, do not re-derive it.

## How equivalence is achieved (the central design decision)

The server aggregation functions live in `src/db/queries.ts` and `src/db/daily-queries.ts`, which type-import `Database` from `src/db/compat-sqlite.ts` → that drags `bun:sqlite` types into the UI typecheck (established in #105: the UI package must not transitively reach `src/db/compat-sqlite.ts`). So the mirror cannot import those modules. Three possible strategies:

1. Copy the SQL into mirror modules and pin equivalence with tests only (#105's approach for its two residual copies). ✗ — copying eight aggregations (streak date-walking, countdown calendar math, recursive budget rollup, month bucketing) recreates exactly the drift surface this task wants to avoid.
2. Extract the aggregation *functions* as shared async code used by both sides. Rejected: the functions would become async (the mirror binding is promise-based), rippling `await` through `api.ts`, 8 `server.ts` routes, 5 CLI tools, and ~40 test call sites in `queries.test.ts`/`budget-hierarchy.test.ts`. High churn, real error-timing risk, for little gain over (3).
3. **Chosen: extract the shared *SQL strings* and the shared *pure math* into one dependency-free module; each side keeps a thin driver.** The server drivers stay synchronous (signatures unchanged — CLI tools and existing tests untouched); the mirror drivers are async. The equivalence surface shrinks to: identical SQL text (same constants), identical pure math (same functions), and a trivial per-side `.all()/.get()` glue — and the parity test deep-equals the endpoint handlers against `serveApiPath` so any drift fails CI. This is the #105 precedent (`transaction-where.ts`, `transactions-query.ts`) generalized to the overview aggregations.

## Architecture delta (on top of landed #105)

```
 server (api.ts handlers)                    mirror worker (wa-sqlite, unchanged wiring)
   apiSummary ─┐   parse* ← overview-params.ts (NEW, pure)   ← serveApiPath routes the same paths
   apiPnl ─────┤                                               with mirror-overview.ts drivers
   apiBudgets ─┤   overview-sql.ts (NEW, pure, ZERO imports):  ↓
   apiSavings ─┘     SQL string constants + pure math helpers — imported by BOTH sides
   apiDailySpending / apiStreak / apiWeeklySummary / apiBudgetCountdown
   apiBudgetLimits (NEW) ── raw budgets rows ──┐
   apiCategories (NEW) ──── raw categories ────┴─→ SyncPayload gains budgets + categories
                                                 → applySync upserts them (MIRROR_SCHEMA_VERSION 2→3)
 fetch seam (ui/src/api.ts): offline GET with no mirror answer → RequiresConnectionError
   → out-of-scope cards (Alerts / Liabilities / Cash Forecast) render graceful "unavailable offline"
```

The eight card endpoints and their server handlers → shared pieces:

| Card | Endpoint | Server impl today | Shared pieces to extract |
|---|---|---|---|
| Heatmap | `/api/daily-spending?startDate&endDate` | `getDailySpending` (`daily-queries.ts`) | `DAILY_SPENDING_SQL` |
| Heatmap + Streak | `/api/streak` | `getStreak` | `STREAK_BUDGET_TOTAL_SQL`, `STREAK_DAILY_SQL`, `computeStreakDailyBudget(total, now)`, `computeStreak(rows, budget, now)` |
| Weekly summary | `/api/weekly-summary` | `getWeeklySummary` | `weekWindows(now)`, `WEEK_TOTAL_SQL`, `WEEK_BY_CATEGORY_SQL`, `WEEK_TOP_MERCHANT_SQL` |
| Budget countdown | `/api/budget-countdown?month` | `getBudgetCountdown` | `countdownDaysLeft(month, now)`, `BUDGET_COUNTDOWN_BUDGETS_SQL`, `BUDGET_COUNTDOWN_SPENT_SQL` |
| Donut | `/api/summary?…` | `apiSummary` → `getSpendingSummary` | `parseDateRange`/`parseAccountId`/`parseEntityId` (moved), `composeSpendingSummarySql(acct?, entity?)` |
| P&L | `/api/pnl?…` | `apiPnl` → `getProfitLoss` | `composePnlSql(acct?, entity?)`, `summarizePnl(incomeRows, expenseRows)` |
| Savings | `/api/savings?months` | `apiSavings` → `getMonthlySavingsData` | `parseSavingsMonths`, `savingsWindow(endMonth, months, now)`, `composeSavingsSql(acct?, entity?)`, `toMonthlyIncomeExpense(rows)` |
| Budget bars | `/api/budgets?…` | `apiBudgets` → `getBudgetVsActual` | `composeBudgetActualClauses(acct?, entity?)`, `BUDGET_ROLLUP_CTE_SQL`, `BUDGET_FALLBACK_SQL`, `budgetActualRow(budget, actual)`; the per-budget loop + categories probe stay per-side glue |

Day-click modal (`/api/transactions?start&end&limit=50`) is already mirrored — nothing to do.

## Scope

**In:** shared SQL/pure-math extraction (behavior-preserving server refactor), shared overview param parsing, two new read-only endpoints for raw budgets/categories, mirror payload + schema for budgets/categories (schema version bump), eight mirror aggregation drivers + `serveApiPath` routes, sync engine/client wiring, seam change for offline-GET signal, card offline/unavailable states + offline pill, aggregation-equivalence + fallback tests, CHANGELOG/README.
**Out:** mirroring `accounts`/`net-worth`/`goals`/`memories`/`embeddings` tables; the Cash Forecast, Alerts, and Liabilities cards working offline (explicitly outside the approved scope — graceful unavailable only); any server *write* endpoint; importer-to-mirror writes; service worker/PWA; legacy `html.ts` dashboard; new npm dependencies (none needed anywhere); wa-sqlite/build changes.

## Work items

### A. Shared aggregation SQL + pure math (server refactor, behavior-preserving)

1. **`src/db/overview-sql.ts` (NEW — ZERO imports, the heart).** Must be safe for the UI bundle: no `bun:sqlite`, no `src/db/*` imports, no browser APIs (same constraint as `src/db/transaction-weather`→`transaction-where.ts` from #105). Contains:
   - **Row interfaces, moved here as the single source** (source modules re-export them for compat): `DailySpendingRow`, `StreakResult`, `WeekCategorySpending`, `WeekData`, `WeeklySummaryResult`, `BudgetCountdownRow` (from `daily-queries.ts`); `SpendingSummaryRow`, `ProfitLossRow`, `MonthlyIncomeExpense`, `BudgetVsActualRow` (from `queries.ts`). Copy interfaces *into* this module; do **not** type-import them back from `queries.ts`/`daily-queries.ts` (bun:sqlite drag).
   - **Minimal structural queryable** (self-contained types, mirroring the store's `SqliteBinding` subset): `type SqlParams = Record<string, unknown>`, `interface OverviewStatement { all(params?): MaybePromise<Record<string, unknown>[]>; get(params?): MaybePromise<Record<string, unknown> | undefined> }`, `interface OverviewQueryable { prepare(sql: string): OverviewStatement }`, `type MaybePromise<T> = T | Promise<T>`. Both the server `Database` and the store `SqliteBinding` satisfy it structurally.
   - **SQL string constants, verbatim from today's implementations** (exact text — the parity tests and the existing `queries.test.ts`/`budget-hierarchy.test.ts` guard them): `DAILY_SPENDING_SQL`, `STREAK_BUDGET_TOTAL_SQL`, `STREAK_DAILY_SQL`, `WEEK_TOTAL_SQL`, `WEEK_BY_CATEGORY_SQL`, `WEEK_TOP_MERCHANT_SQL`, `BUDGET_COUNTDOWN_BUDGETS_SQL` (2-column budgets read), `BUDGET_COUNTDOWN_SPENT_SQL`, `BUDGETS_ALL_SQL` (`getBudgets`' `SELECT * … ORDER BY category`), `HAS_CATEGORIES_PROBE_SQL`, plus composers returning `{ sql, params }`/clause fragments for the dynamically-filtered ones (`composeSpendingSummarySql`, `composePnlSql`, `composeSavingsSql`, `composeBudgetActualClauses` — note the budget queries filter on `t.account_id`/`t.entity_id` with the `t.` alias).
   - **Pure math helpers, logic verbatim, `now` injectable** (today they close over `new Date()`; injection makes equivalence tests deterministic):
     `computeStreakDailyBudget(totalMonthlyLimit, now)` (SUM(monthly_limit)/days-in-current-local-month, verbatim), `computeStreak(spendingRows, budget, now)` (the entire walk: budget≤0 and empty-rows early returns, backward current-streak walk with the 365-day cap, ascending longest-streak loop, `current > longest` fixup), `weekWindows(now)` (Monday-based this/last week windows, `dayOfWeek === 0 ? -6 : 1 - dayOfWeek` verbatim), `countdownDaysLeft(month, now)` (before/in/after-month branches incl. `Math.ceil(...)+1`), `savingsWindow(endMonth, months, now)`, `toMonthlyIncomeExpense(rows)` (savings/rate mapping), `summarizePnl(incomeRows, expenseRows)` (totals + `netProfitLoss = totalIncome + totalExpenses`), `budgetActualRow(budget, actual)` (`remaining`, `Math.round` percent, `over`).
2. **`src/db/daily-queries.ts` (MODIFY, no behavior change):** `getDailySpending`, `getStreak`, `getWeeklySummary`, `getBudgetCountdown` bodies become compositions of the shared constants + helpers. Add optional trailing `now?: Date` params (`getStreak(db, dailyBudget?, now?)`, `getWeeklySummary(db, now?)`, `getBudgetCountdown(db, month, now?)`) — defaults preserve today's behavior exactly; `api.ts` callers unchanged. Re-export the moved interfaces (`export type { … } from './overview-sql.js'`) so existing imports keep working.
3. **`src/db/queries.ts` (MODIFY, no behavior change):** `getSpendingSummary`, `getProfitLoss`, `getMonthlySavingsData`, `getBudgetVsActual`, `getBudgets` bodies use the shared constants + helpers (signatures unchanged). Re-export the moved interfaces. `getBudgetVsActual` keeps its `hasCategories` probe + per-budget loop inline (sync); it now composes the shared CTE/fallback SQL.
4. **Regression guard:** `src/__tests__/queries.test.ts` + `budget-hierarchy.test.ts` (case-insensitive matching, hierarchical rollup, deep nesting) must pass **unmodified** — they are the proof the refactor is behavior-preserving. If a test needs changing, stop and re-examine the extraction.
5. **`src/dashboard/overview-params.ts` (NEW — ZERO imports, parallel to `transactions-query.ts`):** move **verbatim** from `src/dashboard/api.ts`: `parseDateRange` (direct startDate/endDate → month-slice; else `month` ?? current month with UTC month-end), `parseAccountId`, `parseEntityId`; add `parseSavingsMonths` (`parseInt(params.get('months') ?? '6', 10)`), `parseBudgetCountdownMonth` (`params.get('month') ?? current UTC month`), `parseDailySpendingRange` returning `{ startDate, endDate }` **or** `{ error: 'startDate and endDate required' }` (the endpoint's 200-shaped error object — must be replicated exactly).
6. **`src/dashboard/api.ts` (MODIFY):** import the parse helpers from `overview-params.js` (like `parseTransactionListParams`); delete the local copies. Handler bodies otherwise unchanged.

### B. Raw budgets/categories on the wire (sync feed)

7. **`src/dashboard/api.ts`:** `apiBudgetLimits(db)` → `getBudgets(db)` (raw rows; note the wire carries `entity_id` via `SELECT *` even though the `BudgetRow` TS interface predates migration 21 — document in a comment); `apiCategories(db)` → `getCategories(db)` (flat `CategoryRow[]`). Both read-only, comment: these exist to feed the dashboard mirror's sync pull.
8. **`src/dashboard/server.ts` (MODIFY):** two GET routes next to the other data routes: `path === '/api/budgets/limits'` (before any prefix-style matching would matter — the existing `/api/budgets` check is exact-match so there is no conflict) and `path === '/api/categories'`. They inherit the existing auth gate and 500 catch like every route in the dispatch.

### C. Mirror carries budgets + categories

9. **`src/dashboard/ui/src/store/types.ts` (MODIFY):** add structural `MirrorBudgetRow { id, category, monthly_limit, entity_id, created_at, updated_at }` (source of truth: `BUDGETS_TABLE` + migration 21's `ENTITY_ID_COLUMNS` budgets line) and `MirrorCategoryRow { id, name, slug, parent_id, description, is_system, sort_order, created_at, updated_at }` (source: `CATEGORIES_TABLE`). Extend `SyncPayload` with `budgets: MirrorBudgetRow[]` and `categories: MirrorCategoryRow[]`. Comment why copies, not type-imports (same bun:sqlite-drag rule).
10. **`src/dashboard/ui/src/store/mirror-schema.ts` (MODIFY):**
    - Import `BUDGETS_TABLE`, `CATEGORIES_TABLE` from `src/db/schema.js` (pure DDL constants, verbatim reuse — mirror parity by construction). Do **not** add `CATEGORIES_SEED` — the mirror mirrors server *rows*, it does not re-seed the taxonomy.
    - `createPersistentMirrorSchema` gains both tables plus `ALTER TABLE budgets ADD COLUMN entity_id INTEGER REFERENCES entities(id);` (same pattern as the transactions `entity_id`/`revision` ALTERs the mirror already replicates). `foreign_keys` stays OFF (adapter comment) so categories may arrive in any parent/child order — parent integrity is the server's concern; the mirror is read-only.
    - **`MIRROR_SCHEMA_VERSION = 3`** (bump rule documented in that file: payload shape + DDL changed). Existing browser mirrors drop + re-seed on next sync — expected and cheap.
    - `MIRROR_BUDGET_COLUMNS` / `MIRROR_CATEGORY_COLUMNS`; upserts: budgets keyed on **`category`** (UNIQUE in the DDL → valid conflict target), categories keyed on **`id`** (PK); reconcile temp tables `sync_incoming_budgets (category TEXT PRIMARY KEY)` and `sync_incoming_categories (id INTEGER PRIMARY KEY)`; `DELETE … NOT IN` reconcile for both; `resetMirrorSchema` drops them too.
11. **`src/dashboard/ui/src/store/sync-engine.ts` (MODIFY):** `SyncFetcher` gains `fetchAllBudgets()` and `fetchAllCategories()`; `runSync` fetches profile + all four sets (transactions/entities/budgets/categories — parallelize the four data pulls) and builds the extended payload. Failure of any pull still leaves the mirror untouched (`ok: false`).
12. **`src/dashboard/ui/src/store/mirror-client.ts` (MODIFY):** `syncFetcher` implements the two new direct authed fetches (`/api/budgets/limits`, `/api/categories`); `doSync` pulls all four before touching the pool (existing crash-safety pattern). No changes to pool keying, init, or RPC protocol (payload flows through `applySync` unchanged).

### D. Local aggregation drivers + routing

13. **`src/dashboard/ui/src/store/mirror-overview.ts` (NEW, pure — imports only `overview-sql.js` + `./types.js`):** async drivers that compose the **same** SQL constants and pure helpers as the server functions, awaiting the binding: `mirrorGetDailySpending(db, startDate, endDate)`, `mirrorGetStreak(db, now?)`, `mirrorGetWeeklySummary(db, now?)`, `mirrorGetBudgetCountdown(db, month, now?)`, `mirrorGetSpendingSummary(db, startDate, endDate, accountId?, entityId?)`, `mirrorGetProfitLoss(db, startDate, endDate, accountId?, entityId?)`, `mirrorGetMonthlySavingsData(db, endMonth, months, accountId?, entityId?)`, `mirrorGetBudgetVsActual(db, month, accountId?, entityId?)`. Per-budget loops (countdown, vs-actual incl. the hasCategories probe in try/catch) replicate the server glue; the mirror always has categories (synced) so the CTE path is the live one on both migrated servers and mirrors.
14. **`src/dashboard/ui/src/store/mirror-reads.ts` (MODIFY):** `serveApiPath` routes the eight paths, composing parse (`overview-params.js`) + driver **exactly as the `api.ts` handlers do** — including `/api/daily-spending`'s `{ error }` object for missing params. Unmirrored paths still return `null`.

### E. Seam signal + UI states

15. **`src/dashboard/ui/src/store/offline-writes.ts` (MODIFY):** `resolveFetchOutcome`: GET + network error + `mirrored === null` now yields **`'throw-requires-connection'`** (was `'rethrow'`) — an offline GET the mirror cannot serve is "requires connection", not a raw `TypeError`. Writes unchanged. Add `isRequiresConnectionError(err): boolean` helper.
16. **`src/dashboard/ui/src/api.ts` (MODIFY):** comment updated for the new GET outcome; logic already routes through `resolveFetchOutcome`. All GETs to the eight overview paths + transactions now resolve from the mirror offline.
17. **`src/dashboard/ui/src/hooks/useApi.ts` (MODIFY):** `UseApiResult` gains `offline: boolean` — true when the caught error satisfies `isRequiresConnectionError`. No other behavior change.
18. **Overview cards:**
    - `src/dashboard/ui/src/tabs/OverviewTab.tsx` (MODIFY): offline pill at the top when `useMirrorStatus()` reports `available && seeded && !online` — reuse the TransactionsTab pill markup (`data-testid="offline-pill"`, amber).
    - **Out-of-scope cards (required):** `AlertList`, `LiabilitiesCard`, `CashflowForecast` — when `offline && !data`, render a graceful "Unavailable offline — requires the server" muted note inside the intact card instead of the misleading "No alerts. All clear." / zeros. Online behavior unchanged.
    - **In-scope cards:** same two-line guard for the edge where the mirror is unavailable or never seeded (offline with no data → unavailable note, not zeros/"No spending data"). Uniform pattern, keeps the manual check honest.

### F. Tests (root `src/__tests__/`, bun:test; CI runs each file in its own process)

19. **`src/__tests__/overview-parity.test.ts` (NEW — THE aggregation-equivalence gate, acceptance criterion 1):**
    - Server db: `createTestDb()` (full migrations → categories table present) seeded with budgets across categories **including a parent budget with child categories** (`addCategory`/`getCategoryByName` — exercises the recursive rollup) and transactions with **relative dates** (`daysAgo()` from `helpers.ts`): today, yesterday, earlier this week, last week, earlier this month, and 1–6 months back (savings), mixing income/expense, `Income`/`Transfer` category edge cases, account + entity links.
    - Mirror: `applySync` from the server's **own raw pulls** (`apiTransactions` huge-limit + `apiEntities` + `apiBudgetLimits` + `apiCategories`) — exactly what the sync engine does.
    - `test.each` matrices deep-equal **server handler vs `serveApiPath`** for: `/api/streak`; `/api/weekly-summary`; `/api/daily-spending` (window incl. today, and the missing-params `{ error }` shape); `/api/budget-countdown` (explicit current month, explicit past month, default); `/api/summary` and `/api/pnl` (no params; `month=`; direct `startDate/endDate`; `accountId`; `entityId`; combined); `/api/savings` (default, `months=12`, `accountId`); `/api/budgets` (current month, default, `accountId`, `entityId`, and the hierarchical-rollup budget whose actual must include child-category spending).
    - **Float discipline:** amounts in fixtures must be exactly representable (halves/quarters/integers, modest group sizes) so `SUM` is order-insensitive — bun's SQLite and wa-sqlite may otherwise differ in the last ULP on scan-order-dependent float sums. If an order-sensitivity ever flakes, compare with an epsilon for totals only — but design the data so it never triggers.
    - Second describe block: determinism/unit tests for the shared pure helpers with a fixed injected `now` (`computeStreak` 365-cap + longest-streak, `weekWindows` Monday math incl. Sunday, `countdownDaysLeft` before/in/after month, `savingsWindow` boundaries, `computeStreakDailyBudget`).
20. **`src/__tests__/mirror-store.test.ts` (EXTEND):** payload helper gains budgets/categories defaults; new cases: budgets/categories seed + serve; monthly_limit change upserts in place (keyed on `category`); server-side budget deletion reconciles away; category rename/delete reconciles on next full pull; re-seed gate still fires on the v3 version marker; `MIRROR_BUDGET_COLUMNS`/`MIRROR_CATEGORY_COLUMNS` completeness (a full-column row like the existing full-column transaction row). `mirror-helpers.ts` gains `mirrorBudget()` / `mirrorCategory()` row builders.
21. **`src/__tests__/mirror-sync-engine.test.ts` (EXTEND):** fake fetchers implement the two new pulls; end-to-end apply; a failing budgets/categories pull leaves the mirror on its last good set; profile-change re-seed still works with the extended payload.
22. **`src/__tests__/mirror-fallback.test.ts` (UPDATE):** `resolveFetchOutcome` GET + network + no mirror answer → `'throw-requires-connection'` (pin the change); GET + mirror rows → return-mirror; writes → requires-connection; `isRequiresConnectionError`; `serveApiPath` returns `null` for unmirrored paths (`/api/alerts`, `/api/net-worth`, `/api/cashflow/monthly`) so those GETs surface the unavailable state.
23. **`src/__tests__/dashboard-api.test.ts` (EXTEND):** `apiBudgetLimits`/`apiCategories` shapes — equal to `getBudgets(db)`/`getCategories(db)`, budget rows carry `entity_id` on the wire.

### G. Docs

24. **`CHANGELOG.md`** — one `feat:` bullet under `## [Unreleased]` (repo convention; `### Features` heading).
25. **`README.md`** — extend the "Offline dashboard transactions" bullet + section: overview cards (heatmap, streak, weekly summary, budget countdown, savings, donut, P&L, budget bars) work offline from the mirror; alerts/liabilities/cash forecast show an explicit unavailable state; the mirror now also carries budgets + categories. Keep the unencrypted-at-rest acknowledgment as is.

## Design decisions worth remembering

- **Why not copy the SQL (and why not async-rewrite the server):** see "How equivalence is achieved" — shared SQL constants + shared pure math minimize the drift surface; the residual per-side glue (param binding + `.all()` calls + two per-budget loops) is pinned by deep-equality parity tests. Server signatures stay synchronous so the 5 CLI tools (budget-check, profit-loss, forecast, savings-rate, profit-diff) and ~40 existing test call sites are untouched.
- **New endpoints are necessary:** no existing route exposes raw budgets (`/api/budgets` returns the vs-actual *aggregation*) or the categories hierarchy; the sync pull needs the raw tables. Two small read-only GETs, no auth surface change (they sit behind the existing gate).
- **`MIRROR_SCHEMA_VERSION` 2 → 3:** payload + DDL grew. Existing browser mirrors re-seed from scratch on the next sync — by design (documented bump rule), cheap at dashboard scale.
- **Streak's daily budget derives from the budgets table** (`SUM(monthly_limit)/days-in-month`, `getStreak` when no explicit budget passed) — that is exactly why the mirror must carry budgets, per the task.
- **Budget-vs-actual's recursive rollup** (`WITH RECURSIVE descendants` through `categories.parent_id`, case-insensitive `LOWER()` joins) runs unchanged in wa-sqlite (decision doc §5.1 predicted this); the mirror carries `categories` so the CTE path is live on both sides.
- **FK enforcement stays OFF in the mirror** (adapter rationale: mirrored transactions reference `accounts` the mirror doesn't hold) — so categories may upsert in any parent/child order and parent deletes reconcile cleanly.
- **Offline GETs without a mirror answer become `RequiresConnectionError`,** which is what lets out-of-scope cards distinguish "unavailable offline" from a generic failure. HTTP errors still never trigger fallback (server answered). The transactions tab is unaffected (all its paths are mirrored).
- **Time-dependent endpoints** (streak, weekly summary, countdown, savings window): both sides run the same shared helpers; parity holds within a single test run. Parity fixtures seed relative dates; optional `now` injection gives pinned determinism in the helper unit tests.
- **Sync-only ingest unchanged:** browser imports still land server-side and reach the mirror on the next pull; nothing writes the mirror except `applySync`.
- **No new npm dependencies** anywhere (root, UI, or otherwise). wa-sqlite is already vendored inline.

## Verification

1. Fresh worktree: `bun install` (root). `cd src/dashboard/ui && npm install` only if the lockfile demands it — no new deps are added, so likely a no-op.
2. `bun run typecheck` — root tsconfig **and** the UI typecheck (`cd src/dashboard/ui && npm run build`, which runs `tsc -b && vite build`) must both pass. The new modules must not drag `bun:sqlite` types into the UI: `overview-sql.ts` and `overview-params.ts` have ZERO imports; `mirror-overview.ts` imports only `overview-sql.js` + `./types.js`.
3. `bun test` — full suite, plus per-file runs for the changed/added files to mirror CI isolation: `bun test src/__tests__/overview-parity.test.ts`, `mirror-store`, `mirror-sync-engine`, `mirror-fallback`, `dashboard-api`, `queries`, `budget-hierarchy`.
4. UI build: `cd src/dashboard/ui && npm run build` → still a single `dist/index.html` (no new assets); the inline worker now carries the overview drivers.
5. Manual check (acceptance criterion 5): run `wilson --dashboard` (or `bun run src/index.tsx --dashboard`) against a profile with transactions **and budgets set** → load the dashboard online, confirm the overview cards → stop the server → reload the page → the heatmap, streak, weekly summary, budget countdown, savings sparkline, donut, P&L, and budget bars render populated from the mirror with the offline pill showing; Alerts, Liabilities, and Cash Forecast show the graceful "unavailable offline" notes → restart the server → within the 60 s sync interval everything returns online (pill gone, live values).
6. `git diff --stat` sanity: changes confined to `src/db/` (`overview-sql.ts` new, `queries.ts`/`daily-queries.ts` refactor), `src/dashboard/` (`overview-params.ts` new, `api.ts`, `server.ts`), `src/dashboard/ui/src/` (store + cards + hooks), `src/__tests__/`, `CHANGELOG.md`, `README.md`.

## Risks / notes for the builder

- **The extraction is the risky step — treat it as two commits if you like.** Land the behavior-preserving server refactor (A) first and watch `queries.test.ts`/`budget-hierarchy.test.ts` stay green untouched before building the mirror side on top. If any existing server test needs editing, the extraction is wrong — fix the extraction, not the test.
- **Verbatim means verbatim:** copy SQL and math exactly (including `Math.round`, the `Math.ceil(…)+1` in countdown days-left, the 365-day walk cap, `dayOfWeek === 0 ? -6 : 1 - dayOfWeek`, UTC month-ends via `new Date(year, mon, 0).toISOString()`). The parity test is the gate, but byte-identical sources are the cheapest way to pass it first try.
- **Float sums:** keep parity-fixture amounts binary-exact (see test item 19) or the bun-vs-wa-sqlite float summation order can differ in the last ULP.
- **`/api/budgets/limits` route order:** exact-match `if` chains in `server.ts` mean no conflict with `/api/budgets`, but add the new route adjacent to it and keep the name distinct.
- **wa-sqlite named binding:** shared SQL uses `@name` params — the adapter's `atKeys` handles them (proven by the landed mirror SQL). `strftime`, `WITH RECURSIVE`, `COALESCE`, `LIKE` all run unchanged in wasm SQLite.
- **CI bun is 1.4.2** (`.bun-version`), local may be 1.3.x — nothing here needs new bun APIs.
- **Don't touch `getMonthlyCashflowData` / cash forecast / alerts / net-worth paths** — out of scope; they only gain the graceful unavailable state via the seam change.
- Suggested PR title: `feat: offline overview — the eight approved overview cards compute from the local mirror without a server`.