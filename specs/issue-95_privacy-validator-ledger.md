# Plan: Privacy Validator — a live provider ledger proving the demo run never left localhost (Demo tab, section 3)

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-95` (branch contains both blockers already — verified: `1365e1e` = #92 Speed Showdown, `ec75bff` = #93 statement trace)
**Issue:** #95, decomposed from #58 (demo-table artifact); parent artifact tab is #91. Siblings #92/#93 landed; this is the stretch panel that closes the tab.
**Outcome:** An attendee opens the **Privacy Validator** panel in the Demo tab and watches a **live provider ledger** — every model/agent request observed in their run, each labeled by where it actually went — proving the traffic stayed on localhost. Side-by-side sits the exhibit of the exact request a cloud-based agent (the jev-ultrafast contrast case) would have sent for the same decision step, labeled honestly as built only from synthetic sample rows. "Local means private" becomes something the attendee watches being true during their own run.

## Grounding — what exists today (verified in this tree)

- **Both blockers landed.** The Demo tab exists (`src/dashboard/ui/src/tabs/DemoTab.tsx`) and stacks: #93's headline + `<AgentTraceSection />`, then #92's headline ("Your agent. Your data. Your speed."), picker, arm cards, verdict box, and the collapsible payload exhibit **last**. `selectedSlug` state lives in DemoTab (set on picker click and on run) — available to pass down.
- **Trace store** (`src/utils/trace-store.ts`): in-memory ring buffer (MAX 200) + SQLite persistence into `llm_traces` via `setDatabase()`; `record()`, `getTraces()`, `getRecentTraces(limit)`, `clear()`. `LlmTrace` = `{ id, timestamp, model, provider, promptLength, responseLength, inputTokens, outputTokens, totalTokens, durationMs, status: 'ok'|'error', error? }`. Schema (`src/db/schema.ts:193`): `trace_id`, `provider`, `model`, …, `created_at TEXT DEFAULT (datetime('now'))`.
- **Timestamp formats differ across sources — a correctness trap.** In-memory rows carry `new Date().toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`); DB rows carry `created_at` = `YYYY-MM-DD HH:MM:SS` (UTC, second granularity, no tz marker, space separator). Never string-compare a watermark across both. (`apiTraces` at `src/dashboard/api.ts:661` reads DB-first — `ORDER BY id DESC LIMIT @limit`, `created_at AS timestamp` — and falls back to the memory buffer **only when the DB returns zero rows**. DB ordering is the monotone autoincrement `id`.)
- **Every model/agent request funnels through `callLlm`** (`src/model/llm.ts`), which records one trace per call with `provider: provider.id` — on the success path (~line 125) **and on the error path** (~line 178/217, `status:'error'`). A failed cloud attempt therefore still leaves an attributable provider row. The statement-trace chain (#93) makes **zero** trace rows (verified: no `callLlm`/`traceStore` references in `src/demo/statement-trace.ts` — embeddings bypass `callLlm`).
- **#92's markers** (in `src/demo/showdown.ts`): `recordSimulatedCloudTrace` writes `provider: 'simulated'`, `model: 'simulated:<apiModel>'`; `recordBrowserLocalTrace` writes `provider: 'transformers-browser'`. Neither is exported as a constant today (inline literals) — this slice hoists them to exported constants in `showdown.ts` (additive, behavior unchanged).
- **Provider registry** (`src/providers.ts`): `ProviderDef.isLocal: boolean` — documented verbatim as "The single place local-vs-server classification comes from". Local: `ollama`, `transformers`. Cloud (`isLocal:false`): `openai`, `anthropic`, `google`, `xai`, `moonshot`, `deepseek`, `openrouter`, `litellm`. `getProviderById(id)` returns `undefined` for the two demo markers.
- **Fixture + prompt builders** (`src/demo/samples.ts`, `src/demo/showdown.ts`): `SAMPLE_TRANSACTIONS` (8 rows, fixed fields), `getSampleBySlug` (throws on unknown), `buildShowdownUserPrompt(sample)` = the production `buildCategorizationPrompt([{id, description, amount, date}])`, `SHOWDOWN_SYSTEM_PROMPT` (= `CATEGORIZER_SYSTEM_PROMPT`), and the pre-rendered `SAMPLE_TRANSACTIONS_CACHE`. The jev-ultrafast caption `CONTRAST_CAPTION` lives in the pure UI module `src/dashboard/ui/src/demo/core.ts` — the UI can import it directly (it already does in DemoTab); the server must not import from the ui tree.
- **Route posture** (`src/dashboard/server.ts` ~698–740): `/api/demo/showdown/*` sit in the authed section, 400 on bad input (route catches handler throws), 200 + `{ ok:false, error }` for arm-internal failures. Thin handlers in `src/dashboard/api.ts` (~618–658). Endpoint tests boot the real server on port 0 and pin everything at the HTTP layer (`src/__tests__/showdown-endpoints.test.ts` — env mock forces no OpenRouter key, transformers mock makes the server local arm fail deterministically, `traceStore.setDatabase(db)` so misattribution is asserted in `llm_traces`).
- **UI helpers**: `api<T>(path, options)` (auth header, mirror fallback on connection errors) and `useApi<T>(path, deps)` (fetch-on-mount + `deps` array re-fetch; no built-in polling — the section adds its own `setInterval`). Demo-tab components mirror server response types locally (established pattern in DemoTab).
- **Gates**: `bun run typecheck`; CI-style per-file loop `for f in src/__tests__/*.test.ts; do bun test "$f"; done` (each file in its own process — `mock.module` never crosses files); ui build is a manual gate (`cd src/dashboard/ui && npm ci && npm run build` → `dist/index.html`; `tsc -b` inside the ui dir is what typechecks the new component — the root tsconfig excludes `src/dashboard/ui`). **No root lint or build script exists.** The hybrid chunk is untouched by this slice (the new section lives in the main bundle).

## Design decisions (and why)

1. **The ledger reads only the trace store — no new instrumentation layer.** The ticket grounds it: "The trace store already records the provider per call." `callLlm` is the single choke point for every model/agent request (chat, tools, demo arms), and #92's two recorders already add the simulated and browser-local rows with their markers. A new "request observer" would duplicate that and risk drifting from what the LLM tab shows. Consequence, embraced: during a statement-trace-only run the ledger is legitimately empty — the chain makes no LLM calls — and the panel's empty state says exactly that.
2. **Run scoping = id-exclusion watermark, server-issued.** "Requests observed in that run" needs a run boundary. The panel arms monitoring (`POST /api/demo/privacy/start`), the server snapshots the ids of every trace present at that moment (DB latest-200 ∪ in-memory buffer) into module state, and the ledger returns rows **not in that set**. Chosen over a timestamp watermark because `created_at` and ISO strings are different formats (Grounding bullet 2) and second-granularity `datetime('now')` makes a `>=` cutoff lossy at the boundary; id exclusion is exact. The server (not the browser clock) issues the run, so a QR/phone client with clock skew can't misplace the watermark. Module-level `Map<runId, {startedAt, knownIds}>`, capped at 5 runs (oldest evicted) — supports two panels and survives re-arms.
3. **Classification comes from the registry's `isLocal` — the single source — plus #92's two markers.** `classifyProvider(provider)`: `'simulated'` → `simulated` bucket (never cloud — the misattribution the AC calls out); `'transformers-browser'` → `local` (it runs in the attendee's own browser on the same host); registry hit → `isLocal ? 'local' : 'cloud'`; anything else → `'unknown'`, rendered honestly and **never silently counted as local**. The marker strings are imported from `showdown.ts` after being hoisted to exported constants (no string drift, one source).
4. **The verdict must be able to fail.** The ledger is a proof instrument: a real cloud call during the run (live showdown arm with key+network, a cloud chat, any tool call) renders a red row and the verdict says the all-local claim does not hold. An all-clear verdict requires `cloud === 0 && unknown === 0`. This is what makes the panel worth watching — it is not a banner that always says "local".
5. **Exhibit = the exact would-be cloud payload, built only from fixtures — structurally.** `getPrivacyExhibit(slug?)`: with a slug it returns byte-identical the payload the showdown arms send for that sample (`buildShowdownUserPrompt(getSampleBySlug(slug))` — a test pins the equality); without, it returns `buildCategorizationPrompt` over all 8 `SAMPLE_TRANSACTIONS` rows ("the request payload with the transaction rows"). Both paths take only in-repo fixture rows, no `db` parameter exists on the function, and no code path reads the DB — an imported row is physically incapable of entering the payload. DemoTab passes its `selectedSlug` down, so the exhibit follows the row the attendee picked ("the same step"), defaulting to the full fixture set.
6. **Polling, not sockets.** The section auto-arms on mount and polls the ledger every 1 s while monitoring (interval + `api()`); a 400 (`unknown privacy run` — e.g. the server restarted and wiped module state) triggers one automatic re-arm instead of a broken panel. `Stop` ends polling; "Start fresh" re-arms with a new watermark. One source of truth for the ledger text: the **server** computes counts + verdict; the UI renders strings, it never re-classifies.
7. **The panel watches everything, not just demo calls.** The trace store holds all model/agent traffic — if the attendee (or a tool) makes a cloud request mid-run, it appears. That is the point: the ledger proves what actually happened in *their* run, whatever its source. No filtering by `callType` (not persisted in `llm_traces` anyway).

## Step 1 — Hoist #92's marker constants (`src/demo/showdown.ts`, additive)

```ts
export const SIMULATED_PROVIDER = 'simulated';
export const BROWSER_LOCAL_PROVIDER = 'transformers-browser';
```

`recordSimulatedCloudTrace` and `recordBrowserLocalTrace` use the constants instead of their inline literals (byte-identical values — behavior unchanged). No other file changes.

## Step 2 — Privacy module: `src/demo/privacy.ts` (new, server-side)

Imports: `traceStore` + `type LlmTrace` (`../utils/trace-store.js`), `getProviderById` (`../providers.js`), `buildCategorizationPrompt` (`../tools/categorize/prompt.js`), `SHOWDOWN_SYSTEM_PROMPT`, `buildShowdownUserPrompt`, `SIMULATED_PROVIDER`, `BROWSER_LOCAL_PROVIDER` (`./showdown.js`), `SAMPLE_TRANSACTIONS`, `getSampleBySlug`, `type SampleTransaction` (`./samples.js`).

```ts
export type LedgerBucket = 'local' | 'simulated' | 'cloud' | 'unknown';

/** Chip copy per bucket (UI renders these verbatim; server-tested). */
export const BUCKET_LABELS: Record<LedgerBucket, string> = {
  local: 'localhost',
  simulated: 'simulated — no network',
  cloud: 'CLOUD',
  unknown: 'unrecognized',
};

/**
 * The one classification rule. 'simulated' can never be 'cloud' (the #92
 * marker exists precisely to prevent that misattribution); an unrecognized
 * provider is never silently 'local' — it lands in its own honest bucket.
 */
export function classifyProvider(provider: string): LedgerBucket;
// provider === SIMULATED_PROVIDER → 'simulated'
// provider === BROWSER_LOCAL_PROVIDER → 'local'
// def = getProviderById(provider); !def → 'unknown'; def.isLocal → 'local'; else 'cloud'

export interface LedgerEntry {
  traceId: string;
  timestamp: string;        // normalized ISO (see normalizeTimestamp)
  provider: string;         // verbatim from the trace row
  model: string;            // verbatim
  bucket: LedgerBucket;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
}

export interface PrivacyLedger {
  runId: string;
  startedAt: string;                        // ISO, display only
  entries: LedgerEntry[];                   // chronological, oldest → newest
  counts: { local: number; simulated: number; cloud: number; unknown: number; total: number };
  allLocal: boolean;                        // cloud === 0 && unknown === 0
  verdict: string;                          // exact strings below
}

export function buildProviderLedger(input: { runId: string; startedAt: string; rows: LlmTrace[] }): PrivacyLedger;
// pure. entries = rows (already chronological) mapped through classifyProvider; passthrough of
// traceId/provider/model/durationMs/status/error verbatim. allLocal = cloud===0 && unknown===0.
// verdict (exact):
//   total === 0 → 'No model or agent requests since you started watching — nothing has left this machine.'
//   allLocal && total > 0 →
//     `All ${total} request${total===1?'':'s'} stayed on localhost — ${counts.local} local, ${counts.simulated} clearly-marked simulated timers, 0 cloud calls.`
//   cloud > 0 →
//     `${cloud} request${cloud===1?'':'s'} went to a cloud provider during this run — the all-local claim does not hold. See the red rows.`
//   cloud === 0 && unknown > 0 →
//     `${unknown} request${unknown===1?'':'s'} came from an unrecognized provider — not counted as local. Review before trusting the all-local claim.`

// ── Run state (module-level; server process owns the watermark) ─────────────
const MAX_RUNS = 5;
const READ_LIMIT = 200;
// Map<runId, { startedAt: string; knownIds: Set<string> }> — insertion-ordered,
// oldest evicted past MAX_RUNS.

export function startPrivacyRun(): { id: string; startedAt: string };
// startedAt = new Date().toISOString(); knownIds = ids of readRecentTraces() ∪ traceStore.getTraces()
// (belt-and-braces: either source may hold rows the other lost). Returns the token.

export function getPrivacyLedger(runId: string | null): PrivacyLedger;
// unknown/null runId → throw new Error('unknown privacy run — start a new one') (endpoint → 400)
// rows = readRecentTraces().filter(r => !knownIds.has(r.id))  → buildProviderLedger

function readRecentTraces(): LlmTrace[];
// DB-first, mirroring apiTraces' semantics:
//   try: SELECT trace_id AS id, model, provider, duration_ms AS durationMs, status, error,
//          created_at AS timestamp FROM llm_traces ORDER BY id DESC LIMIT 200  → rows.reverse()
//        (autoincrement id = monotone insertion order — the ONLY ordering axis, because
//         created_at and ISO timestamps are different formats; never sort across sources)
//   catch / zero rows → traceStore.getTraces().slice(-200)   // memory ring buffer
// normalizeTimestamp() every row before returning.

function normalizeTimestamp(ts: string): string;
// already contains 'T' → as-is; else `${ts.replace(' ', 'T')}Z` (created_at is UTC) — so the UI
// can `new Date(ts)` either way without knowing the source.

// ── The would-be cloud payload exhibit ──────────────────────────────────────

export interface PrivacyExhibit {
  cloudModel: string;   // getProviderById('openrouter')?.fastModel ?? '' — what a cloud agent would call
  payload: { system: string; user: string };
  rowCount: number;
  rows: Array<{ id: number; slug: string; description: string; amount: number; date: string }>;
  note: string;
}

export const EXHIBIT_NOTE =
  'Built exclusively from the in-repo synthetic sample fixtures — attendee-imported data can ' +
  'never appear here: no code path feeds anything but these fixtures to the prompt builder.';

export function getPrivacyExhibit(slug?: string): PrivacyExhibit;
// slug given → sample = getSampleBySlug(slug) (throws on unknown → endpoint 400);
//   payload = { system: SHOWDOWN_SYSTEM_PROMPT, user: buildShowdownUserPrompt(sample) } — byte-identical
//   to what the showdown arms send; rowCount 1.
// no slug → user = buildCategorizationPrompt(SAMPLE_TRANSACTIONS.map(toCategorizeRow)) over all 8 rows.
// Both paths: rows built only from SAMPLE_TRANSACTIONS; the function takes no db and reads nothing.
```

**Structural note for review:** `getPrivacyExhibit` and `buildProviderLedger` are pure; only `startPrivacyRun`/`getPrivacyLedger` touch module state, and nothing in this module imports the db, `api.ts`, or `interactionStore`.

## Step 3 — API handlers (`src/dashboard/api.ts`, beside the showdown handlers)

```ts
export function apiDemoPrivacyStart()                        → startPrivacyRun();
export function apiDemoPrivacyLedger(params: URLSearchParams) → getPrivacyLedger(params.get('run'));  // throws → route 400
export function apiDemoPrivacyExhibit(params: URLSearchParams) {
  const slug = params.get('slug') ?? undefined;
  if (slug === '') slug = undefined;                         // tolerate ?slug=
  return getPrivacyExhibit(slug);                            // unknown slug throws → route 400
}
```

Thin only — no validation logic duplicated (slug validation lives in `getSampleBySlug`, run validation in `getPrivacyLedger`).

## Step 4 — Routes (`src/dashboard/server.ts`, authed section, directly after the showdown block)

```ts
if (path === '/api/demo/privacy/start' && req.method === 'POST') {
  return Response.json(apiDemoPrivacyStart(), { headers });
}
if (path === '/api/demo/privacy/ledger') {
  try { return Response.json(apiDemoPrivacyLedger(url.searchParams), { headers }); }
  catch (err) { return Response.json({ error: … }, { status: 400, headers }); }
}
if (path === '/api/demo/privacy/exhibit') {
  try { return Response.json(apiDemoPrivacyExhibit(url.searchParams), { headers }); }
  catch (err) { return Response.json({ error: … }, { status: 400, headers }); }
}
```

No `canWrite` gate anywhere: the endpoints write no DB rows (trace rows are written by the flows being watched, exactly as `/api/demo/showdown/browser-trace` already does).

## Step 5 — UI: `src/dashboard/ui/src/demo/PrivacyValidatorSection.tsx` (new)

Self-contained; Tailwind + existing token classes; mirrors the server types locally (DemoTab pattern). Props: `{ selectedSlug: string | null }`.

- **Data**: on mount `POST /api/demo/privacy/start` → store `{ id, startedAt }`, `monitoring = true`; `setInterval(1000)` → `GET /api/demo/privacy/ledger?run=<id>` while monitoring; on a ledger 400 → one automatic re-arm (fresh start + resume polling); on network error → "reconnecting…" and retry next tick. Cleanup interval + `monitoring=false` on unmount. "Start fresh" button re-arms; "Stop" pauses polling (ledger stays rendered).
- **Exhibit data**: `useApi<PrivacyExhibit>(exhibitPath, [selectedSlug])` with `exhibitPath = '/api/demo/privacy/exhibit' + (selectedSlug ? '?slug=' + encodeURIComponent(selectedSlug) : '')` — re-fetches when the showdown picker's selection changes.
- **Layout**: headline block ("Privacy Validator — local means private. Watch it be true." + one-line subtitle), then `grid md:grid-cols-2 gap-4` with the ledger card left and the exhibit card right.

**Ledger card** ("Live provider ledger"):
- Status row: pulsing dot while monitoring + `watching since <HH:MM:SS>` + buttons.
- Summary chips: `N localhost` (green), `N simulated — no network` (yellow, using `BUCKET_LABELS.simulated`), `0 cloud` when `counts.cloud===0` (green) else `N CLOUD` (red), `N unrecognized` (amber; hidden when 0).
- Verdict line (large, mono): the server's `verdict` string verbatim — green when `allLocal && total>0`, muted for the empty state, red when `cloud>0`, amber when only `unknown>0`.
- Entries list (chronological, oldest → newest, `max-h-72 overflow-y-auto`): per row — time (`HH:MM:SS` from the normalized timestamp), provider chip colored by bucket (`BUCKET_LABELS[bucket]`), model (mono, truncated), `durationMs` formatted like the arm cards (`fmtMs`), and `status:'error'` rows flagged red with their `error` text. Entries render `provider` **verbatim** next to the bucket chip — the attendee sees the real marker string (`simulated`, `transformers-browser`, `openrouter`, …).
- Empty state while monitoring: the server's empty-state verdict plus one static line: "The statement-trace chain runs pure local compute (no LLM calls), so it writes no rows here — run the Speed Showdown or send a chat message to see the ledger move."

**Exhibit card** ("What a cloud agent would have sent for this step"):
- Chips: `synthetic sample rows only` (green) + when `selectedSlug` is set, `matching your picked sample` chip.
- Line: `a cloud-based agent would call <cloudModel> with this exact request` (mono model id).
- Collapsible `<pre>` pair (system / user), same styling as the showdown's payload exhibit; default collapsed with the row count visible on the toggle ("8 sample rows" / "1 sample row").
- Footer, small muted: `EXHIBIT_NOTE` from the response, then `CONTRAST_CAPTION` imported from `@/demo/core` (the jev-ultrafast contrast, already UI-side — do not duplicate it server-side).

**DemoTab wiring** (`src/dashboard/ui/src/tabs/DemoTab.tsx`): below the payload-exhibit card add a headline block + `<PrivacyValidatorSection selectedSlug={selectedSlug} />`. `selectedSlug` is already in scope. Extend the file-top doc comment with one line for #95.

## Step 6 — Tests (all new in this slice; per-file process style; copy the mock preamble from `showdown-endpoints.test.ts` where noted)

**`src/__tests__/privacy-validator.test.ts`** (module-level; no server):

1. **`classifyProvider` truth table**: `'simulated'` → `'simulated'`; `'transformers-browser'` → `'local'`; registry providers classify per `isLocal` — loop `PROVIDERS` and assert `classifyProvider(p.id) === (p.isLocal ? 'local' : 'cloud')` for every entry (ollama/transformers local; openai/anthropic/google/xai/moonshot/deepseek/openrouter/litellm cloud); `'acme-cloud'` → `'unknown'`. The AC's core assertion lives here: **the simulated marker can never classify as cloud**.
2. **Ledger rendered from trace records**: `buildProviderLedger` with a mixed `rows` array (one `transformers-browser`, one `simulated` with `model:'simulated:openai/gpt-4o-mini'`, one `transformers`, one `openrouter`, one `'acme-cloud'`, one `status:'error'` row with `error`) → entries pass through `traceId/provider/model/durationMs/status/error` verbatim in order; `counts` exactly `{local:2, simulated:1, cloud:1, unknown:1, total:5}`… (adjust to the fixture set used); `allLocal === false`; the cloud>0 verdict string contains `does not hold`.
3. **Simulated never misattributed**: a rows array of only simulated rows → every entry `bucket === 'simulated'`, `counts.cloud === 0`, `allLocal === true`, verdict contains `0 cloud calls` and `clearly-marked simulated`.
4. **Verdict matrix**: empty rows → the nothing-left-this-machine string, `allLocal === true`; local+simulated only → the `All N request(s) stayed on localhost` string (singular/plural both); unknown-only → the unrecognized-provider string with `not counted as local`.
5. **Run lifecycle against the real `traceStore`** (no db): `traceStore.record(A)` → `startPrivacyRun()` → `record(B)`, `record(C)` → `getPrivacyLedger(id).entries` are exactly B and C (A excluded); `startPrivacyRun()` again → `record(D)` → second ledger has only D; `getPrivacyLedger('nope')` and `getPrivacyLedger(null)` throw. Clear the store in `afterEach`.
6. **DB-backed read + normalization**: `traceStore.setDatabase(createTestDb())` → `record(E)` → `getPrivacyLedger(runId)` returns exactly one entry (DB-first read; no duplication from the memory buffer), `timestamp` parses via `new Date(...)`, `traceId === E.id`. Also assert the DB row's `provider` reaches the entry verbatim. (`createTestDb` from `./helpers.js`; per-file process keeps the singleton wiring isolated.)
7. **Exhibit — fixture-only by construction**: `getPrivacyExhibit()` → `rowCount === 8`, `rows` match `SAMPLE_TRANSACTIONS` (id/slug/description/amount/date), `payload.user` contains every sample description, `Groceries`, `RULES`, and equals `buildCategorizationPrompt(SAMPLE_TRANSACTIONS.map(...))` rebuilt locally; `cloudModel === getProviderById('openrouter').fastModel`; `note` contains `synthetic` and `never`.
8. **Exhibit — same step as the showdown**: `getPrivacyExhibit('harborview-dental')` → `payload` deep-equals `{ system: SHOWDOWN_SYSTEM_PROMPT, user: buildShowdownUserPrompt(getSampleBySlug('harborview-dental')) }`, `rowCount === 1`, user contains `HARBORVIEW DENTAL GROUP` and `-318` and exactly one `"description":` occurrence.
9. **Exhibit — no attendee data can leak in**: wire a test db containing an imported canary row (description `ATTENDEE-CANARY-XYZ`, via the helpers' insert path) → `getPrivacyExhibit()` (and the slug variant) contain zero occurrences of `ATTENDEE-CANARY`. The function takes no db parameter — this pins that no db read feeds the builder.
10. **`getSampleBySlug('nope')` throws** through `getPrivacyExhibit` (assert the throw; the endpoint test pins the 400).

**`src/__tests__/privacy-validator-endpoints.test.ts`** (boot the real server on port 0 — copy `showdown-endpoints.test.ts`'s env/transformer mocks, `beforeEach`/`afterEach`, and `ensureTestProfile`):

11. `POST /api/demo/privacy/start` → 200 `{ id, startedAt }`, `startedAt` parses as a date.
12. `GET /api/demo/privacy/ledger` without/with an unknown run → 400 with an error message.
13. **The demo-run flow (the AC at the HTTP layer)**: start run → `POST /api/demo/showdown/cloud` `{slug:'harborview-dental'}` (forced simulated by the env mock) → `POST /api/demo/showdown/browser-trace` `{model:'onnx-community/Qwen3-0.6B-ONNX', decisionMs: 42, ok:true}` → `GET ledger` → exactly 2 entries: one `bucket:'simulated'` (`model` starts `simulated:`, provider verbatim `'simulated'`) and one `bucket:'local'` (provider `'transformers-browser'`); `counts.cloud === 0`; `allLocal === true`; the response JSON contains **no** occurrence of `"openrouter"` in any entry's provider; verdict is the all-local string.
14. **The panel can fail honestly (cloud visibility)**: with a run armed, `traceStore.record({ provider:'openrouter', model:'openrouter:openai/gpt-4o-mini', …, status:'ok' })` directly → ledger shows a `bucket:'cloud'` entry, `counts.cloud === 1`, `allLocal === false`, verdict contains `does not hold`.
15. **Watermark exclusion**: record F → start run → ledger has no F; record G → ledger has exactly G.
16. **Unknown-provider honesty at the HTTP layer**: record `{provider:'acme-cloud'}` → entry `bucket:'unknown'`, `counts.unknown === 1`, `allLocal === false`, verdict contains `not counted as local`.
17. **Exhibit endpoint**: `GET /api/demo/privacy/exhibit` → 200, rowCount 8, payload contains only sample descriptions; `GET …?slug=harborview-dental` → single-row payload equal to the showdown builder's; `GET …?slug=nope` → 400; `?slug=` (empty) behaves like no slug.

## Step 7 — CHANGELOG

Under `## [Unreleased] → ### Features`, one bullet:

```
- feat: privacy validator — the Demo tab's stretch panel renders a live provider ledger proving every model/agent request during a demo run stayed on localhost: it arms a server-side watermark over the trace store, classifies each row through the provider registry's isLocal (with #92's `simulated` / `transformers-browser` markers in their own honest buckets — a simulated timer can never read as a cloud call, and an unrecognized provider is never silently counted as local), and says so plainly when a real cloud call does occur; side-by-side, the exhibit shows the exact request a cloud-based agent would have sent for the same decision step — the production categorization prompt built only from the in-repo synthetic sample fixtures, never attendee-imported data (#95)
```

## Step 8 — Verify

```bash
bun install
bun run typecheck
for f in src/__tests__/*.test.ts; do bun test "$f" 2>&1 || FAIL=1; done; echo FAIL=$FAIL   # CI-style per-file loop
cd src/dashboard/ui && npm ci && npm run build && cd -    # tsc -b inside typechecks the new section
# hybrid chunk untouched by this slice; `npm run build:hybrid` only if you want parity with #92's checklist
```

Manual matrix (maps to the ACs):

1. **Both flows, no key (required):** no `OPENROUTER_API_KEY`, `bun run start` → dashboard `#demo` → the Privacy Validator auto-arms → run the Speed Showdown on **HARBORVIEW DENTAL GROUP −$318.00** → the ledger shows the local arm's row (`transformers-browser` or `transformers`) and the cloud arm's row with the `simulated` marker — every row a localhost/local-provider entry or clearly marked simulated, `0 cloud` green, verdict says all requests stayed on localhost; the exhibit shows the would-be cloud payload with the sample rows and zero DB-imported descriptions.
2. **Statement flow:** drop `demos/fixtures/august-2026-chase.csv` with the panel armed → the ledger stays empty with the honest empty-state note (the chain makes no LLM calls); DevTools network tab over the whole session shows only localhost.
3. **Violation drill (needs key + network):** with the key set, run the showdown live → one red `openrouter` row and the verdict stating the all-local claim does not hold — the panel catches real cloud traffic instead of rubber-stamping.
4. **Ambient traffic:** send one chat message during the run (any provider) → it appears in the ledger with its real provider; the ledger watches the whole run, not just demo buttons.
5. **Same-step exhibit:** pick different samples in the showdown picker → the exhibit card re-fetches and shows that row's would-be cloud payload.

## Risks / notes for the builder

- **The DB-first read is the subtle part.** Mirror `apiTraces`' semantics exactly (DB rows when present, memory buffer only when the DB yields none) and never sort across sources — `created_at` (`YYYY-MM-DD HH:MM:SS`) and ISO strings are different formats; DB autoincrement `id` is the only monotone order. The ledger therefore reads `ORDER BY id DESC LIMIT 200`, filters by `knownIds`, reverses.
- **`traceStore.setDatabase` is process-global.** The module test that wires it must live in its own file (per-file process isolation already guarantees this) and the endpoint test re-wires per `beforeEach` like the showdown suite does.
- **A live-mode run legitimately shows a red row.** When key+network exist, the showdown's cloud arm is a real OpenRouter call — the ledger must show it and the verdict must not claim all-local. The demo script pairs the panel with the no-key/offline mode (Manual 1) where the proof is clean; Manual 3 is the honesty drill.
- **Ring-buffer wrap:** >200 requests during a long run evict the oldest from memory; the DB still holds them but the ledger window is the latest 200 — acceptable and bounded; don't raise it.
- **Server restart mid-run** wipes the run map → the panel's 400 → auto re-arm keeps the demo unbroken (test 12 covers the 400; the re-arm is UI-side, verified manually).
- **`?slug=` empty string** must mean "no slug" (the UI never sends it, but the endpoint should not 400 on `?slug=`).
- **Don't touch:** `trace-store.ts`, `llm.ts`, the showdown arms' behavior, `AgentTraceSection`, the hybrid chunk, the statement-trace chain. #92's only edit is the two exported constants (Step 1) — keep it byte-identical in value.
- **Root typecheck never sees the ui component** — `tsc -b` in the ui build is its gate; keep the section free of new deps and DOM-free helpers minimal.

## Out of scope

- Persisting ledger runs, exporting the ledger, diffing runs, WebSocket/SSE push.
- Instrumenting non-LLM requests (the statement chain's same-origin POSTs, embedding calls) into the ledger — the trace store is the data source, by design; DevTools covers the rest.
- Changes to #92's arms/labels/payload, #93's chain, the LLM tab, auth/QR flows, the full #91 tab polish.
- Any UI-side re-classification of providers (the server owns bucket + verdict strings).

## Acceptance-criteria map

| Criterion | Where |
|---|---|
| Ledger rendered from trace records (tests in this slice) | `buildProviderLedger` passthrough + run lifecycle + DB-backed read → Step 6 tests 2, 5, 6; HTTP flow test 13 |
| Simulated markers never appear as cloud provider entries | `classifyProvider` truth table + simulated-only ledger + zero-`openrouter` HTTP assertion → tests 1, 3, 13; manual 1 |
| Exhibit payload built only from sample fixtures | exhibit equality/rebuild/canary tests → tests 7, 8, 9; manual 1 |
| Repo test / typecheck / build pass | Step 8 commands (no root lint/build scripts exist; per-file bun test loop + typecheck + ui build are the gates) |
| Manual: both flows, panel shows localhost/local-provider rows or clearly-marked simulated; exhibit shows the would-be cloud payload with zero real attendee rows | Manual 1 + 2 (3–5 harden it) |