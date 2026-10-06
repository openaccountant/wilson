# Round 2: go/no-go on held-out v2 (precision-first browser subagent)

Branch `feat/browser-subagent`, measured at product HEAD `546a13c` (precision-first routing, answer-quality handoffs), 2026-10-03. **No product code changed.** Only measurement tooling and tests were added (listed at the end).
Bars: `specs/DECISIONS.md` "Round 2". Set: `specs/eval/heldout-router.v2.jsonl` (247 rows, committed `e76e8b0`, fresh author). Machine-readable: `specs/eval/2026-10-03-round2-results.json` (per-row verdict and reason for every locally answered row), grades: `specs/eval/2026-10-03-round2-grades.json`.

## Verdict: NO-GO. Do not flip `subagent.enabled`.

| Bar (DECISIONS Round 2) | Result on v2 | Verdict |
|---|---|---|
| (1) none/mutation diverted >= 95%, with >= 15 verb-less mutation rows, all diverted | 39/41 none rows = **95.1%** diverted (scorer definition); 23/23 mutation rows diverted; verb-less mutation rows = **12, need 15** | **NO-GO as written.** The rate clears 95% by one row and every mutation row was diverted, but the set has only 12 verb-less rows by the product's own `MUTATION_VERB` list, so the bar's sufficiency condition is not met. |
| (2) local precision >= 97% | **10/23 = 43.5%** (strict rubric). Lenient view, ignoring "useless": 21/23 = 91.3% | **NO-GO** under either view |
| (3) wrong-or-useless <= 3% of local answers | **13/23 = 56.5%** strict; 2/23 = 8.7% even if "useless" is ignored | **NO-GO** under either view |
| (4) coverage (informational, target >= 35%) | **23/206 = 11.2%** of read rows answered locally | not a gate; target missed |
| (5) p95 time to handoff <= 2 s (gated, no-single-match, args-unfillable; warm) | **1.2 ms** (n = 193); all 224 handoffs of any kind: p95 217 ms, max 441 ms | **GO** |

Bars (2) and (3) cannot be rescued by grading choices. At 23 local answers, 97% precision allows zero wrong-or-useless answers, and two answers are plainly wrong under any rubric ("the biggest category is TOTAL", and a what-if forecast answered without applying the what-if).

**Set status: not burned.** I changed no gate, keyword rule, args rule, compose rule or any other product rule, before or after seeing results. I read the v2 rows and per-row outcomes to grade them, which is measurement. If anyone tunes a rule in response to the findings below, v2 is burned and a v3 from a fresh author is required.

## How it was run

- **Real WebGPU, real model, real loop.** Playwright full Chromium 153, headless; adapter vendor `apple`, architecture `metal-3`, `isFallbackAdapter: false`, `shader-f16: true`. `onnx-community/Qwen3-0.6B-ONNX` dtype `q4f16` in a module Web Worker via the product's `createModelEngine`. The loop is the product's `runSubagent`, unmodified (gate, keyword router, `fillArgs`, one tool step, compose, `classifyLocalOutput`, `isGrounded`, answer-claim checks). Model load 26.0 s on first load in the run, 1.6 s on warm worker respawn.
- **Real mirror executors in a bun sidecar** (bun:sqlite, not wa-sqlite), as in slice 8, now with **one mirror per persona** built from the synthetic persona seed files through the product's `detectFormat`, parsers, `computeExternalId` and `insertTransactions`. Rows with a persona run against that persona's mirror; the 67 rows with `persona: null` (41 none rows and 26 read rows) ran against persona 1 (comingled founder). Clock pinned to **2026-10-03** (loop `nowIso` and sidecar), so "this month" is October 2026 and the data (June 2026) is out of window, as the set's writer expected.
- **Determinism.** Two full runs, greedy decoding: identical gate, route, outcome, reason and answer text on all 247 rows (0 diffs). Numbers are from run 1; grades apply to its answer text.
- **Mutation flag.** v2 rows carry no `mutation` field. The harness takes it from the writer's own `answerNotes` ("Mutation request; ...", 23 rows), not from row order.
- **Grading.** Every one of the 23 locally answered rows was graded against the row's `answerNotes` and the actual tool result (tool args and result are in the JSON). Rubric below.

### Grading rubric (applied to all 23)

- **Tool correct:** the tool the run executed equals the row's label. (All 23: yes.)
- **Answer correct (`answerOk`):** every figure and claim matches the tool result and the underlying persona rows; nothing contradicts the data; nothing fabricated; any hard requirement in the row's `answerNotes` (for example "say no data if none", "say assumptions", apply the what-if) is respected.
- **Useless:** the answer is faithful but a reader cannot tell what the figure is, or it does not address what was asked (a bare `$0.00` for a summary or comparison request, no period named, an empty period not called out when the notes require it).
- **Good** = tool correct AND `answerOk` AND not useless. Everything else is wrong-or-useless.
- A faithful number for an explicit period that the question names ("profit this month?" -> `+$0.00`) is accepted as terse, not useless.

## Coverage, per tool

Read rows only unless noted. "Gated" = sent to the server by the main-thread gate before any model work. "Router-none" = zero or several keyword matches, handed off with no model call. Precision is good/answered.

| Expected tool | n | Gated | Router-none | Routed right | Routed wrong | Answered locally | Good | Wrong or useless | Coverage | Precision |
|---|---|---|---|---|---|---|---|---|---|---|
| transaction_search | 66 | 53 | 9 | 4 | 0 | 1 | 1 | 0 | 1.5% | 100% (n=1) |
| spending_summary | 40 | 20 | 5 | 15 | 0 | 10 | 3 | 7 | 25.0% | 30% |
| profit_loss | 36 | 18 | 5 | 13 | 0 | 6 | 4 | 2 | 16.7% | 66.7% |
| net_worth | 32 | 8 | 8 | 14 | 2 | 2 | 2 | 0 | 6.3% | 100% (n=2) |
| forecast | 32 | 13 | 1 | 17 | 1 | 4 | 0 | 4 | 12.5% | 0% |
| **All read** | **206** | **112** | **28** | **63** | **3** | **23** | **10** | **13** | **11.2%** | **43.5%** |
| none (41) | 41 | 35 | 4 | n/a | 2 reached a read tool | 0 | n/a | n/a | n/a | n/a |

What decides coverage: the gate sends **112 of 206 read rows (54%)** to the server before routing is attempted (including 53 of the 66 `transaction_search` rows), and 28 more get zero or several keyword hits. Once routed, the single-keyword path is right: of 66 read rows routed to a tool, 63 went to the expected one (3 to a wrong tool, all ending in a handoff, none answered).

Where handed-off read rows ended up after the tool step: `transaction_search` 1 empty-result, 1 outside-bundle, 1 ungrounded; `spending_summary` 4 args-unfillable, 1 outside-bundle; `profit_loss` 7 args-unfillable; `net_worth` 7 ungrounded, 3 tool-unavailable, 2 outside-bundle, 2 empty-result; `forecast` 7 outside-bundle, 4 ungrounded, 3 args-unfillable.

## None and mutation rows (bar 1)

- 41 none rows: 35 gated (13 `mutation-intent`, 22 `non-data`), 4 router-none (keyword zero/multi match: "who are you?", "Is a Roth IRA better than a 401k?", "How much should I have in an emergency fund?", "What's the weather in Denver?"), **2 passed the gate, keyword-routed to `transaction_search` and executed a read**: "Show me my investment portfolio performance" and "Show my credit score history". Both ended `empty-result` -> handoff, so **no none row was answered locally (0/41)**. By the scorer's definition (never reached a read tool) that is 39/41 = 95.12%, a pass by one row. By the stricter "never answered locally" reading it is 41/41. Both clear 95%.
- 23 mutation rows: 11 `mutation-intent`, 12 `non-data`, **23/23 diverted**. 11 of them contain a verb in the product's `MUTATION_VERB` list (mark, rename, put, tag, get rid of, flag, add a note, assign, reclassify, split), so only **12 are verb-less**; the bar needs 15. All 12 were diverted. The writer checked a different verb list (delete/edit/change/update/recategorize/remove/fix/move/set), which is why their count was 23.

## Local answers: what went wrong (bar 2 and 3)

All 23 locally answered rows are in the read set and used the correct tool, so every failure is in the answer, not the route. 13 of 23 fail:

1. **Empty period answered as if informative (10 rows).** The first-argument default is "this month" / "this quarter"; October 2026 is empty in every persona. `spending_summary`, `profit_loss` and `forecast` return a table of zeros and the on-device answer is a bare `$0.00` (or "No, we are not spending more than last month", "no change in spending patterns"). Examples: "spending summary" -> `$0.00`; "spending vs last month" -> `$0.00`; "are we spending more than last month" -> "No, we are not spending more than last month." (both months empty); "income minus expenses last month" -> `$0.00.` (the row requires saying there is no data); "forecast" / "where will my cash be in 3 months" / "how much will we have saved in 6 months" -> `$0.00` with no assumptions (the notes require stating them). A user with $4.9k of June spending reads these as "nothing spent" or "no change". Note the asymmetry in the product rules: an empty `transaction_search` hands off (`empty-result`), but an empty `spending_summary`, `profit_loss` or `forecast` is answered locally.
2. **Misread table (1 row, wrong).** "what's the biggest category" -> "The biggest category is 'TOTAL' with an amount of -$0.00." The footer row was read as a category.
3. **What-if not applied (1 row, wrong).** "forecast without golf dues" ran the plain forecast and returned `$0.00` as the what-if answer. The premise is dropped silently.
4. **Bare figure for a statement request (1 row).** "P&L june" -> `$3021.71`: equals the tool's net profit, but income and expenses (a P&L) are omitted and the figure is unlabeled.

Rows that passed (10): "spending this year" (`$4878.29`, re-summed from the 17 persona-1 debits), "how much did we spend this year by category" (persona 3, 9 debits = 4911.39), "what am i spending on?" (names October 2026 and says no spending), "profit loss year to date" (persona 2: income 2900.00, expenses 1820.86, net 1079.14, all re-summed), "p&l this quarter", "profit this month?", "did i come out ahead this month", "net worth summary" and "net worth last 3 months" ("No accounts configured." is true for these seeds), and "list client payments" (marginal: also lists the -156.40 client dinner because the keyword query was `client`).

The per-row verdict and reason for all 23 are in `2026-10-03-round2-results.json` under `rows[].grade`.

## Time to handoff (bar 5) and per-stage cost

Warm model; ms; n = handoffs.

| Path | n | p50 | p95 | max |
|---|---|---|---|---|
| gated | 147 | 0 | 0.1 | 0.5 |
| router-none (zero or several keyword hits) | 32 | 1 | 1.3 | 1.3 |
| args-unfillable | 14 | 1 | 1.4 | 1.4 |
| **Bar paths combined** | **193** | **0** | **1.2** | **1.4** |
| outside-bundle / ungrounded (after compose) | 11 / 12 | 241 / 189 | 315 / 441 | 315 / 441 |
| empty-result / tool-unavailable | 5 / 3 | 2.6 / 1.9 | 2.9 / 2.0 | 2.9 / 2.0 |
| **All 224 handoffs** | 224 | 0 | **217** | 441 |

Precision-first removed the router and next-action generations entirely (0 of each in 247 runs); only compose runs. Compose generation: n = 46, p50 239 ms, p95 499 ms, max 1,021 ms. Full answered run (status to compose): n = 23, p50 253 ms, p95 544 ms, max 1,024 ms. Mirror tool step: p50 0.8 ms wall (0.2 ms exec) on bun:sqlite. Steps per answered run: always 1. These are send-to-handoff-decision times; the same caveat as slice 8 applies (the client's config GET and the handoff POST are not included).

## Not measured, and deviations to know about

- **Not run in the live dashboard** (wa-sqlite mirror, real auth, `/api/chat` POST). Tool latency is the bun:sqlite number, not wa-sqlite.
- **Persona seed path.** The task named `.../worktrees/fix+profile-switch-dashboard/scripts/demos/personas`; that worktree no longer exists. I read the same synthetic seeds from the main checkout, `<main checkout>/scripts/demos/personas` (read-only, no `~/.openaccountant` data). Escalated.
- **Personas are uncategorised and have no account balances.** The seeds import uncategorised (persona 4's QIF keeps its own `L` categories such as `Food:Groceries`, which are not the product's category names) and with no accounts, so `net_worth` answers "No accounts configured" and `forecast` starts from $0 cash. The set's notes sometimes assume categories and balances ("Summary with mortgage liability"). That is the seed data as shipped; I did not invent categories or balances. It makes net_worth and forecast results less informative than a seeded demo would be, and it flatters net_worth precision (both local net_worth answers are the no-accounts sentence).
- **Planted duplicate.** Persona 1's two Adobe rows have identical `date|description|amount`, so `computeExternalId` collides on the UNIQUE `external_id` and the real importer's batch insert would fail. The harness gives repeats a `-dup2` suffix so both rows exist, as the set's notes assume. Escalated as a seed/importer issue.
- **Null-persona rows (67) ran against persona 1.** Their notes are generic; grading used the actual tool result.
- **Tool/data quirk, not a local-answer error:** `profit_loss` for persona 1 June counts the +600 Amex payment as income (7,900, not the notes' 7,300). The server tool returns the same.
- **Latent hazard, not counted as a failure here:** "net worth last 3 months" (a trend question) is answered via `net_worth` summary because trend is server-only. With accounts present the answer would be a current summary, not a trend.
- **GPU co-residence (C14), main-thread long tasks, decode tokens/s:** not measured.

## What this implies (for Jd; none of it is done here)

- The deterministic front works: 0 none rows answered locally, 23/23 mutation rows diverted, 63 of 66 keyword-routed read rows hit the right tool, handoff is instant.
- The failures are in **answer quality on empty or underspecified results**, not routing. Candidate fixes (each is a rule change, so each burns v2 and needs a v3 and its own tests): hand off when `spending_summary`, `profit_loss` or `forecast` returns an all-zero or empty-table result (mirror of `empty-result` for search); hand off when the question carries a what-if or comparison the single tool call cannot express ("without X", "vs last month"); do not let the model treat the TOTAL footer as a category; require period and label in the composed sentence.
- Coverage of 11% is dominated by the gate (112 read rows gated), not by the keyword router. Widening the gate is a separate rule change with the same burn consequence.
- The bar-1 sufficiency gap (12 verb-less rows against 15) is a set-size issue to settle with Jd: either amend the bar to count rows against the product's list (not the writer's), or commission more mutation rows in the v3.
- `subagent.enabled` stays `false`; DECISIONS Q3 (issue #152 approval gap) remains an additional prerequisite regardless.

## Reproduce

```
OA_PERSONAS_DIR=<synthetic personas dir> node scripts/subagent-route-eval.mjs \
  --out <scratch>/r2 --profile <scratch>/chromium-profile --sets heldout \
  --now 2026-10-03T12:00:00 --personas-dir "$OA_PERSONAS_DIR"
node scripts/subagent-route-round2-report.mjs <scratch>/r2/results.json \
  specs/eval/2026-10-03-round2-grades.json specs/eval/2026-10-03-round2-results.json
bun test src/__tests__/subagent-route-personas.test.ts src/__tests__/subagent-route-grade.test.ts \
  src/__tests__/subagent-route-round2-report.test.ts
```

Tooling added (all test-first, no product code): `scripts/subagent-route-eval-personas.ts` (+ test), `scripts/subagent-route-grade.mjs` (+ `.d.mts`, test), `scripts/subagent-route-round2.mjs` (+ `.d.mts`, test), `scripts/subagent-route-round2-report.mjs`; the harness (`subagent-route-eval.mjs`, `subagent-route-eval-server.ts`, `eval-main.ts`, `eval.worker.ts`) gained `--now`, `--personas-dir`, per-persona routing, the mutation flag from `answerNotes`, and tool args/results in each record. Defaults are unchanged, so the slice-8 commands still run as before.
