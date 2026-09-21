# Plan: Admin per-task model overrides, applied live (issue #89)

Parent: #57 (decomposed from #87). Blocked by #88 — **which has landed**: the Settings "Models" panel, `GET /api/models`, `src/model/task-models.ts`, and the call-type tagging all exist in this worktree.

## Outcome

A dashboard admin can pin a different model to any task (chat, categorization, entity classification) — or reset a task to follow the chat model — and the next run of that task uses it immediately, with no restart. Rows stay legible about *why* they run what they run: no override reads "Follows chat model (…)", a pinned row reads "Pinned: …". The chat task's control IS the existing global model setting, making the panel the dashboard's `/model` equivalent; the agent runner and the background summarize/relevance consumers follow it too.

## Context (verified in repo)

- **Settings storage** — `src/utils/config.ts`: `settings.json` is flat JSON; `getSetting(key, default)` calls `loadConfig()` which **reads the file from disk on every call** (no cache). Chat model keys today: `provider` + `modelId`. `setSetting(key, value)` is a read-modify-write. Anything resolved per call from `getSetting` is therefore live by construction.
- **Task-models module** (`src/model/task-models.ts`, from #88): `buildModelTaskRows(configuredModel, webgpu)` emits four rows (chat, categorization, entity-classification, embeddings-not-in-use) with `assignment: 'default'` always; `getModelTaskRows(webgpuOverride?)` reads `getConfiguredModel()` and probes WebGPU via **dynamic import** of `./providers/transformers.js` (heavy deps stay out of the server startup graph). `apiModels(webgpuOverride?)` in `src/dashboard/api.ts:412` wraps it.
- **Task call sites** — all three read the chat model today:
  - categorization: `src/tools/categorize/categorize.ts:126` (`const { model } = getConfiguredModel()` inside the batch loop, per call),
  - entity classification: `src/tools/entity/entity-classify.ts:101` (same shape),
  - dashboard chat: `src/dashboard/chat.ts:16` — but only at `initChatSession` time.
- **Chat live path (the TUI /model precedent)** — `ModelSelectionController.completeModelSwitch` (`src/controllers/model-selection.ts:283-292`) persists `setSetting('provider', …)` + `setSetting('modelId', …)` and calls `this.chatHistory.setModel(newModelId)`; `cli.ts:333-334` additionally calls `agentRunner.updateModel(model, provider)` (`src/controllers/agent-runner.ts:41` mutates `agentConfig`). `AgentRunnerController.runQuery` calls `Agent.create({ ...this.agentConfig, … })` **fresh per run** (`agent-runner.ts:96-101`), so `updateModel` takes effect on the next query with no restart.
- **The dashboard's stale defaults** — `initChatSession(db)` snapshots the model once at server start into `AgentRunnerController` config, and constructs `new InMemoryChatHistory()` with **no model argument**, so `this.model` stays `DEFAULT_MODEL` (`'ollama:qwen3:8b'`, `in-memory-chat-history.ts:55-56`) forever. The background consumers — summarize (`:122-125`, `callType: 'summarize'`) and relevance (`:223-227`, `callType: 'relevance'`) — both pass `model: this.model`, so they ride that stale default today. Changing `modelId` in settings.json does nothing to a running dashboard.
- **Model catalog** — `PROVIDER_MODELS` in `src/utils/model.ts` (`Model { id, displayName, tags?, downloadSize? }`); `PROVIDERS` wraps each with `displayName`/`providerId`. The six `transformers` entries carry `downloadSize`; four are tagged `'webgpu'`, two are CPU/WASM. Ollama entries carry no size.
- **Cached/downloaded checks** — `isTransformersModelCached(modelId)` is private in `controllers/model-selection.ts:13-18` (checks `~/.openaccountant/models/models--{org}--{name}`); `getOllamaModels()` in `src/utils/ollama.ts` fetches `/api/tags` and returns installed ollama model names (`[]` on any failure).
- **Trace visibility** — `callLlm` (`src/model/llm.ts`) records `model` + `provider` into `llm_traces` per call, and the Traces tab renders `trace.model` per row (`LlmTab.tsx:180`). A pinned model therefore shows up in per-call trace rows with **zero extra code**.
- **RBAC idiom** — `canWrite(role)` in `src/dashboard/auth.ts:84` (admin only). Routes gate writes with `if (authEnabled && currentUser && !canWrite(currentUser.role)) return Response.json({ error: 'Forbidden' }, { status: 403 })` (see the annotate route, `server.ts:565-568`). When auth is **disabled**, writes are allowed (single-user local mode) — every existing write behaves this way.
- **UI** — `ModelsSection` (`src/dashboard/ui/src/tabs/SettingsTab.tsx:601-640`) fetches `/api/models` via `useApi`; `ModelRow` (`:563`) renders chips and currently no controls. The auth-status pattern is already in this file (`:93-115`): `useApi<AuthStatus>('/api/auth/status')` → `authEnabled` + `user.role`; note `user` is `null` when auth is disabled. `api()` (`ui/src/api.ts:8-25`) throws `Error('API 403: …')` on non-OK. `useApi` exposes `refetch` (used by `EntitySection`).
- **Test scaffolding** — `dashboard-models-endpoint.test.ts` (HTTP + admin token login), `dashboard-api.test.ts` `apiModels` describe (`:673-699`) with the `setSetting(...)`/`saveConfig({})` reset pattern (`:706-719`), `task-models.test.ts` (pure, no profile/probe/LLM), and `categorize-tool.test.ts` / `entity-classify-tool.test.ts` which `spyOn(llmModule, 'callLlm')`. `dashboard-server.test.ts` has a viewer-vs-admin RBAC scaffold (`setupRbac`, `:171-193`).

## Design

### 1. Settings keys + resolution (`src/model/task-models.ts`)

Two flat settings keys, stored **next to `modelId`** in the profile's `settings.json` (flat dotted keys keep `loadConfig`/`saveConfig`/`setSetting` untouched):

- `modelOverride.categorization`
- `modelOverride.entity-classification`

The chat task has **no override key** — its control is the existing global `provider`/`modelId` pair.

New exports in `task-models.ts`:

```ts
export type OverridableTask = 'categorization' | 'entity-classification';

const OVERRIDE_SETTINGS_KEYS: Record<OverridableTask, string> = {
  categorization: 'modelOverride.categorization',
  'entity-classification': 'modelOverride.entity-classification',
};

/** Raw pinned id from settings, or null when the task follows the chat model. */
export function getTaskOverride(task: OverridableTask): string | null;

/** Persist a pin (model id) or clear it (null = reset to follow chat model). */
export function setTaskOverride(task: OverridableTask, model: string | null): boolean;

/** Effective model for a task: pinned override when set, else the chat model.
 *  Reads settings from disk on every call → resolution at call time is live. */
export function getTaskModel(task: 'chat' | OverridableTask): string;

/** Guard for the write route: non-empty string AND (present in the model
 *  catalog OR prefixed with a known provider's modelPrefix). The prefix arm
 *  lets an admin pin an installed-but-uncatalogued ollama model — the same
 *  freedom the TUI's ollama picker has. Rejects '' / garbage / non-strings. */
export function validateTaskModel(model: unknown): model is string;
```

### 2. Rows become override-aware (`task-models.ts`)

```ts
export interface TaskOverrides {
  categorization?: string | null;
  'entity-classification'?: string | null;
}
export function buildModelTaskRows(
  configuredModel: string, webgpu: boolean, overrides?: TaskOverrides
): ModelTaskRow[];
```

- When `overrides.categorization` is a non-null string → that row resolves `model`/`modelName`/`provider`/`providerName`/`execution` **from the pinned id** and sets `assignment: 'override'`; `null`/absent → chat model + `'default'`. Same for `entity-classification`.
- Chat row: always the chat model + `assignment: 'default'` (its control *is* the global setting; there is no "override" concept for it).
- Embeddings row: unchanged.
- Omitting the param keeps today's behavior → the existing #88 tests keep passing untouched.

Rename/refactor the async entry point (currently `getModelTaskRows`, used only by `api.ts`) into:

```ts
export interface CatalogModel {
  id: string; displayName: string;
  provider: string; providerName: string;
  isLocal: boolean;
  cached: boolean;              // local only; cloud = true (nothing to download)
  downloadSize: string | null;  // catalog value; null when unknown
}
export interface ModelsPanel { tasks: ModelTaskRow[]; catalog: CatalogModel[] }
export async function getModelPanel(webgpuOverride?: boolean): Promise<ModelsPanel>;
```

- Reads `getTaskOverride` for both tasks and passes them into `buildModelTaskRows`; resolves the WebGPU probe exactly as today (**dynamic import** of `./providers/transformers.js` — keep that discipline).
- `apiModels(webgpuOverride?)` becomes a one-liner returning `getModelPanel(webgpuOverride)`; the response shape grows to `{ tasks, catalog }` (additive — the #88 HTTP test keeps passing).

### 3. Catalog builder (`task-models.ts`) + one moved helper

```ts
export async function buildModelCatalog(webgpu: boolean): Promise<CatalogModel[]>
```

Iterate `PROVIDERS` from `src/utils/model.ts`:

- **WebGPU filter**: drop `transformers` entries tagged `'webgpu'` when `webgpu === false` — mirrors the TUI's `handleProviderSelect` filter (`model-selection.ts:125-130`). CPU/WASM transformers entries are always offered.
- **cached**:
  - `transformers` → `isTransformersModelCached(id without 'transformers:')`,
  - `ollama` → membership in `await getOllamaModels()` (compare against the id with `ollama:` stripped). When ollama is unreachable it returns `[]` → all ollama entries report uncached; truthful, and ollama entries have no `downloadSize` so nothing misleading is shown,
  - cloud → `true`.
- **downloadSize**: catalog `downloadSize ?? null` (the six transformers entries carry sizes; ollama/cloud entries are `null`).

Move `isTransformersModelCached` from `controllers/model-selection.ts` (where it is private) to `src/utils/model.ts` as an exported helper, and import it in both places — one cache-dir definition, `model-selection.ts` behavior unchanged.

### 4. Call sites resolve the pin at call time

- `src/tools/categorize/categorize.ts:126` — replace `const { model } = getConfiguredModel();` with `const model = getTaskModel('categorization');`
- `src/tools/entity/entity-classify.ts:101` — same with `'entity-classification'`.

Nothing else changes: `callLlm` records the effective model into `llm_traces`/`llm_interactions` per call, so the pin is visible in per-call trace rows automatically; and because `getSetting` re-reads the file, a pin lands on the **very next run** — dashboard *and* CLI/headless runs of these tools (overrides are profile-wide settings; note this in the row's hint text so the panel doesn't imply dashboard-only scope).

### 5. Chat applies live through the TUI /model path (`src/dashboard/chat.ts`)

```ts
// module-private: last model applied to runner + history
let appliedModel: { model: string; provider: string } | null = null;

/** Re-read the chat model and, when it changed, apply it through the same
 *  live-update path the TUI's /model switch uses:
 *  agentRunner.updateModel(model, provider) + chatHistory.setModel(model). */
export function refreshChatModel(): void;

/** Last model applied (for tests + diagnostics). */
export function getAppliedChatModel(): { model: string; provider: string } | null;
```

- `initChatSession`: after constructing `chatHistory` + `agentRunner`, call `refreshChatModel()` — this fixes the baseline where the dashboard's `InMemoryChatHistory` rides `DEFAULT_MODEL` forever.
- `handleChatMessage`: call `refreshChatModel()` immediately after the initialized guard, before `runQuery` — **per-message resolution**. One mechanism covers every writer of the chat-model setting: the panel write route, the TUI's `/model` switch, or a hand-edited `settings.json`. The background summarize/relevance calls follow because they read `chatHistory`'s model (`setModel` is part of the same refresh).
- The write route does **not** poke `chat.ts` directly — persisting the setting is the route's whole job; the refresh is the single apply point. No new coupling, no second divergent path.
- Testability: add a one-line getter to `InMemoryChatHistory`: `get currentModel(): string { return this.model; }`.

### 6. Write endpoint (`src/dashboard/api.ts` + `src/dashboard/server.ts`)

`api.ts`:

```ts
export interface SetTaskModelBody { task?: string; model?: string | null }
export function apiSetTaskModel(body: SetTaskModelBody):
  { success: true; task: string; model: string | null } | { error: string };
```

- `task === 'chat'`: `model` must pass `validateTaskModel` → `setSetting('provider', resolveProvider(model).id)` + `setSetting('modelId', model)` — exactly what `ModelSelectionController.completeModelSwitch` persists. `model` null for chat → `{ error: … }` (the select is the control; there is no reset concept for the chat row).
- `task` in `OverridableTask`: string → validate + `setTaskOverride(task, model)`; `null`/`undefined` → `setTaskOverride(task, null)` (reset — row returns to "Follows chat model").
- Any other task (including `embeddings`) or invalid model → `{ error: '…' }`.

`server.ts`, right next to the existing GET (after it):

```ts
if (path === '/api/models' && req.method === 'POST') {
  if (authEnabled && currentUser && !canWrite(currentUser.role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  const body = await req.json() as SetTaskModelBody;
  const result = apiSetTaskModel(body);
  if ('error' in result) return Response.json(result, { status: 400, headers });
  return Response.json(result, { headers });
}
```

Same RBAC posture as every other settings write: admin-only when auth is on, allowed when auth is off.

### 7. UI — the panel becomes controllable (`SettingsTab.tsx` + `ui/src/types.ts`)

- `ui/src/types.ts`: mirror `CatalogModel` and `ModelsPanel` next to the existing `ModelTaskRow`.
- `ModelsSection`: fetch `useApi<ModelsPanel>('/api/models')` **and** `useApi<AuthStatus>('/api/auth/status')` (the same per-section pattern `SecuritySection` uses).
  - `const canOverride = !authEnabled || authStatus?.user?.role === 'admin';` — mirrors the server gate (auth-disabled local mode may write; `user` is null in that mode).
- **Row text** (the "why" stays legible):
  - Chat row: label + friendly model name + execution badge as today; **no assignment chip** (it is the source of truth).
  - Tool rows: the assignment chip becomes
    - `assignment === 'default'` → `Follows chat model (${chatRow.modelName})`,
    - `assignment === 'override'` → `Pinned: ${row.modelName}`.
- **Controls** (only when `canOverride`): a `<select>` on each in-use row.
  - Options = the `catalog`, grouped with `<optgroup label={providerName}>`, option text = `displayName` plus, for local uncached models: ` (~${downloadSize} — downloads on first use)` when `downloadSize` is set, else `(downloads on first use)`.
  - Server-side webgpu filtering means the dropdown never offers a local WebGPU model the probe says can't run here — the UI stays dumb.
  - If the row's current effective `model` is not in the catalog (installed-but-uncatalogued ollama model, ad-hoc id), append it as an extra option so the select shows the truth.
  - Tool rows get one extra top option `Follows chat model` (value `''`) → submits `model: null`. The chat row's select has no reset option.
  - `onChange` → `api('/api/models', { method: 'POST', body: JSON.stringify({ task, model: value || null }) })`, then `refetch()`; while saving, disable the select; on failure show a muted inline error like `EntitySection` does (`catch` → error string; 403 surfaces as "API 403" — a generic "Could not save model override" line is fine, plus `Admin access required` hint when `!canOverride` is false but the server still rejects).
  - Under the chat row's select, one muted hint: applies to chat everywhere — CLI and dashboard (it *is* the global setting).
- Viewers (`!canOverride`): rows render exactly as today (chips only, no selects) — the chips now carry the new "Follows chat model (…)"/"Pinned: …" strings.
- Keep the branch-on-`inUse` discipline; the embeddings row gets no control (not in use).

### 8. CHANGELOG

One `feat:` bullet under `## [Unreleased] → ### Features` in the existing style, referencing issue #89.

## Files touched

| File | Change |
|---|---|
| `src/model/task-models.ts` | Override keys + `getTaskOverride`/`setTaskOverride`/`getTaskModel`/`validateTaskModel`; `overrides` param on `buildModelTaskRows`; `getModelPanel` + `CatalogModel`/`ModelsPanel` + `buildModelCatalog` (rename replaces `getModelTaskRows`) |
| `src/utils/model.ts` | Export `isTransformersModelCached` (moved here) |
| `src/controllers/model-selection.ts` | Import `isTransformersModelCached` from `utils/model.js`; delete the private copy |
| `src/tools/categorize/categorize.ts` | `model = getTaskModel('categorization')` |
| `src/tools/entity/entity-classify.ts` | `model = getTaskModel('entity-classification')` |
| `src/utils/in-memory-chat-history.ts` | Add `get currentModel(): string` |
| `src/dashboard/chat.ts` | `refreshChatModel()` / `getAppliedChatModel()`; call in `initChatSession` + `handleChatMessage` |
| `src/dashboard/api.ts` | `apiModels` → `getModelPanel`; add `apiSetTaskModel` |
| `src/dashboard/server.ts` | `POST /api/models` with the `canWrite` gate |
| `src/dashboard/ui/src/types.ts` | Mirror `CatalogModel`, `ModelsPanel` |
| `src/dashboard/ui/src/tabs/SettingsTab.tsx` | Chip text + per-row selects + auth/catalog wiring in `ModelsSection`/`ModelRow` |
| `CHANGELOG.md` | Unreleased feature bullet |
| Tests | `task-models.test.ts`, `dashboard-api.test.ts`, `dashboard-models-endpoint.test.ts` (extend); `dashboard-chat-model.test.ts` (new); `categorize-tool.test.ts`, `entity-classify-tool.test.ts` (extend) |

## Tests

1. **`src/__tests__/task-models.test.ts` (extend)**
   - `buildModelTaskRows('gpt-5.2', false, { categorization: 'ollama:qwen3:0.6b' })`: categorization row carries `model: 'ollama:qwen3:0.6b'`, friendly name containing `Qwen3 0.6B`, `provider: 'ollama'`, `execution: 'local'`, `assignment: 'override'`; chat + entity rows still follow `gpt-5.2` with `assignment: 'default'`.
   - Both overrides set → both rows `'override'`; `{ categorization: null }` → categorization stays `'default'` (reset semantics in the builder).
   - Omitting the third param → all `'default'` (existing tests unchanged).
   - `getTaskModel` / `setTaskOverride` (temp profile — `ensureTestProfile()` pattern; `setSetting`/`saveConfig({})` reset like `dashboard-api.test.ts`): default falls back to the chat model; after `setTaskOverride('categorization', 'ollama:qwen3:0.6b')` → `getTaskModel('categorization')` returns the pin while `getTaskModel('chat')` still returns the chat model; `setTaskOverride('categorization', null)` clears (`getTaskOverride` → `null`).
   - `validateTaskModel`: catalog ids (`'gpt-5.2'`, `'ollama:qwen3:8b'`) → true; prefixed-but-uncatalogued (`'ollama:some-installed-model'`, `'transformers:org/repo'`) → true; `'garbage-id'`, `''`, `null`, `42` → false.
   - `buildModelCatalog(false)`: contains **no** `transformers` entry tagged `webgpu`; `buildModelCatalog(true)`: does contain them. Every entry has boolean `cached`, `isLocal` matching the provider registry, `downloadSize` matching the catalog for transformers entries (`null` elsewhere); cloud entries `cached: true`. Do **not** assert ollama `cached` values (machine-dependent — depends on a running ollama).
2. **`src/__tests__/dashboard-api.test.ts` (extend the `apiModels` describe; add `apiSetTaskModel`)**
   - `apiSetTaskModel({ task: 'categorization', model: 'ollama:qwen3:0.6b' })` → success; `await apiModels(false)` shows the categorization row pinned (`assignment: 'override'`) while the entity row still follows the chat model; `apiSetTaskModel({ task: 'categorization', model: null })` → row back to `'default'` with the chat model. Reset settings afterwards (`saveConfig({})` — the file's existing pattern, `:706-719`).
   - `apiSetTaskModel({ task: 'chat', model: 'gpt-5.2' })` → `getConfiguredModel()` equals `{ model: 'gpt-5.2', provider: 'openai' }`; chat with `model: null` → error; unknown task and `'embeddings'` → error; invalid model id → error.
3. **`src/__tests__/dashboard-models-endpoint.test.ts` (extend)**
   - POST `/api/models` as admin `{ task: 'categorization', model: 'ollama:qwen3:0.6b' }` → 200; subsequent GET shows that row `assignment: 'override'` with the pinned model — live, no restart; POST `model: null` → GET shows `'default'` again.
   - POST as viewer (the `dashboard-server.test.ts` `setupRbac` pattern) → 403.
   - POST with an invalid model id → 400; unknown task → 400.
   - GET response now carries `catalog`: array of entries each with `id`, `displayName`, `provider`, `providerName`, boolean `isLocal`, boolean `cached`, `downloadSize` null-or-string. Don't assert exact membership (machine-dependent ollama/webgpu).
4. **`src/__tests__/dashboard-chat-model.test.ts` (new)** — the live chat apply path, with zero LLM machinery:
   - `spyOn(AgentRunnerController.prototype, 'runQuery').mockResolvedValue({ answer: 'ok' })`, plus spies on `AgentRunnerController.prototype.updateModel` and `InMemoryChatHistory.prototype.setModel`.
   - `setSetting('modelId', 'gpt-5.2'); setSetting('provider', 'openai')` → `initChatSession(createTestDb())` → `getAppliedChatModel()` matches the settings (proves init no longer rides `DEFAULT_MODEL`) and `getAppliedChatModel().model === 'gpt-5.2'`.
   - `handleChatMessage('hi')` → last `updateModel` call args are `('gpt-5.2', 'openai')` and `chatHistory.currentModel === 'gpt-5.2'` (the summarize/relevance consumer follows).
   - Switch: `setSetting('modelId', 'ollama:qwen3:0.6b'); setSetting('provider', 'ollama')` → `handleChatMessage('again')` → last `updateModel` args are the new pair and `currentModel` follows — the next dashboard message uses the new model with no restart. Reset settings afterwards.
5. **Call-site resolution** — `categorize-tool.test.ts` / `entity-classify-tool.test.ts` (both already `spyOn(llmModule, 'callLlm')`):
   - In a test exercising the LLM batch path, first `setTaskOverride('<task>', 'ollama:qwen3:0.6b')`, run the tool, assert the spy saw `options.model === 'ollama:qwen3:0.6b'`; then `setTaskOverride('<task>', null)`, run again, assert the spy saw the chat model. Reset settings at the end. (Existing call-type assertions from #88 stay.)

## Verification

1. `bun run typecheck` — clean.
2. `bun test` — all pass, including the untouched `webgpu-model-path.test.ts`, `providers-index.test.ts`, `chat-sessions.test.ts`, `in-memory-chat-history.test.ts`.
3. Dashboard UI build: `cd src/dashboard/ui && npm run build` — clean.
4. Manual check (the acceptance gate):
   - Start the dashboard (`bun run src/index.tsx --dashboard`), open Settings → Models as admin: pin a small model (e.g. Qwen3 0.6B) to Categorization; the row flips to "Pinned: Qwen3 0.6B (local)". Run a categorization from Chat; confirm the pinned model appears in that task's rows in the Traces tab.
   - Reset it via the "Follows chat model" option; the row reads "Follows chat model (…)" again.
   - Switch the chat model via the panel's Chat row; send a dashboard chat message; confirm it takes effect without a restart (chat answer + its summarize call trace under the new model).
   - Log in as a viewer: no selects are rendered; a direct `POST /api/models` with the viewer token returns 403.

## Do NOT touch

- `package.json` / `bun.lock` — no new dependencies.
- `trace-store.ts` / `llm_traces` schema and all migrations — the pinned model already lands in per-call trace rows via `callLlm`.
- `src/model/providers/transformers.ts` (the probe) — consumed, not modified; keep the dynamic-import discipline in `getModelPanel`.
- The TUI `/model` flow's semantics — only relocate the cache helper out of `model-selection.ts`; `completeModelSwitch` behavior unchanged.
- `PROVIDER_MODELS` catalog entries — consume/display only.
- The legacy fallback dashboard (`src/dashboard/html.ts`).

## Non-goals (later slices)

- Wiring a real embeddings task (the row stays not-in-use and gets no control).
- Per-task overrides for summarize/relevance/other call types; per-profile or per-user overrides.
- Traces-tab schema changes; a chat-model write audit trail.

## Risks / notes for the builder

- **One apply point for the chat model.** `refreshChatModel()` in `chat.ts` is the only place that pushes the chat model into the runner + history. Do not add an eager apply inside the write route — the per-message refresh already covers the next message, and a second path invites drift between the panel, the TUI, and hand-edited settings.
- `setSetting('provider')` + `setSetting('modelId')` for the chat write are two read-modify-writes (non-atomic) — identical to the TUI's existing behavior; acceptable.
- Ollama `cached` is best-effort: when the ollama server is unreachable every ollama entry reports uncached with no size. Tests must not assert ollama cached values or they'll flake on machines running ollama.
- `getSetting` reads disk per call — that is the *feature* that makes pins live; do not add a cache layer to "optimize" it.
- The UI must treat "auth disabled" as may-write (`!authEnabled || role === 'admin'`), because `/api/auth/status` returns `user: null` when auth is off while the server still accepts writes in that mode.
- The `apiModels` response shape change is additive (`tasks` unchanged, `catalog` added) — the #88 endpoint tests keep passing; extend rather than rewrite them.
- Overrides are profile-wide settings: pinning a categorization model also changes CLI/headless categorize runs. That's consistent with how the chat-model setting already behaves; the UI hint text should say so.