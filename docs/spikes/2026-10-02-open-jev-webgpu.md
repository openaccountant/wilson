# open-jev on real WebGPU (Chromium, Apple M4 Pro): go/no-go spike

Date: 2026-10-02. Branch: `feat/open-jev-annotator`. Status: **measured** (real WebGPU, not a fallback adapter).

Raw results: `docs/spikes/2026-10-02-open-jev-webgpu/results/*.json`. Harness: `docs/spikes/2026-10-02-open-jev-webgpu/harness/`.

## 1. Verdict

| Use | Verdict | Why (numbers below) |
|---|---|---|
| (a) Tool routing in chat | **NO-GO as the router. Conditional GO as a shadow/hint signal only.** | Latency is fine (about 80-110 ms). Read-tool accuracy is 33/34 (97%). But "none/handoff" recall is 2/8 (25%): 6 of 8 non-data requests, including "Delete the duplicate Adobe transaction" and "Recategorize that Starbucks charge", were routed to `transaction_search`. A yes/no gate (`noul`) did not fix it (2/8 again). Confidence does not separate the cases. |
| (b) Bulk pre-labeling of transactions | **GO for speed, NO-GO for accuracy as-is. Usable only as a margin-gated pre-labeler, with a human or LLM review for the rest.** | About 70-86 ms/decision with bare labels (about 2.5 min per 2,000 rows, versus 9 min on CPU q4 in gaps #35). Zero-shot accuracy is 61% (30/49). Descriptions in the option text hurt badly (26.5%). With margin >= 0.3 it was 18/19 (95%) but covered only 39% of rows (n is small). |

Zero-shot open-jev is a generic typed-decision model. These numbers say nothing about a Wilson fine-tune.

## 2. What was measured

- **Machine.** Apple M4 Pro, 48 GiB (`hw.memsize` 51,539,607,552), macOS 15.5.
- **Browser.** Playwright 1.63.0, `channel: 'chromium'`, headless, Chromium 153.0.8010.12. This is the full Chromium build, not the headless shell. The existing harness explains the trap (`browser-finetune/demo/c-web.mjs:33-51`). Default `--enable-unsafe-webgpu` was NOT passed.
- **Adapter.** `vendor: apple`, `architecture: metal-3`, `isFallbackAdapter: null` (not true), `shader-f16: true`, `maxBufferSize 4,294,967,292`. The Chromium `device`/`description` fields were empty strings. The run refuses to proceed on a fallback or SwiftShader adapter (same rule as `c-web.mjs:610`).
- **Runtime.** `@huggingface/transformers` 4.3.0, onnxruntime-web `1.31.0-dev.20260914-8d85527a0`, `open-jev` 0.1.2, `crossOriginIsolated: true` (COOP/COEP as in the existing vite config).
- **Weights.** Fetched from huggingface.co into a **fresh browser profile** for the cold run. A second session on the same profile gives the warm-cache load. The existing Node cache was not reused.
- **Models.** `onnx-community/open-jev-deberta-v3-large-ONNX` q4f16 (primary, `T=1.05` from its config), plus fp16 (the library's WebGPU `auto` default) and `kev-0.6b` q4f16 as comparisons. `kev` runs at `T=1` because the adapter hardcodes it (`research/01-sweep/07-open-jev-decision-pattern.md` section 2c).
- **Timing method.** One `decide()` per state, batch 1 (`index.ts` hardcodes `[1, seq]`, see research doc 07 section 2d). Each decision is timed around `await jev.decide(...)`, which includes tokenization, the forward pass and the logits readback. The first call of the page session is reported separately (shader/pipeline compile). Then 3 discarded warmup calls, then every gold row once. p95 is the nearest-rank value over n=42-49, so it is about the 3rd slowest sample; treat it as indicative.

### Gold sets (both are small; n=49 gives roughly +/-13 pp on a 60% accuracy)

- **Categorize, n=49.** Built by `harness/build-gold.mjs` from the 5 synthetic personas in `fix+profile-switch-dashboard/scripts/demos/personas` (72 rows parsed, 49 kept). I labeled obvious rows by hand; ambiguous ones (student loan, daycare, golf club, tax payments, auto loan, FedEx, property tax) were left out. Income is capped at 6 and Groceries at 6 so they do not dominate. The labels are mine, not user-verified. NETFLIX (Subscriptions vs Entertainment) and GYM MEMBERSHIP (Health) follow Wilson's own category descriptions. State is `description: X | amount: -12.30 | date: 2026-06-01`; the Amex-shaped card file is sign-flipped to Wilson's convention (negative = expense).
- **Category list.** Wilson's real 18 categories, `src/tools/categorize/categories.ts:4`, with descriptions from `categories.ts:28`.
- **Tool route, n=42.** 34 questions expecting one of the 5 read tools (`src/mcp/tool-catalog.ts:91` transaction_search, `:99` spending_summary, `:108` profit_loss, `:117` net_worth, `:126` forecast) and 8 expecting `none`. Options are the 5 tool names with the catalog descriptions plus `none` ("No data tool applies: general chat, explanations, or requests to change data. Hand off to the full assistant."). The `none` option text is mine. I wrote the questions; they are not from real chat logs.

## 3. Results: open-jev q4f16 on WebGPU (primary)

Three independent cold runs of the same config (fresh profile each time). The first two ran all workloads; the third ran `route-noul` and `route`. Timings are ms per decision, warm.

| Workload | n | Accuracy | p50 (runs) | p95 (runs) | Margin p10 / p50 / p90 (p1-p2) |
|---|---:|---|---|---|---|
| categorize, **with descriptions** | 49 | **0.265** (13/49) | 174.8 / 162.9 | 287.4 / 180.1 | 0.031 / 0.112 / 0.155 |
| categorize, **bare labels** | 49 | **0.612** (30/49) | 85.8 / 67.1 | 88.5 / 76.0 | 0.018 / 0.192 / 0.529 |
| categorize, bare, description-only state (no amount/date) | 49 | 0.592 (29/49) | 55.9 | 64.3 | 0.050 / 0.153 / 0.423 |
| tool route (5 tools + none) | 42 | **0.833** (35/42) | 107.1 / 111.8 / 80.9 | 126.2 / 114.1 / 82.5 | 0.040 / 0.162 / 0.422 |
| tool route, `noul` read-vs-not gate | 42 | 0.857 (36/42) | 50.2 | 51.2 | n/a |

- **Run-to-run variance in timing is about 25%** (bare p50 85.8 vs 67.1; route p50 80.9 to 111.8). Predictions were identical between runs 1 and 2 on all 91 decisions. Do not quote a single p50 as precise.
- **First decision of a session** (shader compile): 212 / 194 ms on categorize-with-descriptions; an earlier discarded run (before I added 10 route rows) showed 512 ms. Later workloads' first calls were 69-122 ms, so most compile cost lands on the very first decision.
- **Latency scales with option-text length.** Descriptions roughly double the sequence (about 2x the time). Bare labels: 67-86 ms. Route (6 options with descriptions): 81-112 ms. A single `noul` question: about 50 ms.
- **Cold load (download + session create) vs warm.**

| | Cold load ms | Warm-cache load ms | Bytes over network, cold |
|---|---:|---:|---:|
| open-jev q4f16, WebGPU | 18,239 / 24,120 / 24,322 | 1,393 / 1,184 / 998 | huggingface.co 350,631,305 + jsDelivr (ORT wasm/mjs) 5,574,273 = 363,516,153 total, 41 requests |

  `OpenJev.info()` reports `downloadSize` 357,050,727 for `config.json`, `onnx/model_q4f16.onnx`, `onnx/model_q4f16.onnx_data`, `tokenizer.json`, `tokenizer_config.json`. Cold time is dominated by the network (this connection moved 350 MB in roughly 15-20 s); the warm number is the real session-create cost. In the warm session the model weights come from Cache API (685 bytes of HF traffic, 0 from jsDelivr).
- **Correctness check.** Predictions of q4f16-WebGPU agree with an independent fp32 reference on wasm CPU on 40/42 route rows and 46/49 bare-categorize rows, and with fp16-WebGPU on 40/42 and 45/49. fp16 and fp32 have the same accuracy (route 0.833, bare 0.653), so q4f16 on this stack is numerically faithful. This is not the q4f16-collapses-on-WebGPU failure seen with LFM2.5 (`browser-finetune/docs/2026-09-22-gaps.md` #11).

## 4. Comparisons

| Config | Status | Cold load ms | Network bytes (HF) | route p50/p95 ms, acc | bare-categorize p50/p95 ms, acc |
|---|---|---:|---:|---|---|
| open-jev **q4f16** WebGPU | measured | 18,239 | 350,631,305 | 107.1 / 126.2, 0.833 | 85.8 / 88.5, 0.612 |
| open-jev **fp16** WebGPU (the library's `auto` default) | measured | 54,704 | 877,415,109 | 90.8 / 111.4, 0.833 | 77.6 / 81.6, 0.653 |
| **kev-0.6b q4f16** WebGPU (T=1, uncalibrated) | measured | 18,070 | 340,968,535 | 82.6 / 84.7, 0.738 | 58.9 / 63.3, 0.306 |
| open-jev **fp32 on wasm (CPU)** | measured, **CPU, not WebGPU**, labeled reference only | 91,335 | 1,752,218,930 | 717.3 / 770.3, 0.833 | 315.3 / 350.5, 0.653 |
| open-jev **q4 on wasm (CPU)** | **FAILED to load** | n/a | 480,312,921 | n/a | n/a |

- **q4 on wasm exact error:** `Error: Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Could not find an implementation for GatherBlockQuantized(1) node with name '/backbone/embeddings/word_embeddings/Gather_Q4'`. So there is **no working small CPU fallback** for open-jev in this ORT-web build. The only wasm path measured needs the 1.75 GB fp32 file.
- **kev-0.6b is fast but its confidence is unusable.** On bare categorize 20 of its 25 predictions with confidence >= 0.9 were wrong; on route 3 of 23. It predicted `none` for all 8 non-data questions but only got 23/34 read-tool questions. This matches the "raw logits, 11% confident errors" warning in research doc 07 section 2c. open-jev (T=1.05) was far better behaved: on bare categorize only 1 of 13 predictions with confidence >= 0.5 was wrong; on route 0 of 8.
- **fp16 versus q4f16:** same accuracy, 2.5x the download, a bit faster per decision. If the product ships q4f16, 350.6 MB is the number to budget. The `auto` default would download 877 MB.

## 5. What the accuracy numbers actually say

### Categorize (bare labels, 61% overall)

- Margin is a usable confidence signal. Accuracy by margin threshold on 49 rows: margin >= 0.1 gives 22/31 (71%); >= 0.2 gives 21/24 (87.5%); >= 0.3 gives 18/19 (94.7%); >= 0.4 gives 13/13. That is 39% coverage at 95%. Small n, one machine.
- Errors are not "hard" ones. Chipotle -> Shopping, Verizon -> Transport, CLIENT PAYMT (consulting income) -> Transfer, 5 of 6 Income rows went to Transfer (2), Shopping (2) or Health (1). Income was 1/6.
- **Putting `name: description` in the option text collapsed accuracy to 26.5%.** 36 of 49 predictions were `Other` (its description, "Transactions that do not fit any other category", acts as a magnet). Wilson's `CATEGORY_DESCRIPTIONS` should not be passed as `choice()` descriptions. The existing gaps doc (#35) said descriptions are the cost driver; this adds that they are also an accuracy hazard. I did not test shorter, rewritten descriptions.
- Dropping amount and date from the state did not matter (0.592 vs 0.612).

### Tool route (83% overall)

- Of 34 read-tool questions, 33 were right (one miss: "total paid to Costco this year" -> spending_summary instead of transaction_search; arguably ambiguous).
- Of 8 `none` questions, 6 went to `transaction_search` with confidence 0.24-0.46, so a threshold does not separate them (correct read-tool answers have confidence 0.26-0.73 because mass is split across 6 options). Handoff-if-confidence-below-X on this set: at X=0.30, 7 correct read-tool rows are sent to handoff and 2 none rows still execute as tools; at X=0.35, 14 and 1; none-as-tool reaches 0 only at X=0.50, where 26 of 34 correct read-tool rows are sent to handoff.
- The `noul` gate predicted "yes" for all 34 read rows but also for 6 of 8 non-data rows ("Hi, what can you do?" 0.83, "Import my new bank statement" 0.84). Mutating intent is exactly the case Wilson cannot afford to misroute (`tool-catalog.ts:52` lists the mutating tools next to the 5 read tools; none of the mutating tools were options here, which is why they all fall under `none`).
- Positive: when the user does ask a read question, open-jev picks the right one of 5 reads about 97% of the time at about 100 ms.

## 6. Caveats

1. One machine (M4 Pro), one browser build, one network. No other adapter vendor.
2. n=42-49 per workload; confidence intervals are wide (+/-10-13 pp). The route set is mine and skews toward phrasing that echoes the tool descriptions.
3. Labels are mine and not user-verified; this is a proxy for "obvious" rows, not a measure against Jd's real ledger. No real profile data was touched.
4. Timing noise is about 25% run to run; p95 over n~45 is the third-slowest sample.
5. Cold load includes this connection's download speed; the warm-cache number is the portable one.
6. `decide()` was called with one question each; multi-question calls (one state, several heads) were not measured and in the DeBERTa family every question attends to every other (research doc 07 section 2a), so they may interact.
7. Wasm numbers are fp32 on CPU and are not comparable to WebGPU.

## 7. Recommendations and escalations

1. **Chat routing:** do not replace the LLM tool picker with open-jev. If a latency win is wanted, use it only as a fast pre-filter when the question is clearly a read (confidence >= 0.5 had 0 errors on 8 rows, which is far too few to rely on), and fall through to the existing path otherwise. A fine-tuned head with real "handoff" training data is the way to get `none` recall; zero-shot will not do it. Needs a decision from Jd.
2. **Bulk pre-labeling:** feasible at about 2.5 min per 2,000 rows with bare labels, but the output should be treated as proposals: auto-accept only margin >= 0.3 (about 39% of rows at about 95% on this small gold set), send the rest to the LLM or the human. Verify the threshold on a bigger verified set before trusting it.
3. **If the annotator/judge branch (`feat/open-jev-annotator`) depends on open-jev as a judge**, note that it is a discriminative picker over provided options, not a generator. It can be a cheap first-pass labeler but not a rationale-producing judge.
4. **Download policy:** pin `dtype: "q4f16"` (350.6 MB over the network). The library's `auto` picks fp16 (877 MB). There is no working CPU fallback below fp32 (1.75 GB), so browsers without WebGPU plus `shader-f16` should skip this feature rather than fall back.
5. **Open item for Jd:** whether to spend a fine-tune on a ModernBERT-style classifier instead (per the label policy doc, `browser-finetune/docs/2026-09-22-classifier-label-policy.md`), with open-jev kept only as the low-margin escape hatch.
