# Plan: Statement-to-Dashboard Agent Trace — drop a CSV, watch the offline chain run step by step

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-93` (branch `spf-watch/93-statement-to-dashboard-agent-trace-drop-a`, at the same commit as `origin/main`)
**Issue:** #93, decomposed from #58 (demo-table artifact); parent artifact tab is #91. Sibling slices: #92 Speed Showdown (in flight, parallel branch), #94 confirmation gate, #95 privacy validator — later.
**Outcome:** An attendee drops the vendored August-2026 Chase statement in the dashboard's Demo tab and watches Wilson's offline agent chain — **import → embedding lookup → category prediction → reconciliation hint** — run as a live four-node flow diagram, every node lighting in order with its own real measured elapsed-ms, entirely on localhost.

## Grounding — what exists today (verified on this worktree)

- **Base commit = `origin/main` HEAD (`d29e69e`).** Landed and reusable:
  - **#71 import endpoint (ON BRANCH):** `apiImport(db, body)` at `src/dashboard/api.ts:765` with `ImportRequestBody`/`ImportTransactionInput`/`ImportResult` exported from the same file (line ~735). File-hash dedup (imports ledger, `previouslyImported` in the result), per-row `external_id` dedup deriving ids identically to the CLI via `computeExternalId` (`src/tools/import/external-id.ts:9`, `csv-<sha256(date|description|amount)[:16]>`). Route `POST /api/import` at `src/dashboard/server.ts:381` — gated by `canWrite` (403 when auth on + non-admin), 400 when `result.status === 'failed'`. All pinned by `src/__tests__/dashboard-import.test.ts`.
  - **CLI statement pipeline:** `detectFormat(content)` (`src/tools/import/detect-bank.ts:17`) → parser switch in `src/tools/import/csv-import.ts` (`importSingleFile`, hash at line 101) with parsers under `src/tools/import/parsers/`. `parseChaseCSV` maps only `date/description/amount/bank` — **the bank's own Category column is intentionally ignored**, so imported rows arrive uncategorized (which is exactly what makes the prediction node meaningful).
  - **#61 local embedding engine (ON BRANCH):** `src/utils/embeddings.ts` — `embedTexts(texts, modelId?)` (batched, mean-pooled, L2-normalized, CPU/WASM in-process, model cache `~/.openaccountant/models/`, the only network ever involved is the one-time MiniLM download), `DEFAULT_EMBEDDING_MODEL = 'onnx-community/all-MiniLM-L6-v2-ONNX'`, `EMBEDDING_DIM = 384`, `normalizeVector`, and `transactionEmbedText({merchant_name, description})` — **the canonical embed-text rule** (merchant + description joined; used by both backfill and search, so query and document vectors stay comparable). `src/db/embedding-queries.ts` is vectors-in/vectors-out (we do NOT touch the embeddings table in this slice).
  - **#68 hybrid chat machinery** (`src/dashboard/ui/src/hybrid/`) — exists but is **not used** by this slice (see decision D3).
  - **Test helpers:** `createTestDb()` (used by `dashboard-api.test.ts` / `dashboard-import.test.ts`), `src/__tests__/fake-embedder.ts` — deterministic word-basis fake embedder (word overlap directly controls dot-product similarity; identical strings score 1.0).
- **NOT on this branch (parallel branches, unmerged):**
  - **#72 (`spf-watch/72-…`, commit `4b87797`)** — the browser FileReader import substrate: `src/tools/import/client-import.ts` (`parseStatementContent` / `sha256Hex` / `canCommitImport`), `ImportStatementDialog.tsx`, and the ui build plumbing (`@import-tools` vite alias, ui tsconfig paths, ui `csv-parse` dep). **The prompt says "reuse the spec-52 substrate" — it is not merged yet.** See §Step 1 for the convergence strategy.
  - **#92 (`spf-watch/92-…`)** — the Speed Showdown, which creates the **Demo tab** (`#demo` hash route, `DemoTab.tsx`, `TabBar.tsx`/`App.tsx` wiring) and `/api/demo/showdown/*` endpoints. **No Demo tab exists in this tree yet** (verified: `TabBar.tsx` TABS has no `demo`; `App.tsx` `getHashTab()`/`TAB_COMPONENTS` have none). See §Step 6 for the add/add coordination rules.
- **Dashboard UI:** React 19 + Vite 6 + Tailwind 4 + singlefile, `src/dashboard/ui/`; build is a **manual gate** (`cd src/dashboard/ui && npm install && npm run build` → `dist/index.html`); without a build the server serves the legacy `html.ts` fallback and the feature is invisible. Root `tsconfig.json` excludes `src/dashboard/ui` (root typecheck never sees the ui sources); DOM-free pure modules under the ui tree are testable from root `bun test` (established pattern, e.g. `local-chat-bundle.test.ts`).
- **Gates:** `bun run typecheck`, per-file `bun test` loop (CI: `.github/workflows/ci.yml` runs each `src/__tests__/*.test.ts` in its own process), plus the ui builds. **There is no root `lint` or `build` script** — "test / lint / typecheck / build" reduces to those commands.
- **Vendored fixture — verified live:** fetched `origin/demos/granite-demo-videos` and ran the real pipeline over `demos/fixtures/august-2026-chase.csv`: `detectFormat` → `{format:'csv', bank:'chase'}`, **34 rows, date range 2026-08-01 → 2026-08-30**. Ran `detectDuplicates`' exact SQL over an in-memory DB seeded with only those rows: **exactly two duplicate pairs — `HARBORVIEW HOTEL −318.00` (2026-08-17 + 2026-08-20, Δ3 days) and `MEGAMART ONLINE −89.99` (2026-08-12 + 2026-08-13, Δ1 day)** — and zero spikes (the spike detector requires ≥3 same-description rows, which the fixture alone doesn't provide). All other same-description repeats (OAK STREET COFFEE ×4, PAYROLL ×2, CORNER MARKET ×4) fall outside the 3-day window — the two beats are provably the only duplicates. Chase header identical to `data/csv/chase/standard.csv`, so detection is stable.
- **Wilson taxonomy:** `CATEGORIES` in `src/tools/categorize/categories.ts:4` — Dining, Groceries, Transport, Shopping, Subscriptions, Utilities, Health, Entertainment, Travel, Education, Home, Personal Care, Insurance, Gifts, Fees & Interest, Income, Transfer, Other. (Note: deliberately Wilson's names, not Chase's CSV column values.)
- **Anomaly detectors:** `src/tools/query/anomaly-detect.ts` — `detectDuplicates` (same description + same amount within 3 days, SQL JOIN, LIMIT 50) and `detectSpikes` (>3× that description's average, ≥3 occurrences) are module-private; both are pure functions of `(database)`. Exporting them is a two-keyword additive change.

## Design decisions (and why)

1. **The chain reuses the real product paths end-to-end — nothing is faked.** Import = `apiImport` (the exact endpoint the Transactions-tab importer uses); embedding = `embedTexts` (the exact engine behind `wilson --index` and semantic search); reconciliation = the exact SQL of the `anomaly_detect` tool's duplicate/spike detectors. The attendee watches the real machine, not a mock.
2. **"Entirely offline" = everything on localhost, plus a pre-cached model.** The chain's server steps run in the dashboard server process (same-origin); the only external request the whole flow can ever make is the **one-time MiniLM model download** — the manual check therefore includes a pre-cache step (§Verification M0). After caching, the DevTools network tab shows zero non-localhost requests, which is the AC's exact wording.
3. **Category prediction rides the spec-51 embedding machinery, not an LLM.** The prediction = the top known-category match from the local embedding lookup, with the cosine similarity as its confidence — deterministic, milliseconds, zero cloud dependency, and it flows naturally out of node 2 exactly as the issue describes ("embedding lookup → category prediction", "matching each description against known merchants/categories"). The production `categorize` LLM tool is deliberately **not** in this chain: a cloud call violates the offline AC, and the local-Qwen variant (server WebGPU + ~600 MB model + minutes of load + non-deterministic JSON) is already the star of sibling #92 and would make this node fragile. The node is labeled honestly: "predicted from local embeddings — display only".
4. **Prediction is strictly display-only** (explicit in the issue). Nothing is written to `transactions.category` — a test pins that the column is still NULL after a full chain run. This also keeps the slice independent of #84's review-queue guardrail (not on this branch).
5. **The import step commits real rows; a re-drop short-circuits.** Node 1 calls `apiImport`, so file-hash dedup is inherited: re-drop of the same statement returns `status:'skipped'` + `previouslyImported`, the node shows the skip message cleanly, and the chain stops — nodes 2–4 render as "skipped (statement already imported)". Short-circuit (rather than re-running hints) keeps the beat unambiguous and the test trivial. (Rows write is the product behavior; #94's confirmation gate will add the confirm beat later — out of scope here.)
6. **Reconciliation runs over the freshly imported rows only.** The detectors run DB-wide (their real semantics), then hints are filtered to rows whose ids are in the just-imported set — on the demo's fresh DB that is exactly the fixture, and the two proven beats surface. Spikes are included in the node's output and will honestly render "no spikes" for the fixture alone.
7. **Every rendered millisecond is a measured one.** Each step is timed server-side around the step function (`performance.now()`, rounded to whole ms) and returned in its result; the orchestrator's `totalMs` is the exact sum. In-flight UI timers may tick real wall-clock (see #92's honesty rules) but **snap to the server-returned `durationMs` on settle** — never the tick value.
8. **The browser substrate converges with #72.** Since #72 hasn't landed, this slice creates `src/tools/import/client-import.ts` **verbatim from §1 of the already-written spec-72 plan** (`.spf/data/sessions/issue-72/context_handoff/plan.md` — the full module body, doc comments included, is written out there) plus the three ui plumbing diffs (vite alias, tsconfig paths, `csv-parse` dep). Byte-identical content makes the eventual #72 merge a no-op or a trivial resolution. If it already exists when you start: verify the API matches and reuse — do not edit it.
9. **Demo tab coordination with #92** (§Step 6): build the section self-contained; create the tab only if absent; the add/add conflicts are documented and mechanical.

## Data flow (one drop, end to end)

```
Attendee drops/picks a file (.csv/.ofx/.qif) in the Demo tab
  → file.text() → sha256Hex(content)                    browser, WebCrypto (substrate)
  → parseStatementContent(content)                      browser, detectFormat → parser switch (substrate)
       ↳ throws / 0 rows → inline error, chain never starts, ZERO requests
  → POST /api/demo/trace/step {step:'import', filename, bank, fileHash, transactions}
       server: apiImport()  (file-hash dedup · external_id dedup · insert · ledger)
               → resolve importedIds via computeExternalId SELECT
       ↳ status 'skipped' (re-drop) → node 1 shows previouslyImported message,
                                      nodes 2–4 render skipped, chain stops
  → POST …/step {step:'embed', transactions:[{description}…]}
       server: embedTexts over transactionEmbedText(row) for every row (one batched call)
               × dot product vs KNOWN_MERCHANTS reference vectors (cached per model)
       → per-row {label, category, score}
  → POST …/step {step:'predict', description}            // one row — default: first imported row
       server: one embedTexts call → top match → {category, confidence, displayOnly:true}
       (nothing written — UI chip: "prediction only — nothing written")
  → POST …/step {step:'reconcile', importedIds}
       server: detectDuplicates + detectSpikes (anomaly-detect SQL), filtered to importedIds
       → hint cards; the fixture provably yields Harborview $318 ×2 and Megamart $89.99 ×2
```

All four POSTs are same-origin. Step results carry `durationMs`; the UI lights each node as its response lands.

## Files to touch

| File | Change |
|---|---|
| `demos/fixtures/august-2026-chase.csv` | **New.** Vendored verbatim: `git fetch origin demos/granite-demo-videos && git show origin/demos/granite-demo-videos:demos/fixtures/august-2026-chase.csv > demos/fixtures/august-2026-chase.csv` (path kept identical to the demos branch so provenance is auditable by diff). `demos/` is not gitignored (verified). |
| `src/tools/import/client-import.ts` | **New — only if #72 hasn't landed** (check first). Copy §1 of `.spf/data/sessions/issue-72/context_handoff/plan.md` **verbatim** (module body incl. doc comments: `ParsedStatement`, `parseStatementContent`, `sha256Hex`, `canCommitImport`). Pure module, no Node imports — bundles in the browser and typechecks/tests under the root gates. |
| `src/dashboard/ui/vite.config.ts`, `src/dashboard/ui/tsconfig.json`, `src/dashboard/ui/package.json` (+ tracked `package-lock.json`) | The three `@import-tools` plumbing diffs from spec-72 §2a (alias → `../../tools/import`, tsconfig `paths` entry, `"csv-parse": "^5.6.0"` dep + `npm install` in the ui dir to refresh the lock). Only if #72 hasn't landed. |
| `src/demo/known-merchants.ts` | **New.** The known merchants/categories reference set (§Step 3). |
| `src/demo/statement-trace.ts` | **New.** The chain: step functions + `runStatementChain` orchestrator (§Step 4). |
| `src/tools/query/anomaly-detect.ts` | Additive: `export` on `detectDuplicates`, `detectSpikes`, and the `DuplicateAnomaly`/`SpikeAnomaly` interfaces. No SQL or behavior change. |
| `src/dashboard/api.ts` | `apiDemoTraceStep(db, body)` handler (thin dispatcher, §Step 5). |
| `src/dashboard/server.ts` | One route: `POST /api/demo/trace/step` in the authed section next to `/api/import`; the `import` step mirrors `/api/import`'s `canWrite` 403 (§Step 5). |
| `src/dashboard/ui/src/demo/AgentTraceSection.tsx` | **New.** Drop zone + chain driver + flow diagram (§Step 6). |
| `src/dashboard/ui/src/tabs/DemoTab.tsx` | **New — only if absent** (it is, today). Minimal shell: headline + `<AgentTraceSection />`. |
| `src/dashboard/ui/src/components/TabBar.tsx` | Add `{ id: 'demo', label: 'Demo' }` to `TABS` (after `chat`); `TabId` follows. |
| `src/dashboard/ui/src/App.tsx` | Add `'demo'` to `getHashTab()`'s valid list and `DemoTab` to `TAB_COMPONENTS`. |
| `src/__tests__/statement-trace.test.ts` | **New.** Orchestrator tests on the vendored fixture (§Step 7). |
| `src/__tests__/statement-trace-endpoints.test.ts` | **New.** HTTP-layer tests (§Step 7). |
| `CHANGELOG.md` | One `feat:` bullet under `## [Unreleased] → ### Features` (§Step 8). |

**Do not touch:** `apiImport`'s contract or validation, the parsers, `csv-import.ts`, `external-id.ts`'s derivation, the DB schema (no migration — the embeddings table is intentionally not written by this slice), `src/dashboard/html.ts` (legacy fallback gets nothing), the hybrid chunk (transformers stays out of the main bundle), `src/tools/categorize/*` (the LLM categorizer is not in this chain).

## Step 1 — Browser substrate (conditional convergence with #72)

At build time, check `src/tools/import/client-import.ts`:

- **Exists →** verify it exports `parseStatementContent`, `sha256Hex`, `canCommitImport` and type `ParsedStatement` per spec-72; use it as-is. Do not edit; do not add the plumbing diffs if they're already there.
- **Absent →** create it by copying §1 of `.spf/data/sessions/issue-72/context_handoff/plan.md` **byte-for-byte** (that plan contains the complete module, including the doc comments — do not retype from memory). Same for the three plumbing diffs in §2a of that plan. Rationale: #72 may land in parallel; identical content means `git merge` sees the same lines added twice and resolves cleanly.

What the trace consumes from it: `parseStatementContent(content) → { format, bank, transactions, dateRange, total }` and `await sha256Hex(content)`. `canCommitImport(authStatus)` gates the drop zone exactly like #72's dialog (auth on + non-admin → drop zone shows the admin hint instead of running the chain; the server still enforces 403 regardless).

## Step 2 — Vendored fixture

Exactly the command in the files table. Sanity-check after vendoring (already verified on this worktree, but re-run cheaply): `wc -l` → 35 lines (header + 34 rows); first row `08/01/2026,…,3200.00`; the two duplicate beats present (rows 13–14 MEGAMART ONLINE −89.99; rows 18 & 20 HARBORVIEW HOTEL −318.00). The file parses as `{format:'csv', bank:'chase'}` with the existing `detectFormat` + `parseChaseCSV` — no parser changes are needed or allowed.

## Step 3 — Reference set: `src/demo/known-merchants.ts` (new)

```ts
export interface KnownMerchant {
  label: string;     // merchant string as it appears on statements — also the embed text
  category: string;  // a member of CATEGORIES (src/tools/categorize/categories.ts)
}
export const KNOWN_MERCHANTS: KnownMerchant[];
```

Entries (draft — cover every fixture merchant; categories are Wilson's taxonomy, deliberately not the bank's CSV column):

| label | category |
|---|---|
| CORNER MARKET #1247 | Groceries |
| OAK STREET COFFEE | Dining |
| SUNRISE DINER | Dining |
| BLUE WAVE SEAFOOD | Dining |
| THE GILDED FORK | Dining |
| SEASIDE BAR & GRILL | Dining |
| MEGAMART ONLINE | Shopping |
| MEGA ONLINE STORE | Shopping |
| AIRPORT NEWS & GIFTS | Shopping |
| HARBORVIEW HOTEL | Travel |
| HARBORVIEW DENTAL GROUP | Health |
| FUEL DEPOT | Transport |
| COASTAL CAB CO | Transport |
| CITY PARKING AUTHORITY | Transport |
| CITY ELECTRIC CO AUTOPAY | Utilities |
| CLOUDVAULT BACKUP | Utilities |
| MAPLE AVE APARTMENTS RENT | Home |
| SKYSTREAM PLUS MONTHLY | Entertainment |
| STREAMFLIX SUBSCRIPTION | Subscriptions |
| RIVERDALE GYM MONTHLY | Health |
| PHARMACY PLUS #210 | Health |
| PAYROLL DEPOSIT - ACME CORP | Income |

(`HARBORVIEW DENTAL GROUP` is intentional: exact-string entries score 1.0 under the fake embedder while the shared-word `HARBORVIEW` entry demonstrates partial-overlap ranking below the exact match. The demo narrative also gets "Wilson's categories, not the bank's" — Chase's CSV says "Transportation"/"Health & Wellness", Wilson says "Transport"/"Health".)

## Step 4 — Chain module: `src/demo/statement-trace.ts` (new)

Server-side. Imports: `apiImport` + `ImportRequestBody` types (`../dashboard/api.js`), `computeExternalId` (`../tools/import/external-id.js`), `embedTexts`, `transactionEmbedText`, `normalizeVector`, `DEFAULT_EMBEDDING_MODEL` (`../utils/embeddings.js`), `CATEGORIES` (`../tools/categorize/categories.js`), `detectDuplicates`/`detectSpikes` (`../tools/query/anomaly-detect.js`), `KNOWN_MERCHANTS` (`./known-merchants.js`).

```ts
export type TraceStepId = 'import' | 'embed' | 'predict' | 'reconcile';

export interface TraceStepResult {
  step: TraceStepId;
  status: 'ok' | 'skipped' | 'error';
  durationMs: number;                       // Math.round of real wall-clock around the step body
  detail:
    | { bank: string; format: string; rowCount: number; imported: number; skippedRows: number;
        importedIds: number[]; previouslyImported?: { importedAt: string; transactionCount: number | null };
        message: string }
    | { model: string; matches: { description: string; label: string; category: string; score: number }[] }
    | { description: string; category: string; confidence: number; displayOnly: true }
    | { duplicates: DuplicateAnomaly[]; spikes: SpikeAnomaly[] };
  error?: string;                           // set when status === 'error'
}

export interface TraceRunResult { steps: TraceStepResult[]; totalMs: number; }

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface TraceDeps {
  db: Database;
  embed?: EmbedFn;                          // default: (texts) => embedTexts(texts) — inject the fake in tests
  importFn?: typeof apiImport;              // injectable for tests
}
```

Step functions (each opens with `const t0 = performance.now()`, ends with `durationMs: Math.round(performance.now() - t0)`):

- **`importStep(input: {filename, bank, fileHash, transactions}, deps): Promise<TraceStepResult>`**
  1. `const result = (deps.importFn ?? apiImport)(deps.db, body)` — the exact `ImportRequestBody` shape `/api/import` receives (rows mapped 1:1 from `ParsedTransaction`: `date, description, amount, external_id?, bank`, plus `merchant_name/category_detailed/payment_channel/pending/authorized_date` when present — same mapping as spec-72 §2b step 5).
  2. `result.status === 'failed'` → `{ status:'error', error: result.error }`.
  3. `result.status === 'skipped'` → `{ status:'skipped', detail: { …, previouslyImported: result.previouslyImported, message: result.message } }` — the chain's caller then skips steps 2–4.
  4. `status === 'imported'` → resolve ids: chunk the parsed rows' `computeExternalId(row)` values (only for rows lacking their own `external_id`; chase CSV rows have none) into `IN (…)` SELECTs of ≤500 ids against `transactions` → `importedIds` (sorted). Include `message: result.message`.
- **`embeddingStep(rows: {description: string}[], deps): Promise<TraceStepResult>`**
  1. `texts = rows.map(r => transactionEmbedText({ description: r.description }))` — the canonical rule, so row and reference vectors are comparable.
  2. `[rowVecs, refVecs] = await Promise.all([embed(texts), getReferenceEmbeddings(deps.embed)])` — reference vectors computed once per process: module-level `Map<string /* model key */, Float32Array[]>`, keyed by `DEFAULT_EMBEDDING_MODEL`, computed by embedding every `KNOWN_MERCHANTS` label through the same `embed` fn. (Documented constraint: one embedder per process per model key — true in production and in tests.)
  3. Per row: score = dot of the two L2-normalized vectors (pure local helper `dotVec(a,b)`), argmax over references → `{description, label, category, score: round(score*1000)/1000}`. Every row gets a match (nearest neighbor, however weak) — scores are displayed, never thresholded in this slice.
- **`predictStep(description: string, deps): Promise<TraceStepResult>`**
  1. `[vec] = await embed([transactionEmbedText({ description })])`; score vs the cached reference vectors → top match.
  2. `detail: { description, category: top.category, confidence: clamp(score, 0, 1), displayOnly: true }`. The step writes nothing anywhere — assert-worthy by construction (no db call exists in this function).
- **`reconcileStep(importedIds: number[], deps): Promise<TraceStepResult>`**
  1. `const idSet = new Set(importedIds)`.
  2. `duplicates = detectDuplicates(deps.db).filter(a => a.transactions.every(t => idSet.has(t.id)))`; `spikes = detectSpikes(deps.db).filter(a => idSet.has(a.transaction.id))`.
  3. Return both arrays verbatim (their `message` strings are the hint-card copy).
- **`runStatementChain(input, deps): Promise<TraceRunResult>`** — the orchestrator:
  1. `import` → if `status !== 'ok'`: push filler `{status:'skipped', durationMs:0}` results for `embed/predict/reconcile` (skip reason in `error`), return. (This is the re-drop path.)
  2. `embed` over the parsed rows → on error, stop with remaining steps skipped (same filler rule).
  3. `predict` on `input.transactions[0].description` (deterministic default; the UI can re-run it on a clicked row).
  4. `reconcile`.
  5. `totalMs = steps.reduce((s, r) => s + r.durationMs, 0)` — timing accumulation lives here and is asserted exactly in tests.

Failure posture: a step throwing → that step `{status:'error', error: err.message}` and all later steps become `skipped` fillers; nothing is fabricated. (Import's `failed` path is `apiImport`'s own validation result, mapped to `error`.)

## Step 5 — API + route

**`src/dashboard/api.ts`** — `apiDemoTraceStep(db: Database, body: unknown): TraceStepResult`:
- Validate `body` is an object with `step ∈ {'import','embed','predict','reconcile'}` → else `{ step, status:'error', error:'unknown step' }` (route maps to 400).
- `import` → `importStep(db, body)` (rows validated inside `apiImport` as today); `embed` → require `transactions: string[]-of-{description}` (1..2000, non-empty strings) → `embeddingStep`; `predict` → non-empty `description` string → `predictionStep`; `reconcile` → non-empty `importedIds: number[]` → `reconcileStep`. Malformed → `status:'error'` with a precise message (→ 400).

**`src/dashboard/server.ts`** — in the authed section beside `/api/import` (line ~381):

```ts
if (path === '/api/demo/trace/step' && req.method === 'POST') {
  if (body.step === 'import' && authEnabled && currentUser && !canWrite(currentUser.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });   // mirrors /api/import
  }
  const result = await apiDemoTraceStep(activeDb, body);
  return Response.json(result, { status: result.status === 'error' ? 400 : 200, headers });
}
```

(`import` is the only write; `embed/predict/reconcile` are reads/inference and sit under normal authed-section rules. There are no other new endpoints — one route keeps the #92 conflict surface minimal.)

## Step 6 — UI: section + Demo tab

**`src/dashboard/ui/src/demo/AgentTraceSection.tsx`** (new, self-contained; no new deps; Tailwind + existing tokens):

- **Intake.** Dashed-border drop zone ("Drop a bank statement — CSV, OFX, or QIF — or click to browse") + hidden `<input type="file" accept=".csv,.ofx,.qif">`; `onDrop` takes `files[0]`, extension validated. No image/OCR anywhere — the accept list **is** the boundary (per the round-1 decision); a rejected file shows the inline error and starts nothing.
- **Parse (client-side, timed).** On file intake: `t0 = performance.now()` → `content = await file.text()` → `fileHash = await sha256Hex(content)` → `parseStatementContent(content)` → `parseMs = performance.now() - t0`. Throw / 0 rows → inline error in the section, **zero requests made** (honest negative beat). RBAC: when `canCommitImport(authStatus)` is false, show the admin hint instead of running (auth status via `useApi('/api/auth/status')`, same pattern as #72).
- **Chain driver.** On parse success, auto-run, one step at a time (each node must visibly light on its own response):
  1. Node 1 `POST /api/demo/trace/step` `{step:'import', filename, bank, fileHash, transactions}` — on settle: show server `durationMs` + `parseMs` + bank/format label + row count + result message. `skipped` → skip message + nodes 2–4 rendered skipped; `error` → inline error, stop.
  2. Node 2 `{step:'embed', transactions: parsed.transactions.map(t => ({description: t.description}))}` → per-row match table (description → matched merchant, category, score), scrollable.
  3. Node 3 `{step:'predict', description: firstRow.description}` → decision card: predicted category (Wilson taxonomy), confidence (e.g. `0.93`), and the `prediction only — nothing written` chip. **Clicking any row in node 2's table re-runs node 3 on that row** (a fresh POST → fresh real timing) — the demo's "pick any row" moment; default remains the first row (PAYROLL → Income, the sign-convention beat).
  4. Node 4 `{step:'reconcile', importedIds}` → hint cards from the step detail; the two fixture beats render as duplicate cards with both dates + amounts (`HARBORVIEW HOTEL — $318.00 on 2026-08-17 and 2026-08-20`).
- **Flow diagram.** Vertical four nodes with connector lines; per-node states: `pending` (dimmed) → `running` (pulsing border + a real elapsed-ms ticker from run start) → `done` (✓ + the **server-returned** `durationMs` badge — the ticker snaps to it, never renders it) / `skipped` (gray, reason) / `error` (red, message verbatim). A footer line shows `totalMs` (the sum the server accumulated) after the run. One run at a time; re-drop/re-run allowed.
- **Network honesty.** Every request the section makes is a same-origin `api()` call (existing helper) — nothing else. No external URLs anywhere in the component.

**Tab wiring** (see coordination rules):
- If `src/dashboard/ui/src/tabs/DemoTab.tsx` **exists** (#92 landed first): import and render `<AgentTraceSection />` inside it below the existing section; touch nothing else of theirs.
- If it **does not exist** (today's tree): create it minimal — headline (**"Your agent. Your data. Your machine."** or similar to #92's family) + the section; add `demo` to `TabBar.tsx` `TABS` (after `chat`) and to `App.tsx` `getHashTab()` valid list + `TAB_COMPONENTS`.
- **#92 add/add conflict resolution** (for whoever merges second): `TabBar.tsx`/`App.tsx` — keep both additive lines; `DemoTab.tsx` — keep #92's headline + showdown section, append `AgentTraceSection` import + element. Both sides' endpoint routes (`/api/demo/showdown/*` vs `/api/demo/trace/step`) are separate path branches in `server.ts` and merge cleanly.

## Step 7 — Tests (all new in this slice, per-file process style)

**`src/__tests__/statement-trace.test.ts`** (imports `../demo/statement-trace.js`, `../demo/known-merchants.js`, `../tools/import/client-import.js`, `./fake-embedder.js`, test-db helper; deps injected — no network, no model):

1. **Fixture integrity:** `demos/fixtures/august-2026-chase.csv` exists; `parseStatementContent(readFileSync(...,'utf-8'))` → `{format:'csv', bank:'chase'}`, 34 transactions, `dateRange` `{start:'2026-08-01', end:'2026-08-30'}`.
2. **Reference-set integrity:** labels unique; every `category ∈ CATEGORIES`; `KNOWN_MERCHANTS` non-empty.
3. **Orchestrator sequencing + timing accumulation (the core AC test):** `runStatementChain(fixturePayload, { db: createTestDb(), embed: fakeEmbedWrap })` → exactly four steps in order `import → embed → predict → reconcile`, each `status:'ok'`, each `durationMs` a finite number ≥ 0, and `totalMs === steps.reduce(...)` exactly (the accumulation contract). The embed step's `matches` has 34 entries; the predict step's `description` is the first row's (`PAYROLL DEPOSIT - ACME CORP`).
4. **Import step contents:** `imported === 34`, `importedIds.length === 34`, and the ids resolve via `computeExternalId`-based SELECT (spot-check two ids' date/description/amount against the fixture).
5. **Embedding matches:** every row has a match with `score ∈ [0,1]`; the `OAK STREET COFFEE` row's top match is the exact `OAK STREET COFFEE` reference (score `1.0` under the fake embedder, strictly greater than any partial-overlap entry such as `HARBORVIEW DENTAL GROUP` matching the `HARBORVIEW HOTEL` rows).
6. **Prediction + display-only:** predict step → `{category:'Income', confidence ∈ [0,1], displayOnly:true}` for the payroll row; **assert `SELECT category FROM transactions WHERE id IN (importedIds)` is NULL for every row** — nothing written.
7. **Reconciliation beats (the proven ones):** duplicate hints === exactly 2, matched by description — `HARBORVIEW HOTEL` (dates 2026-08-17 + 2026-08-20, amount −318) and `MEGAMART ONLINE` (2026-08-12 + 2026-08-13, −89.99); `spikes` is empty for the fixture-only DB. Each hint's `message` contains the description and amount.
8. **File-level dedup on re-drop:** run the chain twice with the identical payload → second run: import step `status:'skipped'` with `previouslyImported` populated, steps 2–4 are `skipped` fillers with `durationMs 0`, `totalMs` still equals the sum, and `SELECT COUNT(*) FROM transactions` is unchanged (34).
9. **Error propagation:** a payload that fails `apiImport` validation (e.g. a bad date) → import step `status:'error'` with the message and remaining steps `skipped`; nothing inserted.

**`src/__tests__/statement-trace-endpoints.test.ts`** (boot the real server on port 0 — copy the `dashboard-server.test.ts` pattern):

10. `POST /api/demo/trace/step` `import` → 200 + imported 34; **immediate re-POST** → 200 with `status:'skipped'` + `previouslyImported` (the HTTP-layer dedup beat); `embed`/`predict`/`reconcile` → 200 with their detail shapes; reconcile returns the two beats.
11. Unknown `step` → 400; malformed bodies (missing `description`, `importedIds` not numbers, empty arrays) → 400 with messages; no traces/rows written by read-only steps.
12. **Auth posture:** with auth enabled and a non-admin session, the `import` step returns 403 (copy the auth-bootstrap pattern from `dashboard-auth.test.ts` / `dashboard-import.test.ts` if it is cheap; if the bootstrap is disproportionate, cover the `canWrite` mirror with a comment pointing at the identical `/api/import` guard and keep the unauthed coverage — the substrate's `canCommitImport` policy test in #72 already pins the client side).

## Step 8 — CHANGELOG

Under `## [Unreleased] → ### Features`, one bullet:

```
- feat: statement-to-dashboard agent trace — the Demo tab gains a drop-a-statement flow that runs Wilson's offline chain as a live four-node diagram (import → local embedding lookup → category prediction → reconciliation hint), each node lit by its real server-measured duration; import reuses the /api/import substrate with file-hash dedup (re-drop skips cleanly), embeddings run the local MiniLM engine against a known-merchant/category reference, predictions are strictly display-only (nothing written), and reconciliation surfaces duplicate/spike hints over the freshly imported rows — vendored ground-truth fixture at demos/fixtures/august-2026-chase.csv (#93)
```

## Verification

Gates (all must pass; note there is **no root lint/build script** — these are the repo's gates):

1. `bun run typecheck`
2. CI-style per-file loop: `for f in src/__tests__/*.test.ts; do bun test "$f" 2>&1 || FAIL=1; done; echo FAIL=$FAIL`
3. UI build (manual gate, required for the feature to be visible at all): `cd src/dashboard/ui && npm install && npm run build` — `tsc -b` + `vite build` must produce `dist/index.html`; `dist/` stays gitignored. If the substrate was created in Step 1, the `@import-tools` alias must resolve in this build.

Manual check (maps to the acceptance criterion — **the build step is required**):

- **M0 — pre-cache the embedding model (offline prerequisite).** On the demo machine, before doors open, make one local embedding call so MiniLM lands in `~/.openaccountant/models/` (e.g. `bun run src/index.tsx --index` on the demo profile, or simply run this flow once online). This is the only network the flow can ever trigger; afterwards the run is fully local.
- **M1 — the money shot:** fresh profile, `bun run start` → dashboard → `#demo` → drop `demos/fixtures/august-2026-chase.csv` → all four nodes light **in order** (import → embed → predict → reconcile), each showing a real per-step ms badge and a sane total; node 1 shows "CHASE CSV · 34 transactions"; node 2's table shows per-row matches with scores; node 3 shows `PAYROLL DEPOSIT - ACME CORP → Income` with a confidence and the display-only chip; node 4 shows the two duplicate beat cards (Harborview $318 ×2, Megamart $89.99 ×2). DevTools network tab over the whole run: **only localhost requests, zero non-localhost**.
- **M2 — re-drop:** drop the same file again → node 1 renders the already-imported skip message, nodes 2–4 show skipped, transaction count unchanged.
- **M3 — negative path:** drop a `.txt`/garbage file → inline error in the section, the chain never starts, and the network tab shows **no** requests at all for the attempt.
- **M4 — boundary eyeball:** the flow offers no image/OCR input anywhere (accept list is `.csv/.ofx/.qif` only; no file-conversion affordance exists) — the round-1 boundary holds structurally.
- **M5 — RBAC spot-check** (optional): with auth on, a viewer sees the admin hint instead of a runnable chain.

## Acceptance-criteria map

| Criterion | Covered by |
|---|---|
| Chain orchestrator step sequencing + per-step timing accumulation on the vendored fixture (tests written in this slice) | §7 tests 3–6 (`runStatementChain`, `totalMs` exact-sum, per-step `durationMs`) |
| File-level dedup on re-drop (tests written in this slice) | §7 test 8 (orchestrator) + test 10 (HTTP layer) + manual M2 |
| Repo test / lint / typecheck / build pass | §Verification gates 1–3 (no lint/build scripts exist; typecheck + per-file bun test + ui build are the gates) |
| Manual: drop fixture → four nodes in order, real per-step ms, duplicate beat as hint, zero non-localhost requests | §Verification M1 (with M0 pre-cache) |
| No image/OCR input anywhere in the flow | §Step 6 accept-list boundary + manual M4; no OCR code exists or is added |

## Risks / notes for the builder

- **Model pre-cache is part of the demo script, not optional** — the first embedding call otherwise downloads MiniLM from the Hub (a non-localhost request that would fail the AC's network check). M0 exists for exactly this; the demo machine should also have run it before doors open.
- **The substrate/#72 convergence is the delicate bit.** Copy §1 of the issue-72 session plan verbatim; if #72 lands first, reuse and do not edit. Do not "improve" the module (e.g. BOM handling) — the spec-72 notes pin those decisions.
- **Do not write embeddings.** The chain never touches the `embeddings` table — indexing is `wilson --index`'s job (#61). This keeps the demo's writes limited to the import itself.
- **Confidence is a cosine score.** Dot of L2-normalized vectors ∈ [−1,1]; clamp to [0,1] for display. Do not call it a model probability; the UI copy says "similarity".
- **Reconciliation scoping:** ids come from the `computeExternalId` SELECT, so rows that already existed (overlapping prior imports) are included — on the demo's fresh profile the set is exactly the fixture. Don't add intra-batch dedup or scope changes; `apiImport`'s semantics are pinned by its tests.
- **#92 conflicts are expected and mechanical** (§Step 6). Do not rebase onto `spf-watch/92-*`; do not pre-emptively build their endpoints or samples.
- **`performance.now()` is available in Bun** (used the same way by the #92 design); round to whole ms for display.
- **SQLite parameter limits:** chunk the `external_id IN (…)` SELECTs (≤500 per query) — 34 rows today, but statements can be large.
- **`tsconfig.tsbuildinfo` in the ui dir is tracked** and churns on ui builds — commit or restore it, don't gitignore it.
- **Timing honesty:** node 1's on-screen ms is the server's import-work duration; the client-measured `parseMs` is displayed as its own labeled line ("parsed in X ms"). Never render the in-flight ticker as the final number.

## Out of scope

- Image/OCR input of any kind (round-1 boundary — structurally absent).
- Local-Qwen LLM categorization in this chain (#92's showcase); the production `categorize` tool's behavior; #84's review queue.
- Writing categories or embeddings; the `embeddings` table; `wilson --index` behavior.
- #94's confirmation gate, #95's privacy validator, the full #91 tab polish, attendee QR/auth flows.
- Cloud calls of any kind from the chain; batch/multi-file drops; persisting trace runs.