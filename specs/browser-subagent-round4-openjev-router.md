# Spec: Round 4, an open-jev tiebreaker for the browser subagent's read-tool router

**Repo / branch:** `cli/.claude/worktrees/browser-subagent`, branch `feat/browser-subagent`.
**Status:** spec only. No code. This file is the only change in its commit.
**Written:** 2026-10-03, **before** anyone has seen round-3 held-out results. The author did not open `specs/eval/heldout-router.v3.jsonl` or any round-3 or v3 eval file. That makes this a pre-registration: the margin-cut procedure (§5) and the go/no-go (§7) are fixed here, before the data that judges them exists.
**Direction approved by Jd.** These decisions are open for Jd to override: Q1 to Q8 in §12, and every rule marked *default*.

**Path abbreviations** (as in `specs/browser-subagent.md`)
- `H/` = `src/dashboard/ui/src/hybrid/`, `UI/` = `src/dashboard/ui/`, `S/` = `src/dashboard/ui/src/store/`.
- `B:` = the `feat/open-jev-annotator` worktree (`cli/.claude/worktrees/open-jev-annotator`, HEAD `51925f5`).
- `Spike` = `B:docs/spikes/2026-10-02-open-jev-webgpu.md`.

**Citations.** Every `file:line` in this tree points to committed HEAD `efc9f03`. Round 3 is editing `H/subagent-core.ts` in the working tree as this spec is written, so its line numbers may shift. Round-3 surfaces that are not committed yet (the template renderer, the what-if/comparison/trend gate additions, the arm names T/M6/M17) are named but not cited.

---

## 0. Why round 4

Round 2 showed where coverage is lost (`specs/eval/2026-10-03-round2-results.md:40-50`):
- The deterministic front is accurate. 63 of 66 keyword-routed read rows hit the right tool.
- 28 read rows passed the gate and then had zero or several keyword hits. All 28 were handed off with no model call (`:47`, column "Router-none").
- In slice 8, the old 0.6B LLM tiebreak got only 6 of 30 such rows right (`specs/eval/2026-10-02-slice8-results.md:47`). That result is why Round 2 removed it (`specs/DECISIONS.md:24`).

The open-jev spike measured exactly this sub-problem:
- **When the question really is a read, open-jev picks the right one of the 5 read tools 33 of 34 times, at about 100 ms** (Spike `:11`, `:81`, `:84`).
- It failed on `none`: it recalled 2 of 8 none rows (`:82`).

In round 4, `none` is never one of open-jev's options. The rule gate has already removed mutation, non-data, what-if, comparison and trend questions before open-jev runs. open-jev only breaks ties and fills gaps among the 5 reads, and only when its margin clears a cut that is frozen in advance. Everything below the cut goes to the server, as in round 3.

Round 4 adds **no generative model** to this path. The answer is round 3's deterministic template (`specs/DECISIONS.md:34`). Qwen is not loaded for subagent turns. Bundle-mode Q&A (no usable mirror) is unchanged.

---

## 1. Pipeline

```
question
  │
  ├─ RULE GATE (round 3, unchanged): mutation / non-data / what-if / comparison / trend ──► server
  │     (main thread, before any download; H/client.ts:511-521 today)
  │
  ├─ prepareMirror() (unchanged): stale ──► server;  unavailable ──► bundle mode (Qwen, as today)
  │
  ├─ KEYWORD ROUTER (unchanged rules, H/subagent-core.ts:189-205)
  │     exactly 1 hit ─────────────────────────────────────────► that tool  (via: 'keyword')
  │     0 or ≥2 hits ──┐
  │                    ▼
  ├─ OPEN-JEV TIEBREAK (new, arm O)  — only if available, consented, loaded (§4.4)
  │     choice() over the 5 read tools, options = name + catalog description (§3)
  │     margin = p1 − p2
  │     margin ≥ CUT  AND  (0 hits, or top1 ∈ hit set)  ──────► top1  (via: 'openjev')
  │     otherwise, or arm unavailable / not ready / timed out ─► server (reason 'router-none')
  │
  ├─ FILL_ARGS → mirror EXECUTE (unchanged; args-unfillable / empty / all-zero ──► server)
  │
  └─ round-3 TEMPLATE answer (no generation) ──► "answered locally · on-device lookups"
```

Rules (all *default* unless Jd approved them):
1. **open-jev never sees a question with exactly one keyword hit.** A single hit stays the keyword tool, as in round 2. Its 63/66 record is not reopened.
2. **The options are the 5 read tools and nothing else.** `none` is not offered: the gate does that job, and the spike showed open-jev cannot (Spike `:82-83`).
3. **Multi-hit consistency** (*default*). If the keyword router matched 2 or more tools and open-jev's top1 is not one of them, the turn hands off. A disagreement between two independent signals is treated as uncertainty. Zero-hit turns have no such check.
4. **One cut, frozen.** `OPEN_JEV_ROUTE_CUT` is chosen by §5 on dev data only and committed before the v3 arm-O run. It is not a user setting, and it is separate from B1-a's per-profile `prelabelMarginCut` (`B:src/prelabel/config.ts:57,75-78`).
5. **The wire reason stays `router-none`.** That value is already in the shared enum (`src/dashboard/local-handoff-format.ts:26`, `H/core.ts:212`), so the server's zod schema does not change. The detail (unavailable, low margin, inconsistent, timeout) goes in the step event (§4.3) and the eval record, not on the wire.
6. **The server is the fallback for everything.** Every arm-O failure (model missing, lock held by another tab, decide error, timeout, NaN margin) resolves to `router-none`, which is exactly round-3 behaviour. Nothing throws into the UI. This is the hybrid contract (`H/client.ts:17-23`).

---

## 2. What exists today (verified)

**Subagent (this branch, HEAD `efc9f03`)**
- **Gate.** The two-sided `gateQuestion` (`H/subagent-core.ts:145-157`) runs on the main thread before the probe, the mirror and any download (`H/client.ts:506-521`).
- **Keyword router.**
  - `ROUTE_RULES` and `keywordRoute` are at `H/subagent-core.ts:189-205`.
  - Precision-first: `hits.length !== 1` hands off as `router-none` with no model call (`:997-1001`).
  - The route event already carries a `via` field: `'keyword' | 'llm'` (`H/worker-protocol.ts:120`).
- **The loop runs in the model worker.**
  - `model.worker.ts:120-157` handles `subagentRun`.
  - The client loads Qwen before every subagent run (`H/client.ts:440-443`) and then calls `backend.subagentRun` (`:448-461`).
  - Today the run composes with Qwen (`H/subagent-core.ts:1009-1015`). Round 3 replaces that with templates.
- **`SubagentInput`** has no route hint today (`H/subagent-core.ts:748-756`, `H/worker-protocol.ts:145-153`).
- **Wiring from the app.** The app supplies the mirror half of a turn through `TryLocalOpts.subagent.prepareMirror` (`H/client.ts:112-126`), wired in `UI/src/hooks/useHybridChat.ts:136-145`. Round 4 adds its tool-choice dependency the same way.
- **Feature flag.**
  - `LOCAL_SUBAGENT_DEFAULTS = {enabled:false, maxSteps:3}` (`src/model/local-chat.ts:39`).
  - The env override accepts only the literal `1` (`:48`).
- **Read-tool descriptions.** The catalog strings are at `src/mcp/tool-catalog.ts:92,100,109,118,127-129`.
- **Build.**
  - `build:hybrid` runs vite, then `copy-ort-web-assets`, then `check-hybrid-build` (`UI/package.json:9`).
  - Root checks: `test` is `bun test --isolate` (`package.json:18`) and `typecheck` is `tsc --noEmit` (`:17`).

**open-jev pre-labeler, B1-a (`feat/open-jev-annotator`, not merged)**
- **Pins.** `PRELABEL_MODEL` (`B:src/prelabel/config.ts:38-48`):
  - repo `onnx-community/open-jev-deberta-v3-large-ONNX`, `q4f16`, `webgpu`, `temperature 1.05`;
  - revision `7c79f25b…`, a `configSha`, and `approxDownloadBytes 350,631,305`.
- **Worker engine (`B:UI/src/prelabel/worker-core.ts`):**
  - Capability ladder: no `navigator.gpu`, a fallback or SwiftShader adapter, or no `shader-f16` all give `unavailable`. There is no wasm fallback (`:141-171`).
  - The revision is pinned and `config.json` is sha-checked before any weights download (`:176-186`, `:264-278`).
  - Load with a warmup decision (`:250-345`).
  - Labels are fixed at `init` (`:192-203`). The categorize question is hardcoded (`B:UI/src/prelabel/core.ts:32-37`).
  - One batch `run` at a time; a second one gets `run_in_progress` (`:353-356`).
  - The engine yields between rows (`:396`).
- **The worker shim does not await `handle`** (`B:UI/src/prelabel/worker.ts:44-47`). A second message is therefore processed while a run is in flight.
- **Protocol.** `ToWorker`/`FromWorker` are versioned (`v:1`) and strictly parsed: any extra key rejects the message (`B:UI/src/prelabel/protocol.ts:33-40,58-95,105-109`).
- **Controller (`B:UI/src/prelabel/controller.ts`):**
  - Spawns `${baseUrl}/assets/prelabel-worker.js` (`:326`). A dev cross-origin `SecurityError` maps to `dev_cross_origin` (`:327-330`).
  - Idle terminate after 5 min (`:36`, `:198-208`).
  - Opt-in key `wilson-prelabel-optin:v1:<revision>` (`:40`). The consent click takes the lock and then loads (`:456-466`).
  - On a profile change it abandons the model (`:358-363`).
- **Web Lock.** Named `wilson-prelabel`, taken `ifAvailable` only when about to load (`B:UI/src/prelabel/session.ts:360-385`, `:404-420`).
- **B's `build:hybrid`** adds `vite.prelabel.config.ts` and `check-prelabel-bundle.ts` (`B:UI/package.json:9`). The **same line** is edited on this branch, so the two will conflict.

**Spike numbers this spec relies on** (one M4 Pro, n = 42 to 49, ±10 to 13 pp)

| Measure | Value | Spike |
|---|---|---|
| Read-tool accuracy, 6 options (5 tools + none) with descriptions | 33/34 | `:81` |
| Route decide, warm, p50 / p95 | 81–112 / 83–126 ms | `:41` |
| First decision of a session (shader compile) | 194–512 ms | `:45` |
| Cold load (download + session) / warm-cache load | 18.2–24.3 s / 1.0–1.4 s | `:51` |
| Download, `OpenJev.info()` / bytes over the network | 357,050,727 / 363,516,153 B | `:51,53` |
| Categorize with `name: description` options vs bare labels | 26.5% vs 61.2% | `:38-39,76` |
| Confidence of correct read-tool answers (6 options) | 0.26–0.73 | `:82` |

---

## 3. Options: short tool descriptions, not bare labels (decision)

**Decision.** Each option is the tool name plus its catalog description, rendered the way the spike rendered it (`choice(question, names, descriptions)`, `B:docs/spikes/2026-10-02-open-jev-webgpu/harness/web/main.js:36-38`). The description strings are copied verbatim from `src/mcp/tool-catalog.ts:92,100,109,118,127-129`.

The question text is `Which tool should answer this user question?`. This is the spike's text with the `none` sentence removed, because `none` is not an option.

**Why descriptions here, even though the spike found that descriptions hurt categorize**
1. **Route is the measured configuration.** Route used tool descriptions and scored 33/34 on reads (Spike `:30`, `:81`). Bare tool names were never measured for routing.
2. **The categorize collapse came from a magnet option.**
   - In categorize, 36 of 49 predictions went to `Other`, whose description is "Transactions that do not fit any other category" (Spike `:76`).
   - Round 4's option set has no catch-all. `none` is removed, and every remaining description names a concrete report.
3. **Bare labels carry little meaning for this task.**
   - The labels are snake_case identifiers (`profit_loss`, `net_worth`).
   - In categorize, the bare labels were natural words ("Groceries"). Here they are not.
4. **Cost is acceptable.**
   - Descriptions roughly double the sequence length and the time (Spike `:46`).
   - The measured route p95 is still about 126 ms, against a 2 s handoff bar.

**Guard rails**
- The rendered option strings live in a frozen constant (§9, `H/openjev-route.ts`).
- A snapshot test asserts that they equal the catalog descriptions, following the `read-tool-schemas.ts` pattern (`H/read-tool-schemas.ts:1-9`). A catalog edit then fails the test instead of drifting silently.
- Option tokens must stay under B1-a's `MAX_OPTION_TOKENS` (200) (`B:UI/src/prelabel/worker-core.ts:33`).

**Pre-registered fallback.** If §5 finds **no viable cut** with descriptions, the same §5 procedure is run **once** on the same dev data with bare tool names. The first configuration that yields a viable cut is frozen. If neither does, arm O ships disabled. This is the only option-text comparison allowed, and it uses dev data only.

---

## 4. Model sharing with B1-a

### 4.1 One model, one worker, one GPU session

- **One pinned model.** Round 4 uses B1-a's `PRELABEL_MODEL` pins unchanged: same repo, revision, `configSha`, dtype and temperature. It adds no second open-jev pin.
- **One worker per tab, owned by a new shared host.**
  - Ownership moves from `B:UI/src/prelabel/controller.ts` into an app-level singleton, `UI/src/openjev/host.ts`, the "open-jev host".
  - The host owns:
    - the single `prelabel-worker.js` instance (file name kept, so B's build and its guard are unchanged);
    - the capability verdict;
    - the Web Lock gate (`createLockGate`, name `wilson-prelabel`, unchanged so tabs running the old and new code still exclude each other);
    - the opt-in key;
    - the 5-minute idle timer;
    - load and dispose.
- **Two clients use the host.**
  - The **pre-labeler** (Review tab) keeps its session, lanes, scores and per-profile binding. It now asks the host for the model instead of spawning a worker.
  - The **chat router** asks for a single `choose` decision (§4.2).
- **Reference counting.**
  - Each client `acquire()`s and `release()`s the host.
  - The model is disposed (and the lock released) only when no client holds it and the idle timer fires. B1-a's existing release triggers (idle, fatal error, crash, unmount) stay the same.
  - B1-a's profile-change path (`controller.ts:358-363`) now resets the **pre-labeler session** and calls `release('prelabel')`. The model is profile-independent, so chat keeps it if chat holds it.

### 4.2 Engine: a `choose` request and one serialized decide queue

The B1-a engine is categorize-only. Labels are fixed at `init` (`worker-core.ts:192-203`), and the question is hardcoded (`core.ts:32-37`). Round 4 changes the engine as follows.

**Protocol (`v` stays 1, strict parse kept)**
- `ToWorker` gains `{v:1, type:'choose', reqId, state, question, options}`. Limits:
  - `options` has 2 to 8 entries and the same token guard as labels;
  - `state` is at most 512 characters.
- `FromWorker` gains `{v:1, type:'chosen', reqId, ok:true, choice, p1, p2, margin, top2, ms}` and `{v:1, type:'chosen', reqId, ok:false, reason}`.
- `init.labels` becomes optional. A chat-only host (Review tab never opened) inits with no labels, and warmup uses the route question.

**One decide mutex**
- Every `session.decide()` call, from a batch row or from a `choose`, goes through one queue in the engine.
- **`choose` has priority.** The batch loop already yields between rows (`worker-core.ts:396`). Before each row it now drains any pending `choose` first.
- So a chat decision waits at most for one in-flight batch row (about 70 to 90 ms, Spike `:39`), never for a 2,000-row run.
- No two `decide()` calls are ever in flight together on the one ORT session. The non-awaited shim (`worker.ts:44-47`) would otherwise allow it.

**The pure helpers are reused**
- `topTwo` (`B:UI/src/prelabel/core.ts:50-60`) computes the margin, so p1 − p2 has one definition in the codebase.

### 4.3 Chat side

**Where the choice is made.** It is resolved on the main thread of the hybrid chunk, before `subagentRun`. The model worker never talks to the open-jev worker.
- `TryLocalOpts.subagent` gains an optional `chooseTool(question, signal): Promise<ToolChoice | null>`.
- `useHybridChat` supplies it from the host, the same pattern as `prepareMirror` (`UI/src/hooks/useHybridChat.ts:136-145`).

**Flow in `H/client.ts`**, after `prepareMirror()` returns `ready` (`:526-536` today):
1. Run `keywordRoute(query)` on the main thread (pure, already exported).
2. If there is exactly 1 hit, call `subagentRun` with no hint. This is round 3, byte for byte.
3. If there are 0 or 2+ hits, call `chooseTool`. If it returns `null`, or the pure `decideRoute()` (§9) rejects the result, close the port and return the `router-none` handoff immediately.
4. Otherwise, pass `routeHint: {tool, margin, cut, hits}` in `SubagentRunInput`.

**The core re-checks the hint** (`H/subagent-core.ts` ROUTE, today `:995-1003`):
- A hint is honoured only when `keywordRoute` gives ≠ 1 hit, `tool ∈ READ_TOOLS`, `margin` is finite and ≥ `cut`, `cut` equals the frozen `OPEN_JEV_ROUTE_CUT`, and, for multi-hit, `tool ∈ hits`.
- If any check fails, the turn hands off as `router-none`.
- The core stays pure and keeps the invariant testable without a GPU.

**Step event.** The `route` event's `via` union gains `'openjev'`, plus optional `margin` and `cut` fields (`H/worker-protocol.ts:120`). `isWorkerToMain` is updated to match. The handoff payload is unchanged.

**Progress label.** "Picking the right lookup on this device…" while `chooseTool` runs, then the existing labels (`H/client.ts:415-420`).

### 4.4 When arm O is available on a turn

All of these must hold. If any fails, `chooseTool` returns `null` at once, and the turn behaves exactly as round 3 (keyword single match only).

| Condition | Source of truth | Otherwise |
|---|---|---|
| Server flag `subagent.openJevRouter` is on (new, default **off**; env `WILSON_LOCAL_SUBAGENT_OPENJEV=1` for local testing, literal `1` only, as at `src/model/local-chat.ts:48`) | `GET /api/config/local-chat` | arm off |
| The host's capability verdict is `ready` (WebGPU, not a fallback adapter, `shader-f16`) | B1-a ladder (`worker-core.ts:141-171`) | arm unavailable for the session |
| The user already consented ("Download once"): opt-in key set for the pinned revision | `controller.ts:40` | arm unavailable. **Chat never asks for consent and never starts a download.** |
| This tab holds, or can take, the `wilson-prelabel` lock | `session.ts:360-385` | arm unavailable this turn; never wait, never steal |
| The session is **loaded** when the turn starts | host state | this turn hands off. If the user opted in, the host starts a background load from cache (1.0–1.4 s warm, Spike `:51`), so later turns can use it. A chat turn **never waits for a load.** |
| `choose` returns within `OPEN_JEV_CHAT_TIMEOUT_MS` = 400 ms (*default*: about 3× the measured p95 of 126 ms plus one queued row) | host timer | `router-none` |

**Without WebGPU and `shader-f16`, arm O does not exist.** There is no CPU fallback: q4 on wasm fails to load, and fp32 is 1.75 GB (Spike `:66`, `:101`; B DECISIONS OQ6). Chat then behaves as round 3.

**Download consent is shared.** The 357 MB "Download once" consent in the Review tab is the only download path. Its copy changes to say that the same on-device model may also be used to pick lookups for chat questions when that feature is on. Whether chat should get its own consent entry point is Q3.

### 4.5 GPU co-residence

- Subagent turns no longer load Qwen (round 3 templates). On the subagent path, open-jev is the only GPU session.
- Qwen still loads for bundle mode and the Speed Showdown (`H/client.ts:384-391`, `:578-581`). Both models can be resident together. That is B1-a's untested risk R11 (`B:specs/open-jev-labeler.md:602`), and it is not made worse here.
- Slice R4-8 measures the subagent path with both models resident (spec C14 has never been measured, `specs/eval/2026-10-02-slice8-results.md:90`).

---

## 5. Choosing the margin cut on dev data only (pre-registered)

**Dev data** (all already burned, or never held out)

| Set | Rows | Why it may be used |
|---|---|---|
| `specs/eval/heldout-router.v1-burned.jsonl` | 123 (80 read, 43 none) | Burned (`specs/eval/README.md:5`; DECISIONS Round 3 `:37`) |
| `specs/eval/heldout-router.v2.jsonl` | 247 (206 read, 41 none) | DECISIONS Round 3 `:37` declares it burned and usable as a dev set |
| `B:docs/spikes/2026-10-02-open-jev-webgpu/harness/gold/route.json` | 42 (34 read, 8 none) | The spike's own set; the gate and keyword rules were also written against it (`specs/browser-subagent.md` D3) |

Rows are deduplicated by normalized question text (lowercase, collapsed whitespace). A duplicate keeps its first label in the table order above.

**The arm-O population A**
1. Run the **frozen round-4 front end** on every dev row: the round-3 gate as committed, the keyword rules, and the §3 options against the real pinned model on WebGPU, in the same harness as §7.
2. A = the rows that pass the gate and get 0 or 2+ keyword hits.
3. For each row in A, record: label (tool, or none/mutation), keyword hits, top1, p1, p2, margin, and whether the multi-hit consistency rule passes.

**Procedure** (implemented as a pure function, test-first, in `scripts/subagent-openjev-cut.mjs`)
1. Candidate cuts: c ∈ {0.05, 0.10, …, 0.95}. That is the 0.05 grid inside B1-a's valid range (`B:src/prelabel/config.ts:61-62`).
2. For each c, S(c) = rows in A with margin ≥ c that pass the consistency rule.
3. **Tool precision** P(c) = (read rows in S(c) whose top1 equals the label) / |S(c)|. A none or mutation row in S(c) counts as an **error**.
4. **Leak** L(c) = the number of none/mutation rows in S(c).
5. **Choose the smallest c** such that all of these hold:
   - P(c) ≥ 0.97;
   - L(c) = 0;
   - |S(c)| ≥ 20;
   - P(c′) ≥ 0.97 and L(c′) = 0 for **every** c′ ≥ c in the grid. This stability rule stops the procedure from picking a lucky dip.
6. **If no c qualifies:** run the §3 bare-label fallback once. If that also fails, set `OPEN_JEV_ROUTE_CUT = null` (arm O disabled), report "no viable cut on dev", and skip the v3 arm-O run.

**Report** (`specs/eval/<date>-round4-dev-cut.md` + `.json`)
- |A|, the chosen c, P(c), its Wilson 95% lower bound (informational), and L(c).
- Dev coverage gain: read rows newly routed correctly at c, divided by all dev read rows. Report it per tool and per source set.
- The full P/L/|S| curve, the margin histograms for correct, wrong and none rows, and per-decision p50/p95 ms.
- Expect small n. Round 2 had only 28 read and 4 none rows in A on v2 (`2026-10-03-round2-results.md:47-48`). Round 3's looser gate will change the count.

Tool precision is a proxy. The answer itself comes from round 3's templates, so answer quality is judged on v3 (§7), not here.

**Freeze**
- c, the option strings, the question text, the model pins (revision, `configSha`, temperature, dtype) and the sha256 of each dev file go into `specs/eval/round4-openjev-frozen.json`.
- `OPEN_JEV_ROUTE_CUT` in `H/openjev-route.ts` is set to c. A test asserts that the constant, the option strings and the question equal the frozen JSON.
- These land in **one commit, before the v3 arm-O run**. The harness refuses to run arm O on any file whose name matches `heldout-router.v3*` unless the frozen JSON's sha256 matches the hash recorded in the run command (`--frozen-sha`). This stops accidental re-tuning; it is not a security control.
- **Order with round 3.** The procedure runs on round 3's final committed gate. If round 3 changes any rule after its v3 results (and so burns v3), round 4 must also move to a v4.

---

## 6. What arm O does not change

- The gate, the keyword rules, `fillArgs`, the mirror executors, the round-3 empty/all-zero handoffs and the templates.
- The handoff wire format and the server.
- Bundle mode (Qwen), the Speed Showdown and `categorizeSample`.
- B1-a's user-visible behaviour: consent, lanes, margin setting, Web Lock semantics.
- `subagent.enabled` stays off by default. Issue #152 (TOOLS_REQUIRING_APPROVAL) is still a prerequisite for turning it on by default (DECISIONS Q3, `specs/DECISIONS.md:9`).

---

## 7. Measurement plan: arm O on v3

**Same rows, same harness, same clock and personas as round 3**
- Arms T (templates), M6 (Qwen3-0.6B compose) and M17 (Qwen3-1.7B compose) come from round 3. Round 4 adds **arm O = T + the open-jev tiebreak**.
- Run with `scripts/subagent-route-eval.mjs`, the same `--now`, `--personas-dir` and per-persona mirrors (`2026-10-03-round2-results.md:110-112`). Add `--arm O --frozen-sha <sha>`.
- The harness page spawns the **product** open-jev engine (B's `worker-core` via the host's worker) next to the product loop. It calls the same pure `decideRoute`.
- The run must be on real WebGPU and refuse fallback adapters, as in slice 8 and round 2.

**Blind grading** (the round-2/3 protocol)
- **Which rows get graded.**
  - Rows where O and T both answered locally with the **same tool and args** produce byte-identical template text. They inherit T's committed grade and are not re-graded.
  - **O-only answers** (T handed off; O answered) are graded.
  - So are **O-changed answers** (both answered, but with a different tool).
- **Keeping the grader blind.** The rows are mixed with a random sample of **20 of T's already-graded answers** (seeded, seed committed), so the grader cannot tell arm O from arm T.
  - All rows get opaque ids. The grader sees question, `answerNotes`, tool args and tool result, and answer text. It never sees arm, margin or route.
  - **Grades are committed before the id→arm key is opened.**
  - The re-graded T sample gives a grader-consistency figure: how often the new grade matches round 3's grade on identical text.
- **The rubric** is round 2's (`2026-10-03-round2-results.md:28-34`) plus any round-3 amendment.

**Reported per arm (T, M6, M17, O)**
- Coverage: read rows answered locally / read rows, overall and per tool.
- Local precision, and wrong-or-useless rate.
- **Bar 1:** none/mutation diverted, plus none/mutation rows answered locally, broken down by route path.
- p95 time to handoff on gated, no-single-match (now including low-margin and inconsistent), and args-unfillable paths, warm. For O, report the decide's share separately.
- Arm O only:
  - |A| on v3, the margin histogram, and the O-only answers with their grades;
  - decide p50/p95; first decision after load;
  - **cold-load cost:** bytes over the network, cold load ms in a fresh profile, warm-cache load ms;
  - the share of turns that found the model not yet loaded (§4.4).
- GPU co-residence: whether a Qwen bundle-mode turn and an arm-O turn in one tab cause any device error.

**Go/no-go for arm O** (Round-2 bars, unchanged by Round 3, `specs/DECISIONS.md:27,40`)
- Arm O **succeeds** only if, on v3, **all** of these hold:
  - its coverage is **strictly higher than arm T's** (report the delta in rows and pp);
  - local precision ≥ 97%;
  - wrong-or-useless ≤ 3% of local answers;
  - bar 1 ≥ 95%;
  - p95 time to handoff ≤ 2 s.
- *Default, stricter than the bars:* **any** none or mutation row answered locally through arm O is a NO-GO for arm O. That is the spike's known failure mode (Spike `:82`). Jd may relax this (Q6).
- If arm T itself fails the bars, arm O cannot pass on top of it. Report O anyway.
- With few O-only answers, 97% allows zero errors (for example, n < 34). Say so in the report rather than averaging it away.

**Contamination caveat (binding)**
- By the time arm O runs, v3 will have been seen by round-3 graders and the round-3 report.
- That is acceptable **only because** round 4's router, options and cut are frozen on dev data (§5) before arm O touches v3.
- **Nothing in round 4 may be tuned on v3:** not the cut, the options, the question text, the consistency rule, the timeout, or the keyword or gate rules.
- If anything is changed after the v3 arm-O results are seen, v3 is burned for round 4. A **v4 from a fresh author** (no access to code, specs, v1 to v3 or results, as in DECISIONS Round 3 `:38`) is then required before any go.
- The author of this spec has not seen v3 or any round-3 result.

---

## 8. Toward the "local vs server" head (issue #145)

A later fine-tuned classifier could decide "answer locally or hand off" directly, instead of gate + keyword + margin. Below is what could feed it, and what may not.

**What is logged today**
- **Product, local answers.**
  - `POST /api/chat/local` records only `query`, `answer` and `sessionId` (`src/dashboard/server.ts:773-779`).
  - There is no tool, route or margin in that record.
- **Product, handoffs.**
  - The `localHandoff` block (reason, validated `{tool,args}` steps, proposal) is rendered into the server prompt.
  - It therefore reaches `llm_interactions.user_prompt` and the training export (`specs/browser-subagent.md` §17 Q5/C5). Q5 still governs whether that should happen.
- **Step events** (gate verdict, route `via`, tool ms and rows) go to the UI only and are not persisted (`H/worker-protocol.ts:117-122`).
- **Eval.**
  - Per-row result JSON: gate, route, outcome, reason, tool args and results, timings (for example `specs/eval/2026-10-03-round2-results.json`).
  - Per-answer grades JSON: `answerOk`, `useless`, `why` (`specs/eval/2026-10-03-round2-grades.json`).
- **What round 4 adds.** The route event's `via:'openjev'`, `margin`, `cut` and top-2, in the UI event and in the eval record. It adds **no new product persistence**. Persisting route features for real chats is a separate decision (Q7).

**Label policy (binding for any #145 training set)**
- **Labels come only from graded outcomes.** The label is `LOCAL_OK` only when the row was answered locally and a blind grader marked it good (tool correct, `answerOk`, not `useless`). The label is `SERVER` when a grader marked a local answer wrong-or-useless, or when the row's author-written gold label is none or mutation.
- **Never auto-labels.** None of these may be a training target:
  - handoff reasons (`args-unfillable`, `empty-result`, `ungrounded`);
  - open-jev margins or top1;
  - keyword hit counts;
  - a model's own confidence;
  - "the server answered fine";
  - the absence of a user complaint.

  They may be **features**, never labels.
- **Burned sets only.** Burned sets (v1, v2, and v3 after round 4) and dev sets may be used for training. The **current** held-out set never is.
- **Real users' chats** are not collected for this without an explicit local opt-in. Data stays local (privacy-first, CLAUDE.md). This follows `browser-finetune/docs/2026-09-22-classifier-label-policy.md` (cited at Spike `:102`).

---

## 9. File-by-file changes

**This branch (A)**

| File | Change | Slice |
|---|---|---|
| `H/openjev-route.ts` (new, pure, zero-import apart from types) | `OPEN_JEV_ROUTE_OPTIONS` (name → catalog description), `OPEN_JEV_ROUTE_QUESTION`, `OPEN_JEV_ROUTE_CUT` (null until §5 freezes it), `OPEN_JEV_CHAT_TIMEOUT_MS`, `type ToolChoice`, `decideRoute(hits, choice, cut)` → `{tool, via:'openjev'} \| {handoff:'router-none', why}` | R4-1 |
| `H/subagent-core.ts` | ROUTE honours a validated `routeHint` on ≠1 hit (re-check §4.3); emits `via:'openjev'` with margin and cut | R4-2 |
| `H/worker-protocol.ts` | `SubagentRunInput.routeHint?`; `StepEvent.route.via` gains `'openjev'`, optional `margin`/`cut`; guards updated | R4-2 |
| `H/client.ts` | `SubagentTurnOpts.chooseTool?`; main-thread `keywordRoute` and `chooseTool` after `prepareMirror` `ready`; port closed on an immediate handoff; progress label | R4-6 |
| `UI/src/hooks/useHybridChat.ts` | supplies `chooseTool` from the open-jev host | R4-6 |
| `src/model/local-chat.ts` | `subagent.openJevRouter` (default false) + env override | R4-6 |
| `scripts/subagent-openjev-cut.mjs` (+ `.d.mts`) | pure §5 selection | R4-3 |
| `scripts/subagent-route-eval.mjs`, `scripts/subagent-route-eval/*` | `--arm O`, `--frozen-sha`, refuse v3 without a matching frozen hash, record margin and top-2 | R4-3, R4-8 |
| `specs/eval/round4-openjev-frozen.json`, `specs/eval/<date>-round4-dev-cut.{md,json}` | outputs of R4-3 | R4-3 |
| `scripts/check-hybrid-build.ts` | merge B's `prelabel-worker.js` allowlist (spec C14) with this branch's banner rule | R4-7 |
| `specs/browser-subagent.md` | §24 "Round 4" pointer to this file, written after implementation | R4-8 |

**From B (after merge or extraction, §10)**

| File | Change | Slice |
|---|---|---|
| `UI/src/prelabel/protocol.ts` | `choose`/`chosen` messages; optional `init.labels`; strict parse kept | R4-4 |
| `UI/src/prelabel/worker-core.ts` | one decide mutex; `choose` priority between batch rows; chat-only warmup | R4-4 |
| `UI/src/openjev/host.ts` (new) | worker, lock, opt-in, idle, refcount, `choose()` with timeout and no load-wait | R4-5 |
| `UI/src/prelabel/controller.ts` | spawn/lock/idle moved to the host; profile change resets the session and releases the host | R4-5 |
| Consent copy (Review tab panel) | mentions the chat use | R4-5 |

**Tests (written first)**
- `src/__tests__/openjev-route.test.ts`;
- `subagent-precision.test.ts` (extended) and a new `subagent-openjev-hint.test.ts`;
- `hybrid-worker-protocol.test.ts` (extended);
- `hybrid-client-subagent.test.ts` (extended);
- `subagent-openjev-cut.test.ts`;
- `openjev-route-options-snapshot.test.ts`;
- B's `prelabel-worker-core` tests (extended: `choose`, interleaving);
- `openjev-host.test.ts`;
- all of B1-a's controller tests, unchanged and green.

---

## 10. Branch dependency: how A gets open-jev (Q1)

`feat/open-jev-annotator` is not merged. Both branches fork from `bd83e8e`. Its engine, protocol, controller, pins and worker build are what §4 reuses. Three options:

| Option | How | Pro | Con |
|---|---|---|---|
| **(a) Merge order: B1-a first** | B1-a merges to `release/0.10.0`; A rebases; round 4 builds on it | No duplicated code; B's tests and L-steps already exist | A waits on B's review. Conflict on `UI/package.json:9` (`build:hybrid`) and the build-check scripts |
| **(b) Extract a shared module first** (*recommended if B1-a is not about to merge*) | A small PR `feat/openjev-core` off `release/0.10.0`: pins (`config.ts`), `protocol.ts`, `worker-core.ts`, `worker.ts`, `vite.prelabel.config.ts`, the build guard, plus the R4-4 engine changes. B and A both rebase onto it | Unblocks A without B's UI; the engine changes land once with their tests; B's diff shrinks | One more PR; B must rebase |
| (c) Copy B's files into A | none | fastest | Two engines drift; rejected |

**Either way, the R4-1 to R4-3 slices do not need the merge.**
- These are the pure route module, the core hint and the dev cut.
- The dev run can load open-jev directly in the eval page with the **same pins and option strings** (from `H/openjev-route.ts`).
- Once the product engine is available, R4-8 adds a parity check: product engine vs eval engine on 10 dev rows give identical top-2 (±1e-4).

**Recommendation:** (b) if B1-a is blocked on anything (for example judge P0b, `B:specs/open-jev-labeler.md:627`); otherwise (a).

---

## 11. TDD slices

Each slice writes its tests first and watches them fail for the right reason before writing code.

**Done for every slice:**
- `bun test --isolate` is green;
- `bun run typecheck` is clean;
- `cd src/dashboard/ui && npm run build && npm run build:hybrid` succeeds, including `check-hybrid-build` (and B's bundle check once merged);
- `dist/index.html` contains no `open-jev`, `onnxruntime` or `@huggingface/transformers`.

**R4-0. Preconditions (no code)**
- Confirm that round 3 is committed, and that in template mode a subagent turn does not call `loadModel` (today it does, `H/client.ts:440-443`).
- If round 3 left the load in, R4-0 becomes a code slice. Its test: with templates, `subagentRun` succeeds with no `load`/`generate` call on the fake backend. Its change: skip the load for template mode.
- Done: precondition recorded in the slice notes.

**R4-1. Pure route decision (`H/openjev-route.ts`)**
- Tests:
  - 1 hit ignores any choice;
  - 0 hits with margin ≥ cut gives top1;
  - margin < cut, NaN or ∞ margin, unknown tool, or `cut === null` all give `router-none`;
  - multi-hit with top1 ∉ hits gives `router-none`;
  - multi-hit with top1 ∈ hits gives top1;
  - the options never include `none`;
  - the option strings equal the catalog descriptions (snapshot);
  - total option tokens stay under 200 with a stub counter.
- Done: all of the above.

**R4-2. Core accepts a validated hint**
- Tests:
  - a hint with 1 keyword hit is ignored (tool is the keyword one, `via:'keyword'`);
  - a forged hint (cut ≠ frozen, margin < cut, tool outside the hits) gives `router-none`;
  - a valid hint executes exactly one tool and emits `via:'openjev'` with margin;
  - `generate` is never called in template mode;
  - the protocol guard accepts the new fields and rejects extra keys;
  - the existing `subagent-precision.test.ts` assertions still hold.
- Done: the loop property test (it always resolves, never rejects) is still green.

**R4-3. Dev cut selection and freeze**
- Tests (pure, synthetic margins):
  - picks the smallest stable c;
  - rejects a c with a leak;
  - rejects a c with |S| < 20;
  - the stability rule skips a lucky dip;
  - returns `null` when nothing qualifies;
  - dedupe keeps the first label;
  - the harness refuses `heldout-router.v3*` without a matching `--frozen-sha`.
- Then: the real WebGPU run on dev, the report, and the freeze commit (§5).
- Done: `round4-openjev-frozen.json` committed; `OPEN_JEV_ROUTE_CUT` equals it (test).

**R4-4. Engine `choose` and decide mutex** (needs §10 a or b)
- Tests with a fake OpenJev:
  - `choose` before `load` gives `ok:false not_loaded`;
  - `choose` during a 200-row run is answered after at most one more row;
  - never two `decide` calls in flight;
  - a chat-only init (no labels) warms up and answers;
  - strict parse rejects extra keys and options outside 2 to 8;
  - B1-a's existing worker tests are unchanged and green.
- Done: as above.

**R4-5. Shared host**
- Tests with a fake worker, locks, storage and timers:
  - one worker for two clients;
  - the lock is taken only on load after consent;
  - chat never triggers `info` or a download without opt-in;
  - when not loaded, chat returns `null` and (if opted in) starts a background load;
  - another tab holding the lock gives `null`;
  - the 400 ms timeout gives `null`;
  - a profile change resets the prelabel session but keeps the model while chat holds it;
  - the model is disposed when the refcount is 0 and the idle timer fires.
- Done: all B1-a controller tests unchanged and green.

**R4-6. Client wiring and flag**
- Tests in `hybrid-client-subagent.test.ts`:
  - flag off: byte-identical to round 3 (no `chooseTool` call);
  - 1 hit: no `chooseTool` call;
  - 0/2+ hits with `chooseTool` returning `null`: `router-none` before `subagentRun`, port closed;
  - a valid choice passes `routeHint`;
  - `chooseTool` throwing gives `router-none`, never `{ok:false, reason:'error'}` surfacing in the UI;
  - the config parse defaults `openJevRouter` to false.
- Done: as above.

**R4-7. Builds**
- Tests: `hybrid-build-gate.test.ts` covers both bundles:
  - one ORT banner per bundle;
  - `prelabel-worker.js` is allowlisted;
  - no third transformers copy.
- Done: both builds green.

**R4-8. Measurement on v3 (no product code)**
- §7 run, blind grading, report `specs/eval/<date>-round4-results.md` + JSON.
- Product-engine vs eval-engine parity on 10 dev rows.
- GPU co-residence check.
- Done: report committed; `subagent.enabled` and `openJevRouter` unchanged (off).

---

## 12. Open Questions for Jd

1. **Q1: branch dependency.** Merge B1-a first (a), or extract `feat/openjev-core` first (b)? Recommendation: (b) unless B1-a merges this week (§10).
2. **Q2: multi-hit rule.** Should open-jev's top1 have to be one of the keyword hits when there are 2+ hits (current *default*), or be free over all 5 tools as in the approved direction?
3. **Q3: consent surface.** Is the Review tab's "Download once" consent, with the amended copy, enough for chat to use the model? Or should chat (or Settings, issue #88) get its own opt-in? Today chat never asks for consent and never downloads.
4. **Q4: minimum lift.** Should arm O need more than "strictly higher coverage than T", for example +5 pp, to justify a 357 MB download for users who never use the Review tab?
5. **Q5: grader.** A fresh grader for the O-only rows (*default*), or the round-3 grader? A fresh grader avoids anchoring. The round-3 grader is more consistent with T's grades. Either way, the 20-row T re-grade measures consistency.
6. **Q6: none-leak rule.** Keep "any none/mutation row answered locally through arm O is a NO-GO" (stricter than the Round-2 bars), or count it only through bars 1 to 3?
7. **Q7: persistence for #145.** Should route features (`via`, margin, top-2, handoff reason) be persisted locally for real chats, behind an opt-in, so they can later be paired with graded outcomes? Nothing is persisted by default. Labels would still come only from grading (§8).
8. **Q8: lock name.** Keep `wilson-prelabel` for the shared model (*default*: no cross-version double load), or rename it to something like `wilson-openjev` with a one-release compatibility shim?

---

## 13. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| A none question passes the gate with 0 keyword hits, open-jev confidently picks a read tool, and a template answers it | Medium / high (the spike's failure mode) | No `none` option, but: the cut requires zero leak on dev (§5); args-unfillable, empty and all-zero handoffs downstream; the §7 none-leak NO-GO |
| Dev n is small, so a 97% cut is noisy | High / medium | Stability rule, \|S\| ≥ 20, Wilson bound reported, v3 decides |
| Overfitting the cut to dev phrasing (the spike set echoes the tool descriptions, Spike `:89`) | Medium / medium | Three sources from different authors; v3 is the judge; no tuning on v3 |
| A long Review-tab run delays a chat decision | Medium / low | Decide mutex with `choose` priority; 400 ms timeout leads to `router-none` |
| A chat turn arrives while the model is cold | High on first use / low | Never wait; hand off and warm in the background; report the share in §7 |
| Qwen and open-jev are both resident (bundle mode or Showdown + arm O) | Low / medium | R4-8 co-residence check; idle dispose on both sides |
| Catalog description edits silently change routing | Low / medium | Snapshot test (§3) and the frozen JSON |
| `open-jev` 0.x minor bump changes option rendering or temperature | Low / high | B1-a's Dependabot ignore (`B:specs/open-jev-labeler.md:504`); pins recorded in the frozen JSON; parity check |
| Merge conflict on `build:hybrid` and the build checks | Certain / low | R4-7 merges both checks; done once in §10 (a) or (b) |
| Crafted merchant text in the question steers open-jev | Low / medium | open-jev only picks among 5 reads; it cannot write args or answers; args stay rule-based and re-validated by the mirror and the server |
