# Round 4 dev cut: open-jev route tiebreak (2026-10-03)

Pre-registered procedure: `specs/browser-subagent-round4-openjev-router.md` §5, implemented in `scripts/subagent-openjev-cut.mjs` (test-first). Dev data only: `specs/eval/heldout-router.v1-burned.jsonl`, `specs/eval/heldout-router.v2.jsonl`, `specs/eval/heldout-router.v3.jsonl`, `src/__tests__/fixtures/subagent-route-gold.json`. The current held-out set (`heldout-router.v4.jsonl`) was not opened.

## Result

- **No viable cut on dev** with tool name + description options, and none with the bare-label fallback (run once, §3): no grid cut has P(c) >= 0.97, no leak, |S(c)| >= 20 and an error-free curve above it (the "fails" column below says which rule each cut breaks). `OPEN_JEV_ROUTE_CUT` stays `null`: **arm O is disabled** and the v4 arm-O run is skipped (§5 step 6).

## Population A

- Dev rows (deduplicated by normalized question, first label wins in the order v1-burned, v2, v3, spike route set): 587 (v1-burned 123, v2 243, v3 180, spike-route 41); read rows 450.
- A = rows that pass the round-4 gate and the what-if / comparison / trend rule with 0 or 2+ keyword hits: **228** (0-hit 222, multi-hit 6; read 203, none or mutation 25; multi-hit with top1 outside the hits 1).
- open-jev decision errors: 0.

## Curve (descriptions)

| c | S(c) size | correct | wrong | leak | P(c) | fails |
|---|---|---|---|---|---|---|
| 0.05 | 195 | 129 | 66 | 21 | 66.2% | P < 0.97, leak |
| 0.10 | 153 | 114 | 39 | 15 | 74.5% | P < 0.97, leak |
| 0.15 | 102 | 85 | 17 | 8 | 83.3% | P < 0.97, leak |
| 0.20 | 51 | 47 | 4 | 2 | 92.2% | P < 0.97, leak |
| 0.25 | 31 | 30 | 1 | 0 | 96.8% | P < 0.97 |
| 0.30 | 18 | 18 | 0 | 0 | 100.0% | size < 20 |
| 0.35 | 8 | 8 | 0 | 0 | 100.0% | size < 20 |
| 0.40 | 6 | 6 | 0 | 0 | 100.0% | size < 20 |
| 0.45 | 6 | 6 | 0 | 0 | 100.0% | size < 20 |
| 0.50 | 2 | 2 | 0 | 0 | 100.0% | size < 20 |
| 0.55 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.60 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.65 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.70 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.75 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.80 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.85 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.90 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.95 | 0 | 0 | 0 | 0 | n/a | size < 20 |

## Bare-label fallback curve (§3, run once)

| c | S(c) size | correct | wrong | leak | P(c) | fails |
|---|---|---|---|---|---|---|
| 0.05 | 176 | 130 | 46 | 15 | 73.9% | P < 0.97, leak |
| 0.10 | 142 | 110 | 32 | 11 | 77.5% | P < 0.97, leak |
| 0.15 | 117 | 92 | 25 | 8 | 78.6% | P < 0.97, leak |
| 0.20 | 94 | 75 | 19 | 7 | 79.8% | P < 0.97, leak |
| 0.25 | 75 | 62 | 13 | 6 | 82.7% | P < 0.97, leak |
| 0.30 | 60 | 52 | 8 | 4 | 86.7% | P < 0.97, leak |
| 0.35 | 52 | 44 | 8 | 4 | 84.6% | P < 0.97, leak |
| 0.40 | 46 | 39 | 7 | 4 | 84.8% | P < 0.97, leak |
| 0.45 | 39 | 32 | 7 | 4 | 82.1% | P < 0.97, leak |
| 0.50 | 37 | 30 | 7 | 4 | 81.1% | P < 0.97, leak |
| 0.55 | 27 | 20 | 7 | 4 | 74.1% | P < 0.97, leak |
| 0.60 | 19 | 16 | 3 | 1 | 84.2% | P < 0.97, leak, size < 20 |
| 0.65 | 14 | 13 | 1 | 0 | 92.9% | P < 0.97, size < 20 |
| 0.70 | 11 | 10 | 1 | 0 | 90.9% | P < 0.97, size < 20 |
| 0.75 | 7 | 7 | 0 | 0 | 100.0% | size < 20 |
| 0.80 | 6 | 6 | 0 | 0 | 100.0% | size < 20 |
| 0.85 | 2 | 2 | 0 | 0 | 100.0% | size < 20 |
| 0.90 | 0 | 0 | 0 | 0 | n/a | size < 20 |
| 0.95 | 0 | 0 | 0 | 0 | n/a | size < 20 |

## Coverage gain per tool and per source (at the frozen cut)

| Tool | gained / dev read rows |
|---|---|
| transaction_search | 0 / 135 |
| spending_summary | 0 / 89 |
| profit_loss | 0 / 83 |
| net_worth | 0 / 76 |
| forecast | 0 / 67 |

| Source | gained / dev read rows |
|---|---|
| v1-burned | 0 / 80 |
| v2 | 0 / 206 |
| v3 | 0 / 130 |
| spike-route | 0 / 34 |

## Margin histograms (descriptions run, A only, 0.05 bins)

| bin | correct read | wrong read | none / mutation |
|---|---|---|---|
| 0.00 | 13 | 16 | 4 |
| 0.05 | 15 | 21 | 6 |
| 0.10 | 29 | 15 | 7 |
| 0.15 | 38 | 7 | 6 |
| 0.20 | 17 | 1 | 2 |
| 0.25 | 12 | 1 | 0 |
| 0.30 | 10 | 0 | 0 |
| 0.35 | 2 | 0 | 0 |
| 0.40 | 0 | 0 | 0 |
| 0.45 | 4 | 0 | 0 |
| 0.50 | 2 | 0 | 0 |
| 0.55 | 0 | 0 | 0 |
| 0.60 | 0 | 0 | 0 |
| 0.65 | 0 | 0 | 0 |
| 0.70 | 0 | 0 | 0 |
| 0.75 | 0 | 0 | 0 |
| 0.80 | 0 | 0 | 0 |
| 0.85 | 0 | 0 | 0 |
| 0.90 | 0 | 0 | 0 |
| 0.95 | 0 | 0 | 0 |

## Timing and load (real WebGPU)

- Adapter: vendor `apple`, architecture `metal-3`, fallback false, shader-f16 true; Chromium 153.0.8010.12.
- Decide per row (A, warm, descriptions): p50 65.300 ms, p95 78.700 ms, max 91.400 ms. Bare labels: p50 47.900 ms, p95 48.600 ms.
- Cold load in a fresh Chromium profile (download + session): 17023 ms, 348391650 bytes reported by the download progress; first decision 154 ms.
- This run: first load in the browser process (weights already in the Cache API) 21345 ms; warm-cache load in a new worker 1585 ms; first decision after load 147 ms.
- Tokens: question 8, options {"descriptions":106,"bare":13} (engine limit 200).

## Notes

- Tool precision is a proxy: arm O answers with the round-3 templates, so answer quality is judged on the held-out set (§7), not here.
- Expect small n; the stability rule and |S| >= 20 guard against a lucky dip.
- Per-row A records (question, label, source, hits, top1, p1, p2, margin, top-2, ms): `2026-10-03-round4-dev-cut.json`.
