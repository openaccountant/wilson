# Content series: giving the finance chat a desk

Date: 2026-10-28
Source material: `docs/research/2026-10-28-lfm3-webgpu-workspace-teardown.md`, `docs/plans/2026-10-28-004-chat-workspace-plan.md`, `specs/chat-workspace-DECISIONS.md`
Format: one blog post per episode plus a 3–6 minute video. Record on real dashboard tabs with seeded persona data (standing rule: no Demo tab, never real user data).

Thread through the series: **small local models are good at looking and bad at deciding, so give them a desk and keep the ledger locked.**

---

## Ep 1: "Reading someone else's browser agent"
**Hook:** a 1.7B model runs a coding agent with a shell entirely in a browser tab. How?
**Claims:**
- The runtime is a single-model GGUF-on-WebGPU engine with about 55 hand-written WGSL shaders and no ONNX Runtime.
- The clever parts are in the loop: KV reuse across turns, failed-call memory, honest history.
- License reality: the app is Apache-2.0, but the engine is "supplied" with no license. We can learn from it, not ship it.

**Artifacts:** teardown doc, architecture diagram, the "already failed" message.
**Video beats:**
1. The Space running.
2. DevTools showing the worker, the IndexedDB weight cache and `Range` requests.
3. Walk through `controller.js`.
4. The license table.

**Capture now:** screen recording of the Space (Jd's machine, real browser), plus a DevTools Network and Application tab pass.

## Ep 2: "Why the browser can't keep your 1 GB model (yet)"
**Hook:** close the tab, come back, and you're downloading 1.1 GB again.
**Claims:**
- The Space never calls `navigator.storage.persist()`, so IndexedDB can evict the weights.
- Every site downloads the same weights again.
- Cross-Origin Storage (WICG) is a content-addressed cache shared across sites. What it fixes, what it doesn't, and why it must never hold user data.

**Artifacts:** COS section of the teardown, a before/after of `persist()`, the COS extension polyfill demo.
**Ties to:** Web AI Summit talk material (Tab segment).

## Ep 3: "The chat gets a desk; the ledger stays locked"
**Hook:** the split view: chat on the left, files on the right, over your real finances.
**Claims:**
- `/data` is a read-only, in-memory view of your books.
- `/workspace` holds your reports, saved on *your* machine.
- File edits can never change a transaction without an approval card (D1).

**Artifacts:** Phase 3 Playwright recording, the D1–D5 decisions table.
**Video beats:**
1. Ask for a dining report.
2. Watch `awk` run over `/data`.
3. Open and edit `report.md`.
4. Try to edit `/data/transactions.csv` and get refused.
5. Do it properly through the approval card.

**Capture during Phase 3:** the gate's Playwright run, a phone-width run, and the two-tab conflict banner.

## Ep 4: "Local-first doesn't mean browser-only"
**Hook:** we moved the files *out* of the browser, and it made the privacy story better.
**Claims:**
- The "server" is Wilson on your own machine, next to your SQLite.
- What saving on the server fixes: handoff, multiple tabs and browsers, eviction, CLI access.
- What it costs: a new write endpoint in the area our security reviews kept breaking.

**Artifacts:** before/after table from the planning conversation, Phase 2 route tests (role matrix, path fuzz, 409s).
**Capture during Phase 2:** test output and a short code walk of the version check.

## Ep 5: "Teaching a small model to fail once"
**Hook:** small models loop. Here's a 20-line fix.
**Claims:**
- Failed-call memory, failure as an exception, and keeping stopped partial replies out of history.
- Measured effect on our subagent dev sets (Phase 1 numbers, whatever they are, including if they're flat).

**Artifacts:** Phase 1 diff and before/after traces.

## Ep 6: "Grading the model's arithmetic"
**Hook:** can a local model total your groceries? We graded it against SQL.
**Claims:**
- The Phase 5 eval: exact-match totals, injection probes, the stop rule.
- Honest result: either the label comes off or it stays forever.

**Artifacts:** eval set, grades, and the stop-rule decision as written *before* the run.
**Note:** publish the bars before the results (pre-registration is the story).

---

## Capture checklist (keep updated as phases land)

| Phase | Capture | Status |
|---|---|---|
| 0 | Space recording + DevTools pass (Ep 1, 2) | todo (Jd's machine) |
| 1 | Before/after loop traces on dev sets (Ep 5) | code landed 2026-11-07 (`3fac09b`, `d7c81f3`, tests `2d26a59`); traces todo. Today's precision-first route makes one read and never retries, so a flat before/after on the Round 4 dev sets is the expected result; the memory pays off in the Phase 3 file loop |
| 2 | Route test output, version-check code walk (Ep 4) | todo |
| 3 | Playwright gate run, phone width, conflict banner (Ep 3) | todo |
| 5 | Pre-registered bars commit, then results (Ep 6) | todo |

## Guardrails for published material

- Seeded persona data only. No real accounts, balances or merchant history on screen.
- No machine paths or usernames in screenshots or code snippets.
- Credit upstream: Liquid AI (LFM3), webml-community (the Space), Earendil Works (Pi), Vercel (just-bash), and the WICG COS authors.
- Do not redistribute the Space's "supplied" runtime files or long excerpts from them.
