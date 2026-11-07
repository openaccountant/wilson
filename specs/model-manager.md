# Model manager: getting, updating, choosing, benchmarking and caching browser models

Status: building (2026-11-07). Branch `feat/model-manager`, off `main`.
Decisions: `specs/model-manager-DECISIONS.md`.

## Problem

The in-browser WebGPU path (hybrid chat, Speed Showdown, open-jev pre-labeler) loads models like this today:

- **Getting models.** There is one hardcoded catalog in `src/utils/model.ts`. The browser chat model can only be the provider registry's `fastModel`. No user-facing way to pick another one.
- **Staying up to date.** Catalog entries load from the Hub's `main` branch with no revision pin. A cached copy never refreshes. If upstream changes, a later partial download can mix two revisions. Transformers.js is pinned at 4.3.0, so models added since (LFM3, EmbeddingGemma 2) can't load.
- **Freedom.** Users can't add a Hub repo. Admins can only pin catalog ids.
- **Benchmarks.** Nobody measures tok/s or first-token latency. Speed Showdown times one categorize call and stops there.
- **Caching.** Transformers.js's default Cache API store is the only cache. There's no `persist()`, so the browser can evict 0.35 to 3.6 GB of weights under storage pressure. There's no cache UI and no sharing across origins: every dashboard port, the demo sandbox and try.openaccountant.ai each download their own copy.

The open-jev pre-labeler already pins a revision and a `config.json` sha256 (`src/prelabel/config.ts`). This spec extends that discipline to every browser model.

## Scope (this branch)

### M1. Transformers.js 4.3.0 → 4.3.2

Adds LFM3 and LFM3-VL. Fixes `from_pretrained` hanging when an external-data download fails.

Re-run the Hub fixture test and the hybrid/prelabel bundle checks (`build:hybrid`).

### M2. Revision pins

Every `transformers` catalog entry gains `revision` (40-hex Hub commit sha).

- **Browser engine:** passes `revision` to `pipeline()`, so cache keys and download URLs are immutable.
- **Server adapter:** passes `revision` to `pipeline()` the same way. If the server-side `TransformersAdapter` has no revision path today, it gets one.
- **Fixture test:** each pin exists in the recorded Hub fixture, with the recorded file list taken at that revision.
- **Uncatalogued repos (M5):** resolve `main` to a sha once, when the repo is added, and store the sha. Never load `main` live.

### M3. Catalog additions

- **Add:** `onnx-community/LFM3-1.7B-ONNX` at q4f16. It's sharded external data (`model_q4f16.onnx` + one `onnx_data` shard of about 1.09 GB), so the single-file cap from #154 doesn't apply. License is "other" (LFM Open License), shown at add time.
- **Not added:** EmbeddingGemma 2. The browser-vs-Ollama embedding decision (the September sweep's D5) is still open, so it isn't a chat model here.

### M4. Model cache (`src/dashboard/ui/src/hybrid/model-cache.ts`, pure, injected deps)

Replaces the default store via Transformers.js `env.useCustomCache` + `env.customCache` (a `match`/`put` object).

**Read order:**
1. Cross-Origin Storage, when enabled and `navigator.crossOriginStorage` exists.
2. Cache API (`transformers-cache`, the existing name, so current caches keep working).
3. Network (Transformers.js does the fetch).

**COS keying:**
- By sha256 from the repo manifest. The manifest is the Hub tree for `(repo, revision)`; LFS entries carry `lfs.oid` = sha256.
- Only LFS files (weights, external-data shards) go to COS. Small non-LFS files (config, tokenizer, generation config) stay in the Cache API.
- COS is **never** used for user data (chat-workspace D12).

**COS API surface:**
- Call `getFileHandle(hash, opts)` (current spec name). Fall back to `requestFileHandle` (older polyfills, and what Transformers.js 4.3.2's built-in class calls).
- Hash descriptor is `{ algorithm: 'SHA-256', value: <64 lowercase hex> }`.

**Write scope:**
- Writes use `origins: '*'`. Weights are public Hub files.
- Under the spec's availability gating, other sites only see the entry when the hash is on the Public Hash List. Same-site origins (every `localhost` port) see it by default. So Wilson's own ports share a copy even with no PHL entry.

**Writes and failures:**
- If a COS write fails, the file goes to the Cache API. A COS read failure counts as a miss, never an error.

**Persistence:**
- `navigator.storage.persist()` is requested once per load. The result is reported, never required.

**Inspection:**
- `stats()` lists cached files grouped by repo and revision, with bytes, and says which store holds each one.
- `clear({ repo, revision? })` deletes from the Cache API. COS entries can't be deleted by the page (spec), so the UI says so.

**Flag:**
- `crossOriginStorage` in `GET /api/config/local-chat` (`cache.crossOriginStorage`).
- Source is setting `modelCache.crossOriginStorage` (default **false**), or env `WILSON_MODEL_COS=1` for local testing.

### M5. User choice (any Hub repo, plus the vetted catalog)

**Server API (admin-only writes, canWrite rules as for `/api/models`):**

| Route | Behaviour |
|---|---|
| `GET /api/models/browser` | Current browser chat model (repo, revision, dtype, source: `catalog` / `custom` / `fastModel`), the catalog with sizes, the saved choice (v1 keeps one; a list of earlier custom picks is a follow-up), and the cache flag. |
| `POST /api/models/browser/validate` `{ repo, revision? }` | Hub checks, listed below. Never saves. |
| `POST /api/models/browser` `{ repo, revision, dtype }` | Re-validates and saves setting `browserChatModel`. A catalog id is accepted by id. |
| `DELETE /api/models/browser` | Reset to the provider `fastModel`. |
| `GET /api/models/browser/updates` | For each catalog or custom model in use, compares the pinned revision with Hub `main`. Returns `{ repo, pinned, latest, changedFiles? }`. Updating is an explicit `POST` with the new revision, which clears the browser's capability verdict and bench results for that model. |

**`validate` checks, against the Hub API:**
- The repo exists and is public. Gated or private repos are refused in v1.
- `pipeline_tag` is `text-generation`.
- It has ONNX weights and a dtype resolves for WebGPU (the shared `resolveTransformersDtype`).
- A single-file ONNX is ≤ `WEBGPU_SINGLE_FILE_ONNX_MAX_BYTES`.
- `config.json` `model_type` is one Transformers.js 4.3.2 supports. The list is generated from the installed package at build time, with a test.
- It returns total download bytes for the chosen dtype, the license, the resolved revision sha and warnings.

`getLocalChatModelConfig()` resolves in this order: setting `browserChatModel`, then the provider `fastModel`, then disabled. `/api/config/local-chat` gains `revision` and `cache`.

**UI:** Settings → Models, a "Browser model" card.
- Pick a catalog model, or paste a Hub repo and run validation.
- Shows size, license, cache status (from `stats()`), the last benchmark, "Check for updates", "Clear cached files" and the COS toggle (admin).
- No Demo tab (standing rule).

### M6. Benchmark (worker message `bench`)

**Run:**
- A fixed prompt, about 256 tokens of synthetic ledger rows. No user data.
- Greedy, `max_new_tokens: 128`.
- The first token and decode timing come from a `TextStreamer` callback.

**Result:** `{ loadMs, cached, firstTokenMs, decodeTokPerSec, promptTokens, newTokens, adapter: { vendor, architecture, shaderF16 }, tfjsVersion, repo, revision, dtype, at }`.

**Storage:** in the browser (`localStorage`, key `wilson-bench:v1:<repo>@<revision>:<dtype>`). There is no server table: v34 to v39 are reserved for open-jev and v40 for the workspace.

**Triggers:** it runs on demand from the card. An automatic "benchmark after download" opt-in is deferred to a follow-up. Updates need no cleanup: bench entries and capability verdicts are keyed by revision, so a new revision starts fresh.

## Out of scope (fast follow, `specs/webgpu-kernels-followup.md`)

- **`@huggingface/kernels`** and the Fleet benchmark. The bench result shape above is the comparison baseline.
- **Model-specific kernels** in the style of Xenova's LFM3 runtime. Not vendored: no source or license (chat-workspace D13).

## Gates

- `bun test` 0 new failures against origin/main. Baseline: 6851 pass / 0 fail with UI deps installed.
- `bun run typecheck` clean.
- `build:hybrid` passes its own checks.
- New pure modules have unit tests with fakes:
  - model-cache: COS present / absent / old-name / write-fail, and the Cache API fallback.
  - the validate rules, using recorded Hub fixtures.
  - revision pins.
  - bench result shape.
- A live check in Chrome on this Mac (localhost dashboard): load a catalog model cold, then warm. `stats()` shows it, `persist()` is reported, and the bench numbers render.
- COS live check on tomayac's Chromium 159 build (`about://flags#cross-origin-storage`): two localhost ports share one download.
