# Plan: Speed Showdown — race Wilson's local categorization decision against a cloud round-trip (Demo tab, section 1)

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-92` (branch `spf-watch/92-speed-showdown-pick-a-transaction`)
**Issue:** #92, decomposed from #58 (demo-table artifact); parent artifact tab is #91. Sibling stories #93–#95 will extend the same tab later.
**Outcome:** An attendee at the demo table picks a synthetic sample transaction in the dashboard and watches side-by-side **real** timers race Wilson's local categorization decision against a cloud model's round-trip for the *same* decision task — with the exact payload exhibit ("this is what leaves your machine"), a verdict line, and the honest jev-ultrafast contrast-case caption.

## Grounding — what exists today (verified in this tree)

- **Hybrid model routing (spec-49, built in #68/#98):** `src/dashboard/ui/src/hybrid/{core,client,standalone}.ts`. The prebuilt chunk `/assets/hybrid-chat.js` exposes `window.WilsonHybridChat = { init, probe, loadModel, tryLocal }` (`standalone.ts:66`). Layered capability probe (navigator.gpu → requestAdapter → real generation in `loadModel`), verdict cached per browser session (`CAPABILITY_STORAGE_KEY`), `shouldAttemptLocal()` decision matrix. React side: `useHybridChat()` (`src/dashboard/ui/src/hooks/useHybridChat.ts`) loads the chunk via a `/* @vite-ignore */` dynamic import — missing chunk → `'unavailable'`, never throws. transformers.js is bundled **only** into that chunk.
- **Server-side local path:** `transformers` provider, `fastModel: 'transformers:onnx-community/Qwen3-0.6B-ONNX'` (`src/providers.ts:76–83`) — the single place the local model is named; `getLocalChatModelConfig()` (`src/model/local-chat.ts`) derives repo/displayName/bundle from it. `TransformersAdapter` (`src/model/providers/transformers.ts`) matches `Qwen3-0.6B-ONNX` via `WEBGPU_MODEL_PATTERNS` → `device:'webgpu', dtype:'fp16'`, caches pipelines in a module-level `pipelineCache` Map, `checkWebGpuAvailable()` gates WebGPU server-side, and `max_new_tokens` is hardcoded 512 at the generation call.
- **Categorization prompt:** `buildCategorizationPrompt(transactions, dbCategories?)` (`src/tools/categorize/prompt.ts:44`) already produces exactly the spec'd exhibit — category list + RULES + confidence rubric (0.9–1.0 / 0.7–0.89 / 0.5–0.69 / <0.5) + transaction rows + JSON response format. Pure module (data import `./categories.js` + a type-only db import) — safe to call server-side. The production `categorize` tool calls it with system prompt `'You are a precise financial transaction categorizer. Respond only with valid JSON.'` **plus** `outputSchema` (`src/tools/categorize/categorize.ts:88–96`).
- **Categories:** 18 names in `src/tools/categorize/categories.ts`; `'Health'` covers "dental".
- **Trace store:** `src/utils/trace-store.ts` — in-memory ring buffer (200) plus SQLite persistence into `llm_traces` (`src/db/schema.ts:193`) via `setDatabase()`. `callLlm` records one trace per call with the real measured `durationMs` (`src/model/llm.ts:113–127`) but does **not** return the trace id — `LlmResult = { response, usage, interactionId }`. `apiTraces` reads `llm_traces` with fallback to the in-memory buffer (`src/dashboard/api.ts:441`).
- **API-key presence:** `checkApiKeyExistsForProvider('openrouter')` (`src/utils/env.ts:13–19`) — the existing check this slice reuses. OpenRouter provider: `apiKeyEnvVar 'OPENROUTER_API_KEY'`, `fastModel 'openrouter:openai/gpt-4o-mini'` (`src/providers.ts:79–85`); `callLlm` strips the `openrouter:` prefix before the API call.
- **Verified live (network was up):** OpenRouter's public model list (446 models) contains **no** "jev" entry. The jev-ultrafast contrast stays a caption fact (~178 ms median request, quoted from #58's scout findings), not a callable model id. The cloud arm calls the registry's openrouter `fastModel`.
- **Dashboard server:** routes are path if-blocks in the authed section (`src/dashboard/server.ts` ~499–560, e.g. `/api/chat/local` POST at :534). Endpoint tests boot the real server on port 0 and `fetch()` it (`src/__tests__/dashboard-server.test.ts:9–16`).
- **React UI:** hash-routed tabs — `getHashTab()` valid list + `TAB_COMPONENTS` (`src/dashboard/ui/src/App.tsx:14–25`), `TABS` const in `src/dashboard/ui/src/components/TabBar.tsx:1–10`. **No demo tab exists yet.** UI builds (`npm run build`, `npm run build:hybrid`) are manual gates, not in CI (`.github/workflows/ci.yml` runs `bun run typecheck` + each test file in its own process).
- **Pure-UI-module test pattern:** root `tsconfig.json` excludes `src/dashboard/ui` but follows test imports; DOM-free pure modules with relative-only imports are bun-tested today (`src/__tests__/local-chat-bundle.test.ts` → `../dashboard/ui/src/hybrid/core.js`). Follow that pattern.
- **No lint script exists.** Gates: `bun run typecheck`, `bun test` (per-file loop), the two UI builds.
- **Adapter mocking:** `mock.module('../model/providers/index.js', …)` is the established pattern (`src/__tests__/llm.test.ts:15–21`).
- **There is no "Harborview" row anywhere yet** — the sample fixture set is new in this slice (the AC's demo script names it). `data/csv/*` are parser fixtures (different concern); the showdown gets its own ground-truth fixture module.
- `package.json` has no `lint` script; the repo's own gates to run are `bun run typecheck`, `bun test`, and both UI builds.

## Design decisions (and why)

1. **Decision task = single-row categorization; prompt = the production builder.** The attendee picks one sample row; both arms send `buildCategorizationPrompt([thatRow])` as the user prompt and the categorize tool's system prompt. The exhibit therefore *is* the real prompt Wilson's own categorizer uses — category list + rules + confidence rubric + rows — which is the spec's exact wording.
2. **Cloud model = `getProviderById('openrouter').fastModel`** (`openrouter:openai/gpt-4o-mini`). No Jev model is publicly callable on OpenRouter (verified). jev-ultrafast appears only in the contrast caption, with the ~178 ms median figure labeled as an external benchmark.
3. **Neither arm uses `outputSchema`** (the production tool's structured-output gate). Reasons: parity (the transformers adapter injects schema text into its system prompt while OpenAI-compatible providers use response_format — asymmetric payloads), single timed call (spec-65's repair re-prompt would double the round trip), and the exhibit must read "category list + rules + confidence rubric + rows". Deviation is deliberate and noted for review; responses are parsed for display by one shared pure parser (D6), and confidence is clamped [0,1].
4. **The synthetic-only guard is structural, not a filter.** Both arms take only `{ sampleId: string }`; the server resolves fixtures by id and **no API accepts row payloads**. Unknown id → 400. An imported row physically cannot shape a real-mode payload because no code path feeds imported rows into the prompt builder. UI: the picker lists only fixture rows, each carrying a visible `SAMPLE` chip; the payload exhibit carries a "synthetic sample rows only" chip.
5. **Every decision timer on screen comes from a recorded trace — never fabricated.** `callLlm` gains additive `traceId` + `durationMs` on `LlmResult` (the values it just recorded). The browser-local arm measures `performance.now()` around generation and POSTs it to a recording endpoint (provider `transformers-browser`) so its number is also a recorded trace row; the UI renders the recorded value. In-flight timers may tick real elapsed wall-clock, but the final rendered number is always the recorded per-call duration.
6. **Simulated cloud arm honesty.** Mode = `live` only when the key is present **and** the network probe passes; the probe runs only when the key is present (no pointless network call otherwise). A simulated run times real local work (payload build + canned-response assembly), records a trace marked `provider: 'simulated'`, `model: 'simulated:<apiModel>'` (visible marker, no schema change), shows the fixture's known answer labeled `canned`, records **no** interaction row and **no** openrouter-provider trace, and the verdict line in simulated mode never presents measured ms as network latency — the jev-ultrafast ~178 ms benchmark carries that beat instead.
7. **Local arm rides the spec-49 machinery.** Browser chunk first (reuse probe/verdict/`loadModel`), fallback to the server-side transformers path (warm + `callLlm`) when the browser can't do WebGPU. Label always states the actual source: `"in your browser, on your GPU"` vs `"on this machine"`. Model load time is always shown separately and is measured, not fabricated: browser `loadMs` + `loadFresh`; server `warmTransformersPipeline()` returning `{ loadMs, loadedFresh }`.
8. **This slice introduces the Demo tab** (`#demo` hash route) as section 1 of #91's artifact; #93/#94/#95 extend it later. Keep the tab shell minimal — header + the Speed Showdown section.

## Step 1 — Sample fixtures: `src/demo/samples.ts` (new; `src/demo/` is a new dir)

```ts
export interface SampleTransaction {
  id: number;               // stable numeric id used inside the categorization prompt
  slug: string;             // stable UI/API key, e.g. 'harborview-dental'
  date: string;             // fixed YYYY-MM-DD — deterministic, no clock reads
  description: string;
  amount: number;
  expectedCategory: string; // ground truth; must be a member of CATEGORIES
  note?: string;            // demo note shown in the picker
}
export const SAMPLE_TRANSACTIONS: SampleTransaction[]; // 8 rows, ids 1..8
```

Rows (draft — keep exactly this set; it exercises the sign convention, the transfer rule, an ampersand category, and the demo's headline row):

| id | slug | description | amount | expectedCategory |
|---|---|---|---|---|
| 1 | `corner-market` | CORNER MARKET #1247 | -42.67 | Groceries |
| 2 | `harborview-dental` | HARBORVIEW DENTAL GROUP | -318.00 | Health (note: "The $318 row — the demo pick") |
| 3 | `netflix` | NETFLIX.COM | -15.99 | Subscriptions |
| 4 | `payroll-acme` | PAYROLL DEPOSIT - ACME CORP | 3200.00 | Income (positive — sign convention) |
| 5 | `oak-street-coffee` | OAK STREET COFFEE | -5.75 | Dining |
| 6 | `venmo-transfer` | VENMO - TRANSFER TO OWN ACCOUNT | -250.00 | Transfer (rubric rule 5) |
| 7 | `atm-fee` | ATM WITHDRAWAL FEE | -3.50 | Fees & Interest |
| 8 | `city-electric` | CITY ELECTRIC CO AUTOPAY | -128.50 | Utilities |

## Step 2 — Showdown server module: `src/demo/showdown.ts` (new)

Server-only (imports `callLlm`, providers, env utils). All timings real; nothing fabricated.

```ts
export const SHOWDOWN_SYSTEM_PROMPT: string;
// 'You are a precise financial transaction categorizer. Respond only with valid JSON.'
// — export the constant FROM src/tools/categorize/categorize.ts (it is inline there
// today) and re-export/import here, so the production tool and the demo share one
// string. Update categorize.ts's func to use the exported constant.

export type CloudMode = 'live' | 'simulated';

export function resolveCloudMode(input: { hasKey: boolean; networkOk: boolean | null }): CloudMode;
// live iff hasKey === true && networkOk === true. Everything else → 'simulated'.
// hasKey=false must short-circuit without needing a probe (networkOk null = not run).

export const OPENROUTER_PROBE_URL = 'https://openrouter.ai/api/v1/models'; // matches src/model/providers/index.ts baseURL
export async function probeOpenRouterNetwork(fetchImpl?: typeof fetch, timeoutMs?: number): Promise<boolean>;
// GET with AbortSignal.timeout(timeoutMs ?? 2500); resolves true only on HTTP 2xx;
// any throw / non-2xx / timeout → false. Never throws.

export function getSample(slug: string): SampleTransaction;      // throws on unknown id
export function buildShowdownUserPrompt(sample: SampleTransaction): string;
// buildCategorizationPrompt([{ id, description, amount, date }]) — hardcoded CATEGORIES
// fallback (no dbCategories) so the exhibit is deterministic and matches the fixtures.

export interface ShowdownSamplesResponse {
  samples: Array<SampleTransaction & { userPrompt: string }>;    // prompt served for the browser arm
  systemPrompt: string;                                          // SHOWDOWN_SYSTEM_PROMPT
  config: { cloudModel: string; localModel: string; localRepo: string };
  // cloudModel = openrouter fastModel verbatim ('openrouter:openai/gpt-4o-mini')
  // localModel/localRepo from getLocalChatModelConfig() (id + repo), never duplicated
}
export function getShowdownSamples(): ShowdownSamplesResponse;

export interface ShowdownDeps {
  callLlmImpl?: typeof callLlm;                  // default: real callLlm
  hasKey?: boolean;                              // default: checkApiKeyExistsForProvider('openrouter')
  probe?: () => Promise<boolean>;                // default: probeOpenRouterNetwork() — runs ONLY when hasKey
  warm?: (model: string) => Promise<{ loadMs: number; loadedFresh: boolean }>;
}

export interface ShowdownArmResult {
  ok: boolean;
  label: string;                                  // exact label strings below
  model: string;
  decisionMs: number | null;                      // ALWAYS from the recorded trace when ok
  traceId: string | null;
  raw?: string;                                   // model output text (UI parses it)
  decision?: { id: number; category: string; confidence: number } | null; // simulated only (canned)
  decisionSource?: 'canned';
  payload: { system: string; user: string };      // the exact exhibit
  probeRan: boolean;                              // cloud arm only — transparency
  loadMs?: number; loadFresh?: boolean;           // local arm only
  error?: string;                                 // set when ok=false (arm failed honestly)
}

export async function runShowdownCloudArm(slug: string, deps?: ShowdownDeps): Promise<ShowdownArmResult>;
// 1. sample = getSample(slug) (throws → endpoint 400s)
// 2. user = buildShowdownUserPrompt(sample); payload = { system: SHOWDOWN_SYSTEM_PROMPT, user }
// 3. hasKey = deps.hasKey ?? checkApiKeyExistsForProvider('openrouter')
// 4. networkOk = hasKey ? await (deps.probe ?? probeOpenRouterNetwork)() : null
// 5. mode = resolveCloudMode({ hasKey, networkOk })
//    live:  result = await callLlmImpl(user, { model: cloudModel, systemPrompt: SHOWDOWN_SYSTEM_PROMPT, callType: 'demo-showdown' })
//           → { ok:true, mode:'live', label CLOUD_LIVE_LABEL, model: apiModel ('openai/gpt-4o-mini'),
//               decisionMs: result.durationMs, traceId: result.traceId, raw: result.response.content, payload }
//    simulated: time (payload build already done) + canned assembly with performance.now/Date.now:
//           canned = `{"transactions":[{"id":${sample.id},"category":"${sample.expectedCategory}","confidence":0.99}]}`
//           parse it once (real work), decisionMs = measured wall-clock of that local work
//           → recordSimulatedCloudTrace(...) → { ok:true, mode:'simulated', label CLOUD_SIMULATED_LABEL,
//               model: `simulated:${apiModel}`, decisionMs, traceId, raw: canned,
//               decision: { id, category: expectedCategory, confidence: 0.99 }, decisionSource:'canned', payload }
//    live call throws → { ok:false, error: message } (endpoint renders it as a failed arm, not a crash)

export async function runShowdownLocalServerArm(slug: string, deps?: ShowdownDeps): Promise<ShowdownArmResult>;
// 1. sample + payload as above
// 2. cfg = getLocalChatModelConfig(); !cfg.enabled → { ok:false, error:'local model not configured' }
// 3. { loadMs, loadedFresh } = await (deps.warm ?? warmTransformersPipeline)(cfg.repo)
// 4. result = await callLlmImpl(user, { model: cfg.id, systemPrompt: SHOWDOWN_SYSTEM_PROMPT, callType: 'demo-showdown' })
//    → { ok:true, label LOCAL_SERVER_LABEL, model: cfg.repo, loadMs, loadFresh,
//        decisionMs: result.durationMs, traceId: result.traceId, raw: result.response.content, payload }
//    any throw → { ok:false, error, loadMs?, loadFresh? } (e.g. no server-side WebGPU)

export function recordSimulatedCloudTrace(input: {...}): { traceId: string; durationMs: number };
// traceStore.record({ id: `${Date.now()}-showdown-${rand}`, model: `simulated:${apiModel}`,
//   provider: 'simulated', promptLength: payload.user.length, responseLength: canned.length,
//   inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: Math.round(measured), status: 'ok' })
// NO interactionStore call — simulated runs must never look like real LLM interactions.

export function recordBrowserLocalTrace(body): { traceId: string; durationMs: number };
// validates { model: string, decisionMs: finite >= 0, ok: boolean, error?: string, slug?: string }
// → traceStore.record({ provider: 'transformers-browser', model, durationMs: Math.round(decisionMs),
//   status: ok ? 'ok' : 'error', error, promptLength: 0, responseLength: 0, tokens 0 })
// NO interactionStore call. Returns the recorded trace's id + durationMs.
```

**Label constants** (exact strings from the issue; export from `showdown.ts`, mirror in the UI pure module):

- `LOCAL_BROWSER_LABEL = 'in your browser, on your GPU'`
- `LOCAL_SERVER_LABEL = 'on this machine'`
- `CLOUD_LIVE_LABEL = 'live call to OpenRouter'`
- `CLOUD_SIMULATED_LABEL = 'simulated round-trip — no network'`

## Step 3 — `callLlm` trace exposure + optional token cap

**`src/model/llm.ts`** — additive only:
- In the success path, build the trace object once, `traceStore.record(trace)`, and return `traceId: trace.id` and `durationMs` on `LlmResult`. Existing callers unaffected (new fields).
- `LlmResult` interface: add `traceId: string; durationMs: number`.

**`src/model/types.ts`** — `ProviderCallOptions` gains optional `maxTokens?: number` (doc comment: honored by the Transformers adapter; other adapters ignore it in this slice).

**`src/model/providers/transformers.ts`**:
- `max_new_tokens: options.maxTokens ?? 512` in the generation call.
- New export:
```ts
export async function warmTransformersPipeline(modelName: string): Promise<{ loadMs: number; loadedFresh: boolean }> {
  const loadStart = Date.now();
  const loadedFresh = !pipelineCache.has(modelName);
  await getOrCreatePipeline(modelName);
  return { loadMs: Date.now() - loadStart, loadedFresh };
}
```
(Measures the real load — including a first-run Hub download — separately from the timed decision call, which then finds the pipeline cached.)

**`src/tools/categorize/categorize.ts`** — hoist the inline system-prompt string to `export const CATEGORIZER_SYSTEM_PROMPT = 'You are a precise financial transaction categorizer. Respond only with valid JSON.'` and use it in `func` (behavior unchanged; single source of truth).

## Step 4 — API endpoints + routes

**`src/dashboard/api.ts`** (thin handlers delegating to `src/demo/showdown.ts`):
- `apiDemoShowdownSamples()` → `getShowdownSamples()` (no DB needed).
- `apiDemoShowdownCloud(body)` → validate `body.slug` is a non-empty string → `runShowdownCloudArm(slug)`; unknown slug → `{ error }` with 400.
- `apiDemoShowdownLocal(body)` → same shape → `runShowdownLocalServerArm(slug)`; 400 on unknown slug.
- `apiDemoShowdownBrowserTrace(body)` → `recordBrowserLocalTrace(body)`; 400 on invalid body.
- **Failure posture:** arm-internal failures (model load error, call error) return HTTP **200 with `{ ok:false, error }`** so the UI renders the failed arm inline — the demo must degrade gracefully, not show a broken panel. Only bad input (unknown slug, malformed body) 400s.

**`src/dashboard/server.ts`** — in the authed section alongside `/api/chat`:
- `GET /api/demo/showdown/samples`
- `POST /api/demo/showdown/cloud`
- `POST /api/demo/showdown/local`
- `POST /api/demo/showdown/browser-trace`

## Step 5 — Hybrid chunk: browser categorization arm

**`src/dashboard/ui/src/demo/core.ts`** (new, DOM-free, relative imports only — root tsc pulls it in via tests, same as `hybrid/core.ts`):
- `parseCategorizationDecision(raw: string): { ok: true; decision: { id: number; category: string; confidence: number } } | { ok: false; raw: string }` — extract the first `{...}` JSON blob (fence-tolerant), `JSON.parse`, structural checks, clamp confidence to [0,1]. Light validation only — **no zod in the chunk** (keep the hybrid chunk small).
- The four label constants (mirrored values; a test asserts equality with the server-side constants so they can't drift).
- `CONTRAST_CAPTION: string` — exact copy:
  > `Contrast case: jev-ultrafast sends every decision to a cloud-hosted Jev model over OpenRouter — ~178 ms median request, fast, but not privacy-preserving. Wilson bets the other way: the decision happens where the data lives.`
- `buildVerdictLine(local: { decisionMs: number | null }, cloud: { mode: CloudMode; decisionMs: number | null }): string`
  - live, both present: diff = cloud − local; local ≤ cloud → `Local won by ${diff} ms (${ratio}× faster)` where ratio = cloud/local ≥ 1; cloud < local → `Cloud won by ${diff} ms (${ratio}× faster)`. Equal → `Dead heat`.
  - simulated: `Simulated cloud arm — no network call was made (local decision: ${local} ms).` — never claim a measured network latency in this mode.
  - missing timer (failed arm) → `Local arm failed — see its card for the error.` (and the cloud mirror).

**`src/dashboard/ui/src/hybrid/client.ts`** — add `categorizeSample` next to `tryLocal` (reuses probe/verdict/`loadModel`/config):
```ts
export interface CategorizeSampleResult {
  ok: boolean;
  model: string;            // cfg.repo
  raw: string;
  decision: { id: number; category: string; confidence: number } | null; // parseCategorizationDecision
  decisionMs: number;       // performance.now() around the pipe() call
  loadMs: number;           // around loadModel(); ≈0 when already warm
  loadFresh: boolean;       // true iff this call initiated the model load
  reason?: 'unavailable' | 'failed' | 'error';  // when ok=false (shouldAttemptLocal/probe/generation failure)
}
async function categorizeSample(opts: { systemPrompt: string; userPrompt: string; onProgress?: ProgressCb }): Promise<CategorizeSampleResult>
```
- Same never-throws contract as `tryLocal` (every failure resolves `{ ok:false, reason }`).
- Track `loadedFresh` (pipelinePromise was null before this `loadModel` call) so the UI can say "model already loaded (12 ms)" honestly.
- Generation: `pipe([{role:'system',content:systemPrompt},{role:'user',content:userPrompt}], { max_new_tokens: 128, do_sample: false })`; extract the assistant turn with the same logic as `tryLocal` (hoist that extraction into a small local helper reused by both).

**`src/dashboard/ui/src/hybrid/standalone.ts`** — add `categorizeSample(opts)` to the module exports and to `window.WilsonHybridChat` + the `WilsonHybridChatGlobal` interface.

**`src/dashboard/ui/src/hooks/useHybridChat.ts`** — add a `categorizeSample` wrapper with the same `ensure()`/init pattern as `tryLocal`.

## Step 6 — Demo tab UI

- **`src/dashboard/ui/src/components/TabBar.tsx`** — add `{ id: 'demo', label: 'Demo' }` to `TABS` (after `chat`), `TabId` follows.
- **`src/dashboard/ui/src/App.tsx`** — add `'demo'` to `getHashTab()`'s valid list and `DemoTab` to `TAB_COMPONENTS`. `#demo` is the QR deep link.
- **`src/dashboard/ui/src/tabs/DemoTab.tsx`** (new):
  - Headline: **"Your agent. Your data. Your speed."** (Forensic Noir styling — existing token classes).
  - Loads `GET /api/demo/showdown/samples` once (`useApi`).
  - **Picker:** the sample rows only — description, amount (money styling), date, `note`, and a `SAMPLE` chip on every row ("synthetic fixture — safe to send"). Imported rows are structurally absent; nothing in this tab renders DB transactions.
  - **Run:** both arms start in parallel (`Promise.allSettled`); while in flight each card ticks **real elapsed wall-clock** (rAF/interval from run start); on settle, the big mono timer snaps to the **recorded** `decisionMs` (never the tick value).
  - **Local arm card:** first tries `hybrid.categorizeSample({ systemPrompt, userPrompt })`; `ok` → POST the measured time to `/api/demo/showdown/browser-trace`, label `LOCAL_BROWSER_LABEL`, show `loadMs` on its own line ("model load: 2.3 s" / "model already loaded (12 ms)"); not ok / chunk unavailable → `POST /api/demo/showdown/local`, label `LOCAL_SERVER_LABEL` with its `loadMs`/`loadFresh`. Decision: `parseCategorizationDecision(raw)` → category + confidence, or the raw output with an honest "local decision unparseable" note. Failure state renders `error` verbatim.
  - **Cloud arm card:** `POST /api/demo/showdown/cloud` → render `label` (`live call to OpenRouter` / `simulated round-trip — no network`), model, timer, decision (parsed from `raw`, or the `decisionSource:'canned'` decision under a `canned response` chip), failure state from `error`.
  - **Ground truth:** after both settle, a chip compares each decision to the fixture's `expectedCategory` (✓/✗ per arm).
  - **Payload exhibit:** collapsible `<pre>` titled "What leaves your machine" showing `payload.system` and `payload.user` verbatim, with a `synthetic sample rows only` chip. Identical for both arms (same prompt) — rendered once.
  - **Verdict + caption:** `buildVerdictLine(...)` big line; `CONTRAST_CAPTION` small line below, always visible (real and simulated modes).
  - One run at a time; re-run allowed.

## Step 7 — Tests (all new in this slice, `src/__tests__/`, per-file process style; names avoid collisions)

1. **`showdown-mode.test.ts`** — `resolveCloudMode` truth table (key×network → live only when both true; `{hasKey:false, networkOk:null}` → simulated, probe-not-needed); `probeOpenRouterNetwork` with a stubbed `fetchImpl`: 2xx → true; non-2xx → false; rejecting fetch → false; never-resolving fetch + `timeoutMs: 10` → false; default timeout constant exists.
2. **`showdown-samples.test.ts`** — fixture integrity: 8 rows, unique `id`/`slug`, `expectedCategory ∈ CATEGORIES`, the Harborview row (`slug 'harborview-dental'`, description `HARBORVIEW DENTAL GROUP`, amount `-318`, expectedCategory `'Health'`); `buildShowdownUserPrompt` contains the category list (`Groceries`), `RULES`, rubric band (`0.9-1.0`), the row's description/amount/date, and exactly one transaction row; `getSample('nope')` throws; `getShowdownSamples()` shape: per-row `userPrompt` equals `buildShowdownUserPrompt(row)`, `systemPrompt === CATEGORIZER_SYSTEM_PROMPT`, `config.cloudModel === getProviderById('openrouter').fastModel`, `config.localModel === getLocalChatModelConfig().id`.
3. **`showdown-arms.test.ts`** — with injected deps only (no network, no model):
   - **Synthetic-only guard (live mode):** `runShowdownCloudArm(slug, { hasKey:true, probe: async()=>true, callLlmImpl })` where `callLlmImpl` captures its prompt → captured prompt === `buildShowdownUserPrompt(getSample(slug))`; the prompt contains the fixture description and no foreign text; `payload.user === captured prompt`. Unknown slug → throws (and the endpoint test covers the 400), i.e. **no code path accepts row content** — an imported row cannot become a live payload.
   - **Timers from recorded durations (live):** the injected `callLlmImpl` records a real trace via `traceStore.record` (like the real `callLlm`) and returns `traceId`/`durationMs` from it → the arm's `decisionMs`/`traceId` equal the recorded row (contract with Step 3's additive fields).
   - **Simulated mode:** `runShowdownCloudArm(slug, { hasKey:true, probe: async()=>false })` and `{ hasKey:false }` (no probe call — pass a probe spy asserting zero calls) → mode `simulated`, label `CLOUD_SIMULATED_LABEL`, `traceStore` row has `provider:'simulated'`, model starts `simulated:`, `decisionMs === returned decisionMs`, and **no** row with `provider 'openrouter'` and no interaction row exists (wire `traceStore.setDatabase(createTestDb())` and assert the `llm_traces` table; restore/clear after).
   - **Local server arm:** injected `warm` + `callLlmImpl` → label `LOCAL_SERVER_LABEL`, `loadMs`/`loadFresh` passed through, `decisionMs`/`traceId` from the recorded trace; `warm` throwing → `{ ok:false, error }` containing the message.
   - **`recordBrowserLocalTrace`:** records `provider 'transformers-browser'`, returns matching `traceId`/`durationMs`, clamps/validates (negative or non-numeric `decisionMs` → throws), error path records `status:'error'`.
4. **`showdown-ui-core.test.ts`** — imports `../dashboard/ui/src/demo/core.js`: `parseCategorizationDecision` (clean JSON, fenced JSON, prefixed junk → parse of first blob, garbage → `{ok:false}`, confidence clamped, id preserved); label constants equal to the server constants (import both); `buildVerdictLine` — local-wins live, cloud-wins live, tie, simulated qualifier (must not contain "won by" for the cloud arm), failed-arm case; caption contains `jev-ultrafast`, `~178 ms`, `not privacy-preserving`.
5. **`showdown-endpoints.test.ts`** — boots the real server on port 0 (copy `dashboard-server.test.ts` pattern), no `OPENROUTER_API_KEY` in env (save/restore around the test file): `GET /api/demo/showdown/samples` → 8 samples + prompts; `POST /api/demo/showdown/cloud` with the Harborview slug → `mode:'simulated'`, `label` exact, payload present, and `llm_traces` contains the `provider:'simulated'` row and **zero** `provider='openrouter'` rows (misattribution guard at the HTTP layer); unknown slug → 400 and zero traces; malformed body → 400; `POST /api/demo/showdown/browser-trace` happy path + 400s; `POST /api/demo/showdown/local` in the test env → `{ ok:false, error }` (no server-side WebGPU in CI) — assert it degrades with an error string, not a 500 crash.
6. **`llm.test.ts` (update)** — pin the additive contract: on success `callLlm` returns `traceId`/`durationMs` equal to the trace it recorded (`traceStore.getRecentTraces(1)`).

## Step 8 — Verify

```bash
bun install
bun run typecheck
for f in src/__tests__/*.test.ts; do bun test "$f"; done   # CI-style per-file loop
cd src/dashboard/ui && npm ci && npm run build && npm run build:hybrid && cd -
# dist/index.html stays a normal size (no transformers inlined); dist-hybrid/hybrid-chat.js rebuilt with categorizeSample
```

Manual matrix (maps to the ACs):

1. **Real mode, demo machine:** with `OPENROUTER_API_KEY` in `.env` and network up, `bun run start` → dashboard → `#demo` → pick **HARBORVIEW DENTAL GROUP −$318.00** → both timers run; local arm shows `in your browser, on your GPU` (Chrome) with load time separate; cloud arm shows `live call to OpenRouter` and **local wins** (compare the big numbers); payload exhibit contains only sample rows; verdict line shows the ms/× delta; caption names jev-ultrafast. Also eyeball the LLM tab: an `openrouter` trace row with the real duration, and a `transformers-browser` row for the local decision.
2. **Offline run-through (required for Oct 16–23):** no key, network blocked (`OPENROUTER_API_KEY` removed, wifi off) → showdown runs end-to-end; cloud arm labeled `simulated round-trip — no network` with the `canned response` chip; trace store shows a `provider:'simulated'` row and **no** openrouter row; verdict line carries the simulated qualifier.
3. **Non-WebGPU browser** (Safari/Firefox): local arm falls to the server path labeled `on this machine` (demo machine GPU), or shows its honest error state where no server GPU exists.
4. **First run on a fresh demo machine:** pre-cache the model before doors open (one dashboard chat turn in Chrome downloads/caches the ~600 MB browser weights; server path caches to `~/.openaccountant/models`) — the load-time line then reads "already loaded".
5. **Sanity on honesty:** confirm the payload exhibit matches what the LLM tab / OpenRouter dashboard shows for the live call (exact same system + user strings).

## Risks / known frictions

- **Local may lose on odd hardware.** The AC expects local to beat the cloud arm in real mode; on a slow GPU or a rambling 0.6B generation it might not. Mitigations: `maxTokens: 128` on the server local arm (call site in Step 2 — pass `maxTokens: 128` in its `callLlmImpl` options), 128 in the browser path, JSON-only instruction; and the verdict line is honest both ways by design. The ~178 ms jev caption is explicitly an external benchmark, never rendered as this demo's measurement.
- **Qwen3-0.6B may emit unparseable JSON** — always rendered honestly (raw + "unparseable" note); timer stays valid. Do not retry silently; a repair re-prompt would falsify the timing story.
- **Server-side local path requires server WebGPU** (`checkWebGpuAvailable`). CPU-model fallback is out of scope; the arm fails with the adapter's own clear error message.
- **`warmTransformersPipeline` on a cold demo machine includes the Hub download** in `loadMs` — that's honest and it's exactly why load time is a separate line.
- **vite singlefile must stay clean:** the demo UI imports only the pure module + API calls; transformers stays in the hybrid chunk. Verify `dist/index.html` size after build.
- **Trace pollution:** demo runs write real rows to `llm_traces` (marked providers: `simulated`, `transformers-browser`, `openrouter`, `transformers`). That's the point (the LLM tab is part of the exhibit); the markers keep them attributable.

## Out of scope

- The other demo sections (#93 statement trace, #94 confirmation gate, #95 privacy validator), the full #91 tab shell polish, attendee QR/auth flows.
- Any real OpenRouter call containing non-fixture data; a Jev model integration (no public model id exists); OCR/receipt import.
- CPU-model fallback for the server local arm; batch (multi-row) showdown runs; persisting showdown runs as chat sessions; changes to the production categorize tool's behavior beyond exporting its system-prompt constant.

## Acceptance-criteria mapping

| AC | Where |
|---|---|
| Mode selection tested (key presence/network outcome) | `resolveCloudMode` + `probeOpenRouterNetwork` → Step 2 + test 1 |
| Synthetic-only guard tested (payload from fixtures, never imported rows) | id-only arms + `getSample` throw → Step 2/4 + tests 2/3/5 |
| Timers rendered from recorded per-call durations | `LlmResult.traceId/durationMs` + browser-trace recording → Steps 3/5/6 + tests 3/4/6 |
| Simulated timers not misattributed in the trace store | `provider:'simulated'` + `model:'simulated:…'` marker, no interaction rows → Step 2 + tests 3/5 |
| Repo test / typecheck / build pass | Step 8 commands (no lint script exists) |
| Manual: Harborview $318 row, both timers, local wins real mode, labels + clean payload | Manual 1 |
| Manual: no network + no key → labeled simulated end-to-end run | Manual 2 |

Update `CHANGELOG.md` under **[Unreleased] → Features** with one entry for this slice (repo convention).