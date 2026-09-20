# Design: Encryption Pivot, Local Memory, and the Local-AI Platform Tracks

**Status:** Draft v2 — pending review. Decisions D1–D6 below are recommendations, not yet confirmed.
**Supersedes:** the approach (not the goals) of `2026-04-12-001-feat-sqlcipher-encryption-plan.md`.

**Revision 2026-09-12:** the Bun-pin rationale below is obsolete — Bun is now `1.4.2` (`.bun-version`, both CI workflows) and the two issues that justified staying on 1.2.x are closed: oven-sh/bun#30431 (onnxruntime-node crash under `bun test`, fixed by upstream #29981 + #30291) and oven-sh/bun#19322 (Dawn/JSCallback FFI leak in `bun-webgpu`). `bun-webgpu` itself has been removed from the tree. `checkWebGpuAvailable()` now verifies the WebGPU execution provider end-to-end (EP resolution + ORT capability listing + a real inference run) instead of relying on it; server-side WebGPU under Bun is measured working on macOS arm64. Track B's D5 default now conflicts with the Ollama-primary embedding plan — flagged open below. "Runtime constraints" and Track D are rewritten accordingly; other tracks are unchanged. See openaccountant/wilson#36, #37, #38, #39, #41.

## Vision

Wilson's differentiator: **your financial data and the models that read it never leave your machine.** Everything below serves that story — encrypted-at-rest SQLite, local embeddings, small local models on WebGPU, and narrowly-scoped micro-agents ("imps") that are secure by construction. Wilson's moat is its tool surface + local data, not its chat loop; MCP exposes that surface to external agent platforms (OpenWork-style).

## Runtime constraints (govern everything)

**Bun is 1.4.2; both pin blockers are closed.** (openaccountant/wilson#36)
- oven-sh/bun#30431 (onnxruntime-node crash under `bun test`) was fixed upstream by oven-sh/bun#29981 + #30291 on 2026-07-24. oven-sh/bun#19322 (the Dawn/JSCallback FFI leak underlying `bun-webgpu`) was independently verified fixed on 2026-07-25.
- Verified on this branch: the full test suite passes identically on 1.2.22 and 1.4.2, apart from three pre-existing, unrelated date-sensitive failures (issue #23).
- Enforce: `.bun-version` and both CI workflows pin `1.4.2`.

**transformers.js v3 → v4 upgrade is done; `bun-webgpu` is removed.** (openaccountant/wilson#37, #38)
- v4.0.1 (Feb 2026) rewrote WebGPU in C++ on ONNX Runtime's native WebGPU EP; runs in Node/Bun/Deno; adds GraniteMoeHybrid/Mamba/MoE architectures and ~4x faster BERT-family embeddings ([v4 blog](https://huggingface.co/blog/transformersjs-v4)).
- `bun-webgpu` has been removed outright (#38) — its only purpose was standing in for the EP that v4 now bundles, and the Dawn FFI leak made it unfit for a long-running process even before the fix landed.
- `checkWebGpuAvailable()` (`src/model/providers/transformers.ts`) no longer trusts static capability lists. It (1) confirms transformers.js 4.0.1 resolves the `webgpu` device to the `['webgpu']` execution provider, (2) confirms the installed onnxruntime-node (1.24.3) actually lists `webgpu` among its supported backends, and (3) builds and runs a 110-byte embedded MatMul ONNX model on the WebGPU EP end-to-end — because `deviceToExecutionProviders`/`listSupportedBackends` are static lists, not hardware checks, and a stale `node_modules` tree previously passed both while still throwing `Unsupported device` at inference time (#37). The full probe runs once per process (~186ms) and is cached; it never throws, only resolves `false`.
- Server-side WebGPU under Bun, once assumed unproven (ORT#26216), is now measured working: transformers.js 4.0.1 + onnxruntime-node 1.24.3's WebGPU EP sustained ~105 tok/s on `onnx-community/Qwen3-0.6B-ONNX` q4 over 14 iterations with a decaying RSS delta, macOS arm64 (research spike 2026-09-07, company monorepo `docs/research/webgpu-kernels/2026-09-07-webgpu-kernels-synthesis.md`). This supersedes ORT#26216's premise for macOS arm64 specifically — Linux x64 and Windows remain unverified.
- Regression coverage: `src/__tests__/transformers-webgpu-ep.test.ts` and `src/__tests__/webgpu-model-path.test.ts` (#39) — EP-resolution unit tests, an assertion that the capability probe never throws, and a `WILSON_GPU_TESTS=1`-gated smoke test plus RSS soak.

**Cleanup:** remove uncommitted `@journeyapps/sqlcipher` + `better-sqlite3-multiple-ciphers` deps and `trustedDependencies` from `package.json` (NAPI route dead at every Bun version — Node-ABI prebuilts).

## Model strategy (different models for different jobs)

| Job | Model | Why |
|---|---|---|
| Agent loop workhorse (Ollama) | `qwen3:4b` (low-RAM: `qwen3:0.6b`) | Ties #1 on local tool-calling bench (0.880); current default `qwen3:8b` stays available |
| Imp/daemon default | `qwen3:0.6b` or `qwen3:4b` per imp | Narrow prompt + small model; bench shows architecture beats size |
| Security-tier option | `granite4:micro-h` (3B hybrid) | Apache 2.0, cryptographically signed checkpoints, ISO 42001 — the governance narrative; accept mid-pack tool-calling (0.670) |
| Browser/WebGPU showcase | Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`, **q4 not q4f16**) | Official transformers.js WebGPU support, Apache 2.0, native function calling; q4f16 hits the Gemma fp16 overflow bug ([ORT#26732](https://github.com/microsoft/onnxruntime/issues/26732)) |
| Browser fallback/first demo | Llama-3.2-1B or Qwen3-0.6B ONNX q4 | Most proven on transformers.js WebGPU |
| Embeddings | `granite-embedding-small-english-r2` (47M/384-dim, signed) primary; `nomic-embed-text` (768-dim, needs `search_document:`/`search_query:` prefixes) alternative | Granite aligns with security story and is smaller; both local |
| Guardrail (Track E) | Granite Guardian (or ShieldGemma 2B lighter) | Screens prompt-injection + risky tool calls before they touch the DB |

Gemma 4 caveat: native function calling is new and unbenchmarked; Gemma has historically been weak at tool calling — showcase model, not loop workhorse, until proven.

## Decisions (defaults pending user confirmation)

| # | Decision | Default | Alternative |
|---|----------|---------|-------------|
| D1 | Track order | A → B → C(MCP) → D(WebGPU) → E(imps); the v4-upgrade spike (D/E prereq, improves B) is now done (#36, #37) | Reorder per showcase deadlines |
| D2 | Linux encryption | Defer; macOS-first with documented warning | bun:ffi binding to libsqlcipher.so |
| D3 | Dylib distribution v1 | Require `brew install sqlcipher`, clear error | Bundle prebuilt dylibs day one |
| D4 | Default loop model | Switch default `qwen3:8b` → `qwen3:4b` | Keep 8b default, 4b for imps only |
| D5 | Embedding model | **OPEN — blocked on decision.** `granite-embedding-small-english-r2` is not available on Ollama (only r1 `granite-embedding:30m`/`:278m`), so it's incompatible with "Ollama primary via `/v1/embeddings`" as written in Track B. Option A: move D5 to `granite-embedding:30m` on Ollama (server-side backfill, no client download). Option B: keep r2 and make transformers.js the mandatory local embedder (~99.5MB fp16 download) | nomic-embed-text |
| D6 | WebGPU showcase surface | Dashboard in-browser stays primary; server-side Bun WebGPU is no longer just a gated experiment — measured working on macOS arm64 (~105 tok/s, Qwen3-0.6B q4, 2026-09-07 spike) | Server-side first |

## Track A — SQLCipher via `Database.setCustomSQLite` (macOS)

Keep `bun:sqlite` and `src/db/compat-sqlite.ts` API unchanged; swap the underlying C library at startup:

```
if darwin && dylib exists:
  Database.setCustomSQLite('/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib')
open Database(path)
PRAGMA key = '<hex key>'        -- MUST be first statement after open
PRAGMA cipher_compatibility = 4 -- pin format
... existing WAL/foreign_keys pragmas, migrations
```

SQLCipher exports the identical `sqlite3_*` ABI; `setCustomSQLite` dlopens and binds it; `PRAGMA key` is handled inside the dylib. Mechanism proven in production Bun projects (tobi/qmd, sqlite-vec examples); the SQLCipher-specific combo is publicly unverified → spike gate.

**Sharp edges:** invalid dylib path segfaults Bun ([#18811](https://github.com/oven-sh/bun/issues/18811)) — `existsSync()` mandatory, call once before any `Database`; `PRAGMA key` first-statement rule; pin `cipher_compatibility`. Homebrew `sqlcipher` 4.16.0 builds correctly (`SQLITE_HAS_CODEC`, `--dll-basename=libsqlcipher`) at `/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib` (arm64) / `/usr/local/opt/sqlcipher/lib/` (x64).

**Carries over unchanged from old plan:** keychain key management (random 256-bit key, account `db-encryption-{profileName}`, `src/utils/keychain.ts`), header-sniff detection + `sqlcipher_export()` migration with backup-then-rename, `initDatabase()` wiring, per-profile db-manager keys. `:memory:` needs no key → test suite unaffected. Simpler than old plan: no compat-layer rewrite; constructor gains optional `{ key }`.

**Behavior matrix:** macOS+dylib → encrypted (transparent). macOS w/o dylib → clear `brew install sqlcipher` error; existing unencrypted DB keeps working. Linux → unencrypted, documented warning (D2). `:memory:` → unchanged.

**Units:** (1) spike ~half day: brew dylib + setCustomSQLite + PRAGMA key round-trip, wrong-key failure, header check, WAL, sqlcipher_export; (2) dylib resolution module (`src/db/sqlcipher-dylib.ts`: env override → brew paths, `encryptionAvailable()`); (3) key management; (4) initDatabase + `{ key }`; (5) encrypt-migration; (6) db-manager verify; (7) tests + macOS CI job with brew sqlcipher.

**Risks:** spike fails → fallback: SQLite3MultipleCiphers built as libsqlite3-replacement dylib (same mechanism, reads SQLCipher format; NOT runtime-loadable — verified); then bun:ffi; then napi-rs/libsql spike (N-API-stable bindings generally load under Bun, unlike better-sqlite3's raw-ABI addon). User uninstalls dylib post-encryption → startup detects + actionable error, data intact.

## Track B — Local semantic memory (embeddings)

Wilson already records everything (`llm_interactions`, `llm_tool_results`, `chat_sessions`, `chat_history`); only retrieval is missing. Tapes itself is not embeddable (three-service proxy, Postgres+pgvector-only since v0.5).

- **Embed:** Ollama via existing AI SDK `createOpenAI` provider (`/v1/embeddings`, `embedMany`), batch ≤16 ([ollama#6262](https://github.com/ollama/ollama/issues/6262)). Model per D5. Fallback: in-process transformers.js feature-extraction (WASM for single queries; WebGPU only for bulk backfill — WASM matches/beats WebGPU on single short strings).
- **Store:** migration 22, `embeddings` table: `id, source_type ('chat'|'transaction'|'memory'), source_id, model, dim, vec BLOB (Float32Array, L2-normalized at write), created_at, UNIQUE(source_type, source_id, model)`. Lives in profile DB → encrypted by Track A on macOS.
- **Search:** SQL prefilter → dot-product top-k in TS. Instant ≤100k vectors; sqlite-vec deferred (forces Homebrew SQLite on macOS users; still brute-force internally).
- **Consumers:** `search_memory` agent tool; semantic transaction search ("find charges like X"); replace LLM call in `InMemoryChatHistory.selectRelevantMessages()` with embedding retrieval (flag-guarded initially). These tools are also prime MCP surface (Track C).
- **Tool RAG (last unit, flag-guarded):** embed the ~40 tool descriptions (`source_type='tool'`); per query, inject only the top 8–10 relevant tool definitions into the main loop instead of all 40 (~6–12k prompt tokens today), with a one-line-per-tool index as retrieval-miss fallback. Complements Track E's scoping: imps pre-commit to an allowlist; tool RAG covers the open-ended main loop. See wilson#14 comments.

**Units:** (1) `embed()` abstraction (`src/utils/embeddings.ts`: provider detect, prefixes if nomic, batching, normalization, fallback); (2) migration + queries; (3) indexer: embed-on-write + `wilson memory index` backfill (batched, resumable — first imp candidate); (4) cosine search + tools; (5) relevance-selection swap; (6) tests w/ fake embedder + Ollama-gated integration.

**Risks:** Ollama absent → transformers.js fallback, degrade never error. Model switch → UNIQUE constraint + per-model re-index. Backfill cost → batched/resumable/progress.

## Track C — MCP server (OpenWork-style platform integration)

Thin stdio MCP adapter over the existing tool registry (`src/agent/init-tools.ts` already centralizes ~40 DB-wired tools). Wilson's moat exposed to external agent platforms: the tools + local data, with Wilson's own loop as just one consumer.

- Keep tool definitions transport-agnostic (they nearly are).
- **Consent model is the design center:** external agents calling into financial data ⇒ per-profile scoping, explicit allowlist of exposed tools (NOT all 40 by default; start read-only), local stdio only.
- Days of effort; after B so `search_memory`/semantic search ship as part of the MCP surface.

## Track D — WebGPU showcase

Story: "the model reads your finances on your GPU, in your browser — nothing leaves the machine."

- **Primary surface: dashboard in-browser inference** (mature path; WebGPU ~83% of browsers). Ladder: Llama-3.2-1B/Qwen3-0.6B q4 first (proven) → Gemma 4 E2B q4 as the wow model (multimodal, function calling). Use cases: NL transaction Q&A, categorization, monthly-summary narration — client-side.
- **First-load UX is mandatory:** 300MB–2GB download + 3–10s shader compile → progress UI, Cache API with versioned keys, WASM fallback behind capability check. Safari per-buffer limits → default ≤3B q4.
- **Server-side Bun WebGPU (v4 native EP): now a measured yes, not just a gated experiment.** The premise behind ORT#26216 — WebGPU EP maturity on macOS under Bun is unproven — is superseded for macOS arm64: a 2026-09-07 spike measured ~105 tok/s on `onnx-community/Qwen3-0.6B-ONNX` q4 with a decaying RSS delta over 14 iterations (transformers.js 4.0.1 + onnxruntime-node 1.24.3). Linux x64 and Windows are still unverified, so the capability probe (`checkWebGpuAvailable()`) and WASM fallback stay in place regardless of platform. `bun-webgpu` is gone (#38); it is no longer a fallback option, gated or otherwise. Full research and extension proposals: company monorepo `docs/research/webgpu-kernels/2026-09-07-webgpu-kernels-synthesis.md` and `2026-09-07-webgpu-extension-proposals.md`.
- **Granite 4.0 Micro in-browser** (needs v4's GraniteMoeHybrid): stretch demo tying WebGPU + security narrative together.
- **Note on `@huggingface/kernels`:** Hugging Face's `@huggingface/kernels` package (0.0.1-preview.1, 2026-09-01, 207 WebGPU kernels) is browser-only and not wired into transformers.js or ONNX Runtime Web today. A monthly watch workflow (`.github/workflows/kernels-watch.yml`, openaccountant/wilson#41) tracks whether/when it gets upstreamed as a possible future accelerator for this track's existing dependency chain — no integration work is planned against it now.

**Spike (done, shared prereq):** `@huggingface/transformers` upgraded ^3.8.1 → 4.0.1 under Bun 1.4.2 (openaccountant/wilson#36, #37); existing `transformers:` provider tests pass; `device:'webgpu'` verified end-to-end via `checkWebGpuAvailable()`; no regression in the local ONNX text-gen path.

## Track E — Imps: scoped micro-agents (headless harness)

Adopt the concepts, not the dependencies (references: [claude-imps](https://github.com/johnlindquist/claude-imps), [loopcraft/pi](https://github.com/joelhooks/aie-loopcraft-workshop-2026)). Pi's lesson: keep Wilson's core loop minimal; profiles/sandboxing/orchestration are a thin layer over it, not a rewrite.

**Imp = named profile:** `{ small local model, allowlist of N≪40 tools, sandbox tier, structured prompt }` running through the existing headless mode.

**Naming:** "imp" stays as the internal architecture/config term. User-facing brand direction: **clerks** in **Wilson's back office** (Forensic Noir-aligned roles — Filing Clerk = indexer, Night Auditor = vigilance, Bookkeeper = categorize, Reconciler = close, Courier = sync). Roles map 1:1 to sandbox tiers ("the Bookkeeper drafts entries; only you post them") and to marketplace framing ("hire staff" rather than "unlock features"). Monetization split: Polar license gates premium clerks (existing paid-feature pattern), x402 gates clerk *definition packs* via the marketplace content API, per-call x402 reserved for future hosted surfaces only — never meter local execution.

- **Sandbox tiers (financial-data-specific):** `read-only` (DB reads only) → `write-gated` (mutations queue for approval) → `full` (never default). Default read-only.
- **Structured prompt template** (from imps): Mission / tool-output trust boundary (tool output = untrusted input — prompt-injection hygiene) / operating rules / worked examples / error recovery / output style.
- **stdio contract:** answer → stdout (pipe-safe), reasoning → stderr.
- **First imps:** `wilson-indexer` (Track B backfill/index-on-write; read DB + write only embeddings table), `wilson-vigilance` (anomaly watcher over new transactions, read-only, emits alerts), `wilson-categorize` (write-gated).
- **Bounded autonomy (loopcraft):** loops self-stop, stop for approval on mutations, write receipts; `wilson status` surface for loop state.
- **Optional guardrail:** Granite Guardian/ShieldGemma screening tool calls pre-execution.
- **Later (highest-novelty steal):** eval-gated prompt evolution — failed sessions become suggestions that only ship behind a passing eval in the existing Bun test harness.

## Out of scope

- Linux/Windows encryption (bun:ffi or napi-rs/libsql if Plaid requires; D2)
- Bundled SQLCipher platform packages (follow-up to D3)
- sqlite-vec (only if >100k vectors); Rust rewrite (rejected — napi-rs/libsql kept as fallback card)
- Tapes checkpoints/branching/replay; session→skill generation
- Desktop (Tauri/Electron — each dissolves encryption differently; revisit if desktop committed within a quarter, affects D3), mobile (blocked on sync architecture), marketing-site WASM demo tier
- Warm-pool/prewarmed imp processes; imp evolution system (both post-MVP of Track E)
- ~~Bun 1.3 migration (blocked on oven-sh/bun#30431)~~ — done; Bun is 1.4.2 (see Revision note)

## Sources

Bun/runtime: https://github.com/oven-sh/bun/issues/30431 · https://github.com/oven-sh/bun/issues/26081 · https://bun.com/docs/runtime/sqlite · https://github.com/oven-sh/bun/issues/18811 · https://github.com/oven-sh/bun/issues/11397 · https://github.com/oven-sh/bun/issues/16050 · https://github.com/oven-sh/bun/issues/19322
Encryption: https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/s/sqlcipher.rb · https://utelle.github.io/SQLite3MultipleCiphers/docs/installation/install_overview/ · https://www.zetetic.net/sqlcipher/sqlcipher-api/
Embeddings/search: https://www.morphllm.com/ollama-embedding-models · https://github.com/ollama/ollama/issues/6262 · https://ai-sdk.dev/docs/ai-sdk-core/embeddings · https://alexgarcia.xyz/sqlite-vec/js.html · https://github.com/ibm-granite/granite-embedding-models/ · https://huggingface.co/posts/Xenova/906785325455792
Models: https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html · https://huggingface.co/blog/gemma4 · https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX · https://ollama.com/library/granite4 · https://www.ibm.com/new/announcements/ibm-granite-iso-42001 · https://mikeveerman.be/blog/github-2026-02-06-tool-calling-benchmark/ · https://gorilla.cs.berkeley.edu/leaderboard.html · https://arxiv.org/html/2412.07724v1
WebGPU: https://huggingface.co/blog/transformersjs-v4 · https://github.com/microsoft/onnxruntime/issues/26732 · https://github.com/microsoft/onnxruntime/issues/26216 · https://github.com/kommander/bun-webgpu · https://tianpan.co/blog/2026-04-17-browser-native-llm-inference-webgpu
Harness patterns: https://github.com/johnlindquist/claude-imps · https://github.com/joelhooks/aie-loopcraft-workshop-2026 · https://github.com/earendil-works/pi
Other: https://tapes.dev
