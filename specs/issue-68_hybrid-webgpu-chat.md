# Plan: Local-first WebGPU chat for the Wilson dashboard (hybrid, silent server fallback)

**Repo:** `/home/jd/.spf/watch/wilson/worktrees/issue-68` (branch for issue #68, decomposed from #49)
**Outcome:** A user chatting in the dashboard from a WebGPU-capable browser gets answers generated locally on their GPU from a pre-fetched view of their own transactions whenever the local model can answer safely from it, and gets the existing server agent's answer silently whenever it cannot — in both dashboard UIs (legacy vanilla `html.ts` served today, and the React ChatTab).

## Grounding — what exists today (verified in this tree)

- `@huggingface/transformers` is already a root dependency pinned to exactly `4.0.1` (`package.json`, guarded by `src/__tests__/transformers-webgpu-ep.test.ts`). It currently runs **server-side under Bun only** (`src/model/providers/transformers.ts`). `node_modules` is not installed in this worktree — run `bun install` first.
- Model ladder: `src/utils/model.ts` catalog lists `transformers:onnx-community/Qwen3-0.6B-ONNX` as `tags: ['local','small','webgpu']`, `downloadSize: '~600MB'`. `WEBGPU_MODEL_PATTERNS` in `src/model/providers/transformers.ts` dispatches it to `device:'webgpu', dtype:'fp16'`.
- Provider registry: `src/providers.ts` `PROVIDERS` entries carry an optional `fastModel` field. The `transformers` entry has **no** `fastModel` yet. `getFastModel()` (`src/model/llm.ts:18`) currently has **no callers** — adding the field changes no runtime behavior; it is routing metadata.
- Both chat call sites POST to `/api/chat` → `handleChatMessage()` (`src/dashboard/chat.ts`) → `AgentRunnerController.runQuery()` which records via `InMemoryChatHistory.saveUserQuery()/saveAnswer()` → `insertChatMessage`/`updateChatAnswer`/`createChatSession`/`updateSessionTitle` (`src/db/queries.ts:716-768`). Sessions/history shape: `chat_sessions(id, started_at, title)`, `chat_history(query, answer, summary, session_id)`.
- Legacy dashboard: `src/dashboard/html.ts` is a self-contained inline-JS template; `sendChat()` at ~line 1155 POSTs `/api/chat`; its catch block renders `'Error: '+e.message` into the pending bubble (line ~1166). Auth via `authFetch()` (~line 436), `BASE = 'http://localhost:${port}'`.
- React dashboard: `src/dashboard/ui/` builds with vite + `vite-plugin-singlefile` (everything inlined into one `dist/index.html`, gitignored — NOT committed). `src/dashboard/ui/src/tabs/ChatTab.tsx` `handleSend()` is the second call site; its catch block also renders `Error: ...`. `src/dashboard/ui/src/api.ts` has an authed `api()` helper and `getBaseUrl()` (dev → `http://localhost:3141`, prod → same origin).
- Server: `src/dashboard/server.ts` reads `./ui/dist/index.html` at startup (falls back to `getDashboardHtml(port)` when absent — this is what is served today without a build). Serves only `/` and `/index.html` as HTML; **no static asset serving exists yet**. Auth middleware 401s every non-public path when auth is enabled (public list: `/api/auth/status|setup|login`, `/`, `/index.html`) — `/assets/*` must be added to the public set or the model bundle will be blocked.
- Data endpoints the bundle will reuse (no new data endpoint needed): `GET /api/transactions?start&end&limit` (`apiTransactions`, `src/dashboard/api.ts:100` — filters `dateStart/dateEnd`, limit-capped, `ORDER BY date DESC`) and `GET /api/weekly-summary` (`apiWeeklySummary` → `getWeeklySummary` in `src/db/daily-queries.ts:162` returns `{ thisWeek: {total, byCategory, topMerchant}, lastWeek: {...}, change: {amount, percent} }`).
- Injected-context marker style: `src/utils/history-context.ts` exports `HISTORY_CONTEXT_MARKER = '[Chat history for context]'` and `CURRENT_MESSAGE_MARKER = '[Current message - respond to this]'`. The bundle framing copies this bracketed-marker convention.
- Repo tool-call marker detection: `parseToolCall()` in `src/model/providers/transformers.ts` matches `/<tool_call>[\s\S]*?<\/tool_call>/`. Qwen3's native tool-call form is `<tool_call>…<tool_call>` — the hand-off detector must cover both.
- Track D decision (`docs/plans/2026-07-01-002-encryption-pivot-and-local-memory-design.md`, "Track D — WebGPU showcase"): dashboard in-browser inference is the primary surface; "First-load UX is mandatory: 300MB–2GB download … progress UI, Cache API with versioned keys, WASM fallback behind capability check."
- CI (`.github/workflows/ci.yml`): `bun run typecheck` + each `src/__tests__/*.test.ts` run in its own process. UI builds are not in CI. Root `tsconfig.json` excludes `src/dashboard/ui`; `src/dashboard/ui/tsconfig.json` has DOM libs. There is no lint script — the gates are `typecheck`, `test`, and the UI builds.
- Test helpers: `src/__tests__/helpers.ts` (`createTestDb()`, `daysAgo()`); `src/__tests__/dashboard-server.test.ts` boots the real server on port 0 and `fetch()`es it — copy that pattern for the new endpoints.

## ⚠ Operator decision to flag at review (veto candidate)

Item 7 of the task adds a small **history-append path for browser-originated exchanges**: a new `POST /api/chat/local` endpoint that writes `{query, answer}` into the existing `chat_history`/`chat_sessions` tables. This is the only new write path; it uses the existing session/history shapes and no new schema. If the operator vetoes it, locally-answered turns will not survive reload (explicitly counter to the "Wilson records everything" principle), so the default is to ship it — but call it out in the PR description for veto.

## Step 0 — Spike (gating; do this first)

Goal: prove `@huggingface/transformers@4.0.1` can load and generate with `device:'webgpu'` **in a browser**, inside a bundle the dashboard can serve.

1. `bun install` at repo root (fresh worktree).
2. Build a throwaway browser harness under `src/dashboard/ui/` (e.g. `spike/index.html` + `spike/main.ts` — delete after, or keep under `spike/` and exclude from shipped builds):
   - Entry imports `pipeline` from `@huggingface/transformers`, calls `pipeline('text-generation', 'onnx-community/Qwen3-0.6B-ONNX', { device: 'webgpu', dtype: 'fp16', progress_callback })`, then generates ~32 tokens from a two-message chat array (system + user), `do_sample: false`.
   - Two build variants, both recorded:
     a. **Plain vite build** with the ort wasm binaries served as static same-origin files (see Step 3 build config). Set `env.backends.onnx.wasm.wasmPaths` to the same-origin `/…/ort/` dir, `env.backends.onnx.wasm.proxy = false` (main thread — avoids worker/wasm cross-origin friction; the server-side adapter already sets `proxy=false`), `env.allowLocalModels = false`. Model files stream from the HF Hub and are cached by the browser Cache API (transformers.js does this by default).
     b. If (a) fights vite: try `vite-plugin-singlefile` inlining to learn exactly what breaks (expected: `dist/index.html` grows by megabytes and the `.wasm`/`.mjs` assets cannot inline). **Shipped path must be (a)** — the singlefile React build must never inline transformers.js; the React tab loads the prebuilt hybrid chunk at runtime (Steps 3/5).
   - Record: fp16 requires the GPU `shader-f16` feature — if `requestAdapter()` succeeds but session creation fails on an older GPU, that is exactly the real-generation-probe failure path the fallback covers; note which GPU/browser you tested.
3. Verdict is one of **works / partial / blocked**, recorded in `docs/research/dashboard-webgpu-spike.md` (create the dir; CONTRIBUTING already references `docs/research/`) **and** summarized in the PR description — whatever the outcome. If **blocked**, stop, record findings, and return the tree per the task ("this tree is pulled and the spec returns to the operator"). Do not fake the rest of the slice.
4. On **works/partial**: keep the harness's working configuration as the blueprint for `src/dashboard/ui/vite.hybrid.config.ts` and `client.ts`, then proceed.

## Step 1 — Server: model choice rides `fastModel`, exposed via config endpoint

**`src/providers.ts`** — add to the `transformers` entry:
```ts
{
  id: 'transformers',
  displayName: 'Transformers.js (local)',
  modelPrefix: 'transformers:',
  fastModel: 'transformers:onnx-community/Qwen3-0.6B-ONNX',
},
```
This is the single place the model is named. It must equal the webgpu-tagged catalog id in `src/utils/model.ts` (a test enforces the cross-check).

**`src/model/local-chat.ts`** (new module; depends only on the registry and catalog):
```ts
export const LOCAL_CHAT_BUNDLE_DEFAULTS = { days: 30, limit: 200, maxChars: 6000 };
export function getLocalChatModelConfig(): {
  enabled: boolean;
  id: string;            // 'transformers:onnx-community/Qwen3-0.6B-ONNX' (fastModel verbatim)
  repo: string;          // 'onnx-community/Qwen3-0.6B-ONNX' (prefix stripped)
  displayName: string;   // from the model catalog
  downloadSize: string;  // '~600MB' from the catalog
  bundle: typeof LOCAL_CHAT_BUNDLE_DEFAULTS;
};
```
Derive everything from `getProviderById('transformers')?.fastModel` + `getModelsForProvider('transformers')` — never duplicate the model id. Return `enabled: false` if `fastModel` is ever absent (defensive), so the browser silently skips local.

**`src/dashboard/api.ts`** — add:
- `apiLocalChatConfig()` → JSON of `getLocalChatModelConfig()` (no DB needed).
- `apiRecordLocalChatMessage(db, body: { query: string; answer: string; sessionId?: string })` → validates both fields non-empty; reuses `createChatSession`/`insertChatMessage(db, query, answer, null, sessionId)`/`updateSessionTitle` (title = `query.slice(0, 100)` only when the session is brand-new); returns `{ success: true, sessionId }`. Same auth posture as `POST /api/chat` (any authed user; no extra RBAC). `summary` stays `null` — the LLM-summary pass is a server-agent behavior, not a browser one.

**`src/dashboard/server.ts`**:
- `GET /api/config/local-chat` → `apiLocalChatConfig()`.
- `POST /api/chat/local` → `apiRecordLocalChatMessage(activeDb, body)`.
- Static assets: serve `/assets/*` **publicly** (add to the same treatment as `/` and `/index.html` — the auth middleware's 401 currently covers everything else, and a 401'd module script breaks the hybrid chunk):
```ts
if (path.startsWith('/assets/')) return serveDashboardAsset(path, DASHBOARD_ASSETS_DIR, headers);
```
  Implement `serveDashboardAsset(pathname: string, dir: string, headers)` (exported from `server.ts` for tests): resolve the file under `dir`, **reject path traversal** (resolved path must stay inside `dir`), map `.js`/`.mjs` → `text/javascript`, `.wasm` → `application/wasm`, `.json` → `application/json`; 404 when missing. `DASHBOARD_ASSETS_DIR = new URL('./ui/dist-hybrid', import.meta.url).pathname` — the vite hybrid build output (Step 3). Missing dir/404 is the normal "hybrid not built" state; the client treats a failed chunk load as capability-unavailable (silent server path).

## Step 2 — Shared browser core (pure, DOM-free, test-covered)

**`src/dashboard/ui/src/hybrid/core.ts`** — plain TS, no `window`/`document`/fetch. Root `tsc` pulls it in via the test imports (root tsconfig excludes `ui` as a root set but follows imports), so it must compile under both configs; DOM-free guarantees that.

```ts
export interface BundleTxn { date: string; description: string; amount: number; category: string | null }
export interface BundleWeekly {
  thisWeek: { total: number; topCategory: string | null };
  lastWeek: { total: number; topCategory: string | null };
  change: { amount: number; percent: number };
}
export interface BundleParams { days: number; limit: number; maxChars: number }
export interface ContextBundle { text: string; rowCount: number; totalRows: number; truncated: boolean }

export function projectTransactions(rows: BundleTxn[], params: { days: number; limit: number }): BundleTxn[]
// keep rows with date >= (today - days), cap to limit; API returns date DESC → reverse to chronological
// (oldest first) so the size guard can drop from the front (oldest) when over budget

export function buildBundle(txns: BundleTxn[], weekly: BundleWeekly | null, params: BundleParams): ContextBundle
// framing (mirrors history-context.ts marker style):
//   [Pre-fetched transaction context]
//   Period: <start>..<end> (last N days, <rowCount> of <totalRows> transactions shown)
//   [truncation note when the size guard dropped rows]
//   Weekly spending: this week $X (top: Groceries), last week $Y (top: ...), change $Z (P%)
//   Transactions (date | description | amount | category):
//   2026-09-18 | SAFEWAY #1234 | -54.21 | Groceries
//   [End of pre-fetched context]
//   [Current message - respond to this]        ← reuse the exact exported constant from src/utils/history-context.ts
// size guard: while text.length > maxChars, drop the OLDEST transaction row and re-render; truncated=true
// iff rows were dropped. Never drop the weekly summary or the markers.

export type HandoffReason = 'tool-call' | 'outside-bundle' | 'no-answer' | 'error';
export type LocalVerdict = { kind: 'answer'; text: string } | { kind: 'handoff'; reason: HandoffReason };

export const NEED_MORE_SENTINEL = 'NEED_MORE_DATA';   // deterministic opt-out the local system prompt teaches (below)
export const NEED_MORE_PHRASES: readonly string[] = [ // fuzzy backstop, lowercase, multiword to avoid false positives
  "i don't have access", 'i do not have access', 'need access to', 'please provide me',
  'provide me with', 'upload your', 'import your', 'connect your', 'outside the provided',
  'beyond the provided', 'not included in the provided', 'i cannot see your', 'no tools available',
];

export function classifyLocalOutput(text: string): LocalVerdict
// order matters, tests pin it:
// 1. /<tool_call>[\s\S]*?<\/tool_call>/  (repo marker — mirrors parseToolCall in src/model/providers/transformers.ts) → handoff 'tool-call'
// 2. /<tool_call>[\s\S]*?<\/tool_call>/  (Qwen3 native) → handoff 'tool-call'
// 3. contains NEED_MORE_SENTINEL → handoff 'outside-bundle'
// 4. lowercase text contains any NEED_MORE_PHRASES entry → handoff 'outside-bundle'
// 5. trimmed empty → handoff 'no-answer'
// 6. otherwise → answer

export function shouldAttemptLocal(state: 'unknown' | 'ready' | 'unavailable' | 'failed'): boolean
// true only for 'unknown' | 'ready' — the decision-matrix function both UIs call
```

Local system prompt (built in `client.ts`; template constant exported from `core.ts` for testability):
```
You are Open Accountant's local browser assistant. Today is {date}.
Below is a pre-fetched snapshot of the user's own transactions. It is your only data source.
{bundle.text}

Rules:
- Answer ONLY from the pre-fetched context. Never invent, estimate, or extrapolate figures that are not derivable from it.
- Do not attempt tool calls; you have no tools.
- If the context does not contain what the question needs, reply with exactly NEED_MORE_DATA and nothing else — the app will route the question to the full agent.
- Keep answers short. Use $ amounts.
```

## Step 3 — Hybrid client + build (the only place transformers.js is bundled)

**`src/dashboard/ui/src/hybrid/client.ts`** — browser-only orchestration:

```ts
export interface HybridOpts { baseUrl: string; fetchImpl: typeof fetch }
export type HybridResult =
  | { ok: true; answer: string; sessionId: string | null; source: 'local' }
  | { ok: false; reason?: HandoffReason };   // UI must treat this as "use the server path", never as an error

export function createHybridChat(opts: HybridOpts): {
  probe(): Promise<'ready' | 'unavailable' | 'failed'>;
  loadModel(onProgress?: (label: string) => void): Promise<void>;
  tryLocal(query: string, onProgress?: (label: string) => void): Promise<HybridResult>;
};
```

Behavior (every failure path returns `{ok:false}`, never throws into the UI):
1. `tryLocal` starts with `shouldAttemptLocal(cachedVerdict)`; unknown → probe.
2. **Layered capability probe** (mirrors the repo's never-trust-static-lists philosophy; cached in `sessionStorage` under `wilson-hybrid-capability` as `{verdict, repo}` for the rest of the browser session):
   - Layer 1: `'gpu' in navigator` and `navigator.gpu` non-null → else `unavailable`.
   - Layer 2: `await navigator.gpu.requestAdapter()` non-null → else `unavailable` (Safari, unsupported/old GPUs).
   - Layer 3: real generation — performed on first successful `loadModel` (a ~16-token run through the pipeline doubles as warmup). Load or generation failure → `failed`.
   - A cached `unavailable`/`failed` verdict skips local for the whole session (per the task: "cached for the session"); only `ready` short-circuits the probe.
3. `GET {baseUrl}/api/config/local-chat` (via `fetchImpl`) → model `repo` + bundle params. Failure → `{ok:false}` (server path).
4. Fetch the bundle over localhost only: `GET {baseUrl}/api/transactions?start={today-days}&end={today}&limit={limit}` and `GET {baseUrl}/api/weekly-summary` (via `fetchImpl`), then `buildBundle(...)`. Either fetch failing → `{ok:false}`.
5. Model files come from the HF Hub on first run (transformers.js default; browser Cache API persists them — Track D). Generate with the loaded pipeline: messages `[{role:'system', localPrompt}, {role:'user', bundle + question}]`, `{ max_new_tokens: 256, do_sample: false }`; extract the assistant turn the same way `TransformersAdapter.call` does (array-of-messages → last content).
6. `classifyLocalOutput(output)`:
   - `answer` → `POST {baseUrl}/api/chat/local {query, answer, sessionId?}` (the client tracks the current `sessionId`, set from whichever path created it) and return `{ok:true, answer, sessionId}`. If the record POST itself fails, **still return the answer** (`sessionId: null`) — losing a history row must not become a user-facing error.
   - `handoff` → return `{ok:false, reason}`.
   - Any thrown error anywhere → `{ok:false, reason:'error'}`.

env setup in `client.ts` (before pipeline):
```ts
const { pipeline, env } = await import('@huggingface/transformers');
env.backends.onnx.wasm.wasmPaths = `${assetBase}/ort/`;  // same-origin static files, see build
env.backends.onnx.wasm.proxy = false;                    // main thread; matches the server-side adapter's choice
env.allowLocalModels = false;
```
`assetBase` = `${opts.baseUrl}/assets` (same-origin when relative).

**`src/dashboard/ui/src/hybrid/standalone.ts`** — build entry: one `createHybridChat` instance held module-level, attached as `window.WilsonHybridChat = { init(opts), tryLocal(query, onProgress) }` (declare the global's type in an exported interface / `.d.ts`).

**`src/dashboard/ui/vite.hybrid.config.ts`** (new):
```ts
export default defineConfig({
  build: {
    outDir: 'dist-hybrid',
    target: 'esnext',
    minify: false,
    lib: { entry: 'src/hybrid/standalone.ts', formats: ['es'], fileName: () => 'hybrid-chat.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },  // single file, no code-splitting
  },
});
```
**`scripts/copy-ort-web-assets.ts`** (new, ~40 lines): copies the ort web binaries next to the chunk — `node_modules/@huggingface/transformers/dist/ort/**` → `src/dashboard/ui/dist-hybrid/ort/` (fall back to `node_modules/onnxruntime-web/dist/**` if the former doesn't exist in 4.0.1 — the spike confirms which). Clear error if neither is found. The wasm files **must** be same-origin static files; they can never be inlined into the singlefile HTML.

**`src/dashboard/ui/package.json`**: add `"build:hybrid": "vite build --config vite.hybrid.config.ts && bun run ../../scripts/copy-ort-web-assets.ts"`. Do **not** add `@huggingface/transformers` to `ui/package.json` — the hoisted root install is the single pinned copy (its exact-pin is guarded by `transformers-webgpu-ep.test.ts`); vite/tsc resolve it up the tree.
**`src/dashboard/ui/vite.config.ts`**: add `'/assets': 'http://localhost:3141'` to `server.proxy` so React dev mode can load the built chunk from the API server.

## Step 4 — Wire the legacy dashboard (served today, no build)

**`src/dashboard/html.ts`**:
- In `<head>` (before the inline script): `<script type="module" src="/assets/hybrid-chat.js"></script>`. A 404 (not built / plain `bun start` without the hybrid build) leaves `window.WilsonHybridChat` undefined → pure server behavior, unchanged.
- Inside the IIFE, after `authFetch` is defined and again from `onAuthReady()`: `if (window.WilsonHybridChat) window.WilsonHybridChat.init({ baseUrl: BASE, fetchImpl: authFetch });`
- `sendChat()` (~line 1155) becomes local-first:
```js
async function sendChat() {
  var q = chatInput.value.trim(); if (!q) return;
  chatInput.value = ''; chatSend.disabled = true;
  addChatMsg('You',q,false); var pending = addChatMsg('Wilson','Thinking...',false);
  var localAnswer = null;
  try {
    if (window.WilsonHybridChat) {
      var r = await window.WilsonHybridChat.tryLocal(q, function(label){ pending.querySelector('.text').textContent = label; });
      if (r && r.ok) { localAnswer = r.answer; if (r.sessionId) { activeSessionId = r.sessionId; isLiveSession = true; } }
    }
  } catch(e) { /* silent: any local failure falls through to the server path */ }
  if (localAnswer != null) {
    pending.querySelector('.text').innerHTML = renderMd(localAnswer); loadSessions();
  } else {
    // existing POST /api/chat block verbatim, including its catch 'Error:' rendering —
    // that catch now only fires for genuine server-path failures
  }
  chatSend.disabled = false; chatMessages.scrollTop = chatMessages.scrollHeight;
}
```
Progress text replaces "Thinking..." while downloading/generating (Track D first-load UX); a silent hand-off simply continues into the server path with the same pending bubble — no error bubble can appear for hybrid-eligible failures.

## Step 5 — Wire the React chat tab

- **`src/dashboard/ui/src/hooks/useHybridChat.ts`** (new): lazily `await import(/* @vite-ignore */ \`${base}/assets/hybrid-chat.js\`)` exactly once (module-level memo). `/* @vite-ignore */` is essential — it keeps the prebuilt chunk (and transformers.js) OUT of the singlefile HTML; verify after `npm run build` that `dist/index.html` contains no `onnxruntime`/`transformers` strings and stays a normal size. Missing chunk (404) → hook returns "unavailable", never throws. Exposes `{ tryLocal(query, onProgress), status }`.
- **`src/dashboard/ui/src/tabs/ChatTab.tsx`** — `handleSend()`:
  - first: `const r = await tryLocal(query, setProgressLabel)`; `r.ok` → append assistant message `r.answer`, `setSessionId(r.sessionId)` (if non-null), `refetchSessions()`, done.
  - `!r.ok` (or hook unavailable) → the **existing** `POST /api/chat` block unchanged, including its catch → `Error:` bubble only for genuine server-path failures.
  - While `sending`, render `progressLabel` in place of the animated dots when present (first-load download progress).
  - The `tryLocal` call itself must be wrapped so it can never reach the outer catch (the client already never throws; belt-and-braces).
- **`src/dashboard/ui/src/types.ts`**: add the `HybridResult` / window-global types (or import from `hybrid/core.ts`).

### Session continuity (both UIs)
One `sessionId` threads through both paths: the local record returns/creates a `sessionId`; a later hand-off sends it as `sessionId` to `POST /api/chat` (`handleChatMessage` already `setSessionId`s it), and server-created session ids flow back into subsequent `/api/chat/local` calls. Result: one session in the sidebar per conversation regardless of which path answered.

## Step 6 — Tests (bun test, per-file process style; names chosen to avoid collisions)

All in `src/__tests__/`, mirroring the repo's layered philosophy — browser-only layers are simulated with injected state, never faked GPU runs:

1. **`local-chat-config.test.ts`** — `getProviderById('transformers').fastModel` equals a webgpu-tagged catalog id from `getModelsForProvider('transformers')` (cross-check in the spirit of `webgpu-model-path.test.ts`); `getLocalChatModelConfig()` returns the repo with prefix stripped, `displayName`/`downloadSize` from the catalog, bundle defaults present; `shouldAttemptLocal` matrix (unknown/ready → true; unavailable/failed → false).
2. **`local-chat-bundle.test.ts`** — imports `../dashboard/ui/src/hybrid/core.js`: projection keeps only `date|description|amount|category` (assert no extra fields leak), window bounds using the `daysAgo()` helper, limit cap; framing contains `[Pre-fetched transaction context]`, `[End of pre-fetched context]`, and the exact `CURRENT_MESSAGE_MARKER` from `history-context.ts`; size guard drops oldest rows first, sets `truncated`, keeps weekly summary + markers, never exceeds `maxChars`; weekly-summary lines rendered.
3. **`local-chat-handoff.test.ts`** — `classifyLocalOutput`: repo `<tool_call>` marker, Qwen3 `<tool_call>` marker, `NEED_MORE_DATA` sentinel, each `NEED_MORE_PHRASES` class, empty output → handoff with the right reason; normal answers (including text containing the word "provide" in innocuous contexts) → `answer`.
4. **`dashboard-local-chat.test.ts`** — boots the server on port 0 (copy the `dashboard-server.test.ts` pattern): `GET /api/config/local-chat` shape and model id; `POST /api/chat/local` creates a session + history row, reuses a supplied `sessionId`, titles a new session from the query, rejects missing fields; `serveDashboardAsset` serves a file from a temp dir with correct content-type and 404s a missing file and a `../` traversal attempt.

Run with the CI-style loop (`for f in src/__tests__/*.test.ts; do bun test "$f"; done`) to catch cross-file contamination.

## Step 7 — Verify

- `bun install && bun run typecheck && bun test` (per-file loop).
- `cd src/dashboard/ui && npm ci && npm run build && npm run build:hybrid` — both builds pass; `dist-hybrid/` contains `hybrid-chat.js` + `ort/*.wasm`; `dist/index.html` does NOT inline transformers.
- Manual matrix (maps to the acceptance criteria):
  1. `bun run src/index.tsx --dashboard` (or `wilson --dashboard`) with a seeded DB; open in a WebGPU browser (Chrome/Edge) → ask "how much did I spend on groceries this week?" → answer rendered with figures matching the DB; **server log shows no `Dashboard chat query` line for that message** (that log line in `handleChatMessage` is the observable proof no agent-loop request reached the server) and no new `llm_traces` row for it.
  2. First message in a fresh profile: progress label while ~600MB downloads; reload later → instant (browser Cache API).
  3. Ask something outside the 30-day bundle (e.g. "what did I spend on rent last year?") → server agent's answer, no error bubble.
  4. Same dashboard in Firefox/Safari (no WebGPU) → server answer, no error bubble, no model download.
  5. Reload the page after a locally-answered exchange → the exchange appears via `/api/chat/sessions` history like server answers.
  6. Legacy UI without any build (delete `src/dashboard/ui/dist`) → dashboard loads, hybrid chunk 404s, chat behaves as today; with `dist-hybrid/` present → local-first works there too.
- Update `docs/research/dashboard-webgpu-spike.md` with the final verdict + tested browsers/GPUs; summarize in the PR description together with the veto flag.

## Risks / known frictions

- `vite-plugin-singlefile` vs wasm/worker assets is the known fight; the shipped architecture sidesteps it (transformers only ever bundles into `dist-hybrid/hybrid-chat.js`, loaded at runtime by both UIs). If singlefile still tries to bundle the `@vite-ignore` import, fall back to injecting a `<script type="module">` tag from `main.tsx` at runtime.
- fp16 needs GPU `shader-f16`; older adapters pass `requestAdapter()` but fail session creation — covered by the real-generation probe and silent fallback.
- Main-thread generation (`proxy=false`) blocks the UI for a few seconds per answer; worker mode is a follow-up, not this slice.
- Model weights download from the HF Hub (like the CLI does); user data stays on localhost. Server-proxied weights are a future privacy upgrade, out of scope.
- `getFastModel()` has no callers today, so the `fastModel` addition cannot change server behavior; note this for reviewers.

## Out of scope

Streaming tokens, worker/async generation, server-proxied model weights, hybrid chat in the CLI/TUI, a settings-UI toggle for hybrid, embeddings/memory, in-browser categorization, new DB schema/migrations.

## Acceptance-criteria mapping

| AC | Where |
|---|---|
| Spike findings recorded (works/partial/blocked) | Step 0 → `docs/research/dashboard-webgpu-spike.md` + PR description |
| Bundle-covered question answered locally, no agent request to server | Steps 2/3/4/5 + manual check 1 (log-line proof) |
| Non-WebGPU + load/generation failure → silent server answer | client probe/fallback (`{ok:false}` contract), manual checks 3/4 |
| Bundle-unanswerable question hands off silently | `NEED_MORE_DATA` sentinel + `NEED_MORE_PHRASES` + classifier, manual check 3 |
| Model choice via `fastModel`, changeable in one place | Step 1 (`src/providers.ts` + `getLocalChatModelConfig` + config endpoint), test 1 |
| Bundle within 0.6B window, localhost-only fetches | `buildBundle` size guard + existing endpoints, test 2 |
| Locally-answered exchanges survive reload | `POST /api/chat/local` + session continuity, test 4, manual check 5 |
| Tests for projection/framing, hand-off, fallback decision, config exposure; typecheck/test/build pass | Steps 1/2 + tests 1–4, Step 7 |
| Manual check incl. legacy no-build UI | Step 7 checks 1–6 |