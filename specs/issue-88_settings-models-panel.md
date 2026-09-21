# Plan: Dashboard Settings "Models" panel — which model handles each AI task, local vs server (issue #88)

Parent: #57 (decomposed from #87). Outcome: a dashboard user opening Settings sees, on one demo-legible screen, which model handles each AI task the product runs — chat, categorization, entity classification — whether that model runs on this device or a cloud server, and a plainly-worded embeddings row that says no embeddings task runs on their data in this build. The "which model handled what" history becomes equally honest: categorization and entity-classification LLM calls get their own call types instead of landing in the generic `standalone` bucket.

## Context (verified in repo)

- **Provider registry** — `src/providers.ts` is the declared single source of truth for provider metadata. `ProviderDef` has `id`, `displayName`, `modelPrefix`, `apiKeyEnvVar?`, `fastModel?` — **no local-vs-server flag today**. Local providers are `ollama` and `transformers` (Transformers.js local); everything else is cloud (openai, anthropic, google, xai, moonshot, deepseek, openrouter, litellm). `resolveProvider(modelName)` maps a model id → provider via prefix (falls back to OpenAI).
- **Model resolution** — `getConfiguredModel()` in `src/utils/config.ts` reads `modelId` from the active profile's `settings.json` and falls back to `DEFAULT_MODEL` (`ollama:qwen3:8b`). All three product LLM tasks read this same call today:
  - chat: `src/dashboard/chat.ts:16` (and the CLI agent via `AgentRunnerController`),
  - categorization: `src/tools/categorize/categorize.ts:124-128`,
  - entity classification: `src/tools/entity/entity-classify.ts:99-104`.
  So today every task row shows the same model with `assignment: 'default'`.
- **Friendly model names** — `getModelDisplayName(modelId)` in `src/utils/model.ts` (model catalog `PROVIDER_MODELS`; falls back to the prefix-stripped id for unknown models).
- **WebGPU capability probe** — `checkWebGpuAvailable()` in `src/model/providers/transformers.ts`: async, never throws, cached for the process lifetime (3-layer probe: transformers.js knows the device → onnxruntime-node ships the WebGPU EP → tiny ONNX session actually runs on the GPU). The module statically pulls `onnxruntime-node` + `@huggingface/transformers`, so the dashboard must reach it by **dynamic import** to keep the heavy dep out of the server startup graph.
- **Call types today** — `callLlm` (`src/model/llm.ts:166-168`) records `runId ?? 'standalone'` / `callType ?? 'standalone'` into `llm_interactions` via `interactionStore`. Existing values: `'agent'` (`src/agent/agent.ts:260`), `'summarize'` and `'relevance'` (`src/utils/in-memory-chat-history.ts:125,227`). **Categorization and entity-classification pass no `callType` → they land in `standalone`.** `llm_traces` (trace store) has no call-type column — the per-task history view is the Training tab's `call_type` filter (`LlmTab.tsx` builds the filter options from data, so new call types appear automatically).
- **Dashboard API pattern** — handlers live in `src/dashboard/api.ts` (either db-first or config-derived, e.g. `apiLocalChatConfig()` at api.ts:399); routes in `src/dashboard/server.ts` (see the `/api/config/local-chat` route at server.ts:528); auth is gated globally for `/api/*` (the local-chat config endpoint returns 401 without a token — new route inherits this for free).
- **Server tests** — `src/__tests__/dashboard-local-chat.test.ts` is the scaffold for HTTP-level tests (`startDashboardServer(db, 0)` + `setInitialProfile` + login token). `createTestDb()` in `src/__tests__/helpers.ts` calls `ensureTestProfile()` (temp-dir `setActiveProfilePaths`), so `getConfiguredModel()` works in any test using `createTestDb()`. `src/__tests__/config.test.ts` shows the temp-profile + `setSetting` pattern.
- **Tool tests** — `categorize-tool.test.ts` and `entity-classify-tool.test.ts` `spyOn(llmModule, 'callLlm')`, so asserting the options passed to `callLlm` is direct.
- **Settings tab** — `src/dashboard/ui/src/tabs/SettingsTab.tsx` is a stack of section components (`ProfileSection`, `EntitySection`, `SecuritySection`, `MemoriesSection`, `CustomPromptSection`), each using `useApi` + the shared card styling. UI types live in `src/dashboard/ui/src/types.ts`. Build: `cd src/dashboard/ui && npm run build` (= `tsc -b && vite build`, single-file output served from `src/dashboard/ui/dist`).
- **Embeddings decision (round 1, issue #61)** — the local embedding engine + `wilson --index` backfill exist as CLI maintenance commands, but **no product AI task consumes embeddings yet** (no embed-on-write, no semantic tool in the product). Per round 1: the embeddings row is **not-in-use**, rendered as "Not in use — no embeddings task in this build", no model, no override control.

## Design

### 1. Provider registry gains the local/server flag (`src/providers.ts`)

Add a **required** `isLocal: boolean` to `ProviderDef` and set it on all 11 entries: `true` for `ollama` and `transformers`, `false` for the nine cloud providers. Required (not optional) so the registry test below enforces every entry declares it — this is the single place local-vs-server classification comes from, matching the file's own docstring ("all other modules derive from this"). Only `src/providers.ts` references `ProviderDef`; no other construction sites exist.

### 2. New module `src/model/task-models.ts` — task rows + call-type constants

```ts
export type TaskKey = 'chat' | 'categorization' | 'entity-classification' | 'embeddings';
export type TaskExecution = 'local' | 'server';

// Shared with the tool call sites so history tags and panel task keys stay aligned.
export const CALL_TYPE_CATEGORIZATION = 'categorization';
export const CALL_TYPE_ENTITY_CLASSIFICATION = 'entity-classification';

export interface ModelTaskRow {
  task: TaskKey;
  label: string;                          // 'Chat' | 'Categorization' | 'Entity classification' | 'Embeddings'
  inUse: boolean;                         // false only for the embeddings row in this build
  model: string | null;                   // model id in effect; null when !inUse
  modelName: string | null;               // getModelDisplayName(model); null when !inUse
  provider: string | null;                // provider id from resolveProvider; null when !inUse
  providerName: string | null;            // provider displayName; null when !inUse
  execution: 'local' | 'server' | null;   // from ProviderDef.isLocal; null when !inUse
  webgpu: boolean;                        // machine capability from checkWebGpuAvailable() — same value on every row
  assignment: 'default' | 'override';     // always 'default' in this slice (field in the shape from day one)
  note: string | null;                    // 'No embeddings task in this build' on the not-in-use row; null otherwise
}

export function buildModelTaskRows(configuredModel: string, webgpu: boolean): ModelTaskRow[];
export async function getModelTaskRows(webgpuOverride?: boolean): Promise<ModelTaskRow[]>;
```

- `buildModelTaskRows(configuredModel, webgpu)` — pure, no I/O. Resolves provider via `resolveProvider(configuredModel)`, friendly name via `getModelDisplayName(configuredModel)`, execution via `provider.isLocal`. Emits four rows in order: `chat`, `categorization`, `entity-classification`, `embeddings`. The three LLM task rows all use `configuredModel` (documented in a comment: they follow the chat model today; the override slice will pass per-task models into this builder). The embeddings row is the not-in-use row: `inUse: false`, `model/modelName/provider/providerName/execution: null`, `note: 'No embeddings task in this build'`, `assignment: 'default'`, `webgpu` passthrough. Every row carries the `webgpu` value as given (it's a machine capability, not a per-model property).
- `getModelTaskRows(webgpuOverride?)` — `const webgpu = webgpuOverride ?? await (await import('./providers/transformers.js')).checkWebGpuAvailable(); return buildModelTaskRows(getConfiguredModel().model, webgpu);` — the **dynamic import** keeps `onnxruntime-node`/transformers.js out of the dashboard server startup graph until the first `/api/models` hit; the probe is cached so subsequent calls are free.

### 3. Call-type tagging at both tool call sites

- `src/tools/categorize/categorize.ts` (~line 126): add `callType: CALL_TYPE_CATEGORIZATION` to the `callLlm` options (import from `../../model/task-models.js`).
- `src/tools/entity/entity-classify.ts` (~line 101): add `callType: CALL_TYPE_ENTITY_CLASSIFICATION` the same way.

After this, `llm_interactions.call_type` is `'categorization'` / `'entity-classification'` instead of `'standalone'`, and the Training tab's Type filter picks them up automatically (it derives options from data — no UI change needed). The Traces tab has no call-type surface (trace store has no such column) and needs no change; the per-task view is Training's filter.

### 4. Read endpoint `GET /api/models`

- `src/dashboard/api.ts`: add

```ts
export async function apiModels(webgpuOverride?: boolean) {
  return { tasks: await getModelTaskRows(webgpuOverride) };
}
```

  (Response shape is `{ tasks: ModelTaskRow[] }` — room for future section-level metadata. The `webgpuOverride` param exists so tests can pin the probe result without loading onnxruntime-node.)
- `src/dashboard/server.ts`: route next to `/api/config/local-chat`:

```ts
if (path === '/api/models') {
  return Response.json(await apiModels(), { headers });
}
```

  The enclosing handler is async (POST /api/chat already awaits), and auth gating is global — the endpoint requires a token when auth is enabled, like every other `/api/*` route.

### 5. UI: `ModelsSection` in the Settings tab

- `src/dashboard/ui/src/types.ts`: mirror the server types — `export interface ModelTaskRow { ... }` (same fields) and use `{ tasks: ModelTaskRow[] }` at the call site.
- `src/dashboard/ui/src/tabs/SettingsTab.tsx`: add a `ModelsSection` component following the existing section pattern (`useApi<{ tasks: ModelTaskRow[] }>('/api/models')`, skeleton pulse while loading, `bg-surface-raised border border-border rounded-lg p-4` card), and render it **first** in `SettingsTab` (above `ProfileSection`) — it's the privacy-story lead on a demo screen.
- Section content:
  - Heading `Models` + one-line explainer, e.g. "Which AI model handles each task — and whether it runs on this device or a cloud server."
  - One **WebGPU capability chip** in the section header area, derived from any row's `webgpu` field: "WebGPU acceleration: available" / "WebGPU acceleration: not available". Machine-level — it does not imply any local model is in use. Render it regardless of which models are configured.
  - One row per task in the order returned. For `inUse` rows: task label, **friendly model name** (`modelName` — never the raw id), provider name as muted text (e.g. "via Ollama"), and a plain-language execution badge:
    - `execution === 'local'` → green-tinted badge "Runs on this device" (reuse the existing badge styling idiom, e.g. `bg-green/15 text-green`),
    - `execution === 'server'` → amber-tinted badge "Runs on a cloud server" (e.g. `bg-amber-*`-style tint consistent with the role-badge styling already in the file).
  - Assignment state: render the `assignment` field as a muted chip on non-chat rows — "Default — follows the chat model" when `'default'`, "Override" when `'override'` (dead path today, but both branches exist so the override slice lands without UI redesign). No interactive control anywhere — this slice adds **no** model picker or override UI.
  - Not-in-use row: branch on `row.inUse === false` — **never** on `row.task === 'embeddings'` — rendering the muted text `Not in use{row.note ? ` — ${row.note}` : ''}` with no model name, no badges, no control. This generic render is what lets a future embeddings task light the same row up without redesign: flip `inUse` server-side and the row renders like any in-use row.

### 6. CHANGELOG

Add one `feat:` bullet under `## [Unreleased] → ### Features` in the existing style, referencing issue #88 (see how #68 and #71's entries are written).

## Files touched

| File | Change |
|---|---|
| `src/providers.ts` | Add required `isLocal: boolean` to `ProviderDef`; set `true` on ollama + transformers, `false` on the nine cloud entries |
| `src/model/task-models.ts` | **New** — `ModelTaskRow`, task/call-type constants, `buildModelTaskRows()`, `getModelTaskRows()` |
| `src/tools/categorize/categorize.ts` | Pass `callType: CALL_TYPE_CATEGORIZATION` to `callLlm` |
| `src/tools/entity/entity-classify.ts` | Pass `callType: CALL_TYPE_ENTITY_CLASSIFICATION` to `callLlm` |
| `src/dashboard/api.ts` | Add `apiModels(webgpuOverride?)` |
| `src/dashboard/server.ts` | Add `GET /api/models` route |
| `src/dashboard/ui/src/types.ts` | Mirror `ModelTaskRow` |
| `src/dashboard/ui/src/tabs/SettingsTab.tsx` | Add `ModelsSection`, render first in the tab |
| `CHANGELOG.md` | Unreleased feature bullet |
| Tests (below) | New `task-models.test.ts`, new `dashboard-models-endpoint.test.ts`, extend `dashboard-api.test.ts`, `categorize-tool.test.ts`, `entity-classify-tool.test.ts` |

## Tests

1. **`src/__tests__/task-models.test.ts` (new)** — no profile, no probe, no LLM:
   - **Registry classification**: every `PROVIDERS` entry has a boolean `isLocal`; exactly `ollama` and `transformers` are `true`; `openai`, `anthropic`, `google`, `xai`, `moonshot`, `deepseek`, `openrouter`, `litellm` are `false`.
   - `buildModelTaskRows('ollama:qwen3:8b', true)`: four rows with task keys `['chat','categorization','entity-classification','embeddings']` in order; each in-use row carries `model: 'ollama:qwen3:8b'`, friendly `modelName` containing `'Qwen3 8B'`, `provider: 'ollama'`, `providerName: 'Ollama'`, `execution: 'local'`, `webgpu: true`, `assignment: 'default'`; embeddings row has `inUse: false`, all model/provider/execution fields `null`, `note` non-null, `assignment: 'default'`.
   - `buildModelTaskRows('gpt-5.2', false)`: in-use rows get `execution: 'server'`, `provider: 'openai'`, `webgpu: false`.
   - Unknown model id: friendly name falls back to the normalized id (the `getModelDisplayName` contract), provider falls back to openai/server — the panel stays truthful for ad-hoc models.
   - Call-type constants: `CALL_TYPE_CATEGORIZATION === 'categorization'`, `CALL_TYPE_ENTITY_CLASSIFICATION === 'entity-classification'` (drift guard — the tools import these constants).
2. **`src/__tests__/dashboard-api.test.ts` (extend)** — `describe('apiModels')`:
   - `await apiModels(false)` returns `{ tasks }` with 4 rows, each row's `webgpu === false` (override honored, no probe run).
   - Pin the model with `setSetting('modelId', 'ollama:qwen3:8b')` (temp test profile — the `config.test.ts` pattern) → chat row model matches, `execution: 'local'`; then `setSetting('modelId', 'gpt-5.2')` → `execution: 'server'`. Reset with `saveConfig({})` after so other tests in the file see defaults.
   - Shape check: in-use rows always carry non-null `model`/`modelName`/`provider`/`execution`; the not-in-use row carries none of them.
3. **`src/__tests__/dashboard-models-endpoint.test.ts` (new)** — HTTP wiring, following the `dashboard-local-chat.test.ts` scaffold (`createTestDb` + `setInitialProfile` + `startDashboardServer(db, 0)` + auth login):
   - `GET /api/models` with token → 200, JSON has `tasks` array of 4, every row has a boolean `webgpu` (assert type, not value — machine-dependent), in-use rows' `model` equals `getConfiguredModel().model` (consistency, no settings writes), embeddings row `inUse: false`.
   - `GET /api/models` without token → 401 (auth posture identical to other API routes).
4. **Call-type tagging at both call sites**:
   - `categorize-tool.test.ts`: in a test that already exercises the LLM batch path, assert the spy saw `callType: 'categorization'` — e.g. `expect(llmSpy.mock.calls.some(([, opts]) => (opts as any)?.callType === 'categorization')).toBe(true)`.
   - `entity-classify-tool.test.ts`: same for `'entity-classification'`.
   - Training-view consequence is data-driven (the filter builds from `call_type` values) — covered by the existing `apiInteractions` filter test plus the tagging assertions above; add one insertion-and-filter assertion if cheap (insert an interaction row with `call_type: 'categorization'` and filter `apiInteractions(db, { callType: 'categorization' })` returns it, `'standalone'` does not).

## Verification

1. `bun run typecheck` — clean.
2. `bun test` — all pass, including untouched `webgpu-model-path.test.ts`, `transformers-webgpu-ep.test.ts`, and `providers-index.test.ts`.
3. Dashboard UI build: `cd src/dashboard/ui && npm run build` — clean (`tsc -b && vite build`).
4. Manual check (the acceptance gate):
   - Start the dashboard (`bun run src/index.tsx --dashboard`), open Settings: each task row shows a friendly model name plus a "Runs on this device" / "Runs on a cloud server" badge; the WebGPU chip renders; embeddings reads "Not in use — no embeddings task in this build" with no model and no control.
   - From the Chat tab, run one categorization, then open the LLM tab → Training sub-tab: the Type filter offers `categorization` and the run appears under it (not `standalone`).

## Do NOT touch

- `package.json` / `bun.lock` / the `@huggingface/transformers` `4.0.1` exact pin — no new dependencies anywhere.
- `src/utils/model.ts` `PROVIDER_MODELS` catalog — no new model entries; this slice only *displays* the model in effect.
- The text-generation path in `src/model/providers/transformers.ts` and both WebGPU test files — they must pass unchanged; `checkWebGpuAvailable()` is consumed, not modified.
- `trace-store.ts` / `llm_traces` schema — no call-type column, no migration. Per-task history lives in `llm_interactions` (Training), which is where `call_type` exists today.
- Migrations entirely — this slice writes no schema.
- The legacy fallback dashboard (`src/dashboard/html.ts`) — server-bound, out of scope.

## Non-goals (later slices)

- Per-task model override (settings write path + picker UI) — this slice only ships the `assignment` field, always `'default'`.
- Wiring a real embeddings task (embed-on-write, semantic search tool) — the row stays not-in-use until a product task consumes embeddings.
- Ollama/OpenAI embedding-provider rows, sqlite-vec, `summarize`/`relevance`/chain/team call-type taxonomy beyond the two tagged here.
- Traces-tab call-type column (would need an `llm_traces` migration).

## Risks / notes for the builder

- `getModelTaskRows` **must** dynamically import `./providers/transformers.js` — a static import would pull `onnxruntime-node` into every dashboard server startup (and into `api.ts`'s import graph). The probe is process-cached and never throws, so calling it per-request after first hit is free.
- All three LLM tasks follow the chat model *today* — the panel is honest about that via the assignment field, not by pretending otherwise. Do not invent per-task configuration in this slice.
- `resolveProvider` falls back to OpenAI for unprefixed model ids; `getModelDisplayName` falls back to the normalized id. Keep both fallbacks visible in the endpoint output (truthful for ad-hoc models) rather than special-casing.
- The UI must branch on `inUse`, never on the task key, for the not-in-use render — that branch discipline is the whole future-proofing story for the embeddings row.
- In `dashboard-api.test.ts`, the pinned-model test mutates the temp profile's `settings.json`; reset it afterwards (`saveConfig({})`) so later tests in that file are unaffected.