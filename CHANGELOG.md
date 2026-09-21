# Changelog

## [v0.8.0] — 2026-09-21

### Features

- feat: offline dashboard transactions — sync-fed local mirror serves the transactions tab without a server (#105) (4ff32f3)

### Other

- Add what-if controls to the Cash Forecast card: 6/12/24-month horizon and ±50% income/expense assumption sliders (#81) (#114) (c834456)


## [Unreleased]

### Features

- feat: Speed Showdown demo — pick an in-repo synthetic sample transaction (incl. the Harborview $318 Health row) in a new `#demo` dashboard tab and race side-by-side real, trace-store-sourced timers for the identical categorization decision: local via the hybrid routing (browser WebGPU with separately measured load time, else the server-side transformers path, always labeled with its actual source) against a live OpenRouter round-trip when key + network probe pass, otherwise a clearly-labeled simulated round-trip whose traces carry provider `simulated` markers so they are never misattributed; the exact prompt exhibit ("what leaves your machine") contains synthetic sample rows only, the verdict line names the ms/× delta, and the caption honestly contrasts jev-ultrafast (~178 ms median request, not privacy-preserving) (#92)

- feat: statement-to-dashboard agent trace — the Demo tab gains a drop-a-statement flow that runs Wilson's offline chain as a live four-node diagram (import → local embedding lookup → category prediction → reconciliation hint), each node lit by its real server-measured duration; import reuses the /api/import substrate with file-hash dedup (re-drop skips cleanly), embeddings run the local MiniLM engine against a known-merchant/category reference, predictions are strictly display-only (nothing written), and reconciliation surfaces duplicate/spike hints over the freshly imported rows — vendored ground-truth fixture at demos/fixtures/august-2026-chase.csv (#93)

- feat: per-response provenance indicator in both dashboard chat UIs — each live answer is badged `answered locally · on-device`, `server fallback`, or a neutral `server agent` when the hybrid layer is absent; derived at send time from the exchange's actual path (never from message text), not persisted, so history-loaded messages show no badge (#69)

- feat: embed-on-write — every import (CSV/OFX/QIF, Monarch, Firefly, dashboard /api/import), sync (Plaid insert/update/remove, Coinbase), description edit (agent tool + dashboard PATCH), and delete keeps the semantic index fresh immediately, so search reflects changes without ever running `wilson --index`; embedding failures degrade to a logged warning and leave rows for the next backfill instead of failing the import or edit, and `--index` now also sweeps orphaned vectors whose transaction is gone (#63)

- feat: dashboard Review tab for the categorization queue — lists every pending review with the transaction's date, amount, description, the suggested category and its confidence (plus the currently applied category for backfilled historical rows); Confirm applies the suggested category and Correct applies a user-picked one from the existing category list, and either action atomically applies the category, marks the transaction user-verified, and resolves the queue entry (`GET /api/reviews` readable by any authenticated user, `POST /api/reviews/:id/confirm|correct` admin-only; `PATCH /api/transactions/:id` can now also carry `user_verified`) (#86)

### Other

- Add what-if controls to the Cash Forecast card: 6/12/24-month horizon selector and ±50% income/expense assumption sliders that re-run the seeded in-browser simulation in place (#81)


## [v0.7.0] — 2026-09-21

### Features

- feat(plaid): dedup Items by institution_id; fix cross-file test mock pollution (#59) (013cc8b)

### Other

- Add client-side Monte Carlo cash forecast fan chart to Overview (#80) (#111) (15b6c0e)
- Render markdown in dashboard chat replies via react-markdown + remark-gfm (#47) (747e36c)
- Add admin per-task model overrides applied live via POST /api/models and the controllable Settings Models panel (#89) (#112) (a3d1a4d)
- WebMCP bridge: browser-native + Streamable-HTTP tool access with prepare/commit confirmation (#99) (cc74c17)
- Gate below-threshold categorization suggestions into a persistent review queue instead of auto-applying (#100) (6e2e7ca)
- Add Transactions-tab statement importer: client-side parse preview with confirm-to-commit (#72) (#102) (5fd38ff)
- Add dashboard Transactions semantic search endpoint and zero-match UI fallback (#62) (#101) (13c14a8)


## [v0.6.0] — 2026-09-21

### Features

- feat: dashboard Settings Models panel — per-task model rows with local/server badges and tool call-type tagging (#88) (#104) (c39981c)

### Fixes

- fix: align dashboard UI account types with the real wire format so Accounts and Liabilities render real balances (#79) (#103) (83fa52b)

### Other

- Show model confidence badge in dashboard transaction list Category cell (#109) (ccb545c)
- Add local-first WebGPU hybrid chat to the dashboard with silent server fallback (#68) (#98) (d29e69e)
- Add dashboard POST /api/import endpoint with CLI-shared external_id dedup and imports ledger (#96) (35b0783)
- Validate tool-call arguments against each tool's zod schema in defineTool (#66) (#90) (c840e7f)
- Add local embedding engine, embeddings store, and batched backfill (#82) (64a4763)
- Validate structured LLM output in callLlm with one repair re-prompt and typed rejection (#65) (#77) (72d40eb)
- Add percentage-of-income targets to goal_manage financial goals (#46) (7b34ab3)
- Route SPF roster through gertie's Ollama Cloud (ebe2dd6)
- Add SPF quality/protected_files/watch config (4a3d645)


## [Unreleased]

### Features

- feat: client-side Monte Carlo cash forecast card on Overview, beside Savings Rate — a new read-only `GET /api/cashflow/monthly` series classified exactly like the P&L (transfers between accounts excluded so card payments aren't double-counted, complete calendar months only so the partial current month never skews sampling), a seeded in-browser bootstrap of 500 twelve-month paths over the user's own history (mulberry32 PRNG, deterministic under test), a recharts fan chart of translucent p10–p90 bands around the median liquid-cash line starting from checking/savings/cash balances, a plain-language takeaway naming the median cash at the horizon (and roughly when the pessimistic path runs low, if it does), and an empty state until a couple of months of history exist (#80)

- feat: admin per-task model overrides, applied live — the Settings Models panel becomes controllable: an admin-gated `POST /api/models` pins a model from the catalog to categorization or entity classification (or resets it to follow the chat model), and the panel's Chat row is the global model setting itself; tool call sites resolve their pinned model per call and the dashboard chat applies chat-model changes through the same live-update path the TUI's `/model` switch uses (agent runner + background summarize/relevance), so every change lands on the next run with no restart; the dropdown lists friendly names, offers no WebGPU model the capability probe says can't run on this machine, and marks uncached local models with their download size (#89)

- feat: below-threshold AI categorization suggestions are routed to a persistent review queue instead of being auto-applied — the categorize tool now applies a suggestion only at or above the confidence threshold (default 0.7, per-profile via "categorizationConfidenceThreshold"); lower-confidence suggestions leave the transaction uncategorized and land as pending rows in the new categorization_reviews table (migration v24 also backfills historical low-confidence model categorizations into the queue while keeping their applied category) (#84)

- feat: dashboard statement importer — the Transactions tab gains a drag-and-drop/file-picker importer that reads CSV/OFX/QIF statements entirely in the browser (shared parse + WebCrypto-hash modules bundle with the UI via the @import-tools alias), previews detected bank/format, row count, date range and first rows in a dialog, and only POSTs to /api/import on explicit confirm; commit is admin-gated following the settings tab's auth-status pattern and re-imports surface the duplicates-skipped result (#72)

- feat: semantic search in the dashboard Transactions view — a new `GET /api/transactions/search` embeds the query with the local on-device engine, prefilters candidates with the same SQL filters the transactions endpoint accepts (date range, account, category, entity), ranks by dot product, and returns full transaction rows with similarity scores plus indexed/total coverage counts; the Transactions tab keeps today's instant substring matching whenever it produces results and only falls back to semantic matches on a zero-match query (score chips, `semantic` marker, and a one-line hint naming `wilson --index` when vectors lag the transaction count); query and transaction text are embedded in-process — nothing but the one-time model download ever leaves the machine (#62)

- feat: dashboard Settings "Models" panel — a read endpoint (`GET /api/models`) and Settings section showing which model handles each AI task (chat, categorization, entity classification) with friendly model names, "runs on this device" vs "runs on a cloud server" badges derived from a new `isLocal` flag on the provider registry, the server-side WebGPU capability probe, and an embeddings row marked "Not in use — no embeddings task in this build"; categorization and entity-classification LLM calls are also tagged with their own call types so the Training per-task view groups them truthfully instead of lumping them into `standalone` (#88)

- feat: offline dashboard transactions — a sync-fed, per-profile local mirror (wa-sqlite@1.0.0 + AccessHandlePoolVFS in an inline worker, wasm base64-inlined into the single-file build, no COOP/COEP or static-asset routes) seeds/refreshes on full pulls keyed by external_id, reconciles server-side deletions, and re-seeds on schema-version change; the fetch seam goes network-first with mirror fallback so browsing/search/filtering work offline with server-identical results (parity pinned by tests), and offline entity assignment shows an explicit requires-connection state instead of failing silently (#75)

- feat: local-first hybrid dashboard chat — WebGPU-capable browsers answer from a pre-fetched transaction bundle via transformers.js (Qwen3-0.6B, fastModel-driven) with silent server fallback, bundle framing/hand-off classification, and browser-originated history recording (#68)

- docs: record dashboard offline-store comparison spike (IndexedDB-direct vs OPFS-backed sqlite-wasm, measured against the real read contract) and commit wa-sqlite@1.0.0 + AccessHandlePoolVFS as the store technology, incl. the accepted unencrypted-at-rest tradeoff — `docs/plans/2026-09-20-003-dashboard-offline-store-comparison.md` (#74)

- feat: percentage-of-income targets for goal_manage — financial goals accept an optional `targetPercent` (plus `incomePeriod`, default month) alongside the fixed `targetAmount`; the dollar target is resolved from actual period income via profit-loss totals, progress defaults to the period's net savings, and goal snapshots record the resolved target (#34)

- feat: dashboard import endpoint — POST /api/import commits client-parsed statement rows into the active profile with file-hash + per-row external_id dedup (sharing the CLI's id derivation, so one statement dedups across both paths) and an imports-ledger record; admin-gated like other dashboard writes (#71)

- feat: local semantic index — `wilson --index` backfills a locally-computed embedding for every existing transaction (migration 23 `embeddings` table, L2-normalized vectors keyed by source + model) using a `feature-extraction` pipeline over the pinned transformers.js (all-MiniLM-L6-v2-ONNX, 384-dim, CPU/WASM); batched, resumable, with model-download and per-batch progress; top-k search ranks SQL-prefiltered candidates by dot product; nothing but the one-time model download ever leaves the machine (#61)

### Fixes

- fix: validate structured LLM output at the `callLlm` boundary — a response violating its `outputSchema` gets exactly one schema-aware repair re-prompt, then the call rejects with a typed `LlmValidationError` instead of returning unvalidated data; categorization and entity-classification batches land in their errors channel with nothing written (no more NaN confidences or junk categories from malformed local-model JSON), chat-history relevance degrades to no injected history, and team dispatch falls back to the dispatcher's direct answer; both tool schemas now constrain `confidence` to [0, 1] (#65)

- fix: validate every tool invocation against its own zod schema in `defineTool` — malformed model tool-call arguments are rejected with a field-naming error before the tool function runs, and the failure is fed back to the model as a tool error so it can correct its arguments (#66)

- fix: correct the dashboard UI's drifted account wire-format types — `Account`, `NetWorthResponse`, and `NetWorthTrendPoint` now declare the shape the API actually sends (`account_type`/`account_subtype`/`current_balance`, the `*BySubtype` arrays, and `date`/`totalAssets`/`totalLiabilities` trend rows) so the Accounts tab groups by real type with real balances (no more "Other" catch-all or NaN), the trend chart shows date labels, and the Liabilities card's per-account breakdown renders again; the wire contract is pinned by seeded-API field-name tests (#79)


## [v0.5.0] — 2026-07-05

### Features

- feat: upgrade @huggingface/transformers to 4.0.1 (#26) (12c1550)


## [v0.4.3] — 2026-07-05

### Fixes

- fix: drop ./ prefix from bin path so npm 11 keeps it (#30) (9071216)


## [v0.4.2] — 2026-07-04

### Fixes

- fix: restore installable wilson bin under npm 11 (#29) (5c56f64)


## [v0.4.1] — 2026-07-04

### Fixes

- fix: wire agent tools to database in dashboard chat (#25) (ecb22ea)


## [v0.4.0] — 2026-07-04

### Features

- feat: SQLCipher encryption at rest via bun:sqlite setCustomSQLite (#24) (4771db9)


## [v0.3.0] — 2026-04-09

### Features

- feat: auto-version releases, recursive skill discovery, OSS best practices (fbae552)


## [v0.2.0] — 2026-04-08

- feat: merge npm publish into release-on-merge workflow (182bb85)
- fix: resolve all CI test failures (d2d4da4)
- fix: pin CI to Bun 1.2.22 and fix orchestration spyOn compatibility (e102c49)
- fix: regenerate lockfile with correct package name @openaccountant/wilson (c245a7a)
- fix: convert LongTermChatHistory from class to factory function (063cbfd)
- fix: resolve CI test failures — pin Bun 1.3.10, break circular import, fix dashboard test (adeaecf)
- fix: pin Bun to 1.2.x in CI — tests break on 1.3 due to class/mock changes (fc84092)
- fix: use relative dates in test seed data so tests don't rot over time (c9c8edf)
- chore: update CHANGELOG for v0.2.0 (9759434)
- chore: rename to @openaccountant/wilson and bump to v0.2.0 (bd369aa)
- feat: Plaid production readiness — sync correctness, security, and compliance (be7926b)
- feat: add WebGPU support, model switch fix, entity system, coinbase sync, and dashboard enhancements (fab7ec3)
- fix: resolve sync UI flickering and add profile awareness to system prompt (ce528a8)
- fix: resolve remaining TypeScript typecheck errors for CI (2aeec36)
- test: improve coverage for utils - env, logger, trace-store (3a73792)
- feat: add custom category system with hierarchical budgets, goals, memories, and dashboard UI (aa18c9a)
- chore: add test:coverage script, gitignore debug dir, remove stale data file (3642680)
- feat: expand test suite with 30+ new test files (c7dd01f)
- feat: add /upgrade command, improve /help, proxy license validation (b2dbd57)
- feat: add spending-by-institution dashboard card and db-manager init fix (cb9bd28)
- feat: pass active model through tool executor to chains and teams (22caa9d)
- feat: add Plaid API proxy mode and debug dump support (7f5aaaa)
- feat: support directory import and refactor csv-import to single-file fn (3e69248)
- feat: add browser open utility and Pro upsell module (0525436)
- feat: extend --sync to all integrations, add MCP SSE transport and --mcp diagnostic (212fe9a)
- feat: add LLM interaction capture & fine-tuning data pipeline (1b734f1)
- feat: rotating, time-aware, data-driven context hints (a193580)
- feat: add context-aware hints line below TUI input (23713c4)
- feat: auto-sync Plaid balances to accounts, auto-link transactions, add --sync flag (fc858d4)
- fix: persist logs and traces to SQLite, fix chat session fragmentation (1698620)
- feat: add net worth and balance sheet tracking (cc49ef8)
- feat: add tests and fixture for Firefly III import integration (fd382cf)
- feat: add Winston logging, LLM trace store, dashboard enhancements, and comprehensive test suite (9f84d22)
- feat: add multi-profile support with separate databases (4422c36)
- (chore):readme (a02d834)
- Update GitHub URLs from open-accountant/open-accountant to openaccountant/wilson (1f15cdd)
- Add 40 paid skill stubs for expanded x402 catalog (73b4236)
- Rename Agent Wilson → Open Accountant (cf68cfc)


## [v0.2.0] — 2026-04-08

- chore: rename to @openaccountant/wilson and bump to v0.2.0 (bd369aa)
- feat: Plaid production readiness — sync correctness, security, and compliance (be7926b)
- feat: add WebGPU support, model switch fix, entity system, coinbase sync, and dashboard enhancements (fab7ec3)
- fix: resolve sync UI flickering and add profile awareness to system prompt (ce528a8)
- fix: resolve remaining TypeScript typecheck errors for CI (2aeec36)
- test: improve coverage for utils - env, logger, trace-store (3a73792)
- feat: add custom category system with hierarchical budgets, goals, memories, and dashboard UI (aa18c9a)
- chore: add test:coverage script, gitignore debug dir, remove stale data file (3642680)
- feat: expand test suite with 30+ new test files (c7dd01f)
- feat: add /upgrade command, improve /help, proxy license validation (b2dbd57)
- feat: add spending-by-institution dashboard card and db-manager init fix (cb9bd28)
- feat: pass active model through tool executor to chains and teams (22caa9d)
- feat: add Plaid API proxy mode and debug dump support (7f5aaaa)
- feat: support directory import and refactor csv-import to single-file fn (3e69248)
- feat: add browser open utility and Pro upsell module (0525436)
- feat: extend --sync to all integrations, add MCP SSE transport and --mcp diagnostic (212fe9a)
- feat: add LLM interaction capture & fine-tuning data pipeline (1b734f1)
- feat: rotating, time-aware, data-driven context hints (a193580)
- feat: add context-aware hints line below TUI input (23713c4)
- feat: auto-sync Plaid balances to accounts, auto-link transactions, add --sync flag (fc858d4)
- fix: persist logs and traces to SQLite, fix chat session fragmentation (1698620)
- feat: add net worth and balance sheet tracking (cc49ef8)
- feat: add tests and fixture for Firefly III import integration (fd382cf)
- feat: add Winston logging, LLM trace store, dashboard enhancements, and comprehensive test suite (9f84d22)
- feat: add multi-profile support with separate databases (4422c36)
- (chore):readme (a02d834)
- Update GitHub URLs from open-accountant/open-accountant to openaccountant/wilson (1f15cdd)
- Add 40 paid skill stubs for expanded x402 catalog (73b4236)
- Rename Agent Wilson → Open Accountant (cf68cfc)


## [v0.1.0] — 2026-03-01

- Rename to Agent Wilson, add Plaid balance/recurring tools, bank-sync skill (e104f4e)
- Add brand guide (f5588f9)
- Wire budget context into agent system prompt (17cbb51)
- Add headless mode for scheduled and non-interactive execution (c010724)
- Add paid chain orchestration with license gating (b390ebc)
- Add paid skill definitions for Pro workflows (020bc60)
- Add paid skill tier with license gating and server-side content (03e6619)
- Add content fetcher for paid skill and chain delivery (f04ffd2)
- Add scheduled task system with crontab sync (8e3cc28)
- Add Plaid integration for bank account linking and transaction sync (d8daf0e)
- Add budget set and budget check tools (fc322d8)
- Add budgets table, Plaid columns, and budget queries (9b97225)
- Add license validation system with Polar.sh integration (b140617)
- Gate Plaid and Monarch as Pro features with cross-sell messaging (d6542f4)
- feat: add open source infrastructure (README, LICENSE, CI, templates) (e7d1c41)
- fix: update recommended Ollama models with current-gen tool-calling SLMs (69af2f5)
- feat: Wilson CLI with MCP client, model tags, /pull, and export (791fa53)


## [v0.1.0] — 2026-03-01

- Initial release
- Agent loop with 9 LLM providers (Anthropic, OpenAI, Ollama, etc.)
- Bank statement import: Chase, Amex, BofA, generic CSV, OFX, QIF
- Smart categorization with rules engine
- P&L reports, profit diffs, savings rate tracking
- Tax deduction tracker with IRS categories
- Spending alerts and budget monitoring
- Markdown report export and browser dashboard
- Plaid integration for bank sync (Pro)
- Skills system for multi-step workflows
- Privacy-first: all data in local SQLite, no telemetry
