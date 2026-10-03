# Decisions for specs/browser-subagent.md (2026-10-02)

Binding for implementation. "Jd" = decided by Jd; "default" = orchestrator default Jd may override.

| Q | Decision | By |
|---|---|---|
| Q1 balances in mirror | YES — slice 7 is in scope (accounts, balance_snapshots, loans → mirror v4) | Jd |
| Q2 net-worth trend | Stays server-only (current plan); no entitlement flag in sync payload | default |
| Q3 approval gap | Option (a)+ticket: subagent never mutates; mutation requests hand off to the server exactly as today. Issue #152 filed for TOOLS_REQUIRING_APPROVAL; that issue is a prerequisite before `subagent.enabled` defaults on | Jd |
| Q4 open-jev in chat | OUT of v1 | Jd |
| Q5 local turns in llm_interactions / export | Deferred to judge P4a owner (relay note filed); this branch does not edit export.ts | default |
| Q6 history hydration | No; keep last-3 `priorLocalTurns` | default |
| Q7 defineTool default bug | Out of scope here; keep explicit-args workaround + documenting test | default |
| Q8 default-on bars | Critic-amended D3 bars. Held-out set is written by a fresh agent that never sees the gate/router rules | default |
| Q9 maxSteps | 3; slice 8 measures per-step cost | default |
| Q10 local turns to cloud provider | NO — server drops priorLocalTurns unless provider is local | Jd |
| Q11 server re-execution | YES — server re-runs each validated {tool,args} (≤4) via executeRead and ignores client summary numbers | Jd |
| Q12 ChatTab markdown img | Fix in this branch (no remote image fetch on render) | Jd |

## Round 2 (2026-10-03), after the slice-8 NO-GO

| Item | Decision | By |
|---|---|---|
| Mode | **Precision-first**: answer locally only when the keyword router has exactly one match; every other read hands off to the server. The 0.6B LLM never picks the tool. It still composes the answer from tool results. | Jd |
| Answer-quality bugs | Fix: paraphrased NEED_MORE_DATA replies and "no results" claims that contradict non-empty results must hand off | Jd |
| Held-out set v1 | **Burned** (rules change). Archive as `specs/eval/heldout-router.v1-burned.jsonl`. A fresh author writes v2 without seeing rules, v1 or the slice-8 results | Jd |
| New go/no-go bars (replace D3/Q8) | On held-out v2: (1) none/mutation diverted ≥ 95% (≥ 15 verb-less mutation rows); (2) **local precision ≥ 97%**: of reads answered locally, tool correct AND answer correct per the grading rubric; (3) wrong-or-useless local answers ≤ 3% of local answers; (4) coverage (share of read rows answered locally) is reported, with ≥ 35% as an informational target and not a gate; (5) p95 time to handoff ≤ 2 s | default (orchestrator; Jd may override) |
| Security fixes | Sync routes origin-gated and only synced when subagent.enabled is on; server ignores localHandoff when the flag is off; links in local answers render as plain text; check-hybrid-build runs inside build:hybrid | Jd |

## Round 3 (2026-10-03), after the Round-2 NO-GO (precision 43.5%)

| Item | Decision | By |
|---|---|---|
| Local answer writing | **Deterministic templates** per tool (labeled figures, top categories, never the TOTAL row) are the product default. A model-composed answer stays only as a config option used for comparison | Jd |
| Comparison arm | Measure Qwen3-1.7B composing answers (and 0.6B as baseline) on the same v3 rows; the grader doesn't know which arm produced each answer | Jd |
| Empty results | An empty or all-zero result from ANY tool hands off. What-if and comparison phrasing the template can't express also hands off | Jd |
| Gate | Loosen it so terse read questions qualify. v1 and v2 are burned and may be used as dev sets; none/mutation diversion on them must stay ≥ 95% | Jd |
| Held-out v3 | Fresh author with no access to code, specs, v1/v2 or results. Gets the tool catalog, the augmented persona fixtures, and the product MUTATION_VERB list (so it can write ≥ 18 verb-less mutation rows) | default |
| Eval personas | Add synthetic accounts and balances to the eval persona fixtures so net_worth and forecast are meaningful (eval tooling only) | default |
| Bars | Round-2 bars unchanged | default |
| History links | Render links as plain text in every message reloaded from history, local or server (no migration) | Jd |
| Git history paths | Squash-merge at PR time; scan both branches before any push | Jd |

## Round 4 (2026-10-03), the final round with a stop rule

| Item | Decision | By |
|---|---|---|
| Direction | **Final round.** Fix the known template/gate bugs, add the open-jev read-tool tiebreaker (spec `browser-subagent-round4-openjev-router.md`), and measure on a fresh v4. **Stop rule:** if no arm meets the bars, merge with `subagent.enabled` off and stop tuning | Jd |
| Model-written answers | Dropped from measurement (templates beat the model 13 to 9 on shared rows); the code path stays behind config | Jd |
| Bugs to fix | (1) forecast with an empty trailing window must hand off (`isEmptyResult` ignores `startingCash`); (2) net_worth: never state a date the data doesn't hold; time-qualified net-worth questions ("last month") hand off; (3) gate leak: apply the change-wording check to the READ_START openers ("all my", "any", "every"); (4) search precision misses, fixed only if the fix is general, never row-specific | Jd |
| Spec open questions | Accept defaults: extract `feat/openjev-core` first; when several keywords match, open-jev must pick one of them; reuse the Review tab's Download-once consent (updated wording); require ≥ +5 pp coverage over T; fresh grader; any none/mutation row answered locally via arm O = automatic fail; no route logging; keep lock name `wilson-prelabel` | Jd |
| Bar 1 | "Diverted" = never answered locally. A read that then hands off counts as diverted | Jd |
| v3 | Burned (round-4 fixes come from its failures). v4 from a fresh author | default |
| Blinding | The key file stays outside the repo (scratchpad) until the grades are committed | default |
| Legacy XSS | Fix on `fix/legacy-rendermd-xss` off release/0.10.0 and merge that branch into this one. Merging into release/0.10.0 is Jd's call | Jd |

---

# Decisions for specs/open-jev-labeler.md (2026-10-02)

Scope: build **B1-a only (S0–S6)**. B1-b (S8–S12) parked until judge v33 merges and v34 is free.

| OQ | Decision | By |
|---|---|---|
| OQ1 blind disagreement in B1-a | Accept (alternative hidden on DISAGREES rows) | default (rec) |
| OQ2 v34 sequencing | Wait for judge v33; B1-b parked | Jd |
| OQ3 B1-c backlog | DROP | Jd |
| OQ4 export default for one-click accepts | Deferred to B1-b | default |
| OQ5 feature default | Off; revisit after ≥200 user-verified rows | default |
| OQ6 wasm fp32 override | Leave out entirely | Jd |
| OQ7 weights | Pin HF commit via env.remotePathTemplate + config.json sha256 | Jd |
| OQ8 in-app label export | NO — S7 not built; extractor stays the only exporter | Jd |
| OQ9 bulk confirm | NO | Jd |
| OQ10 extractor follow-up | Deferred to B1-b | default |
| OQ11 ship order vs judge P0b | Ship B1-a now; its own routes are origin-gated per S3 | Jd |

## Round 3 (2026-10-03)

| Item | Decision | By |
|---|---|---|
| Lock release | Release on worker crash/onerror and on profile_changed; add hook-wiring tests | Jd |
| LAN gate | Port judge P0b's loopback-peer/Host check into the interim gate now; once P0b lands, the interim file becomes a plain re-export | Jd |
| Git history paths | Squash-merge at PR time; scan before any push | Jd |
