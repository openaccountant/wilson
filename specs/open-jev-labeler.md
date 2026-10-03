# B1: open-jev as a browser-side categorization pre-labeler for the Review tab

Status: implementation spec, **revision 2** (adversarial critic pass, 2026-10-02; every change is listed in §18 "Critic revisions"). **Write no code until Jd signs off on the Open Questions (§17).**

- **Branch.** `feat/open-jev-annotator`, from `release/0.10.0` @ `bd83e8e`. The spike is `d62bcdf`.
- **Paths.** All paths are relative to the worktree root unless absolute.
- **Read-only inputs:**
  - Spike: `docs/spikes/2026-10-02-open-jev-webgpu.md` and its `results/*.json`.
  - Label policy: `browser-finetune/docs/2026-09-22-classifier-label-policy.md` (sibling directory, relative to the monorepo root).
  - Applicability: `.../browser-finetune/docs/2026-09-22-wilson-applicability.md`.
  - Label extractor: `.../browser-finetune/scripts/extract_wilson_labels.py`.
  - Judge spec: `.claude/worktrees/webmcp-security-judge/specs/webmcp-security-judge.md`, the P4a section. This is a separate session; we never edit it.

**Out of scope:**
- B2, open-jev as a trace judge. §12 defines only the seam B2 will plug into.
- Tool routing. The spike says no-go (spike §1).
- Any fine-tune of open-jev. Applicability doc line 110 says not to.
- A ModernBERT head. That is a separate project (spike §7.5).

---

## 0. Approved policy and where this spec implements it

| Approved policy (binding) | Where |
|---|---|
| open-jev labels are **weak**. They are stored as proposals with provenance: model id, dtype, calibration temperature, margin, `label_set_version` | B1-a: browser-local, with the full provenance (§8.1). B1-b: server rows (v34, §8.2) |
| **Never auto-accepted** | No code path writes `transactions.category` without a trusted human click (§9, §10) |
| High-margin proposals pre-fill the Review tab for one-click accept. Low-margin proposals are queued for human attention first. Follows the three-stage margin router | §6 (lanes). B1-a pre-fills only when the proposal agrees with the stored suggestion. See §2 for why, and OQ1. **One-click means one row per click.** Bulk (multi-row) confirm is not in the approved policy; it is removed from B1-a and parked behind OQ9 (§18 C4) |
| Training export excludes labels a human has not verified, by default. This mirrors the P4a judge policy (judge spec `:746-747`, `:1021`). Opt-in is per export only | §11. B1-a: the existing extractor already satisfies it (verified-only by default, `extract_wilson_labels.py:353`, `--include-unverified` per run `:480`), and open-jev output never reaches `transactions.category` without a human click. B1-b: needs the extractor to learn the provenance columns before B1-b's accept UI is enabled (§11, §18 C9) |
| Runs in a dashboard Web Worker on WebGPU, with the wasm fallback per the spike | §4.3. The spike found **no usable small wasm path**: q4 fails to load and fp32 is 1.75 GB (spike §4). The fallback is therefore "feature unavailable" by default (OQ6) |
| Calibrated DeBERTa open-jev, not kev | §4.1. Repo, dtype and temperature are pinned. kev is rejected: 20 of 25 predictions at confidence ≥ 0.9 were wrong (spike §4) |
| Prefer **zero** new migrations | B1-a needs **zero**. B1-b needs **one ALTER-only migration (v34)** with a sequencing note (§8.2, OQ2) |

---

## 1. Verified grounding

| Fact | Citation |
|---|---|
| Highest migration is v27. Migrations must be contiguous, and the test asserts `version === MIGRATIONS.length` | `src/db/migrations.ts:80`; `src/__tests__/migrations.test.ts:35` |
| `categorization_reviews` has no source or model column. `status` is free TEXT with no CHECK. A partial unique index allows one `pending` row per transaction | `src/db/schema.ts:419-438` (DDL `:419-433`, v24 backfill `:432-438`) |
| A pending row is inserted with `INSERT OR IGNORE` | `src/db/categorization-review-queries.ts:22-34` |
| The queue read model filters `status='pending'` | `categorization-review-queries.ts:93-106` (`:101`) |
| Confirm keeps the model confidence. Correct NULLs it. Both set `user_verified=1`. Neither bumps `revision` | `categorization-review-queries.ts:125-151` (`:137-146`) |
| Transaction writes elsewhere bump `revision` | `src/db/queries.ts:722` |
| The categorize tool applies the suggestion at or above the threshold, and queues it below the threshold | `src/tools/categorize/categorize.ts:166`, `:180`. Category validation is at `:160`; the DB-or-static category source is at `:79-82` |
| Threshold default is 0.7, set per profile | `src/utils/config.ts:103-111` |
| Review routes: GET is open to any authenticated user; POST confirm/correct require admin via `canWrite` | `src/dashboard/server.ts:484-502`, `:142`; handlers `src/dashboard/api.ts:239-266`, category validation `:262` |
| `ReviewTab`: threshold 0.7, `ConfidenceBadge`, the Confirm/Correct post, the queue fetch, the admin gate | `src/dashboard/ui/src/tabs/ReviewTab.tsx:8`, `:15-29`, `:51-65`, `:141`, `:156`; table rows at `:251-260` |
| `ReviewQueueItem` already carries description, merchant, amount and date, so B1-a needs no new read API | `src/dashboard/ui/src/types.ts:139-150` |
| Only the hybrid build may contain transformers.js or onnxruntime-web. It is served at `/assets/*`. ORT wasm is same-origin under `/assets/ort/` | `src/dashboard/ui/vite.hybrid.config.ts:6-11`; `server.ts:96-136`; `scripts/copy-ort-web-assets.ts:1-20`; `src/dashboard/ui/src/hybrid/client.ts:262` |
| Root `tsc` excludes the UI. The UI typechecks in `npm run build` (`tsc -b`) | `tsconfig.json` `exclude`; `src/dashboard/ui/package.json` `scripts.build` |
| Categories seed: 18 rows with `sort_order` in `CATEGORIES` order, plus a slug column | `schema.ts:293-316`; `src/db/queries.ts:788-798`, `:818-820`; `resolveCategory` `:904-907` |
| No transaction-label export exists. `export.ts` exports only LLM interactions, with `callTypes` defaulting to `['agent']` | `src/training/export.ts:53-56`; routes `server.ts:879-907` (no `canWrite` gate) |
| The extractor derives confirm/correct from the latest `status='resolved'` review row, and computes `label_set_version = cat-<n>-<sha256(sorted slugs joined by \n)[:12]>` | `extract_wilson_labels.py:345-375`, `:378-386`, `:445-452` |
| Policy §4 defines the three-stage router: head, then open-jev on low margin only, then the human queue. It says "Do not" put the escape hatch in front of the head | `classifier-label-policy.md:202-234` (`:208-224`, `:225-227`) |
| `open-jev` 0.1.2 API: `OpenJev.load/info/decide/countTokens/dispose`. `temperature` defaults to 1.05. `maxLength` is 512 and `maxStateTokens` is 256 for open-jev. Truncation defaults to `"cut"`. Peer dependency is `@huggingface/transformers >=4.3.0` | `node_modules/open-jev/dist/index.d.ts:15-63`, `types.d.ts:15-75`, `package.json` `peerDependencies` (scratch install) |
| The spike template is `description: X \| amount: -12.30 \| date: YYYY-MM-DD`. The question is "Which spending category does this transaction belong to?". Options are bare labels | `docs/spikes/2026-10-02-open-jev-webgpu/harness/web/main.js` (`fmtTx`, `WL.categorize`) |
| WebMCP grants change event; P4a's canonical `agentPresent(db, userKey)` | `src/dashboard/webmcp-session.ts:15`; judge spec `:818-822`, `:915` |
| *(critic)* Every non-MCP route answers with `Access-Control-Allow-Origin: *`, and `Bun.serve` has no `hostname`, so it binds all interfaces. With auth off (the default; `isAuthEnabled` is false until setup, `src/dashboard/auth.ts:14-19`), any web page the user visits can read any `/api/*` GET and send JSON POSTs after a preflight that the server answers with 204 | `server.ts:205-209` (headers), `:216-218` (OPTIONS → 204), `:191-192` (`Bun.serve({port, …})`). Judge P0b fixes this globally (origin gate, loopback bind, judge spec `:351-367`), but P0b has not merged |
| *(critic)* Judge P0b will add `src/dashboard/origin-gate.ts` with `corsHeaders(port, origin)` and `requireBrowserProof(req)`. Judge P4a accept routes require browser proof | judge spec `:351`, `:365`, `:904` |
| *(critic)* `OpenJev.info()` makes network calls: `AutoConfig.from_pretrained` (config.json) and `ModelRegistry.get_file_metadata` for every file. Calling it before consent contacts huggingface.co | `open-jev@0.1.2 dist/index.js` (`static async info`; scratch install) |
| *(critic)* `info()` reports `downloadSize` 357,050,727 B. The bytes actually moved were 350,631,305 B from HF | spike §3 (lines 51-53) |
| *(critic)* open-jev passes no `revision`, but transformers.js builds every remote URL from `env.remotePathTemplate` (default `{model}/resolve/{revision}/`). Setting it to `{model}/resolve/<commit-sha>/` pins all files to one commit | `node_modules/@huggingface/transformers/types/env.d.ts:104`; `dist/transformers.web.js:134`, `:7454` |
| *(critic)* The extractor already emits a `source` field, with the values `review_confirm`, `review_correct` and `verified_no_review` | `extract_wilson_labels.py:456-464` |
| *(critic)* `expires_at` is written as ISO-8601 with a `T` (`src/mcp/store.ts:98`) but compared with `datetime('now')` (space separator) in SQL (`:156`, `:280`). Within the same UTC day the string comparison is always true, so expired grants or ops look live | `src/mcp/store.ts:98`, `:156`, `:280` |
| *(critic)* Judge P2 edits `categorization-review-queries.ts` so that resolve bumps `revision`. Judge P3 adds an agent-facing `list_review_queue` tool that reads the review table | judge spec `:608`, `:695` |
| *(critic)* The judge worktree has uncommitted edits to `server.ts` (+39 lines: maintenance timer, an export audit hook on every `GET /api/export/*`, an extra CORS allow-header). Its base is `1bc5ae4`, an ancestor of `bd83e8e`, so the judge spec's `server.ts` line numbers are about 2 lines lower than ours | `git -C .claude/worktrees/webmcp-security-judge diff --stat` (read-only); `git merge-base --is-ancestor 1bc5ae4 bd83e8e` |
| *(critic)* The dashboard serves whichever profile is active on the **server**. `POST /api/profiles/switch` changes it for every open tab. The tab that switched reloads itself; other tabs do not | `server.ts:393-403`; `SettingsTab.tsx:36-42` |
| *(critic)* WebGPU and Web Locks require a secure context. `http://localhost` qualifies; `http://<LAN-IP>:3141` does not | platform rule; relevant because of the all-interfaces bind above |
| *(critic)* In vite dev, `getBaseUrl()` is `http://localhost:3141` while the page is served from `:5173`. A cross-origin `new Worker(url)` throws `SecurityError` (the hybrid chunk avoids this because it uses `import()`, `useHybridChat.ts:27`) | `src/dashboard/ui/src/api.ts:13-16` |
| *(critic)* Dependabot groups minor and patch npm bumps, and they auto-merge on green CI. For a 0.x package like `open-jev`, a minor bump is allowed to break | `docs/dependency-policy.md` "Safe — fast-track" |

---

## 2. Design in one page

Wilson has no ModernBERT head yet. Stage 1 of the policy's router is therefore **the existing categorize path**: rules, then the LLM with its threshold. Its low-confidence tail is **already** the `categorization_reviews` pending queue. B1 places open-jev as **stage 2 on that tail only**, which is what policy §4 prescribes. The human queue is stage 3.

The build ships in three increments. Each one is independently shippable.

| Increment | Schema | What open-jev does | What gets written |
|---|---|---|---|
| **B1-a: second opinion (zero migrations)** | none | Scores every pending review in the browser and records agree, disagree or unsure. It reorders the queue into lanes and pre-fills one-click Confirm (one row per click, **no bulk**) when it agrees with high margin | Nothing new. Writes go through the existing confirm/correct routes, so every stored label is one that exists today (the LLM's suggestion, or the human's pick). The only server additions are read-only config/gold routes plus a settings toggle, all behind the origin gate (§9.0) |
| **B1-b: proposals with provenance (v34)** | v34, ALTER-only | Its own proposal becomes a server row with full provenance. High-margin proposals, including ones that **disagree** with the LLM, are pre-filled for one-click accept | `categorization_reviews` rows with `source='open-jev'`, `status='proposed'`; accept/resolve with `resolved_via` |
| **B1-c: backlog experiment (PARKED, not in the build plan)** | uses v34 | Pre-labels uncategorized rows that never went through the LLM, up to 2,000 per run | Same as B1-b. This puts open-jev in front of stage 1, which contradicts policy §4 (`classifier-label-policy.md:225-227`) and is outside the approved scope. It is kept here only as a design sketch. **No slice builds it unless Jd overrides the policy (OQ3)** |

**Why B1-a is blind on disagreement.** Without a provenance column, nothing durable can show that a human label followed an open-jev hint. So in B1-a the UI shows **that** open-jev disagrees, but **not what it picked**. A human Correct in B1-a therefore stays an independent human label, and a Confirm stays a human-confirmed LLM label. *(Critic correction.)* That keeps the **label values** free of open-jev output. It does **not** make the labels independent of open-jev: the AGREES chip and the QUICK lane still steer which LLM suggestions a human confirms, and how quickly. That influence cannot be recorded in B1-a. B1-a bounds it in two ways. First, every write is still one human click on one row; bulk confirm is removed (§18 C4). Second, B1-a labels are no more contaminated than today's queue, where the LLM's confidence badge already primes the human. B1-b reveals the proposal because it can record that it did. This is a deliberate, partial deferral of "high-margin proposals pre-fill". Pre-fill applies in B1-a only to agreeing rows. See OQ1.

---

## 3. Data flow

```
B1-a (zero migration)
  ReviewTab ──GET /api/reviews──────────────► server (unchanged)
      │      ──GET /api/prelabel/config─────► server: labels, label_set_version, profile, pins
      ▼
  usePrelabel ──Web Lock 'wilson-prelabel'──► new Worker('/assets/prelabel-worker.js', {type:'module'})
      │  init(config) → capability → load(progress) → run(items[]) → result chunks(25) → done
      ▼
  sessionStorage cache (key: profile|label_set_version|modelId|template)  — per-tab only, recomputable
      ▼
  routeLane() → lanes: ATTENTION first, QUICK after → existing POST /api/reviews/:id/confirm|correct

B1-b (+v34)
  worker results ──batch ≤100──► POST /api/prelabel/proposals ──validate──► categorization_reviews
                                     (canWrite, rate-limited, 409 on stale label set)   source='open-jev', status='proposed'
  ReviewTab ──GET /api/prelabel/proposals──► joins proposals onto pending rows (+ orphan proposals in B1-c)
            ──POST /api/prelabel/proposals/:id/accept (no bulk, critic)──► one db.transaction:
                 txn.category, user_verified=1, revision+1; proposal→resolved(+resolved_via); LLM pending row→superseded
  GET /api/export/training/labels ──► human-verified labels by default; opt-ins per export (§11)
```

Transaction text goes only from the local server to the local browser. Model weights come from huggingface.co. The ORT runtime comes same-origin from `/assets/ort/`, never jsDelivr; the spike fetched 5.57 MB from jsDelivr, and B1 must not.

*(Critic.)* "Only to the local browser" holds only if no other origin can read the new routes. Today the server sends `Access-Control-Allow-Origin: *` and binds all interfaces (§1), so every new route that returns transaction text or writes a label goes through the §9.0 origin gate. Requests to huggingface.co carry no transaction data, but they do reveal the user's IP address and the model id. That is why no HF request happens before the consent click (§4.4).

---

## 4. Model and runtime contract

### 4.1 Pins

All pins live in one server constant, `PRELABEL_MODEL` in `src/prelabel/config.ts`. The browser receives them via `/api/prelabel/config` and **echoes** them in provenance.

| Field | Value | Why |
|---|---|---|
| `repo` | `onnx-community/open-jev-deberta-v3-large-ONNX` | Calibrated DeBERTa open-jev (spike §2). The repo id is passed explicitly, not the `open-jev` alias |
| `dtype` | `q4f16` (pinned, never `auto`) | `auto` picks fp16, which is 877 MB (spike §4, §7.4). q4f16 is 350,631,305 B over the network and is numerically faithful: 46 of 49 rows agree with fp32 (spike §3) |
| `device` | `webgpu` | §4.3 |
| `temperature` | `1.05`, passed explicitly to every `decide()` | This is the library default (`types.d.ts:17-20`). Passing it explicitly makes the recorded provenance true by construction rather than inferred |
| `templateVersion` | `prelabel-tmpl-v1` | State is `description: <desc> \| amount: <amount.toFixed(2)> \| date: <YYYY-MM-DD>`. Question is `Which spending category does this transaction belong to?`. Options are bare label names. This is identical to the spike, so the spike's predictions are a regression oracle (§15). Descriptions as options collapsed accuracy to 26.5% (spike §5) and are **forbidden** |
| `modelId` (provenance string) | `onnx-community/open-jev-deberta-v3-large-ONNX:q4f16` (51 characters) | Matches P4a's `judgeModel` pattern `/^[\w.:\/-]{1,64}$/` (judge spec `:883`), so B2 can reuse it verbatim (§12) |
| `revision` *(critic)* | a 40-hex HF commit sha, recorded at S0 time in `PRELABEL_MODEL.revision` | Pins the weights; see below |

The library cannot pin a model `revision`; there is no option in `OpenJevOptions`. A silent upstream weight change on `main` would therefore change predictions under the same `modelId`. *(Critic revision.)* transformers.js builds every remote URL from `env.remotePathTemplate` (`types/env.d.ts:104`; `transformers.web.js:7454`). The worker therefore sets `env.remotePathTemplate = '{model}/resolve/<revision>/'` on the same module instance open-jev imports, before it calls `info()` or `load()`. All five files then come from one immutable commit, and the Cache API keys change when the pin changes. This turns R6 from "detect" into "prevent" without a mirror. `configSha`, the sha256 of the fetched `config.json`, stays in provenance as a cross-check. If it differs from `PRELABEL_MODEL.configSha` (also recorded at S0), the run fails with `failed:model_mismatch`; there is no "model changed" notice to click through. If the pin ever 404s because the upstream repo was deleted or rewritten, the result is `failed:load`, and the feature is unavailable until the pin is updated in code. OQ7 is narrowed to "pin a commit (recommended) or a same-origin mirror".

### 4.2 Labels and `label_set_version`

- **Source.** `getCategories(db)` names in `sort_order` (`queries.ts:818-820`). If the table is empty, fall back to `CATEGORIES`. This is the same two-source rule as `categorize.ts:79-82` and `api.ts:262`. `Other` stays in, because the residual class is required (policy §1).
- **Version.** `label_set_version = cat-<n>-<sha256(sorted(slugs).join('\n'))[:12]>`, the extractor's exact algorithm (`extract_wilson_labels.py:378-386`). JS default sort and Python `sorted` agree for ASCII slugs. Slugs come from `categories.slug`, or `toSlug(name)` (`queries.ts:807-812`) for the static fallback. The v16 seed must yield `cat-18-0f7b02225108`, which I computed with the extractor's algorithm over the slugs at `schema.ts:295-312`. This is a test fixture value.
- **Token guard.** Before each row the worker checks `countTokens(state) + Σ countTokens(label) + question` against `maxLength` 512. If the **options alone** exceed 200 tokens, the whole run refuses with `label_set_too_large`. A user with many child categories hits this; see R7. Rows whose state would be cut are still scored (`truncation:'cut'`) but carry `truncated:true`.

### 4.3 Capability ladder and the wasm fallback

0. *(Critic.)* If `navigator.gpu` is undefined, the verdict is `unavailable:no_webgpu`. This covers non-secure contexts such as a LAN IP over http, browsers without WebGPU in workers, and Firefox on macOS. Check before calling anything, and never throw. If `navigator.locks` is undefined, the tab runs without the lock rather than failing. In vite dev the cross-origin `new Worker` throws `SecurityError`; catch it and report `unavailable:dev_cross_origin`. The feature is verified only on the built dashboard (§15).
1. The worker calls `navigator.gpu.requestAdapter()` itself. If there is no adapter, or it is a fallback adapter, or the vendor/description is SwiftShader, the verdict is `unavailable:no_webgpu`. This is the same rule the spike used (spike §2). *(Critic.)* Read `adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter`. The top-level attribute is deprecated; the spike saw `null` (spike §2, line 20). The spike also saw empty `device`/`description` strings, so the SwiftShader check must look at `vendor` and `architecture` as well. The spike ran on the **main thread**, so WebGPU inside a dedicated worker was never measured (R17).
2. If `!adapter.features.has('shader-f16')`, the verdict is `unavailable:no_shader_f16`. The model's q4f16 path needs it.
3. **wasm fallback: off by default.** The spike's only wasm path that loads is fp32: 1,752,218,930 B, 315 ms/row bare p50 (spike §4). q4 on wasm fails with `GatherBlockQuantized` not implemented. The ladder therefore ends at `unavailable`, and the Review tab behaves exactly as today. An admin-only override setting, `prelabelAllowWasmFp32` (default false), enables `device:'wasm', dtype:'fp32'`. It requires a second consent that shows "1.75 GB, about 10 minutes per 2,000 rows" (OQ6).
4. A load or first-decision failure gives the verdict `failed:<phase>` with detail. Like `hybrid/capability.ts`, only real capability failures persist, in sessionStorage, keyed by `modelId|revision|templateVersion`. Network failures retry. *(Critic.)* Workers have no `sessionStorage`. The worker only reports the verdict, and `usePrelabel` on the main thread persists it.

### 4.4 Download consent and locality

- **Consent.** Nothing downloads without a click. *(Critic revision.)* No request to huggingface.co is made before that click, either. `OpenJev.info()` is **not** a local check: it fetches `config.json` and the metadata of every file (§1). Before consent, the panel therefore shows the server-supplied `approxDownloadBytes` (350,631,305 B, shown as "about 351 MB") and the source host, and needs **Download once**. Only after the click does the worker call `info()`, which reports `downloadSize` 357,050,727 B (spike §3), and then `load()`. After consent, an opt-in flag in `localStorage` (`wilson-prelabel-optin:v1:<revision>`, wrapped in try/catch) lets later visits auto-run. Auto-runs skip `info()` and call `load()` directly. That load still makes about 1 KB of metadata requests to HF (spike §3, line 53: 685 B on a warm load), and the consent copy says so. Because the flag is keyed by `revision`, a new pin asks for consent again.
- **Same-origin ORT.** The worker sets `env.backends.onnx.wasm.wasmPaths = '/assets/ort/'`, `env.allowLocalModels = false` and `env.remotePathTemplate` (§4.1), as `client.ts:262-266` does for the first two. This is on the **same** transformers module instance open-jev imports, because it is a peer dependency and is deduped by the bundler. Slice S0 asserts that the bundle contains one transformers copy.
- **One tab at a time.** `navigator.locks.request('wilson-prelabel', {ifAvailable:true})` makes only one tab load 350 MB onto the GPU. The other tabs show "running in another tab".
- **Idle.** The worker is terminated (and `jev.dispose()` called) after 5 min idle, or when the Review tab unmounts.

---

## 5. Worker protocol (`src/dashboard/ui/src/prelabel/protocol.ts`, import-free)

Messages are versioned (`v:1`). Both sides validate every inbound message with `parseFromWorker` / `parseToWorker`, which return `null` on anything malformed. These are pure functions, tested under bun.

```ts
type PrelabelPins = { repo: string; dtype: 'q4f16' | 'fp32'; device: 'webgpu' | 'wasm'; temperature: number;
                      templateVersion: 'prelabel-tmpl-v1'; modelId: string;
                      revision: string /* 40-hex, critic */; configSha: string /* 64-hex expected, critic */ };
type PrelabelItem = { txnId: number; description: string; amount: number; date: string };

// main → worker
type ToWorker =
  | { v: 1; type: 'init'; pins: PrelabelPins; labels: string[]; labelSetVersion: string; assetBase: string }
  | { v: 1; type: 'probe' }                                   // capability only, no download
  | { v: 1; type: 'info' }                                    // OpenJev.info(): isCached, downloadSize. NETWORK: only after consent (§4.4)
  | { v: 1; type: 'load' }                                    // consent already given by the UI
  | { v: 1; type: 'run'; runId: string; items: PrelabelItem[] }   // ≤ 2,000 items
  | { v: 1; type: 'cancel'; runId: string }
  | { v: 1; type: 'dispose' };

// worker → main
type FromWorker =
  | { v: 1; type: 'capability'; verdict: 'ready' | 'unavailable' | 'failed'; reason: string | null;
      adapter: { vendor: string; architecture: string; shaderF16: boolean; isFallback: boolean } | null }
  | { v: 1; type: 'info'; isCached: boolean; downloadSize: number }
  | { v: 1; type: 'progress'; phase: 'download' | 'session' | 'warmup'; loaded: number; total: number }
  | { v: 1; type: 'loaded'; loadMs: number; fromCache: boolean; firstDecisionMs: number;
      runtime: { transformers: string; ort: string; openJev: '0.1.2'; device: string; dtype: string };
      configSha: string }
  | { v: 1; type: 'results'; runId: string; rows: PrelabelResult[] }    // chunks of 25
  | { v: 1; type: 'done'; runId: string; n: number; skipped: number; cancelled: boolean;
      p50Ms: number; p95Ms: number; wallMs: number }
  | { v: 1; type: 'error'; fatal: boolean; code: 'load' | 'decide' | 'label_set_too_large' | 'locked' | 'model_mismatch'; detail: string };

type PrelabelResult =
  | { txnId: number; ok: true; choice: string; p1: number; p2: number; margin: number;
      top2: [[string, number], [string, number]]; ms: number; stateTokens: number; truncated: boolean }
  | { txnId: number; ok: false; reason: 'decide_error' | 'empty_description' | 'bad_amount' };
```

- **Logic location.** The worker logic lives in `worker-core.ts` as `createPrelabelEngine({loadOpenJev, now})`. It is pure apart from the injected loader, so bun tests drive it with a fake `OpenJev`. `worker.ts` is a 20-line `self.onmessage` shim.
- **Decisions.** Sequential and batch-1: the library queues, and the model hardcodes `[1, seq]` (spike §2).
- **Cancellation.** A cancel is honoured between rows, so the maximum overrun is one decision (about 90 ms).
- **Margin.** `margin = p1 − p2` over the calibrated probabilities (T = 1.05), computed in `core.ts` from `answer.probabilities`. This is the spike's definition (`harness/web/main.js:69`).
- *(Critic.)* **Result acceptance on the main thread.** `parseFromWorker` checks shape only. A pure `acceptResults(run, msg)` in `core.ts` also drops:
  - any `results` or `done` whose `runId` is not the current run;
  - rows whose `txnId` was not in that run's `items`;
  - rows whose `choice` or `top2` labels are not in the run's `labels`;
  - rows whose probabilities are non-finite or outside [0, 1], or where `p2 > p1`.

  It counts every drop. A worker left over from a cancelled run, or a confused one, can therefore never attach scores to rows it was not asked about.
- *(Critic.)* **Profile binding.** A run is bound to the `{profile, labelSetVersion, revision}` that `/api/prelabel/config` returned when the run started. Another tab or the CLI can switch the server's active profile mid-run (§1, `server.ts:393-403`), and transaction ids are per profile. So:
  - before every B1-b POST, and on `visibilitychange`, the client re-reads `/api/prelabel/config`;
  - on any mismatch it cancels the run, discards its results and shows "Profile changed; reload to score this profile";
  - the B1-b server rejects a POST whose declared `profile` is not the active one with **409 `profile_changed`** (§9.2).
- *(Critic.)* **State format.** `date` is `transactions.date.slice(0, 10)`. `amount` must be a finite number, otherwise `ok:false, reason:'bad_amount'`. Add `'bad_amount'` to `PrelabelResult.reason`.

---

## 6. Router and lanes (`core.ts`, pure)

Inputs per pending row:
- the stored suggestion `{category, confidence}` (the LLM's), or none in B1-c;
- the open-jev result;
- `marginCut`, the per-profile setting `prelabelMarginCut`, default **0.3**. The spike measured 18/19 = 95% at 39% coverage, with n=49, and says to re-check it (spike §5). Slice S6 produces the routing table that re-checks it.

| Condition | Lane | Chip (B1-a) | B1-b pre-fill |
|---|---|---|---|
| No result yet, or `ok:false` | ATTENTION | `JEV —` / `JEV SKIPPED` | none |
| `margin < cut` | ATTENTION | `JEV UNSURE · M .08` | none. Low-margin proposals are visible only as a muted hint, never pre-filled |
| `margin ≥ cut` and `choice === suggested` | QUICK | `JEV AGREES · M .42` | **Confirm** pre-filled (one click; the LLM's label, which open-jev agrees with) |
| `margin ≥ cut` and `choice !== suggested` | ATTENTION (sorted first) | `JEV DISAGREES` (category **not shown**, §2) | **Accept open-jev: X** pre-filled, next to the existing Confirm |
| B1-c: no stored suggestion, `margin ≥ cut` | QUICK | n/a | **Accept open-jev: X** |
| B1-c: no stored suggestion, `margin < cut` | ATTENTION | n/a | hint only |

**Ordering.** ATTENTION before QUICK. Inside ATTENTION: DISAGREES, then UNSURE in ascending margin, then not-yet-scored. Inside QUICK: descending margin. The lane header rows show counts. `orderByLane()` is stable and pure. With no results, it returns the server order unchanged, so the tab is identical to today when the feature is off.

---

## 7. Throughput and batching plan (from the spike)

These are the warm, bare-label, q4f16 numbers on the M4 Pro: p50 is 67-86 ms and p95 is 76-89 ms across two runs. Run-to-run noise is about 25%. A cold load is 18-24 s plus 350.6 MB. A warm-cache load is 1.0-1.4 s. The first decision is 194-212 ms (spike §3).

| Workload | Rows | Decision time (p50 range) | With +25% noise | Plus load |
|---|---:|---|---|---|
| Fixture queue (§15) | 49 | 3.3-4.2 s | ≤ 5.3 s | +1.4 s warm / +24 s cold |
| One `/api/reviews` page (default limit 200, `api.ts:241`) | 200 | 13.4-17.2 s | ≤ 21.5 s | +1.4 s warm |
| Measurement set (applicability step 1, `:107`) | 500 | 34-43 s | ≤ 54 s | +1.4 s |
| **Budget run (B1-c cap)** | **2,000** | **2.2-2.9 min** | **≤ 3.6 min** | +1.4 s warm / +24 s cold |
| wasm fp32 override (OQ6) | 2,000 | ~10.5 min (315 ms/row) | ≤ 13 min | 1.75 GB download |

Batching rules:

- **Input order.** Rows are scored in display order (newest first, `categorization-review-queries.ts:102`), so visible rows fill first.
- **Worker to UI.** Results are posted in chunks of **25**, about every 2 s, which keeps React re-renders near 0.5 Hz. The first chunk is posted after **5** rows so the UI shows life within about 1 s of a warm load.
- **Worker to server (B1-b).** The client accumulates results and sends `POST /api/prelabel/proposals` every **100** rows, or at `done`. That is 20 POSTs per 2,000 rows, one `db.transaction` each.
- **Caps.**
  - `run` accepts at most **2,000** items.
  - B1-a scores only what `/api/reviews` returned, at most 200 per page. A "score next 200" button pages through the queue.
  - B1-c fetches candidates in pages of 500, up to 2,000 per run.
  - The daily server cap in B1-b is `prelabelDailyLimit`, 10,000 items per profile, admin-set (§9.2).
- **Cache.** Results are stored in sessionStorage under `wilson-prelabel:v1:<profile>:<labelSetVersion>:<modelId>:<revision>:<templateVersion>`. *(Critic.)* Each entry also stores a 32-bit FNV-1a hash of the exact `formatState` string. A hit counts only when the hash matches, so editing a transaction's description, amount or date invalidates its cached score. Predictions were identical between spike runs, so a revisit re-scores only rows it hasn't seen. The size is about 120 B/row, so 2,000 rows is about 240 KB, under quota. The cache is wrapped in try/catch, and if it is unavailable the rows are simply re-scored.
- **GPU memory.** One session of about 350 MB, held for the whole run. It is disposed on idle or unmount (§4.4).

---

## 8. Storage

### 8.1 B1-a: zero migrations

- No schema, mirror or server write changes. `MIRROR_SCHEMA_VERSION` stays 3 (`src/dashboard/ui/src/store/mirror-schema.ts:38`).
- Proposals and their full provenance live in the worker results and the sessionStorage cache. The provenance is `{modelId, repo, dtype, device, temperature, templateVersion, labelSetVersion, margin, p1, p2, top2, configSha, runtime, runId}`.
- They are deliberately ephemeral. They are recomputable, they never reach the server, and so they never reach an export.
- The only server-side effect is a human pressing the existing Confirm or Correct.

### 8.2 B1-b: v34 `add_prelabel_provenance` (ALTER-only)

Constant `CATEGORIZATION_REVIEW_PROVENANCE_COLUMNS` in `schema.ts`. Never edit `CATEGORIZATION_REVIEWS_TABLE` (convention at `schema.ts:470-477`, judge spec `:8`).

```sql
ALTER TABLE categorization_reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'categorize'; -- 'categorize' | 'open-jev'
ALTER TABLE categorization_reviews ADD COLUMN model TEXT;              -- modelId (§4.1); NULL for legacy rows
ALTER TABLE categorization_reviews ADD COLUMN margin REAL;             -- p1 − p2 (calibrated); NULL for legacy
ALTER TABLE categorization_reviews ADD COLUMN label_set_version TEXT;  -- cat-<n>-<sha12>
ALTER TABLE categorization_reviews ADD COLUMN provenance_json TEXT;    -- {dtype, device, temperature, templateVersion, p2, top2, configSha, runtime, runId}
ALTER TABLE categorization_reviews ADD COLUMN resolved_via TEXT;       -- 'dashboard' | 'dashboard_agent_present' (mirrors P4a created_via)
CREATE UNIQUE INDEX IF NOT EXISTS idx_categorization_reviews_proposed_txn
  ON categorization_reviews(transaction_id, source) WHERE status = 'proposed';
```

**Row semantics:**
- `confidence` (NOT NULL) holds `p1`.
- `status` lifecycle for `source='open-jev'`: `proposed` → `resolved` | `superseded`.
- A resolved LLM `pending` row is set to `superseded` when the human resolves through the open-jev proposal. That keeps the extractor's "latest resolved row" (`extract_wilson_labels.py:346-350`) pointing at the suggestion the human actually saw.
- Status values are validated in code. There is no CHECK, matching the v24 column.
- No triggers. Unlike P4a v33, these rows are **not** export-bearing on their own. The export reads `transactions.user_verified` (§11).
- *(Critic.)* **`created_at` and `too_new`.** The column default is `datetime('now')`, which has second resolution and a space separator (`schema.ts:425`). The insert writes `created_at` explicitly from the injected clock, **in that same `YYYY-MM-DD HH:MM:SS` format**, never ISO with a `T`. Mixing the two formats breaks the string ordering and comparison that `store.ts:156/280` already gets wrong. `too_new` is computed in JS from the injected clock: refuse while `now − created_at < 2 s`. The stored value is truncated to the second, so the effective minimum age is 1 s. This is what makes S10's clock injection actually work.
- *(Critic.)* **Lingering proposals.** A human or agent can resolve the LLM `pending` row through the **existing** route (`resolveCategorizationReview`, `categorization-review-queries.ts:125-151`, or judge P2's `review_action`). That leaves the open-jev row `proposed`. `listOpenPrelabelProposals` therefore marks `superseded`, in the same call, every `proposed` row whose txn is now `user_verified=1`, before it returns. `insertPrelabelProposals` does the same. S9 tests both.
- *(Critic.)* **Every browser-supplied string is validated before storage**, because `provenance_json` sits in a table an agent-facing tool will read (judge P3 `list_review_queue`, judge `:695`):
  - `runId`: a UUID;
  - `configSha`: `/^[0-9a-f]{64}$/` and equal to the pin;
  - each `runtime.*`: `/^[\w.+-]{1,40}$/`;
  - `top2`: exactly 2 entries whose labels resolve against the live list, with `top2[0][0] === category`, `top2[0][1] === p1` and `top2[1][1] === p2`.

  Anything else is a 400. No free text from the browser is stored.

**Existing readers stay correct with no edits:**
- `getPendingReviewQueue`, `countPending…` and the v24 pending index all key on `status='pending'`.
- `source` defaults to `'categorize'`, so the categorize tool (`categorize.ts:180`) is untouched.

**Sequencing vs the judge worktree (v28-33 reserved, judge spec `:8`):**
- v34 is additive on a table P4a never touches, so there is no content conflict. Numbering must stay contiguous (`migrations.test.ts:35`), so v34 can only merge **after** v33 exists on the base.
- Before implementing S8, re-check the highest version on `origin/*`, as the judge spec requires.
- If B1-b must land before judge P4a, the options are: (a) B1-b takes the next free number and the judge branch renumbers its unmerged migrations; or (b) B1-b waits. **Recommendation: (b).** B1-a delivers the throughput win with zero schema, and B1-b waits for judge v33. This is a decision for Jd (OQ2).
- *(Critic.)* Be explicit about the cost of (b). v32 and v33 belong to P4a, which is the **sixth of seven** judge phases (judge spec line 5: P0a → P0b → P1 → P2 → P3 → P4a → P4b). So "wait for v33" means waiting for nearly the whole judge plan. The judge worktree already has uncommitted migration code (`migrations.ts` +2, `schema.ts` +43), so option (a) is not free either. The judge session should record "v34 reserved for B1-b" in its own spec. We do not edit that spec; this is an escalation.

**Files B1-b must edit, which the judge also edits:**
- `schema.ts` and `migrations.ts`: append only.
- `migrations.test.ts`: if it hardcodes counts. It mostly uses `MIGRATIONS.length` (`:35`, `:38`, `:59`).

---

## 9. API changes

All new handlers live in a **new** file, `src/prelabel/routes.ts`, as `handlePrelabelRoute(req, url, ctx): Promise<Response | null>`. `server.ts` gains one import and one dispatch line, placed just after the reviews block (`server.ts:502`):

```ts
const pre = await handlePrelabelRoute(req, url, { db: activeDb, headers, authEnabled, currentUser, canWrite }); if (pre) return pre;
```

`api.ts` and `categorization-review-queries.ts` are **not edited**. Bodies are validated with zod `.strict()`. Errors are `{error:{code,message}}` with a real HTTP status; never `200 {success:false}`, as in judge spec `:848`, `:922`.

*(Critic.)* `ctx` also carries `port: actualPort` (`server.ts:202`) for the gate below. The dispatch line must run **after** the auth middleware (`server.ts:232-262`), which it does when placed after the reviews block. It must not move above the `/assets/` early return either.

### 9.0 Request gate (critic, applies to every route in §9 and §11)

Today the server answers every route with `Access-Control-Allow-Origin: *`, binds all interfaces, and with auth off treats every caller as admin (`server.ts:205-209`, `:191-192`, `:142-144` via `authEnabled && …`). So without a gate:
- any web page the user visits could read `/api/prelabel/gold`, a raw verified ledger;
- with B1-b, any page could POST fabricated proposals and click "accept".

Judge P0b fixes this for the whole server, but it is not merged. B1 does not wait for it. `src/prelabel/origin-gate-interim.ts` exports the **same names and signatures** as judge P0b's `src/dashboard/origin-gate.ts` (judge `:351`): `isAllowedOrigin(origin, port, env?)`, `corsHeaders(port, origin, env?)`, `resolveBrowserOrigin(req, port, env?)` and `requireBrowserProof(req, port?, env?)`. Its logic is a copy of that file's subset (Round 2 fix 1), with no extra exports. When P0b merges, the file becomes a re-export, the same pattern as `agent-present.ts`.

1. **CORS.** Every response from `handlePrelabelRoute` first deletes `Access-Control-Allow-Origin` from the shared `headers`, then applies `corsHeaders` (own origin reflected, else nothing). The shared object is copied, never mutated.
2. **Reads that return transaction text** (`/gold`, `/api/export/training/labels*`) need browser proof via `resolveBrowserOrigin`: an allowlisted `Origin`, or `Sec-Fetch-Site: same-origin` to an allowed Host (a browser sends no `Origin` on a same-origin GET). A present non-allowlisted `Origin` or a `cross-site`/`same-site` fetch is 403 `origin_denied`; a request with neither header (curl, LAN scripts, a rebinding Host) is 403 `origin_required` (Round 2 fix 2).
3. **Every state-changing route** (`PUT /api/prelabel/settings`, and every B1-b POST) requires:
   - `Content-Type: application/json`, else 415. This forces a CORS preflight and blocks `text/plain` form CSRF;
   - **browser proof**: an allowlisted `Origin` **and** `Sec-Fetch-Site: same-origin`, else 403. This matches judge P4a accept routes (judge `:904`).
4. `GET /api/prelabel/config` carries no transaction text. It gets rule 1 only.

The pre-existing `POST /api/reviews/:id/confirm|correct` routes stay CSRF-able until P0b. B1-a makes them **no more** exposed than today, because it adds no new caller path and no bulk loop. This is an escalation, not a B1 fix.

### 9.1 B1-a

| Route | Auth | Response |
|---|---|---|
| `GET /api/prelabel/config` | any authenticated user (same as `GET /api/reviews`) | `{enabled, profile, pins: PrelabelPins, labels: string[], labelSetVersion, marginCut, maxRowsPerRun: 2000, approxDownloadBytes: 350631305, allowWasmFp32}` |
| `GET /api/prelabel/gold?limit=500` (S6, measurement) | `canWrite`; §9.0 rule 2 | `{rows:[{txnId, description, amount, date, label}]}`. Only `user_verified=1` rows with a non-null category, newest first, limit 1..500. Read-only. Used only by the measurement panel; nothing persisted |
| `PUT /api/prelabel/settings` *(critic)* | `canWrite`; §9.0 rule 3 | Body `{enabled?: boolean, marginCut?: number 0.05..0.95}.strict()` → writes `prelabelEnabled` / `prelabelMarginCut` through `setSetting` (`config.ts:113`) → `{enabled, marginCut}`. Revision 1 had no write path for these settings, so turning the feature on meant hand-editing `settings.json`. `prelabelDailyLimit`, `prelabelAllowWasmFp32` and `prelabelBacklogExperiment` stay file-only. Admins edit the profile's `settings.json` directly; there is no route for them |

`enabled` is a per-profile setting `prelabelEnabled`, **default false** (OQ5). When it is false, the panel renders nothing and the Review tab is byte-identical in behaviour. *(Critic.)* "Renders nothing" would hide the toggle too. So when `enabled` is false and the viewer can act, the panel renders a single muted line, "Second opinion (open-jev): off · Turn on", which calls the settings route. Nothing else on the page changes.

### 9.2 B1-b (after v34)

| Route | Auth and limits | Behaviour |
|---|---|---|
| `POST /api/prelabel/proposals` | `canWrite`; §9.0 rule 3; 30 calls/min/user; ≤100 items/call; ≤2,000 items per `runId` (advisory only: `runId` is chosen by the client, so it can be rotated, *critic*); `prelabelDailyLimit` items/profile/day (default 10,000, admin-only setting) → 429. The daily cap is the real bound | Body `{runId, profile, modelId, revision, labelSetVersion, templateVersion, dtype, device, temperature, configSha, runtime, items:[{transactionId, category, p1, p2, top2}]}`. *(Critic.)* `profile` must equal the active profile, else **409 `profile_changed`** (§5). `revision` and `configSha` must equal the pins, else 400. All string fields are validated per §8.2. Server checks: `labelSetVersion`/`templateVersion` must equal current, else **409** `label_set_changed` / `template_changed` (mirrors `rubric_changed`, judge `:883`). `modelId`, `dtype`, `device` and `temperature` must equal the pins, else 400. The fp32/wasm pin is accepted only when `allowWasmFp32`. `category` must resolve against the live list (`resolveCategory ?? CATEGORIES`, as at `api.ts:262`). `0 ≤ p2 ≤ p1 ≤ 1`, and **the server computes `margin = p1 − p2` itself**. *(Critic.)* That only keeps `margin` consistent with `p1`/`p2`. It does **not** verify that the scores are real: a same-origin script can still invent `p1`/`p2`. The defence is that a human still clicks every accept. Skips: `not_found`, `verified` (txn `user_verified=1`), `duplicate` (an identical open proposal). A different open proposal for the same `(txn, 'open-jev')` is set to `superseded` and the new row inserted, in one transaction. Returns `{created, superseded, skipped:[{transactionId, reason}]}`. `model` is labelled "declared by browser" in the UI, because the server cannot verify inference ran |
| `GET /api/prelabel/proposals?limit=200` | any authenticated user | Open `proposed` rows whose txn has `user_verified=0`, joined to the txn: `{proposalId, transactionId, category, margin, p1, modelId, labelSetVersion, createdAt, pendingReviewId \| null}` |
| `POST /api/prelabel/proposals/:id/accept` | `canWrite`; §9.0 rule 3 (browser proof, as judge accept `:904`) | Body `{action:'confirm'} \| {action:'correct', category}`. **409 `too_new`** if the proposal is younger than 1 s (judge `:821`; computation in §8.2). 409 `not_open` if it is not `proposed`. 409 `already_verified` if the txn is verified (and the proposal is marked `superseded`). **One `db.transaction`:** `UPDATE transactions SET category, category_confidence = NULL, user_verified=1, revision=revision+1, updated_at`; proposal `status='resolved', resolved_via`; any `pending` LLM row for the txn → `superseded`. `resolved_via = agentPresent ? 'dashboard_agent_present' : 'dashboard'`. *(Critic.)* Revision 1 wrote `category_confidence = p1` on confirm. That puts open-jev's calibrated probability into a column every other reader treats as the **categorize LLM's** confidence: the v24 backfill threshold `schema.ts:437`, `ConfidenceBadge`, the extractor's `category_confidence` `extract_wilson_labels.py:366`. It is now always NULL. `p1` lives on the review row (`confidence`) |
| ~~`POST /api/prelabel/proposals/bulk-accept`~~ | **Removed in revision 2** (critic). Bulk is not in the approved policy, and `isTrusted` plus press-and-hold do not prove a human is present (R14). If Jd wants bulk (OQ9), it comes back as its own slice, with `resolved_via='dashboard_bulk'` so exports can drop it, with the judge's cap of 10, and with 409 `agent_present` | — |

- **`agentPresent`.** Until P4a lands, `src/prelabel/agent-present.ts` exports `agentPresent(db, userKey)`, the **same signature** as P4a's (judge `:915`). It is true if `mcp_grants` has a row for this user and profile with `revoked_at IS NULL` and a live `expires_at`, or if `listPendingOperations(db)` is non-empty (`src/mcp/store.ts:278`). When P4a merges, the body becomes a re-export of `src/training/annotations.ts`. *(Critic.)* `expires_at` is ISO with a `T` (`store.ts:98`). Compare it as `julianday(expires_at) > julianday('now')`, or in JS with `Date.parse`, **not** as `expires_at > datetime('now')`. The latter is always true within the same UTC day. `listPendingOperations` has that bug (`store.ts:280`). For `agentPresent` it errs toward "present", which is the safe direction, so B1 calls it as is and reports the bug to the judge session (escalation).
- **Existing routes.** They are not changed by B1. P2 of the judge spec adds `agent_present` auditing to confirm/correct (judge `:589`). B1 inherits that for free.

### 9.3 B1-c (experiment flag) — PARKED (critic: outside approved scope, contradicts policy §4; built only if Jd overrides, OQ3)

| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/prelabel/candidates?cursor=&limit=500` | `canWrite`, only when `prelabelBacklogExperiment=true` | Transactions with `category IS NULL`, `COALESCE(user_verified,0)=0` and no `pending` or `proposed` review row. `{items: PrelabelItem[], nextCursor}`, capped at 2,000 per run by the client |

---

## 10. UI changes

### 10.1 `ReviewTab.tsx`

The diff is small and additive, about 15 lines, because judge P2 adds `ReviewActionForm` to this file (judge `:571`, `:603`).

1. Import and render `<PrelabelPanel reviews={pending} onResults={setPrelabels} />` between the banners and the table (after `:213`).
2. Replace `pending.map(...)` (`:251`) with `orderByLane(pending, prelabels, marginCut).map(...)`, which renders `LaneHeaderRow` entries between lanes.
3. Pass `prelabel={prelabels.get(r.transaction_id)}` to `ReviewRow`, and render `<PrelabelChip>` after `ConfidenceBadge` in the Suggested cell (`:90-93`).
4. B1-b: `ReviewRow` renders `<PrelabelAccept>` in the Actions cell when the proposal is high-margin. This replaces nothing; the existing Confirm, Correct and Apply controls are unchanged.

### 10.2 New components (`src/dashboard/ui/src/components/prelabel/`)

These follow Forensic Noir (`app/BRAND.md`): theme tokens already used in `ReviewTab.tsx`, mono 10 px uppercase badges, no emoji, no pill radius.

| Component | Content |
|---|---|
| `PrelabelPanel` | **States:** `off` (renders nothing); `unavailable` ("open-jev needs WebGPU with shader-f16. Your review queue works as before."); `consent` ("Second opinion from open-jev runs on this computer's GPU. One-time download: 351 MB from huggingface.co. Transaction text never leaves this machine." + **Download once**); `loading` (a progress bar with bytes); `running` (`Scoring 87 / 200 · p50 81 ms` + **Cancel**); `ready` (counts per lane, model line `open-jev q4f16 · T 1.05 · cat-18-0f7b…`, **Score next 200**); `failed` (detail + **Retry**); `locked` ("running in another tab"). **Admin-only:** the B1-c button **Pre-label backlog (experiment)**, with an amber `EXPERIMENT` badge. **Measurement:** the measurement section is shown when `?prelabelMeasure=1` |
| `PrelabelChip` | `JEV AGREES · M .42` (`border-green/40 text-green`), `JEV DISAGREES` (`border-yellow/40 text-yellow`), `JEV UNSURE · M .08` (`text-text-muted`), `JEV SKIPPED`. The tooltip says "open-jev's margin between its top two choices, not the LLM's confidence". It is visually distinct from `ConfidenceBadge` so the two numbers aren't conflated |
| `LaneHeaderRow` | `NEEDS YOU · 12` / `QUICK CONFIRM · 31`. *(Critic.)* Counts only. There is no bulk action (§9.2, OQ9) |
| `useTrustedAction` (hook) | Mirrors judge `:821`: enabled after 800 ms; `event.isTrusted` required. Logic lives in a pure `trusted-action-core.ts` (injected clock) so it is bun-tested. *(Critic.)* It is a speed bump against scripted `.click()`. It is **not** proof of a human: input dispatched over the Chrome DevTools Protocol (Playwright, browser-driving agents such as Claude in Chrome) arrives with `isTrusted === true`. Server-side `agentPresent` covers only WebMCP grants and ops (R14). Revision 1's bulk press-and-hold and its dialog are removed with bulk |
| `PrelabelAccept` (B1-b) | `Accept open-jev: Dining` (`bg-green/20 text-green`), a small `DECLARED BY BROWSER · M .41` caption, and the same `useTrustedAction` single-click rules (800 ms, `isTrusted`) |
| `MeasurePanel` (S6) | Runs `/api/prelabel/gold` through the worker. Shows accuracy, a routing table at cuts **0.10 / 0.20 / 0.30 / 0.50 / 0.70** (auto-share, auto-accuracy, review-share, as in policy §4 `:209-211`), p50/p95, and n with a "small n" warning below 200. **Download JSON** is a local file; nothing is persisted or sent. *(Critic.)* The JSON holds `{txnId, label, pred, p1, p2, margin, ms}` per row and the routing table. It holds **no descriptions, merchants or amounts**, so the file is not a ledger extract |

*(Critic.)* Revision 1 had B1-a run a bulk Confirm loop over the existing `POST /api/reviews/:id/confirm`. It is **removed**. Bulk is not in the approved policy. In B1-a it would also mint up to 25 "human" labels per gesture with no provenance at all, since no column exists, and it would add a scripted loop over a route that is still CSRF-able until judge P0b.

`PrelabelPanel` copy fixes *(critic)*: the `consent` text reads "One-time download: about 351 MB from huggingface.co (a pinned model version). Transaction text never leaves this machine; later visits make about 1 KB of version checks to huggingface.co." The `off` state is the single toggle line from §9.1, not an empty render. The B1-c button is removed while B1-c is parked.

### 10.3 Client modules (`src/dashboard/ui/src/prelabel/`)

| File | Contents |
|---|---|
| `core.ts` | `formatState`, `buildQuestion`, `marginOf`, `routeLane`, `orderByLane`, `cacheKey`, `estimateRunMs` |
| `protocol.ts` | §5 |
| `worker-core.ts` | The engine with an injectable loader |
| `worker.ts` | The `self.onmessage` shim. **Only** the prelabel build imports it |
| `usePrelabel.ts` | Spawns `new Worker(`${base}/assets/prelabel-worker.js`, {type:'module'})`, takes the Web Lock, and wires `session.ts` to React. Thin: no logic that is not in `session.ts` |
| `session.ts` *(critic)* | Pure and bun-tested: `createPrelabelSession({storage, fetchConfig, post, now})` handles the cache read/write (with the per-row state hash, §7), `acceptResults` (§5), profile binding (§5), the B1-b POST batcher (100 rows or `done`), and the lock-unavailable/`locked` state. Revision 1 left all of this in an untested hook |

The singlefile React bundle must never import `worker.ts` or `open-jev`. Slice S0 enforces this.

*(Critic, path clarity.)* Two different `src/prelabel/` directories exist in this spec:
- **Server:** `<root>/src/prelabel/{config,label-set,provenance,routes,proposal-queries,agent-present,origin-gate-interim,rate-limit}.ts`.
- **Browser:** `<root>/src/dashboard/ui/src/prelabel/{core,protocol,session,worker-core,worker,usePrelabel}.ts`.

`vite.prelabel.config.ts` lives in `src/dashboard/ui/`, so its `src/prelabel/worker.ts` entry means the **browser** path. `worker.ts` touches `navigator.gpu` and `self`, but the UI tsconfig `lib` is `["ES2022","DOM","DOM.Iterable"]` (`ui/tsconfig.json`), with no WebWorker or WebGPU types. Use structural casts, the way `hybrid/client.ts:96` does, instead of adding `@webgpu/types`.

---

## 11. Export changes

> **Critic revision: this section is no longer on B1-a's critical path.** For B1-a the approved export policy is **already met** by the existing extractor. It exports verified rows only by default (`extract_wilson_labels.py:353`); unverified rows need a per-run `--include-unverified` (`:480`); and it redacts by default, refusing raw output without `--i-accept-risk` (`:495-501`). B1-a writes no open-jev value into any label. The in-app route below has two problems:
> - It reused the extractor's row shape but renamed its vocabulary. The extractor's `source` already means `review_confirm|review_correct|verified_no_review` (`:456-464`); revision 1 added a second `source` plus `label_origin` with different values.
> - It is **raw by default**. It would be the only training-data path in the stack that defaults to unredacted descriptions and amounts.
>
> So S7 and S12 are **conditional on OQ8**. If they are built:
> - `source` keeps the extractor's exact values;
> - the B1-b origin goes in a new field, `prelabel_origin: null | 'confirm_prelabel' | 'correct_after_prelabel'`;
> - amounts default to the extractor's `<AMOUNT>` placeholder, with `keepAmounts=1` as a per-export opt-in;
> - §9.0 rule 2 applies.
>
> **B1-b blocking follow-up (cross-repo).** The extractor picks the **latest resolved** review row as `suggested_label` (`:346-350`), and that is the open-jev row after an accept. It would therefore emit an open-jev one-click accept as `review_confirm`, indistinguishable from a human confirming the LLM. That silently erases the provenance B1-b exists to record. Before B1-b's accept UI ships, `browser-finetune/scripts/extract_wilson_labels.py` must:
> 1. select `r.source` and `r.resolved_via` when those columns exist (schema ≥ v34);
> 2. emit `prelabel_origin`;
> 3. exclude `resolved_via='dashboard_agent_present'` by default.
>
> That file is outside this repo. This spec cannot do the work, so it is an escalation.

This is a new file, `src/training/label-export.ts`, plus new routes. `export.ts` is **not edited**, because the judge rewrites it (judge `:833`). *(Critic.)* Judge P0a's uncommitted `server.ts` hook already audits every `GET /api/export/*` (judge worktree diff), so this route would be audited for free once P0a merges.

| Route | Auth | Output |
|---|---|---|
| `GET /api/export/training/labels` | `canWrite`. This is stricter than today's ungated `/api/export/training/*` (`server.ts:879-907`); OQ8 | JSONL, one row per labelled transaction, in the extractor's row shape (`extract_wilson_labels.py:438-452`): `{id, date, description, merchant_name, amount, amount_sign, category (slug), label (slug), category_label, user_verified, source, suggested_label, label_origin, weak}` plus, in B1-b only, `prelabel:{modelId, margin, labelSetVersion, provenance} \| null` and `resolved_via` |
| `GET /api/export/training/labels/manifest` | `canWrite` | `{label_set_version, label_by_slug, slugs, counts:{human_correct, human_confirm, human_confirm_prelabel, human_correct_after_prelabel, verified_no_review, agent_present, unverified}, filters, generated_at}`. This is compatible with the extractor's `categories.json` (`extract_wilson_labels.py:649-676`) |

**`label_origin` derivation:**
- `human_confirm`: the latest resolved review's `suggested_category` equals the final category.
- `human_correct`: the latest resolved review's suggestion differs from the final category.
- `verified_no_review`: `user_verified=1` with no resolved review, for example a manual edit (`queries.ts:717`).
- B1-b adds `human_confirm_prelabel` and `human_correct_after_prelabel` when that resolved row has `source='open-jev'`.

**Filters, mirroring the P4a policy (judge `:746-747`, `:1021`):**

| Row class | Default | Per-export opt-in |
|---|---|---|
| `user_verified=1` (human-verified, all origins above) | **included** | — |
| `resolved_via='dashboard_agent_present'` (B1-b) | excluded | `includeAgentPresent=1` (mirrors OQ24) |
| `user_verified=0` with a category (LLM or rule labels, already applied) | excluded | `includeUnverified=1`. Rows carry `weak:true` and `label_origin:'unverified'` |
| open-jev proposals (`status='proposed'`, or B1-a cache) | **never**. They are not transaction labels | none |
| `superseded` or `resolved` review rows | only as the `suggested_label` context of a verified row | — |

- **Open question.** A stricter mirror would treat `human_confirm_prelabel` (a one-click accept of a model proposal) like an accepted judge row, which is opt-in. The spec includes it by default because the human verified it, and tags it so trainers can drop or down-weight it (OQ4).
- **Download confirmation.** Downloading with any opt-in checked requires the press-and-hold (judge `:821`).
- **Redaction.** The export carries raw descriptions and amounts, like `/api/export/csv`. PII redaction stays in the extractor (`extract_wilson_labels.py:131` `Redactor`, `:136` `strict_check`) (OQ8).

---

## 12. B2 seam (trace judge; not built here)

B2 would have open-jev score `llm_interactions` and write through P4a's `insertProposals`. P4a's `insertProposals` sits behind both `propose_judgements` and `judge_interaction` (judge `:75`, `:884`, `:915`). B1 makes that cheap in four ways:

- **Provenance type.** `src/prelabel/provenance.ts` (import-free; the UI imports it the way `client.ts:31` imports `src/model/`) defines `PrelabelProvenanceV1 = {schema:'prelabel-prov/1', modelId, repo, dtype, device, temperature, templateVersion, labelSetVersion, margin, p1, p2, top2, configSha, runtime, runId}`.
- **Field mapping to P4a:**
  - `modelId` → `judgeModel`, verbatim. The pattern already conforms (§4.1).
  - `labelSetVersion` / 409 `label_set_changed` → `rubricVersion` / 409 `rubric_changed`. Same staleness contract.
  - `margin` and `top2` → `criteria_json` or `tags`. P4a requires a `rationale` of 20..600 characters, which open-jev cannot produce (spike §7.3). B2 must use a templated, honest rationale from `provenance.ts`: `templateRationale(p)`, e.g. "open-jev (DeBERTa q4f16, T=1.05) chose 4 over 3 at margin 0.31; discriminative score, no free-text reasoning." This function is defined and unit-tested in B1 so B2 doesn't invent its own.
  - `resolved_via` values are the P4a `created_via` vocabulary (judge `:763`).
- **Engine reuse.** The worker engine (`worker-core.ts`) is model-agnostic over `{state, options[]}`. B2 reuses it with a different template, and needs one `decide()` per criterion, because multi-question calls were not measured (spike §6.6).
- **What B2 needs from P4a, not from B1.** A `created_via` value for an in-dashboard model (for example `dashboard_model`), and a principal for it. `insertProposals` today assumes an agent transport (judge `:888`). This is noted for the judge session; B1 does not touch it.

---

## 13. File-by-file list

| File | New / changed | Increment | Collision with judge worktree |
|---|---|---|---|
| `package.json` (root) | devDependency `open-jev: 0.1.2` (exact) | S0 | none |
| `src/dashboard/ui/package.json` | `build:hybrid` also runs `vite build --config vite.prelabel.config.ts` | S0 | none |
| `src/dashboard/ui/vite.prelabel.config.ts` | new. A lib build of `src/prelabel/worker.ts` → `dist-hybrid/prelabel-worker.js`; `emptyOutDir:false`; `inlineDynamicImports:true`; the same `onnxruntime-web-use-extern-wasm` condition as `vite.hybrid.config.ts:15-22` | S0 | none |
| `src/__tests__/prelabel-bundle-guard.test.ts` | new. If `dist/` exists, asserts the singlefile HTML contains neither `open-jev` nor `onnxruntime`; asserts `prelabel-worker.js` contains one transformers `env.version` | S0 | none |
| `scripts/check-prelabel-bundle.ts` *(critic)* | new. The same assertions, run at the end of `build:hybrid` and **failing the build**. The bun test above skips when `dist/` is absent, which is the CI case (CI runs only `bun run typecheck` and `bun test`), so on its own it passes vacuously. Today's `dist/index.html` has 0 matches for `onnxruntime`, `open-jev` and `huggingface`, so the guard has no false positive to work around | S0 | none |
| `.github/dependabot.yml` *(critic)* | add `open-jev` to `ignore` (or exclude it from the `minor-and-patch` group). A 0.x minor bump can change encoding or temperature defaults, and the fast-track path auto-merges on green CI (`docs/dependency-policy.md`), which no B1 unit test would catch. Bumps become manual, gated by L10 | S0 | none |
| `src/dashboard/ui/src/prelabel/{core,protocol,session,worker-core,worker,usePrelabel}.ts` | new (`session.ts` added by critic) | S1-S5 | none |
| `src/dashboard/ui/src/components/prelabel/{PrelabelPanel,PrelabelChip,LaneHeaderRow,PrelabelAccept,MeasurePanel}.tsx`, `useTrustedAction.ts`, `trusted-action-core.ts` | new | S5, S6, S11 | none |
| `src/dashboard/ui/src/tabs/ReviewTab.tsx` | about 15 lines, additive (§10.1) | S5, S11 | **Yes.** Judge P2 adds `ReviewActionForm`. Keep B1's lines out of the header and form area |
| `src/dashboard/ui/src/types.ts` | append `PrelabelConfig`, `PrelabelProposal` | S3, S11 | low (append only) |
| `src/prelabel/config.ts` | new: `PRELABEL_MODEL` pins, settings readers (`prelabelEnabled`, `prelabelMarginCut`, `prelabelDailyLimit`, `prelabelAllowWasmFp32`, `prelabelBacklogExperiment`) via `getSetting` | S3 | none |
| `src/prelabel/label-set.ts` | new: `getPrelabelLabels(db)`, `labelSetVersion(slugs)` | S3 | none |
| `src/prelabel/provenance.ts` | new: `PrelabelProvenanceV1`, `templateRationale` | S2 | none |
| `src/prelabel/routes.ts` | new: `handlePrelabelRoute` | S3, S6, S10, S13 | none |
| `src/prelabel/proposal-queries.ts` | new: `insertPrelabelProposals`, `listOpenPrelabelProposals`, `acceptPrelabelProposal` (bulk removed, critic) | S9 | none (does not edit `categorization-review-queries.ts`). *(Critic.)* Semantic coupling: judge P2 makes `resolveCategorizationReview` bump `revision` (judge `:608`). B1-b's accept bumps it independently, and the S9 tests must not assume the existing route leaves `revision` unchanged |
| `src/prelabel/agent-present.ts` | new: interim `agentPresent` with P4a's signature | S10 | becomes a re-export after P4a |
| `src/prelabel/origin-gate-interim.ts` *(critic)* | new: `corsHeaders`, `requireBrowserProof`, and a read-gate helper (§9.0), with judge P0b's names | S3 | becomes a re-export of `src/dashboard/origin-gate.ts` after P0b |
| `src/prelabel/rate-limit.ts` | new, unless judge P0a's `src/mcp/rate-limit.ts` (judge `:170`) has merged; if so, reuse it | S10 | possible duplication |
| `src/dashboard/server.ts` | one import and one dispatch line after `:502` | S3 | **Medium** *(critic, was Low)*. The judge worktree has **uncommitted** `server.ts` edits right now (+39 lines), and P0b rewrites the shared `headers` object at `:205-209` that B1's gate reads. Rebase onto whatever P0b merges, and keep B1's single dispatch line away from `:205-262` |
| `src/training/label-export.ts` | new, **only if OQ8 says build it** (critic) | S7, S12 | none (does not edit `export.ts`) |
| `src/db/schema.ts`, `src/db/migrations.ts` | append v34 | S8 (B1-b) | **Yes.** Numbering; sequence after v33 (§8.2) |
| `scripts/prelabel-fixture-server.ts` | new: a dashboard on a scratch DB seeded from the synthetic persona gold (§15) | S5 | none |
| `browser-finetune/scripts/extract_wilson_labels.py` *(critic, other repo, not edited by B1)* | read `source` and `resolved_via` when the schema is ≥ v34; emit `prelabel_origin`; exclude agent-present rows by default (§11) | **blocks enabling B1-b's accept UI** | n/a (escalation) |
| `src/__tests__/prelabel-*.test.ts` | new (§14) | all | none |

---

## 14. TDD slices (write the test first, watch it fail, then implement)

The gate for every slice is `bun test --isolate` green and `bun run typecheck` green. Slices that touch the UI also need `cd src/dashboard/ui && npm run build && npm run build:hybrid` green.

| # | Slice | Tests first | Done when |
|---|---|---|---|
| S0 | Build plumbing | `prelabel-bundle-guard.test.ts`; `scripts/check-prelabel-bundle.ts` runs inside `build:hybrid` | `dist-hybrid/prelabel-worker.js` is built **after** the hybrid build (which uses `emptyOutDir:true`, `vite.hybrid.config.ts`, and would otherwise delete it); the singlefile `dist/index.html` has no `open-jev` or `onnxruntime`; the guard passes; the HF commit sha and `config.json` sha256 are recorded in `PRELABEL_MODEL`; dependabot ignores `open-jev` |
| S1 | Pure core | `prelabel-core.test.ts`: `formatState` equals the spike's `fmtTx` byte-for-byte on 3 gold rows, including the sign and `toFixed(2)`; `marginOf` on the spike's `top3` rows; the `routeLane` table in §6 (every row); `orderByLane` is stable and, with no results, returns input order; `estimateRunMs(2000)` falls in [134 s, 216 s] at 67-86 ms/row ±25% | all green |
| S2 | Protocol and provenance | `prelabel-protocol.test.ts`: every message round-trips; malformed and extra-key messages → `null`; `v≠1` → `null`. `prelabel-provenance.test.ts`: `modelId` matches `/^[\w.:\/-]{1,64}$/`; `templateRationale` length is within 20..600 for extreme margins | green |
| S3 | Server labels and config | `prelabel-label-set.test.ts` (createTestDb): the seed gives the 18 labels in `CATEGORIES` order and `label_set_version === 'cat-18-0f7b02225108'` (re-computed by the critic with the extractor's algorithm); a user-added category changes the version; an empty table falls back to `CATEGORIES`. `prelabel-routes.test.ts`: `GET /api/prelabel/config` shape; `enabled:false` by default. *(Critic.)* `prelabel-origin-gate.test.ts` (HTTP, auth off): • `Origin: http://evil.example` → no `Access-Control-Allow-Origin` on `/api/prelabel/config`, and 403 on `/api/prelabel/gold`; • own origin → reflected, never `*`; • `PUT /api/prelabel/settings` with `text/plain` → 415; • with `Sec-Fetch-Site: same-site` → 403; • with no `Origin` → 403 (browser proof); • same-origin JSON → 200 and `settings.json` updated in the temp profile; • `marginCut: 2` → 400 | green; dispatch line in `server.ts` |
| S4 | Worker engine | `prelabel-worker-core.test.ts` with a fake `OpenJev` (deterministic probabilities, injectable clock) and a fake transformers `env`. *(Critic additions:)* • `navigator.gpu` undefined → `unavailable` with no throw; • `adapter.info.isFallbackAdapter` is honoured; • `env.remotePathTemplate` is set to the pinned revision **before** `info()` or `load()` is called; • `info()` is never called before a `load` message; • a `configSha` mismatch → `failed:model_mismatch`. • Revision 1 cases: the capability ladder (no adapter, fallback adapter, no `shader-f16` → `unavailable`; wasm only when the pin says so); `decide` receives `temperature:1.05` and bare options; results chunk at 5 then every 25; cancel stops within 1 row; a too-large option set → `label_set_too_large`; one decide error → `ok:false` and the run continues; p50/p95 in `done` | green |
| S5 | B1-a UI | *(Critic: revision 1 had no automated test here.)* • `prelabel-session.test.ts`, with fake storage, fetch and clock: • the cache hits only when the state hash matches; • throwing storage → re-score, no crash; • `acceptResults` drops stale `runId`, unknown `txnId`, an out-of-set `choice`, and NaN or out-of-range probabilities; • a profile mismatch on re-read cancels the run and discards its results. • `prelabel-trusted-action.test.ts`: a click before 800 ms is ignored; `isTrusted:false` is ignored. • Components are covered by build plus live Chrome. | UI build green; live-Chrome steps L1-L9 (§15) pass on the fixture |
| S6 | Measurement | `prelabel-routes.test.ts`: `/api/prelabel/gold` returns only `user_verified=1` rows, the limit is clamped to 1..500, and non-admin → 403 when auth is on. A `core.ts` routing-table function at cuts 0.1/0.2/0.3/0.5/0.7 is checked against the spike's `categorize-bare` results (≥0.3 → 18/19) | live step L10 reproduces 30/49 and 18/19 |
| S7 | Label export (zero migration). **Conditional on OQ8** (critic) | `prelabel-label-export.test.ts`: by default only `user_verified=1`; `label_origin` is confirm, correct or `verified_no_review` as specified; `includeUnverified=1` adds `weak:true` rows; pending reviews never appear; the manifest `label_set_version` equals S3; non-admin → 403 | green |
| — | **Stop. B1-a is shippable here** (S0-S6; S7 only if OQ8 says so). Phase B1-b starts after OQ2 is resolved and the v34 slot is free. *(Critic.)* B1-b's accept UI (S11) is **not enabled** until the extractor follow-up in §11 has landed in browser-finetune | | |
| S8 | v34 | `migrations.test.ts` stays generic; new `prelabel-migration.test.ts`: the columns exist with the right defaults; legacy rows get `source='categorize'`; the proposed index allows 1 pending (LLM) + 1 proposed (open-jev) per txn and rejects a second open-jev proposal | green; highest version re-checked on `origin/*` first |
| S9 | Proposal queries | `prelabel-proposals.test.ts`: insert validates and computes margin server-side; an identical proposal → `duplicate`; a different one → supersede and insert; a verified txn → `verified`; accept-confirm sets category, **`transactions.category_confidence` NULL** (critic: was `p1`), `user_verified=1`, **`revision+1`**, proposal `resolved`, LLM pending → `superseded`; accept-correct likewise. *(Critic additions:)* • `created_at` is written in `YYYY-MM-DD HH:MM:SS` format from the injected clock; • a proposal whose txn was verified through the **existing** review route is swept to `superseded` by the list and insert calls; • `runtime` with a newline, a non-hex `configSha`, or `top2[0][0] ≠ category` → rejected. • Then: the **extractor-compat SQL** (copied from `extract_wilson_labels.py:346-350`) then returns the open-jev row's suggestion | green |
| S10 | B1-b routes | `prelabel-routes.test.ts`: 409 `label_set_changed` / `template_changed`; 400 on a pin mismatch (including `revision` and `configSha`) or unknown category; **409 `profile_changed`** (critic); 429 on the daily cap and per-minute limit; 409 `too_new` under 1 s (injectable clock, §8.2); `agentPresent` → single accept sets `resolved_via='dashboard_agent_present'`; accept without browser proof → 403 (critic); an expired grant whose ISO `expires_at` is earlier today is **not** counted as present by B1's own grant query (critic). Bulk cases are removed | green |
| S11 | B1-b UI | build plus live Chrome | live steps L11-L13 pass; the extractor follow-up (§11) has merged |
| S12 | Export provenance | `prelabel-label-export.test.ts`: `human_confirm_prelabel` and `human_correct_after_prelabel`; agent-present rows excluded by default and included with `includeAgentPresent=1`; `prelabel` provenance object present | green |
| S13 | B1-c experiment: **PARKED**, not built unless OQ3 overrides policy (critic) | `prelabel-routes.test.ts`: candidates exclude categorized, verified and already-queued rows; 403 when the flag is off; the client caps at 2,000 | live step L14 within the §7 budget |

---

## 15. Live-Chrome verification for Jd

**Never use a real profile.** `scripts/prelabel-fixture-server.ts` does the following:
- calls `setActiveProfilePaths` on a temp dir, as `src/__tests__/helpers.ts:33-48` does;
- opens a **plain** SQLite file at `$TMPDIR/wilson-prelabel-fixture.db` and runs migrations;
- seeds the **49 synthetic-persona gold rows**, `docs/spikes/2026-10-02-open-jev-webgpu/harness/gold/categorize.json`, which are fabricated merchants from `fix+profile-switch-dashboard/scripts/demos/personas`;
- starts `startDashboardServer(db, 3142)`.

It never reads `~/.openaccountant`.
- *(Critic.)* `setActiveProfilePaths` alone does not guarantee that. `OA_ROOT` is `join(homedir(), '.openaccountant')`, evaluated at import time (`src/profile/context.ts:5-6`), and `GET /api/profiles` lists `PROFILES_DIR` (`server.ts:386-391`). So the script **re-executes itself with `HOME=$TMPDIR/wilson-prelabel-home`** before importing anything from `src/`. The prep command below is a wrapper that sets `HOME`. If `homedir()` does not resolve under `$TMPDIR` after the re-exec, the script refuses to start.
- **Default mode.** Each row is inserted with a `pending` review at confidence 0.55. The suggested category is the gold label for rows where `i % 3 !== 0`; otherwise it is the next label in `CATEGORIES`. The script prints the expected lane counts, computed from the spike's `results/open-jev-q4f16-webgpu.json` → `workloads['categorize-bare']`.
- **`--verified` mode.** Rows are seeded as `user_verified=1` with the gold category, for S6.

**Prep:**
- `cd src/dashboard/ui && npm run build && npm run build:hybrid`.
- `bun run scripts/prelabel-fixture-server.ts --enable`. This sets `prelabelEnabled=true` in the temp profile.
- In Chrome, open `http://localhost:3142`, then the Review tab.

| Step | Do | Expect |
|---|---|---|
| L1 | Open the Review tab with DevTools Network open, filtered to "All" | 49 pending rows. The panel shows `consent` with about 351 MB (the static `approxDownloadBytes`). **No** request to huggingface.co yet. *(Critic: revision 1 called `info()` here, and `info()` contacts HF, so this step would have failed.)* |
| L2 | Console: `(await navigator.gpu.requestAdapter()).features.has('shader-f16')` | `true` (on the M4 Pro) |
| L3 | Click **Download once** | Progress with bytes. Requests go only to `huggingface.co` (model files), every path containing `/resolve/<pinned sha>/` and none containing `/resolve/main/` (critic), and to same-origin `/assets/ort/*` and `/assets/prelabel-worker.js`. **Zero** requests to `cdn.jsdelivr.net`. No request body contains a transaction description |
| L4 | Wait | Cold: about 18-25 s plus about 5 s scoring; the chips fill top-down. `running` shows p50 of about 60-110 ms |
| L5 | Inspect lanes | `NEEDS YOU` first, then `QUICK CONFIRM`. The counts equal the fixture's printed expectation within 2 rows (R5). DISAGREES chips **do not** reveal open-jev's category (B1-a) |
| L6 | Reload the tab | No re-download (`fromCache`); the chips come back from the sessionStorage cache in under 1 s; warm load is about 1-1.5 s if a re-score is needed |
| L7 | Click Confirm on one QUICK row, then run `sqlite3 $TMPDIR/wilson-prelabel-fixture.db "select category,user_verified from transactions where id=<id>"` | The banner appears; the row disappears; the DB shows the LLM's suggested category with `user_verified=1` |
| L8 *(critic: replaces the bulk step)* | In the console, `document.querySelector('[data-testid=prelabel-confirm]').click()` on a QUICK row. Then, from a page on another origin (for example `python3 -m http.server 8000` serving a file that runs `fetch('http://localhost:3142/api/prelabel/gold').then(r=>r.text())`), open it | The scripted click does **nothing** (`isTrusted` false); a real click after 800 ms works. The cross-origin fetch fails with a CORS error in the console and a 403 in the fixture log. There is no bulk control anywhere |
| L9 | Start a re-score, then click **Cancel** within 1 s. Then relaunch Chrome with `--disable-features=WebGPU` and reload | Stops within one row. After the relaunch, the panel shows `unavailable`, and the Review tab works exactly as before |
| L10 | Restart the fixture with `--verified`, open `http://localhost:3142/?prelabelMeasure=1`, and run Measure | 30/49 correct (0.612); cut 0.30 → 18/19. This is identical to the spike, because the template, option order (seed `sort_order`) and pins are identical. **Download JSON** saves a local file only |
| L11 (B1-b) | With v34, re-run the default fixture | Network shows `POST /api/prelabel/proposals` about every 100 rows (here, once). DISAGREES rows now show **Accept open-jev: X** with `DECLARED BY BROWSER · M .xx` |
| L12 (B1-b) | Click Accept on a disagree row within 1 s of the proposal | 409 `too_new` banner. After 1 s it works; `sqlite3` shows the open-jev row `resolved` and the LLM row `superseded` |
| L13 (B1-b) | Grant any WebMCP tool from the agent panel, then Accept one proposal | It succeeds, and `sqlite3` shows `resolved_via='dashboard_agent_present'` (critic: bulk removed) |
| L13b (B1-b, critic) | The fixture needs a second synthetic profile. From a second tab, switch the profile during a run, then return to the first tab | The run is cancelled, the panel shows "Profile changed; reload", and a forced POST returns 409 `profile_changed` |
| L14 (B1-c, **parked**) | `--backlog 2000` fixture (synthetic rows replicated with id suffixes), then **Pre-label backlog (experiment)** | Completes in ≤ 3.6 min warm. Progress is monotonic. Tab stays responsive (the worker keeps the main thread free) |

---

## 16. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Accuracy is low.** Zero-shot is 61% on n=49 (spike §5), with Income at 1/6. The 0.3 cut rests on 19 rows (about ±13 pp) | It is a second opinion only. Nothing auto-accepts. S6 builds the measurement panel, and `prelabelMarginCut` is set from the routing table on real verified data before B1-b is enabled by default |
| R2 | **Automation bias.** One-click Confirm on QUICK rows makes rubber-stamped "human" labels | *(Critic revision.)* No bulk in any increment unless OQ9 brings it back. One row per click. B1-b `prelabel_origin` tags let training drop or down-weight these labels (OQ4). B1-a never reveals open-jev's alternative. The residual influence in B1-a cannot be recorded (§2) |
| R3 | **Policy tension.** B1-c puts open-jev in front of stage 1 (policy `:225`) | *(Critic.)* Parked: no slice builds it unless Jd overrides the policy (OQ3) |
| R4 | **The browser is untrusted.** A tab or extension can POST fabricated proposals | Server-side pin, label-set and category validation. Margin recomputed (consistency only, not authenticity). The daily cap; the per-`runId` cap is advisory. Rows are weak and never exported. The "declared by browser" label. *(Critic.)* §9.0 browser proof stops **other origins**. It does not stop a same-origin script or an extension |
| R5 | **Determinism across machines.** Spike predictions were identical run-to-run on one M4 Pro only. Other GPUs and drivers may flip near-tie rows | L5 tolerance is 2 rows. *(Critic correction.)* The cache key is `profile`, `labelSetVersion`, `modelId`, `revision`, `templateVersion` and a per-row state hash (§7). It does not include `configSha` or `runtime`; the pinned `revision` makes `configSha` redundant there. A browser or driver update is **not** in the key, so cached chips can outlive one. That is acceptable because the cache is per tab and per session |
| R6 | **Unpinned weights.** No `revision` option, so a re-upload on `main` changes outputs silently, and the Cache API keeps the old copy | *(Critic revision.)* Pinned through `env.remotePathTemplate` to a commit sha (§4.1); `configSha` cross-check → `failed:model_mismatch`. Residual: the upstream repo could delete or rewrite history, so the pin 404s and the feature becomes unavailable (it fails closed). A same-origin mirror is the remaining OQ7 option |
| R7 | **Large user label sets** exceed the 512-token budget or slow decisions; latency scales with option text (spike §3) | `label_set_too_large` guard; the cut was measured at 18 labels. Re-measure if a profile has more than 30 labels |
| R8 | **Not cross-origin isolated.** The dashboard lacks COOP/COEP, unlike the spike (spike §2), so ORT wasm is single-threaded | The WebGPU EP should be unaffected. L4 measures the actual p50 in the dashboard; if it is more than 1.5x the spike, investigate before shipping |
| R9 | **Duplicate transformers.js.** `hybrid-chat.js` and `prelabel-worker.js` each bundle their own copy | Accepted: about 1 MB, same-origin and cached. Shared ORT binaries under `/assets/ort/`. The S0 guard catches a third copy |
| R10 | **Merge conflicts** with the judge on `ReviewTab.tsx`, `server.ts`, and in B1-b `schema.ts`/`migrations.ts` | New-file-first layout (§13); about 15-line and 1-line diffs; v34 sequenced after v33 |
| R11 | **GPU memory pressure** with hybrid chat. Qwen3 and open-jev together exceed 1 GB of GPU buffers | Web Lock plus idle dispose. Running both at once is untested; L-step follow-up if Jd uses both |
| R12 | **Empty verified corpus.** Jd's `default` has 0 `user_verified=1` rows (applicability `:7`, `:82`), so S6 cannot validate on real data yet | B1-a exists to make verifying fast. The first 200+ resolutions feed S6. Until then the cut stays at the spike's 0.3 |
| R13 *(critic)* | **Wildcard CORS, all-interfaces bind, auth off by default** (§1). Without §9.0, any visited web page could read `/api/prelabel/gold` (a raw verified ledger) and, in B1-b, accept proposals. Anyone on the LAN can reach the server too | §9.0 interim gate with judge P0b's names, re-exported once P0b merges. Over a LAN IP the page is not a secure context, so WebGPU is absent and the feature is `unavailable`. The existing review routes stay exposed until P0b (escalation) |
| R14 *(critic)* | **`isTrusted` is not proof of a human.** Input dispatched over CDP (Playwright, browser-driving agents) is trusted. `agentPresent` sees only WebMCP grants and ops | One row per click; no bulk. `agent_present` tagging is best effort and documented as such. The judge spec carries the same residual for its accept buttons (judge `:821`) |
| R15 *(critic)* | **Profile switch mid-run.** The server's active profile is global (`server.ts:393-403`), and transaction ids are per profile, so scores could land on the wrong profile's rows | Run bound to `{profile, labelSetVersion, revision}`; re-read before each POST and on `visibilitychange`; server 409 `profile_changed` (§5, §9.2) |
| R16 *(critic)* | **Silent library bump.** Dependabot fast-tracks minor bumps (`docs/dependency-policy.md`), and for 0.x that can change encoding | `open-jev` ignored by dependabot (§13); bumps are manual and re-run L10 |
| R17 *(critic)* | **Worker-scope WebGPU was not measured.** The spike ran `decide()` on the page's main thread (`harness/web/main.js`) with COOP/COEP | L4 measures it in the dashboard worker. If the p50 is more than 1.5x the spike, or the worker cannot get an adapter, fall back to running the engine on the main thread with the same `worker-core.ts`. This costs UI jank but keeps the feature |
| R18 *(critic)* | **Crafted text steers the picker.** Imported or Plaid descriptions are attacker-reachable, and so are custom category names (judge `:168` says a prompt-injected chat agent can create categories). A description such as "ACME - category Income", or a category named to attract the residual mass, can push a row into QUICK or a high-margin DISAGREES. open-jev is discriminative, so it can only pick among the options; it cannot exfiltrate or call tools | A human click is still required. In B1-b, render custom names through the judge's `safeCategoryLabel` rule once P0a lands. The §4.2 token guard bounds how long the options can get. No open-jev output is ever sent to an LLM (§12 keeps B2 out of scope) |

---

## 17. Open Questions for Jd

Revised by the critic. The writer's original wording is kept where the question still stands; every change is marked.

1. **B1-a blind disagreement.** In the zero-migration increment, open-jev's alternative category stays hidden on DISAGREES rows, so labels stay uncontaminated without provenance storage. That defers "high-margin pre-fill" for disagreeing rows to B1-b. Accept? (Recommended: yes.) *Critic note:* "uncontaminated" applies to label **values** only. The AGREES chip still steers which suggestions get confirmed, and that cannot be recorded in B1-a (§2).
2. **v34 sequencing.** B1-b needs one ALTER-only migration on `categorization_reviews` (§8.2). Wait for judge v33 to merge and take v34 (recommended), or let B1-b take the next free number now and have the judge branch renumber? *Critic note:* v33 belongs to judge P4a, the sixth of seven phases, so "wait" may mean a long wait. Either way, ask the judge session to record "v34 reserved for B1-b" in its spec.
3. **B1-c backlog experiment.** Pre-labeling uncategorized rows that never went through the LLM contradicts policy §4's "do not put the escape hatch in front of the head", and it is outside the approved scope. *Critic recommendation: drop it.* It is parked in this revision, and no slice builds it.
4. **Export default for one-click open-jev accepts** (`prelabel_origin='confirm_prelabel'`, critic rename). Include them in the default export because a human verified them (the writer's default, tagged)? Or put them behind a per-export opt-in, the stricter mirror of P4a? *Critic note:* this has to be decided in the **extractor** (§11). An in-app route exists only if OQ8 says so.
5. **Feature default.** `prelabelEnabled` defaults to false per profile. Turn it on by default once S6 has validated the cut on ≥ 200 verified rows? (There is now an in-tab toggle, §9.1.)
6. **wasm fallback.** No WebGPU with shader-f16 means "unavailable". Ship the admin-only fp32/wasm override (1.75 GB, about 10 min per 2,000 rows), or leave it out entirely? *Critic recommendation: leave it out.* The spike says browsers without WebGPU and shader-f16 "should skip this feature rather than fall back" (spike §7 item 4, line 101). Dropping it also removes `prelabelAllowWasmFp32`, the second consent, and the wasm pin branch in §9.2.
7. **Weights provenance** (narrowed by the critic). Pin a specific HF commit through `env.remotePathTemplate` (recommended; §4.1, no infrastructure), or serve a same-origin mirror from `/assets/`? Unpinned `main` is no longer offered.
8. **In-app label export** (reframed by the critic). The approved export policy is already met by `browser-finetune/scripts/extract_wilson_labels.py`: verified-only by default, unverified per run, redacted by default. Build `/api/export/training/labels` at all? *Critic recommendation: not in B1.* If it is built, it uses the extractor's `source` vocabulary, defaults to `<AMOUNT>`, and goes through the §9.0 gate. Gating the existing `/api/export/training/*` routes belongs to judge P0b.
9. **Bulk confirm** (reframed by the critic). The approved policy says "one-click accept", not bulk. `isTrusted` and press-and-hold cannot tell a human from a CDP-driven agent. Bring bulk back at all? *Critic recommendation: no.* If yes, it would be a B1-b-only slice with `resolved_via='dashboard_bulk'`, the judge's cap of 10, and 409 `agent_present`.
10. **(New, critic) Extractor follow-up ownership.** B1-b's provenance is erased unless `extract_wilson_labels.py` (a different repo) reads `source` and `resolved_via` (§11). Who makes that change, and should B1-b's accept UI stay disabled until it lands? (Recommended: yes, keep it disabled.)
11. **(New, critic) Ship order against judge P0b.** Until P0b merges, the existing `POST /api/reviews/:id/confirm|correct` routes accept cross-site JSON POSTs: the server answers the preflight with 204 and `*`. With auth off, the server is also reachable from the LAN. B1-a does not make this worse, and its own routes are gated (§9.0). Is shipping B1-a before P0b acceptable? (Recommended: yes, with this as a known pre-existing issue.) Or should B1-a wait for P0b?

---

## 18. Critic revisions (revision 1 → 2, 2026-10-02)

This was an adversarial review. Every `file:line` claim in revision 1 was re-checked against `release/0.10.0` @ `bd83e8e` (main checkout), the judge spec (read-only), the spike report and results, the browser-finetune policy, applicability and extractor files, and `open-jev@0.1.2` `dist/` in the scratch install.

**Claims that held up (no change needed):**
- v27 is the highest migration, and the contiguity test is at `migrations.test.ts:35`.
- The v24 DDL and the partial index.
- `INSERT OR IGNORE`.
- Confirm and correct semantics, including that neither bumps `revision`.
- The categorize threshold and its routing at `:166/:180`.
- The review routes and `canWrite`.
- The `ReviewTab` and `ReviewQueueItem` shapes.
- The hybrid build and ORT paths.
- The category seed order and the `toSlug` and `resolveCategory` behaviour.
- `label_set_version` `cat-18-0f7b02225108`, re-computed by the critic.
- The extractor's `label_set_version`, its latest-resolved-row SQL and its row shape.
- Policy §4 lines `:202-227`.
- The open-jev API, its defaults (T 1.05, maxLength 512, maxStateTokens 256, `cut`) and its peer dependency.
- The spike numbers used in §4.1 and §7: the throughput arithmetic, 46/49 fp32 agreement, kev's 20/25 confident errors, the margin table, and q4-on-wasm failing.
- The spike template and option order (`harness/web/main.js:32-35`, `lists.json` equals `CATEGORIES` order).

**Corrections to citations:**
- C0. Judge `:844` (a zod line) → `:848`, `:922` (the error-shape rule).
- C0. `client.ts:262` → `:262-266`.
- C0. `harness/web/main.js` → `:69` for the margin definition.

**Substantive revisions:**

| # | Finding | Where fixed |
|---|---|---|
| C1 | **Privacy and CSRF hole.** Every non-MCP route sends `ACAO: *`, the server binds all interfaces, and auth is off by default (`server.ts:205-209`, `:191-192`; `auth.ts:14-19`). Revision 1 added `/api/prelabel/gold` (a raw verified ledger) and B1-b write routes on top of that, relying only on `canWrite`, which is a no-op with auth off | New §9.0 interim gate, with judge P0b's function names (judge `:351`, `:365`) and a re-export once P0b merges; tests in S3; L8; R13; OQ11 |
| C2 | **Consent leak.** Revision 1 called `OpenJev.info()` before the consent click. `info()` fetches `config.json` and every file's metadata from HF (`open-jev dist/index.js`), so L1 ("no HF request yet") could not pass. "About 351 MB" was also attributed to `info()`, which actually reports 357,050,727 B (spike §3) | §4.4, §5 (`info` is network), §10.2 copy, L1, S4 |
| C3 | **Unpinned weights are pinnable.** `env.remotePathTemplate` (transformers `types/env.d.ts:104`, `transformers.web.js:7454`) pins every file to one commit with no mirror. A `configSha` mismatch now fails closed instead of showing a click-through notice | §4.1 (`revision` pin), §4.4, protocol pins, S0, S4, L3, R6, OQ7 |
| C4 | **Scope creep: bulk confirm.** The approved policy says one-click accept. Revision 1 added a 25-row bulk confirm, and in B1-a it would mint unprovenanced "human" labels in batches over a still-CSRF-able route. `isTrusted` does not stop CDP-driven agents | Bulk removed from B1-a and B1-b (§0, §2, §9.2, §10.2, L8, L13, S10); R2, R14; OQ9 |
| C5 | **Scope creep and policy conflict: B1-c.** It contradicts `classifier-label-policy.md:225-227` and is outside the approved scope | Parked; no slice builds it (§2, §9.3, S13, L14, R3); OQ3 recommends dropping it |
| C6 | **Wrong confidence column.** B1-b accept wrote open-jev's `p1` into `transactions.category_confidence`, which the v24 backfill (`schema.ts:437`), `ConfidenceBadge` and the extractor (`:366`) read as the categorize LLM's confidence | §9.2 accept → `category_confidence = NULL`; S9 |
| C7 | **`too_new` was untestable and format-unsafe.** `created_at` defaults to `datetime('now')`, which has second resolution, so an injected clock cannot affect it. The ISO-vs-space format mix is the same bug as `store.ts:98` against `:156/:280` | §8.2: explicit `created_at` from the injected clock in SQLite format, JS comparison; S9, S10 |
| C8 | **Interim `agentPresent` copied a broken comparison.** ISO `expires_at > datetime('now')` is true all day | §9.2 uses `julianday` or JS; S10; escalated to the judge session |
| C9 | **Export provenance would be erased.** The extractor picks the latest resolved row and already owns `source` with different values (`extract_wilson_labels.py:456-464`). Revision 1's route renamed that vocabulary and was raw by default, the only unredacted training path. B1-b accepts would also reach the **extractor** as plain `review_confirm` | §11 is now conditional on OQ8, keeps the extractor vocabulary plus `prelabel_origin`, and redacts amounts by default; a cross-repo extractor follow-up blocks B1-b's accept UI (§13, S11, OQ10) |
| C10 | **Profile-switch race.** The server's active profile is global and transaction ids are per profile. A run could attach scores, or POST proposals, against another profile's rows | §5 profile binding, §9.2 409 `profile_changed`, S5, S10, L13b, R15 |
| C11 | **Worker message trust.** Shape validation alone let stale or unknown rows through | §5 `acceptResults` (runId, txnId set, label set, numeric ranges); S5 |
| C12 | **Injection surface into agent-facing tools.** `provenance_json` would hold browser-supplied free text in a table that judge P3's `list_review_queue` reads (judge `:695`) | §8.2 strict validation of every string; nothing free-form is stored; escalation that `list_review_queue` must keep `status='pending'` and never project B1 columns |
| C13 | **Lingering proposals.** Resolving through the existing route, or judge P2's `review_action`, left open-jev rows `proposed` forever | §8.2 sweep on list and insert; S9 |
| C14 | **No settings write path.** `prelabelEnabled` defaulted to false with no route or UI to turn it on, and the `off` state rendered nothing | §9.1 `PUT /api/prelabel/settings` (gated), `off` renders a toggle line; S3 |
| C15 | **Untestable slices.** S5 had no automated test, and the S0 guard passes vacuously in CI, which never builds `dist/` | New `session.ts` and `trusted-action-core.ts` with bun tests; `scripts/check-prelabel-bundle.ts` fails `build:hybrid` |
| C16 | **Runtime contexts not covered.** Workers have no `sessionStorage`. A LAN IP over http is not a secure context, so there is no `navigator.gpu` or `navigator.locks`. Vite dev makes the worker cross-origin, and `new Worker` throws. `isFallbackAdapter` is deprecated, and the spike saw `null`. Worker-scope WebGPU was never measured | §4.3 step 0/1/4, R17, path and typing note in §10.3 |
| C17 | **Cache staleness.** An edited description, amount or date kept its old cached score. R5 also claimed a `configSha` key that §7 did not have | §7 per-row state hash; R5 corrected |
| C18 | **Fixture isolation.** `OA_ROOT` comes from `homedir()` at import time (`src/profile/context.ts:5-6`), and `GET /api/profiles` lists real profiles, so `setActiveProfilePaths` alone was not enough | §15: re-exec with a temp `HOME`, and refuse to start otherwise |
| C19 | **Supply chain.** Dependabot fast-tracks 0.x minor bumps of `open-jev` | `.github/dependabot.yml` ignore (§13), R16 |
| C20 | **Collision table understated.** `server.ts` has uncommitted judge edits right now, and P0b rewrites the shared header object. Judge P2 changes `resolveCategorizationReview` semantics, which B1 reads | §1 rows, §13 risk raised to Medium, coupling note |
| C21 | **Measurement download was a ledger extract.** MeasurePanel JSON could include descriptions | §10.2: ids, labels and scores only |
| C22 | **Overstated claims.** "Training contamination is zero by construction", "margin recomputed" as an integrity control, and "≤2,000 items per runId" as a limit | §2, §9.2, R4 reworded honestly |

**Not changed (deliberately):** the B1-a/B1-b split; the v34 recommendation (with a sharper cost note); the 0.3 cut default; the lanes; zero edits to `api.ts`, `export.ts` and `categorization-review-queries.ts`; and the B2 seam.
