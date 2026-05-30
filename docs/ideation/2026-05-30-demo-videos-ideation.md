---
date: 2026-05-30
topic: demo-videos
focus: make demo videos of the chatbot using granite4.1:3b with demo data from the entire month of May
mode: repo-grounded
---

# Ideation: Demo videos of the Open Accountant chatbot (granite4.1:3b · May data)

## Grounding Context (Codebase)

- **Open Accountant ("wilson")** — privacy-first AI bookkeeper **TUI** (Bun terminal chat). Tagline "Your AI bookkeeper. Follow the money." Named after Frank J. Wilson, the forensic accountant who convicted Al Capone by following the money. Voice (SOUL.md): direct, no-jargon, action-over-analysis, finds savings, privacy non-negotiable.
- **Core flows:** import bank CSV (Chase/Amex/BofA/generic) → AI categorize into 18 categories → spending summaries (period/merchant compare) → anomaly detection (duplicate charges, spikes, forgotten subscriptions) → export CSV/XLSX → 50+ skills. Commands: `/model`, `/pull`, `/skill`, `/help`.
- **granite4.1:3b** runs via Ollama (OpenAI-compatible endpoint). `src/model/providers/transformers.ts:23-26` warns small-Granite tool-calling "works for simple single-tool calls, fails on complex multi-tool chains. Not recommended for multi-tool agent tasks." → slow + occasionally wrong. **This is the central demo tension.**
- **No May data exists.** Fixtures are dated Jan/Feb 2026. Chase CSV header `Transaction Date,Post Date,Description,Category,Type,Amount` includes a **Category column**. `data/dedup/chase-jan-overlap.csv` is a planted-duplicate fixture; Jan CSV encodes a `RETURN`/`Sale` pair → planted edge cases are the house style.

### Toolkit map (5 installed demo skills)

| Skill | Engine | Fit |
|---|---|---|
| **cli-demo-generator** | **VHS** `.tape` (`--bootstrap`, `--speed`, base64 escaping, frame verification) | **The harness** — scripted, re-runnable terminal GIFs of the TUI. |
| **ce-demo-reel** | VHS terminal-recording tier + upload/approval + secret-scan | Lightweight per-clip path for README/PR. "Evidence = using the product." |
| **demo-video** | HTML→playwright→**edge-tts narration**→ffmpeg; story arcs (Hook→Problem→Magic→Proof→Invite; 15s teaser) | Compositor for the narrated reel (feed it VHS frames, not its playwright path). |
| **demo-producer** | VHS + Remotion, `--live` Tailscale funnel | Heavier; `--live` is web-only — not relevant to a local TUI. |
| **ui-demo** | Playwright WebM of web apps | ❌ Dead end — wilson is a TUI. |

**Key find:** VHS 0.11+ has **`Wait "prompt>"`** (blocks until a string appears) and a **`Hide … Show`** off-camera prelude. `Wait` makes recordings deterministic regardless of granite's run-to-run latency (no `Sleep 8` guessing); `--speed 2` then compresses dead air evenly and honestly. `Hide` runs DB seed + model pre-warm off-camera. **Caveat:** VHS drives a *real* terminal with granite live — it does not fake output, so model fumbles during capture are still failed takes.

## Topic Axes

1. Demo data design
2. Scenario / script selection
3. Small-model reliability
4. Production & format
5. Distribution / narrative framing

## Ranked Ideas

### 1. Author May *backward* from planted anomalies + an April baseline
**Description:** Write the punchlines first — one duplicate charge (same merchant/amount, 2 days apart), one forgotten subscription that renews mid-May, one spend spike — then back-fill mundane transactions. Author a quiet April 2026 file so the period-compare flow has a baseline ("spending is up vs. what?").
**Axis:** Demo data design
**Basis:** `direct:` `data/dedup/chase-jan-overlap.csv` is an existing planted-duplicate fixture; Jan CSV encodes a `RETURN`/`Sale` pair — planted edge cases are the house style. Period comparison is a listed core flow.
**Rationale:** Anomaly detection is mostly deterministic code, not the LLM, so these beats record fast and reliably and deliver the "found you money" payoff. The demo never has to get lucky.
**Downsides:** Authoring two months + tuning realism is the biggest upfront effort; over-on-the-nose anomalies can look staged. Bonus: dataset doubles as a parser/categorization test fixture and a "try the demo" onboarding path.
**Confidence:** 90% · **Complexity:** Medium · **Status:** Unexplored

### 2. Pre-categorize the data; demo analysis live, categorize as one bracketed showcase
**Description:** Fill the CSV `Category` column with correct labels so import doesn't wait on granite to classify 30+ rows on camera. Demo the high-value analysis skills on clean data; keep live categorization to a single pre-tested "watch it reason about this ambiguous merchant" moment.
**Axis:** Small-model reliability
**Basis:** `direct:` `data/csv/chase/standard.csv` header includes `Category`, already populated for Jan fixtures.
**Rationale:** Live bulk categorization is the longest, most failure-prone segment on a 3B local model. Removing it from the critical path lets reliable flows carry the video.
**Downsides:** Less raw "watch the AI work" magic — curated proof over raw demonstration.
**Confidence:** 88% · **Complexity:** Low · **Status:** Unexplored

### 3. Single-tool-call-only scripting; route multi-step through `/skill`
**Description:** Phrase every on-camera prompt to need exactly one tool call ("show my May spending by category"). Anything multi-step (month-end-close) is triggered as a pre-defined `/skill` orchestrated by code, not by the model improvising a chain. Rehearse a vetted prompt list.
**Axis:** Scenario / small-model reliability
**Basis:** `direct:` `src/model/providers/transformers.ts:23-26` — small-Granite fails on multi-tool chains.
**Rationale:** The documented failure mode most likely to wreck a take. Constraining prompt *shape* sidesteps it without faking anything.
**Downsides:** Can't showcase autonomous multi-tool "agent" behavior some viewers expect.
**Confidence:** 92% · **Complexity:** Low · **Status:** Unexplored

### 4. Segmented VHS capture from a seeded state + one-command regeneration
**Description:** One `.tape` per flow (import / categorize / summary / catch-the-sub / export), each from a known-good state. Use `cli-demo-generator` + `--bootstrap` to reset to the seeded May DB, a `Hide` prelude to pre-warm granite, and `Wait "❯"` to self-pace around latency; `--speed` to compress. A missed line or model bump = re-run the tape, not re-stage by hand.
**Axis:** Production & format
**Basis:** `direct:` `cli-demo-generator` (VHS, `--bootstrap`, `--speed`) + `ce-demo-reel` terminal-recording tier are installed; `/model`/`/pull` exist. `reasoned:` a 5-segment continuous take's success is the product of per-segment odds — five independent short tapes beat one fragile long run.
**Rationale:** Bounds any fumble to one cheap reshoot and makes the data + scripts reusable across model swaps. Highest leverage across all future videos. Mostly off-the-shelf configuration, not a build.
**Downsides:** Upfront tape authoring; segmented clips need a stitch pass. VHS runs granite live, so #2/#3 still required for behavior reliability.
**Confidence:** 87% · **Complexity:** Medium · **Status:** Unexplored

### 5. Make "local & private" the hero — airplane mode + visible network-silence proof
**Description:** Build one video around privacy: `/model` shows `ollama:granite4.1:3b`, go airplane-mode, run the flow, optionally with a network-monitor pane showing zero outbound traffic. Slowness becomes *proof* it's on-device. Pairs with the VHS `Hide` prelude (network pane as a second recorded region).
**Axis:** Distribution / narrative framing
**Basis:** `direct:` SOUL.md "Privacy is non-negotiable / all data stays local"; Ollama runs locally, so offline operation is literally demonstrable.
**Rationale:** Local-only is the differentiator vs. every cloud finance app. Showing the silent network converts the latency liability into the selling point.
**Downsides:** Network-monitor overlay adds complexity; narrower hook.
**Confidence:** 84% · **Complexity:** Low-Medium · **Status:** Unexplored

### 6. Correction-as-hero: script one real fumble + a one-line fix
**Description:** Keep a scene where granite miscategorizes a merchant, the user corrects it in one line ("no, that's Software"), and the model re-files it. Pre-empts the credibility gap of suspiciously perfect small-model demos and showcases the correction UX.
**Axis:** Scenario / script selection
**Basis:** `direct:` repo concedes granite is "occasionally wrong"; SOUL.md voice is direct/"you're the boss." `reasoned:` audiences discount demos that are too clean — especially for local 3B models.
**Rationale:** Turns an inevitable on-camera failure into trust-building content at near-zero capture cost.
**Downsides:** A visible mistake is a positioning call — keep to a secondary/honest cut, not the hero reel.
**Confidence:** 80% · **Complexity:** Low · **Status:** Unexplored

### 7. "Follow the money" forensic whodunit spine, sliced into modular per-skill clips
**Description:** Frame May as a case to crack — Wilson follows the money to a buried culprit (the forgotten sub, the duplicate, the spike from #1). Structure as an ordered scene bank, then slice the same spine into a long walkthrough, a 15s README loop, and 30-60s per-skill clips. `demo-video` story arcs + edge-tts narration composite the VHS clips.
**Axis:** Distribution / narrative + scenario
**Basis:** `direct:` brand is literally Frank J. Wilson / "follow the money"; 50+ skills make a single linear video lossy and fast to rot. `reasoned:` modular clips de-risk production (reshoot one, not all) and survive product changes.
**Rationale:** Narrative stakes that map onto anomaly detection, plus a content cadence; one spine means a product change edits one script, not N.
**Downsides:** Narrative wrapper risks "ad" feel for a dev audience; more pieces to manage.
**Confidence:** 78% · **Complexity:** Medium · **Status:** Unexplored

## Dependency chain

**#1 (data) → #2 + #3 (record reliably) → #4 (VHS harness) → #5 / #6 / #7 (framing & cuts).** #1–#4 are load-bearing decisions; #5–#7 are mixable framing choices.

## Emerging pipeline

`cli-demo-generator` (seed DB + pre-warm in `Hide`, single-tool prompts, `Wait`-on-prompt, `--bootstrap`, `--speed`) → deterministic per-segment GIFs → `ce-demo-reel` for README/PR drops, or `demo-video` to composite the narrated whodunit reel.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Record/replay "cassette" of canned model output | Borders on dishonest for a live-model demo; overlaps #4 — keep only as a fallback |
| 2 | 30-min uncut "real speed" stream | Narrow audience, high boredom risk; honesty served by #5/#6 |
| 3 | 10,000-transaction stress timelapse | Scope overrun — contradicts "month of May"; needs different data |
| 4 | Telestrator / slow-mo replay overlay | Editing technique below decision floor — a #4/#7 detail |
| 5 | Nature-doc Attenborough voiceover | Flavor; folds into #7 narration |
| 6 | "Mise en place" cold open | Folds into #2 (pre-import) + #4 (segmented) |
| 7 | Ship dataset as product / as CI fixture | Real leverage but a side-benefit of #1, not a separate demo decision |
| 8 | Deterministic seed-script generator | Implementation detail of authoring #1 + regenerating in #4 |
| 9 | One story across all 6 import formats | Risks multi-format scope creep; folded into #1/#7 |
| 10 | Curated-vs-realistic highlight month | A sub-decision within #1, not standalone |
| 11 | Golden-transcript fixture | Folded into #4 as the harness's script+regression artifact |
| 12 | "End on the one-command path" / convert | Distribution principle folded into #5/#7 |
| 13 | Pre-warm model before record | Tactical; concretely realized as #4's VHS `Hide` prelude |
| 14 | ui-demo (Playwright WebM) path | Web-app only — wilson is a TUI; dead end |

_Axis spread: all 5 axes covered (data #1,#2 · reliability #2,#3 · scenario #3,#6,#7 · production #4 · distribution #5,#7)._
