# Shared HyperFrames cut template

One template for every beat. `build.mjs` turns a take (`events.json`, `ab-audit.jsonl`, `actor.jsonl`, `video.mp4`) plus a per-beat
config (`../beats/<beat>.json`) into a HyperFrames composition, and `run-beat.sh` renders it with the pinned
`npx --yes hyperframes@0.8.123` (`HYPERFRAMES_SKIP_SKILLS=1`).

```
node build.mjs --take /private/tmp/claude-501/wilson-demos/<beat>/take<N> --config ../beats/<beat>.json [--out <dir>]
cd <out> && HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@0.8.123 render --quiet -o <take>/cut.mp4
```

`--out` defaults to `<take>/hf`, never the template dir (the build refuses to write here), so two beats or two takes cannot collide.
The take's `video.mp4` is hard-linked (copied if that fails) into `<out>/assets/take.mp4`. Tests: `bun test src/__tests__/demo-cut-plan.test.ts
src/__tests__/demo-cut-b10.test.ts` (the b10 test uses a hand-made fixture in `../fixtures/`, a config-parsing test only; it is never rendered).

## Stage profile (footage only, for a live talk)

```
demos/compose/hyperframes/stage.sh --take <take dir> [--config <beat json>] [--publish <dir> --name <name>]
```

`build.mjs --profile stage` applies the beat's `profiles.stage` block (its keys replace the top-level ones), then renders footage only:
no title card, transcript, captions, callouts or CUT/ZOOM badges. The 16:10 recording fills the 1080 px height of the 1920x1080 frame and
zooms crop to the full 16:9 frame (`stageCrop` in plan.mjs), so a zoom shows footage edge to edge. A zoom that runs to the end of the cut
stays in. One corner tag, `sourceTag` (default `real agent · take {take} · recorded {recordedOn}`): the take number comes from the take
folder name and the date from `events.json` `recordingStartedAt`; while a ramp plays it adds `· <rate>× speed`. The default (web) profile
renders exactly as before.

`stage.sh` builds into `<take>/hf-stage`, renders, clones the last frame for `endHoldSeconds` (default 2; the deck freezes on it) into
`<take>/cut-stage.mp4`, and grabs `<take>/cut-stage-poster.png` at the `poster` anchor. Both times come from the build's `hf-stage/stage.json`.

| Profile field | What it does |
|---|---|
| `ramps[]` | `{id?, from, to, rate}` (anchors as above, rate in (1, 10]): kept footage between the anchors plays faster (`data-playback-rate`). Ramps never reorder or drop footage; they must not overlap. Use them for dead time (the agent working, a human scrolling). Works in the web profile too. |
| `poster` | Anchor of the poster frame; it must be inside kept footage. |
| `endHoldSeconds` | Last-frame hold added by stage.sh. |
| `sourceTag` | Tag text; `{take}`, `{recordedOn}` and the usual tokens. |

All other checks still run in the stage profile: audit vs stream, card binding, required events, `holds`, `noCardAfter`.

## Rules the template enforces

- Nothing is staged. Every cut, caption and transcript row is derived from `events.json`, `ab-audit.jsonl` or `actor.log`; the config only
  holds offsets from those anchors and the words.
- Editing only annotates: cuts are marked (CUT badge), zooms are a uniform crop of the same recording (ZOOM badge), never a re-composite.
- The take is refused when: a stream command is not in the audit (or the reverse), a card was shown and never resolved, a config belongs to
  another beat, a required event is missing, or a required caption/callout cannot be built.
- Optional items (`"optional": true`, `"if": ...`, each-captions) whose events are missing are skipped and listed on stderr under
  "skipped optional items".

## Config fields (`beats/<beat>.json`)

| Field | What it does |
|---|---|
| `id` | Must equal `events.json` `beat`; a mismatch refuses the build. Names the HyperFrames project. |
| `kicker`, `titleLead`, `titleAccent`, `subtitle`, `headerTitle`, `terminalTitle`, `titleSeconds` | Title card, header strip and terminal title. |
| `target` | Optional string for `{target}` in copy (beat 5: the merchant). |
| `requireTargetCard` | true: refuse the take unless a change card the host flagged `target` was decided (beat 5). |
| `requiredEvents` | Event names, or `{event, where}`. Any missing one fails the build, naming it. |
| `binding` | `{strategy, requireBinding}`. Binds a change card to the audited `webmcp invoke <tool> --detach` that raised it. `categorize-by-id` (beat 5): same tool + `params.id` == card `txId` + category == card "after"; unbindable cards throw. `tool-match`: same tool, started before the card; unbound cards are skipped unless `requireBinding`. `none`: no binding. |
| `cards` | `{rowMatch}`: regex (default `^categor`) selecting the `card-checked` row whose `[field, before, after]` feed `{field}`, `{before}`, `{after}`, `{category}`; with no match the first 3-element row is used. |
| `holds[]` (and `endHold`, the same for one entry) | `{event, where?, minSeconds}`: the kept segment containing that event must keep running at least this long after it (a readable result frame); an event outside every kept segment fails. |
| `cardStart` | When a card's overlays and zoom begin. `event` (default): the host's `card-shown`, which is polled and can lag the footage. `audit`: the audit end time of the invoke that raised the card (an early bound). `footage`: the first frame in which the card rectangle changes (ffmpeg, needs ffmpeg on PATH), searched between the audit end of the invoke (or `cardDetect.lead` s before the event) and the event; falls back to the event, noted on stderr. Beat 5 and 10 use `footage`. |
| `cardDetect` | `{fps: 10, lead: 4, fraction: 0.5, minMax: 5, rect?}`. The rect defaults to the card's `box`, else `zoom.card.rect`. A frame counts once its mean difference from the window's first frame reaches `fraction` of the largest difference, so a fading toast from the previous card is ignored. |
| `noCardAfter` | Event name; refuse if any card is shown after it. |
| `transcript.verbs` | Which `webmcp <verb>` audit entries appear in the terminal pane. Default `["list","invoke","result"]`. |
| `segments[]` | Footage kept, in order: `{id?, from, to, optional?, if?}`. Overlaps are clamped, never reordered; a gap of 1 s or more gets a CUT badge. A missing anchor drops an optional segment and fails a required one. `{seg: n}` anchors refer to the config index. |
| `callouts[]` | `{id, at, end, x, y, txt, sub?, src?, optional?, if?}`. `x`,`y` are in a 1200x750 design space (scaled to the footage panel). `src` is a third, cyan "source" line for a code citation. |
| `captions[]` | `{at, end, t, optional?, if?}` or the each form `{each: "<event>", where?, atOffset, endOffset, t}` (one caption per matching event; `{@this.field}` quotes that event; always optional). |
| `perCard` | Per-card copy from each card's own events. `kinds` (default `["change"]`), `requireDecisionEvents` (default true: a decided card needs `approve-pressed`/`reject-clicked`; false: the shown caption simply runs until it resolves), `resolvedHold`, `propose`, `behindDialog`, `shown`, `hold`, `resolved.{approve,reject,rejectOther,allow}`, `coShown`, `coDecide.{approve,reject,allow}`. Card variables: `{tool} {opId} {txId} {field} {before} {after} {category} {decision} {outcome} {cardText} {proposalArgs}`. `rejectOther` is used only for a card that is provably a different transaction than the host-flagged target card. |
| `zoom.card` | Honest crop while a card is on screen: from `card-shown` to `card-resolved + holdAfter`. `rect` (fractions of the frame, used when the card's `card-shown` event has no `box`), optional `box` on the event wins (CSS px of the recorded viewport, or fractions), `pad`, `maxScale`, `kinds`. Cards flagged `card-behind-dialog` with no `box` are not zoomed (we cannot say when the card became visible). |
| `zoom.windows[]` | `{id?, from, to, rect, optional?, if?}`: zoom on an anchored span (e.g. the Judge queue). `zoom.ease` seconds (default 0.6); windows closer than 2x ease glide to the next rect instead of resetting. |

Anchors (`at`, `end`, `from`, `to`) are objects: `{event, where?, nth?, offset?}` (an event in `events.json`; `where` filters by field, `nth` is an index or
`"last"`); `{cmd: "firstAgentCommand" | "firstProposal" | "lastBeforeFirstProposal", offset?}`; `{tool, which?: "first"|"last", edge?: "start"|"end", offset?}` (the agent's audited
`webmcp invoke <tool>`); `{seg, edge: "s"|"e", offset?}`; `{max: [...]}` / `{min: [...]}` (latest / earliest of the alternatives that exist). Derived event names that stand
in when the host did not record them: `last-card-resolved`, `first-proposal`, `first-card-shown`. A recorded event of the same name wins.

Copy tokens: `{@event.field}`, `{@event[phase=after-agent].field}`, `{@catch-score.caught.length}`, `{@event.field|fallback}`. Arrays join with " . ". Built-in
variables: `{target} {nCards} {nApproved} {nRejected} {nAllowed} {targetId} {targetAfter} {targetIs} {agentTools}` (`{agentTools}` is the audited tool names the agent invoked, in order).
`if` takes an event name, `{event, where}`, or an array of them (all must exist); `ifNot` is the same but skips the item when any exists. `where` values are plain (string compare) or `{lt|lte|gt|gte: n}`. Captions over 150 / 190 characters drop to 34 / 30 px so three lines fit.

## Adding a beat

1. Make the beat's host script emit `events.json` events (`t_ms` relative to the first loaded frame, `recordingStartedAt` set). Card events keep the shape
   `card-shown {index, opId, tool, change, text}`, `card-checked {index, rows}`, `card-resolved {index, decision, outcome}`; a `box` on `card-shown` gives the zoom its rect.
2. Copy `beats/b10-judge.json` (events-only anchors) or `beats/b5-propose.json` (card binding by id) to `beats/<beat>.json`; set `id` to the events `beat`.
3. List what must exist in `requiredEvents`; mark everything else `optional` or give it an `if`.
4. `node build.mjs --take <take> --config ../beats/<beat>.json --out <take>/hf`, read stderr (segments, cards, zooms, skipped items), then render and extract stills.
5. Add a config-parsing test beside `src/__tests__/demo-cut-b10.test.ts`. A fixture must be named as a fixture and never rendered.

## Source sub-lines and what the code supports (beat 5, 10)

The beat-5 card callout reads "Before -> after computed by the server", with the sub-line `#<id> . <before> -> <after>` and the source line
`src/dashboard/webmcp-bridge.ts:214 . the card shows the before/after "the server computed in prepare"`.
The brief cited `src/dashboard/ui/src/agent/webmcp-bridge.ts:214`; that path does not exist. The file is `src/dashboard/webmcp-bridge.ts`, and line 214 reads
"structured before/after the server computed in `prepare`; a read the user set to" (it continues "Ask shows what will run. Never the agent's own prose." on 215).
So the code does support "computed by the server", as a code comment about the card renderer; the footage alone does not prove it, which is why the callout carries the source line.
The beat-10 card callout says only what lines 214-215 say: the card text is not the agent's own prose.

The 2-hour rule (beat 10) cites `src/dashboard/judgement-routes.ts:42` (`REVIEW_AGENT_WINDOW_MS = 2 * 60 * 60 * 1000`). Read with `src/training/annotations.ts:346-348` and `judge-ui-core.ts:81`:
a rating or accept made while an agent had access, or within 2 hours of it (a grant created in the window, or a proposal younger than 2 hours), is flagged agent-present and is left out of the
default export; judge rows additionally need `includeJudge`, and agent-present rows need `includeAgentPresent` ("Include ratings made while an agent had access"). Proposed, rejected and superseded rows never qualify.

# Appendix: HyperFrames bake-off notes (beat 5, take1, historical)

Output: /private/tmp/claude-501/wilson-demos/bakeoff/hyperframes-b5.mp4 (1920x1080, 30fps, H.264, yuv420p, 46.7 s, 4.2 MB, no audio; source is silent)
Contact sheet: /private/tmp/claude-501/wilson-demos/bakeoff/hyperframes-b5-contact.png (1 frame / 3 s)
Tool: hyperframes 0.8.123 via npx (no global install). Node 22.20, ffmpeg 8.1, M4 Pro.

## Numbers
- Time to first render: about 4.5 min from `init` (11:48:50) to first finished MP4 (about 11:53). Roughly 1 min of that was reading the docs, the rest was writing `build.mjs` and one lint/check pass. First render itself: 54.3 s for 1487 frames (cold: Google Fonts fetch, 3 workers, drawElement capture).
- Re-render after edits: 21.0 s (24 s wall incl. CLI start), fonts cached.
- `npx hyperframes check`: about 57 s wall (it launches a browser and samples layout/contrast).
- Iterations: 2 renders. Render 1 showed a premature "now Shopping" caption (seg 3 started on the full ledger list, not the Kiln row); fixed by moving the cut to ledger-after minus 1.2 s.

## How it was built
`build.mjs` reads `assets/events.json` and `assets/actor.log` and emits `index.html`. Cuts, caption/callout times and transcript row times all come from event-log keys (grants-applied, card-shown, approve-pressed, approve-released, card-resolved, ledger-after) and actor-log wall clocks mapped to video time via `recordingStartedAt`. Re-run `node build.mjs` after changing anything. Source video (`assets/b5-take1.mp4`) is gitignored; copy it from /private/tmp/claude-501/wilson-demos/b5/take1/video.mp4.

Cuts (source s -> comp s): 15.8-33.9 -> 4.0; 92.0-111.9 -> 22.1; 120.4-125.1 -> 42.0. Title card 0-4 s. Removed: 58 s of agent reads between the grants and the "studio" search, and 8.5 s between "Done" and the ledger check. Video pixels are untouched apart from scaling 2880x1800 -> 1200x750.

## Honesty notes (read before publishing)
- Transcript panel shows only command lines, the `: pending` line, the `: completed` line, the result JSON and `[SUMMARY]`, verbatim. Tool outputs (the big JSON for searches) are omitted, not edited. One amber line "[clip edit: ...]" is my annotation and is labelled as such.
- Transcript lines from the cut section (15:45:56 to 15:46:49) appear all at once at the cut (comp 22.1 s), with their original timestamps. They are not shown at their real moments; the 58 s gap is elided.
- Actor log has 1 s timestamp resolution, so row timing vs. video is +/- 1 s. 
- Ordering oddity in the log: `webmcp result` is stamped 15:47:00 but the human approved at 15:47:03-04 (host log). I show the command at 15:47:00 and its "completed" output at card-resolved (108.9 s), on the assumption that `result` blocks until the card resolves. I did not verify that; it is an inference.
- The [SUMMARY] line has no timestamp; I placed it 1.2 s after card-resolved. Its claim that the agent "left the Amazon charge" is the agent's own statement, not shown in the footage.
- Callout 2 wording ("computed by the server") was from the brief; the footage shows the card with Uncategorized -> Shopping but nothing in the footage proves who computed it. (Resolved in the shared template: see "Source sub-lines" above.)
- The first transcript line `webmcp list --json` ("permission denied" then a fallback note in the log) is shown; the denied/fallback lines are skipped.

## Docs vs. observed
- Docs/AGENTS.md say to run the `/hyperframes` skills first; the CLI `init` printed a skills check hitting GitHub. I ignored the skills (HYPERFRAMES_SKIP_SKILLS=1) and the project worked from the schema docs alone.
- Docs warn about telemetry only indirectly: `lint` printed an "anonymous usage data" banner (and says it links to a HeyGen account if signed in). I ran `hyperframes telemetry disable` before the checks. Privacy-first repo: worth setting in CI.
- Docs/lint push sub-compositions for anything nested ("nested_structure_needs_subcomposition", "timeline_track_too_dense"). I ignored these 6 warnings; render is fine with a single file. Not an error, but the docs imply it is required for good Studio editing.
- Docs say "Do not call play/pause/currentTime" on video: followed; three `<video>` elements pointing at one file with different `data-media-start` worked, no seek drift seen.
- The blank template shipped `window.__timelines["main"]` without the `|| {}` guard that the schema doc shows. Worked anyway.
- I did not observe the `autoProxy` media behaviour (hyperframes.json) doing anything visible for the 2880x1800 source; extract step took 6.1 s on the first run, 0.5 s after.
- Fonts: Space Grotesk / Inter / JetBrains Mono (brand) are not installed locally; HyperFrames fetched them from Google Fonts and cached them ("Injected deterministic @font-face rules"). Works, but needs network the first time.
- `check` reported 3 errors that were false positives from my design: a bottom-anchored terminal whose old lines scroll out under the title bar (text_occluded / canvas_overflow). Fixed with `data-layout-allow-overflow` / `data-layout-allow-occlusion`. Contrast check passed 149/149.

## Seek/sync issues
None observed. Frame-by-frame capture means GSAP `tl.set(display)` row reveals, caption fades and video cuts land on the intended frames (verified by sampling frames at cuts and at card-shown / approve). No audio, so no A/V drift to test.

## What I'd change
- Show each transcript line at its real time by keeping more of the 40-92 s agent-read span (e.g. 2x speed ramp via `data-playback-rate`, labelled), instead of dumping 11 lines at the cut. Needs the speed-ramp reference; not tried.
- Add an arrow from callouts to the exact on-screen element (card, Hold button). Position is hand-tuned now.
- Move panels into sub-compositions to quiet the lint and make Studio editing nicer.
- Record the actor log with sub-second timestamps and a timestamp on the result output; the 1 s resolution and the `result` ordering are the weakest links in "timed to the event log".


## Cutting a long take (beat 10 additions)

- `each` on a segment, caption or zoom window: one per matching event (`each`, `where`, `atOffset`, `endOffset`; zoom windows take `phases: [{from, to, rect}]` so one event can pan across two rects). An each caption or zoom whose event is in cut footage is skipped; a segment wholly inside the previous one is dropped. Segments are sorted by start, so they can be listed in any order.
- `anchors`: named anchors, e.g. `dialogClosed: {footage: {rect, from, to}, fallback: {event, offset}}`. `footage` takes the LAST big change of that rectangle between `from` and `to` (ffmpeg; a dialog closing), else `fallback`. Use `{anchor: "dialogClosed", offset}` anywhere an anchor goes. `footageAnchors: "skip"` forces the fallbacks (tests).
- Audited counts as variables: `{calls_<tool>}` (e.g. `{calls_get_interaction}`) count the agent's `webmcp invoke <tool>` entries in `ab-audit.jsonl`. A copy string with any unfilled `{name}` fails (required) or is skipped (optional) instead of reaching the screen.
- Zoom rects: a `box` on `card-shown` may use `width`/`height` (Playwright `boundingBox`). Callouts take `w` (max width in px) so a callout can stay clear of a zoomed card.
- stderr prints `WARNING empty caption bar (comp s): ...` for any kept footage with no caption for more than 0.5 s.

## Card first appearance, measured (beat 5 take21)

| card | host `card-shown` | audit end of the `--detach` invoke | first frame the card changes (footage) |
|---|---|---|---|
| 0 (#279) | 42.83 s | 39.46 s | 40.66 s (visible in a 10 fps stills check at 40.7) |
| 1 (#298) | 53.33 s | 50.26 s | 51.46 s (visible at 51.5; the 50.4 s blip is the previous card's "Done" toast fading) |

The event lags the footage by 2.17 s and 1.87 s. The audit end precedes the card by 1.20 s on both cards (consistent, but a poll delay, not a signal within 0.3 s), so `audit` is only an early bound; `footage` matches the visible pop-in and is what beats 5 and 10 use.
