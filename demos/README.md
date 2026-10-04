# demos/

Everything demo-related lives here — one directory, not split across `demos/`
and `data/demo/` like it used to be.

```
demos/
├── media/        shippable output ONLY - every clip you'd actually watch
├── scripts/      the recording/post-processing pipeline
├── tapespec/     JSON recording scripts (+ legacy .tape files, see below)
├── fixtures/     seed data for the demo profile (~/.openaccountant/profiles/demo)
├── remotion/     Remotion sub-project - renders the branded "-card" composites
└── tape-video/   scratch: raw recordings, screenshots, timing sidecars (gitignored-in-spirit;
                  nothing here is committed, it's just where a recording session's
                  intermediate files land before you tighten + copy the result into media/)
```

## media/ naming

Every clip ships as a **plain cut** (`sovereignty.mp4`) with no title/end
cards, since that's the "watch this in a README/demo" format. Some also have
a **branded composite** (`sovereignty-card.mp4`) — the same footage run
through `remotion/` with an animated title card, subtitle, and end card,
produced by `remotion/render-all.sh`. `-card` always means "the Remotion
composite version"; no suffix means the direct recording.

GIFs (`*.gif`) exist for most plain cuts, not for the `-card` composites.

## Regenerating a clip

1. **VHS doesn't work on this machine** — go-rod's CDP screencast produces
   zero frames. Everything here is recorded with
   `bun demos/scripts/record-terminal.mjs demos/tapespec/<name>.json`
   (Playwright + ttyd), not `vhs <name>.tape`. The `.tape` files under
   `tapespec/` are kept only as the original human-readable design/prompt
   reference each JSON spec was translated from — they're not executable
   here.
2. **`idle` steps, never fixed `sleep`s, after a model beat.** The TUI's
   working indicator ends in the constant string `(esc to interrupt)` while
   a query is in flight (`src/components/working-indicator.ts`) — the `idle`
   step type keys on that. A prompt typed while it's showing is **silently
   swallowed**, not queued. Instant UI navigation (palette browsing, arrow
   keys) should use a short `sleep` or the `key` step type instead — `idle`
   would just sit through its 20s arm-deadline since no busy indicator ever
   appears for pure UI nav.
3. **Validate every take against its `shot` screenshots** before accepting
   it — re-record if a beat was swallowed or a number drifted from the demo
   profile's ground truth (see `scripts/verify-accuracy.sh` for what "correct"
   looks like: Harborview Hotel $318.00 / Megamart Online $89.99 duplicates,
   $4,481.44 August total, SKYSTREAM/STREAMFLIX/CLOUDVAULT/RIVERDALE GYM
   subscriptions).
4. **Tighten with `demos/scripts/tighten-by-timing.ts`**, not the older
   `tighten.ts` (freezedetect-based). An animated "esc to interrupt" spinner
   defeats freezedetect — every frame "moves," so it ends up cutting the
   answer reveal instead of the dead pause. `tighten-by-timing.ts` instead
   reads the wall-clock `armedAt`/`firedAt` timestamps that
   `record-terminal.mjs` writes to `<name>.timing.json`, speed-ramps the
   known think-window, and holds the reveal at real time.
   - Usage: `bun demos/scripts/tighten-by-timing.ts <raw.mp4> <timing.json> <out.mp4> [targetSec=13] [holdSec=2.5] [maxSpeed=14] [bootTrimSec=1.5] [tailCapSec=3.0]`
   - **Use a small `holdSec` (0.3-0.5), not 2+.** The idle detector's
     `firedAt` already lags true completion by ~1-1.5s (it waits for 3 clean
     0.5s polls before firing), so a large `holdSec` starts the "reveal
     hold" segment *before* the busy spinner actually cleared on screen —
     you'll ship a clip whose reveal still shows the spinner. Verify by
     extracting frames at **2fps, not 1fps** (1fps can straddle right over
     the transition and hide the bug) and actually looking at a few.
5. **GIF recipe depends on content.** For flat-color monospace TUI clips:
   ```
   ffmpeg -i in.mp4 -vf "fps=8,scale=900:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" pal.png
   ffmpeg -i in.mp4 -i pal.png -filter_complex "fps=8,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none" out.gif
   ```
   `dither=none` is a big size win here with zero visible cost — flat
   terminal backgrounds don't need it.
   **For the dashboard (real web UI: anti-aliased sans-serif text, card
   gradients, chart lines), that recipe posterizes badly.** Use full
   dithering + colors instead:
   ```
   ffmpeg -i in.mp4 -vf "fps=8,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" pal.png
   ffmpeg -i in.mp4 -i pal.png -filter_complex "fps=8,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" out.gif
   ```
   If still oversized, reach for `gifsicle -O3 --lossy=N` (N=40-80 is usually
   invisible; push higher only after spot-checking a frame) or a width cut
   before you ever turn off dithering on real UI content.
6. **Replace the file(s) in `media/` in place** and commit.

## Dashboard scenes are a different pipeline

`demos/scripts/record-dashboard.mjs` drives the dashboard SPA directly with
Playwright — no ttyd/xterm, no `idle`-step concept, no JSON tapespec. It has
its own hardcoded per-scene functions and waits (selectors/networkidle/sleep).
Boot the dashboard first: `wilson --profile demo --dashboard` (port 3141,
fixed in v0.5.0 — make sure no other wilson process is already running, since
only one can hold that port).

## The `-card` composites (`remotion/`)

`remotion/render-all.sh` reads raw/scratch recordings from `demos/tape-video`
(hero is the one exception — it reads its already-polished cut straight from
`demos/media/hero.mp4`, since compositing it needs no additional speed-up)
and writes `demos/media/<name>-card.mp4`. It intentionally has its own flat
per-clip speed multiplier tuned for *raw*, untightened footage — don't feed
it an already-tightened `demos/media/*.mp4` cut expecting the speed math to
still make sense.

## Ground truth

The demo profile (`~/.openaccountant/profiles/demo`) is seeded Jan-Aug 2026.
Don't reseed unless `scripts/verify-accuracy.sh` actually fails — a single
run occasionally flakes on one LLM-judged check due to model
non-determinism; re-run it before concluding the data is actually broken.

## WebMCP agent demo (`scripts/record-webmcp-agent.mjs`)

Approval cards are hold-to-approve (0.6 s press-and-hold; a plain click does
nothing), and `/mcp` client tokens carry write tools only while dashboard auth
is on. The harness now holds Approve with `page.mouse.down()`/`up()`.
TODO: the demo profile has auth off, so `categorize_transaction` cannot be
granted to the token as the script expects; enable auth on the profile (and log
the page in as its admin) before recording.

## Re-run a beat (real dashboard, real agent, real footage)

`rig/` + `seed/` + `compose/` record the real dashboard with synthetic data and cut it with HyperFrames. Nothing is
staged: a real LLM (Claude Code, headless) chooses its own actions over WebMCP; the compositor only annotates footage.

One command, from anywhere:

```bash
demos/run-beat.sh b5-propose [--take N] [--with-injection] [--short-history] [--no-render]
```

Prerequisites (checked up front; the script stops with a message if one is missing):

- System Chrome 154.x at `/Applications/Google Chrome.app` (WebMCPTesting flag). Chrome for Testing is never downloaded.
- Ollama serving `gemma4:12b` on 127.0.0.1:11434 (Wilson `/categorize` runs on it, locally).
- `claude` CLI on PATH and logged in (the agent; default model `sonnet`).
- `bun`, `node` (22), `ffmpeg`/`ffprobe`, `lsof`, network once for the `hyperframes@0.8.123` npx download and Google Fonts.
- Vendored agent-browser: `(cd demos/rig && npm install)`. It is pinned to exactly 0.38.2 in `demos/rig/package.json`
  (not in the product package.json); the rig refuses any other version and never uses a global install.
- Free ports 3141 (dashboard), 9333 (CDP), 9400 (control).

What it does: preflight, reset the scratch HOME under `/private/tmp/claude-501/`, start the host detached and wait for
READY (import September, `/categorize` on gemma), start recording, play the human in the background, wait for the human
to grant tools on camera (sync point only), run `rig/actor.mjs`, wait for `beat-end`, stop (constant 30 fps MP4),
cut keyframe stills, copy everything into the take dir, then build and render the HyperFrames cut. A trap always stops
the host (verified pid-file kill) on any failure.

Output, never committed: `/private/tmp/claude-501/wilson-demos/<beat>/take<N>/` with `video.mp4`, `events.json`,
`actor.log`, `actor.jsonl` (raw stream-json), `host.log`, `frames/`, `cut.mp4`. Existing takes are never overwritten.

The agent: `rig/actor.mjs` runs `claude -p --output-format stream-json --verbose` with `--tools Bash` and five narrow
`--allowedTools` patterns, each the exact absolute path of the vendored agent-browser with `--cdp <port> --session s`
plus one subcommand: `webmcp list`, `webmcp invoke`, `webmcp result`, `snapshot`, `get url`. `close`, `eval`, `click`,
`fill`, `screenshot`, `state save`, `open` and a re-targeted `--cdp` are not allowed (so the model cannot press Approve
on its own card). No `--dangerously-skip-permissions`; cwd is an empty directory inside the take. The brief is
`rig/beats/<beat>.brief.md`. After the run the harness audits `actor.jsonl` and fails the take (actor exit 5, and again
in the HyperFrames build) if any tool use falls outside that set, including a command that was attempted and denied.

Transcript integrity: the harness (not the model) writes `actor.jsonl` (raw stream-json plus a harness receipt time `_rx`
per line) and `actor.log`, a readable view (commands collapsed to one line, every tool-output line indented, so model-
or page-controlled text cannot forge a command or `[SUMMARY]` line). The cut does not parse `actor.log`; `build.mjs`
replays `actor.jsonl` through `rig/lib/actor-log.mjs` and renders structured entries. Compose copy lives in
`compose/beats/<beat>.json`; `compose/hyperframes-b5/build.mjs --take <dir>` derives all timing from `events.json` and
the receipt times.

What varies between takes: which reads the agent runs, which rows it proposes and the categories it picks, how long
gemma takes to categorize, and the Approve timing. The cut's captions are filled from the take's own data
(`{category}`, `{id}`).

**Most takes can still fail, and that is by design.** The agent is a real LLM choosing its own actions and the human on
camera is a script that only approves the explicit target (`SQ *KILN & CO STUDIO`, -$240.00, Uncategorized to a real
category). The brief steers the agent (read September, biggest uncategorized expense first) but cannot force it. Any
other change card is rejected on camera and never approved; the human then waits up to 150 s for a proposal for the
target. If the agent never proposes it (it finishes, or proposes only other rows), the human script errors and the take
fails with the reason in `events.json` (`human-script-error`). Other known failure causes: the agent's first reads
return nothing and it spends time re-querying (the brief now says September and lists the search semantics), a
proposal that times out because the human is gone, gemma leaving the target categorized. Expect to run a few takes
and keep the good one; do not expect every take to produce a cut.

How failures surface (non-zero exit, a `[run-beat] FAILED: ...` line): preflight problems name the missing piece; host
failure shows `host.log`; the actor exits 2 (setup), 3 (timeout, default 600 s), 4 (claude error) or 5 (policy
violation); the beat not ending means the human script errored (see `human-script-error` in `events.json`, `host.log`);
a take with no mutating proposal fails in the HyperFrames build. On ANY failure the take dir keeps the evidence
(`host.log`, `actor.log`/`actor.jsonl`, and the partial `video.mp4`/`video.webm`, `events.json`, `human-error.png` when
the rig produced them) plus a `FAILED` file with the exit code and reason. A failed take dir is moved aside to
`take<N>.failed-<epoch>` if you re-run with the same `--take N`; a take dir without a `FAILED` marker is never
overwritten.
