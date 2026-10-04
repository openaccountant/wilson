# HyperFrames bake-off notes: beat 5 "It proposes. You decide."

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
- Callout 2 wording ("computed by the server") is from the brief; the footage shows the card with Uncategorized -> Shopping but nothing in the footage proves who computed it.
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
