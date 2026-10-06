# Slice 8: measurement and go/no-go for the browser subagent

Branch `feat/browser-subagent`, measured at HEAD `f2db5f9` (slice 7), 2026-10-03. No product code changed.
Spec: `specs/browser-subagent.md` D3 and slice 8. Decisions: `specs/DECISIONS.md` Q8 (critic-amended D3 bars), Q9 (measure per-step cost).

## Verdict: NO-GO. Do not flip `subagent.enabled`.

The held-out set decides, and it fails two of the three D3 bars by a wide margin:

| Bar (Q8 / D3) | Spike gold (42, optimistic) | **Held-out (123, decides)** | Held-out result |
|---|---|---|---|
| none / mutation rows diverted >= 95% | 8/8 = 100% | **42/43 = 97.7%** | pass |
| read rows routed correctly >= 90% | 31/34 = 91.2% | **40/80 = 50.0%** | **FAIL** |
| read rows falsely gated <= 10% | 0/34 = 0% | **15/80 = 18.75%** | **FAIL** |
| [C4] >= 15 mutation rows with no denylist verb, all diverted | n/a (no such rows) | 14 rows, 14/14 diverted | **set is one row short**; behaviour passes |
| [C3] local answer never built on an empty search | 0 violations | 0 violations | pass |
| [C15] p95 time to handoff <= 2 s (gated, router-none, args-unfillable; warm) | 136 ms | **142 ms** (n=87) | pass, with the caveat under "Not measured" |

The gold column is reported separately as asked. It is optimistic by construction (the gate and keyword rules were written with those 42 rows visible, spec D3), and it passes. The held-out column is the one that counts.

**Held-out set status: NOT burned.** I changed no gate, router, args or any other product rule after seeing the held-out set. I did read its per-row outcomes while writing this report (that is measurement, not tuning). **If anyone tunes the gate, keyword rules, router prompt or `fillArgs` in response to the numbers below, `heldout-router.jsonl` is burned and a fresh set from a fresh author is required before the next go/no-go.**

## What was measured, and how

- **Real WebGPU.** Full Chromium 153 (Playwright `channel: 'chromium'`, headless, the `c-web.mjs` pattern; fallback/software adapters are refused). Adapter reported: vendor `apple`, architecture `metal-3`, `isFallbackAdapter: false`, `shader-f16: true`. The page is **not** cross-origin isolated, like the dashboard.
- **Real model and loop.** `onnx-community/Qwen3-0.6B-ONNX`, dtype `q4f16`, loaded by the product's `createModelEngine` in a module Web Worker. The loop is the product's `runSubagent` unmodified: gate, keyword router, LLM tiebreak/choice, `fillArgs`, tool step, next-action generation, compose, `classifyLocalOutput`, `isGrounded`.
- **Real mirror executors, bun:sqlite, not wa-sqlite.** The worker's only substitution is the mirror port: an HTTP bridge to `scripts/subagent-route-eval-server.ts`, which runs the product's `handlePortMessage` -> `mirrorExecuteRead` (args re-validated) over the synthetic net-worth parity fixture (`buildNetWorthFixture`, clock pinned to 2026-07-15). Synthetic data only; the sidecar ran with a scratch `HOME`.
- **Scoring.** `scripts/subagent-route-score.mjs` (test-first: `src/__tests__/subagent-route-score.test.ts`, seen failing on the missing module, then 10/10 green). A none row is "diverted" if it never reached a read tool. A read row is "routed correctly" if the gate passed it and the first tool chosen equals the label. "Falsely gated" is a read row the gate sent to the server.
- **Repeatability.** Two full runs (greedy decoding) produced identical routes, reasons, outcomes and answer text on all 191 rows. Numbers below are from run 2 (`2026-10-02-slice8-results.json`).
- **C3 on the persona seed.** `scripts/subagent-route-eval-c3.ts` runs `fillArgs` and the real server `transaction_search` on persona 1's rows (copied from the existing persona test, clock 2026-07-15). Raw output: `2026-10-02-slice8-c3-persona.json`.

## Held-out detail (123 rows: 80 read, 43 none)

Where each label ended up (`gated` = diverted by the main-thread gate, `none` = the LLM router said none):

| Label | n | routed right | wrong tool | LLM said `none` | gated |
|---|---|---|---|---|---|
| transaction_search | 21 | 14 | 0 | 1 | 6 |
| spending_summary | 18 | 7 | 8 (all to transaction_search) | 2 | 1 |
| profit_loss | 15 | 5 | 4 | 2 | 4 |
| net_worth | 13 | 8 | 2 | 3 | 0 |
| forecast | 13 | 6 | 0 | 3 | 4 |
| none | 43 | (38 gated, 4 router-none) | 1 misrouted | | |

Why the read bar fails:

1. **The LLM router is the weak link.** Of the 65 read rows that passed the gate, the keyword router single-hit 35 and was right on 34 (97%). The other 30 went to Qwen3-0.6B: **6 right, 13 wrong tool, 11 `none`** (20% correct). On gold the same step was 2 of 5. This matches the spec's own caveat that no Qwen3-0.6B tool-choice measurement existed before this.
2. **Keyword coverage is only 44%** (35/80 single-hit). The fallback in D3 ("keyword single-hit only, otherwise handoff") scores 34/80 = **42.5%** on read rows (gold: 29/34 = 85.3%), so it does not rescue the bar either. It does keep none-diversion at 42/43.
3. **The allowlist side of the gate is too strict for terse imperatives.** All 15 false gates are noun-phrase or imperative openers outside `READ_START`: "any charges from hulu lately", "look up the payment to my landlord", "anything from Delta airlines in 2026", "lookup charge '...'", "monthly spend breakdown pls", "net income for the past 12 months", "revenue minus costs ...", "income statement for last year", "earnings vs outgoings since January", "based on current trends ...", "can I afford rent ...", "cashflow outlook ...", "if things keep going like this ...". Per D3 a false gate is the safe failure (the server answers), but it is 18.75% against a 10% bar.

Other bars on the held-out set:

- **None / mutation diversion 42/43.** Gate caught 38 (13 as `mutation-intent`, 25 as `non-data`); the LLM router said none on the 4 remaining (small talk / advice / weather). One miss: **"show me my credit score"** passes the gate, keyword-routes to `transaction_search` on `\bshow\b` with no LLM check, and ends in `empty-result` on this data. It is a wrong route, not a wrong answer here, but on a profile with a "credit score" merchant it would answer locally.
- **[C4].** Of the 21 mutation rows, 7 contain a verb that is in the current `MUTATION_VERB` list (mark, get rid of, flag, rename, put, move, split). The other **14 use none**, and **all 14 were diverted** (13 by the allowlist side as `non-data`, 1 as `mutation-intent` via the `ACTION_HINT` word "transfer"). All 21 mutation rows were diverted. The requirement is >= 15 such rows, so the set is one short; the behaviour is a pass.
- **[C3] on persona 1.** Rows the pipeline routed to `transaction_search`: 27 (14 are labelled `transaction_search`, 13 are misroutes). Outcome: 3 return rows, 10 `empty-result`, 14 `args-unfillable`. Zero local answers on an empty search (the loop hands off). Most relative-date and ordinal phrasings ("last week", "2 weeks ago", "the 3rd", "each bill", typos like "starbcks") are `args-unfillable`: 9 of the 14 labelled rows. That is safe but it is why only 23 of 80 read rows (29%) end in a local answer.
- **Local answers actually produced:** held-out 23 of 80 read rows; gold 22 of 34.

## Per-step cost (Q9) and latency, warm model

All times are ms, in a worker, real GPU. Greedy decoding, `max_new_tokens` 12 for router and next-action, 256 for compose. n = number of generations.

| Stage | n | p50 | p95 | max |
|---|---|---|---|---|
| gate (main thread, pure) | 191 | < 0.1 | 0.1 | 0.5 |
| mirror `status` round trip (HTTP bridge) | 130 | 0.9 | 1.2 | 2.4 |
| tool step (bridge wall / mirror exec in bun:sqlite) | 90 | 0.8 / 0.2 | 1.4 / 0.4 | 1.8 / 0.8 |
| router generation (12 tokens) | 45 | 133 | 150 | 164 |
| next-action generation (12 tokens) | 69 | 196 | 229 | 266 |
| compose generation (<= 256 tokens) | 69 | 360 | 1,044 | 2,120 |
| full answered run (status -> compose, model warm) | 65 | 564 | 1,309 | 2,352 |

- **Time to handoff, bar [C15] (p95 <= 2 s), held-out, n = 87:** p50 0 ms, **p95 142 ms**, max 146 ms. By path: gated p95 0.1 ms (n=53); router-none p50 134 / p95 140 ms (n=15); args-unfillable p50 120 / p95 146 ms (n=19). Gold (n=12): p95 136 ms.
- **Q9 maxSteps.** One extra step costs one next-action generation (~0.2 s) plus a tool call (~1 ms here), not the 0.3 to 1 s the spec estimated. But the model **never took a second step**: across 90 runs that executed a tool, `stepsPerAnsweredRun` was 1 in every case (max 1). So `maxSteps = 3` is cheap in latency and unexercised in practice; every run that executes a non-empty tool step pays one next-action generation (~0.2 s) that never chose another tool. I make no change; see escalation 3.
- **Model load.** Worker respawn with weights already cached in the same browser: **1.6 to 1.8 s** (1.56 s run 1, 1.82 s run 2). First load in a fresh browser process: 28.6 to 29.8 s, including the first-ever download (run 0 downloaded it at 29.6 s; later fresh processes took the same time, so I cannot claim cross-process cache reuse from this data).

## Answer quality (not covered by any Q8 bar; manual audit of the composed text)

`isGrounded` passes any answer without a figure in it, and the compose model is paraphrasing the `NEED_MORE_DATA` sentinel, which `classifyLocalOutput` does not catch. Across gold, held-out and the 26-run bench:

- **"Need more data." was returned as a final local answer 7 times** (gold 2, held-out 3, bench 2), for example "Did I get charged twice by Adobe?" (2 rows found), "will I run out of money before December", "compare my spending this month vs the usual".
- **"No results found." was returned 4 times with >= 1 row found** (gold 1, held-out 1, bench 2), for example "Show me every Whole Foods charge in June" (1 row) and "pull up every transaction with Whole Foods this year" (4 rows).
- Wrong or non-answers that pass grounding, from the held-out answered rows I checked by hand: "No, I did not get charged twice by Netflix." (5 Netflix rows); "what will my balance be in 3 months" -> "$3677.25" (that is the monthly net; the 3-month figure is $27,282.50); "am I spending more on groceries than last month" -> a sentence about dining; "how much will i spend on groceries next month" -> "$231.08" (total monthly expense, not groceries); "find the adobe charges" -> "$59.75" with no context. By my count roughly 9 of 23 held-out local answers and at least 5 of 22 gold local answers are wrong or useless. This is a manual judgement, not a scored metric.

This is independent of routing and would be a blocker even if the routing bars passed.

## Not measured, and why

- **§14 live dashboard walkthrough** (steps 1 to 7 in the real app): not run. This session had no dashboard server, auth or wa-sqlite mirror; the harness substitutes the bun:sqlite mirror executors. Tool latency in the table is therefore **not** the wa-sqlite number (expect it to be higher but still small next to generation).
- **"Send to `/api/chat` POST" for [C15].** I measured send to handoff **decision**. `client.ts` also does a same-origin config GET before the gate (`loadConfig`, one fetch per turn) and the handoff POST; neither is in these numbers. With 140 ms measured against a 2,000 ms bar there is large margin, but the exact figure needs the live dashboard.
- **GPU co-residence with open-jev** (spec C14, §16): open-jev is on another branch; not measured.
- **Main-thread long tasks during generation, decode tokens/s, prefill of a 6,000-char prompt** (slice 1 items): not measured here. The router, next-action and compose timings above are the end-to-end generation times for the actual prompts.
- **Persona-seeded end-to-end answers.** The compose/latency runs used the parity net-worth fixture, not persona 1 (which is uncategorised). Persona 1 was used for the C3 search check only.

## Reproduce

```
# test-first scorer
bun test src/__tests__/subagent-route-score.test.ts
# real WebGPU Chromium run (writes <out>/results.json; downloads ~570 MB once)
node scripts/subagent-route-eval.mjs --out <scratch>/run --profile <scratch>/chromium-profile --sets gold,heldout,bench
# C3 on persona 1
HOME=<scratch>/home bun scripts/subagent-route-eval-c3.ts <scratch>/run/results.json heldout
```

Files: `scripts/subagent-route-eval.mjs`, `scripts/subagent-route-eval/` (page + worker), `scripts/subagent-route-eval-server.ts`, `scripts/subagent-route-eval-c3.ts`, `scripts/subagent-route-score.mjs` (+ `.d.mts`), `specs/eval/2026-10-02-slice8-results.json`, `specs/eval/2026-10-02-slice8-c3-persona.json`.

## What this implies (for Jd; none of it is done here)

- The deterministic front works: the gate diverts 38 of 43 none rows and all 21 mutation requests, and the keyword single-hit router is 34/35. The two read-bar failures come from the gate's allowlist breadth (15 false gates) and the 0.6B LLM router (6/30).
- Any fix (wider `READ_START`, more keyword rules, dropping the LLM tiebreak in favour of handoff, a different router) is a rule change and **requires a new held-out set from a new author** before the next go/no-go. Do not re-score this file after tuning.
- The answer-quality defects above (`Need more data.` accepted, number-free wrong answers pass grounding) are separate fixes with their own tests.
- `subagent.enabled` stays `false`; DECISIONS Q3 (issue #152 approval gap) remains an additional prerequisite regardless.
