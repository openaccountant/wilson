# demos/rig: recording rig for real-tab dashboard demos

Records the real dashboard (system Chrome 154, WebMCP + WebGPU) with real data. No demo tab, no demo routes, no scripted
"agent". The only compositing allowed is annotating real footage. Media goes to `/private/tmp/claude-501/wilson-demos/`
(never git). Run everything from the repo root with `node`; `bun` is only used by the seed and the dashboard.

## Commands

```bash
# 1. reset: reseed the scratch HOME, set the profile to local Ollama, prove Ollama serves it (fails loudly)
node demos/rig/reset.mjs --name p1 [--with-injection] [--short-history] [--model ollama:gemma4:12b]

# 2. host: dashboard + Chrome + login + beat.preState (unrecorded), then wait on the control channel
node demos/rig/host.mjs --beat w9-tour --name p1 [--port 3141] [--cdp-port 9333] [--control-port 9400] [--auto-human] [--opts '{"decision":"deny"}']
#    prints READY control=... cdp=... when preState is done

# 3. drive it (from another process)
node demos/rig/ctl.mjs start-recording      # opens a fresh recorded tab (the scratch tab is closed)
node demos/rig/ctl.mjs run-human            # plays the beat's humanScript (or use --auto-human on the host)
node demos/rig/ctl.mjs wait <event> [ms]    # block until an event appears in the log
node demos/rig/ctl.mjs event <name> '{"k":1}' [--keyframe]   # an external process (the agent driver) can add events
node demos/rig/ctl.mjs status | events

# 4. stop: stop recording, encode, shut down; kills only what the rig started (pid files in <work>/run, command-line checked)
node demos/rig/stop.mjs --name p1

# 5. stills from the video itself, at every event flagged keyframe
node demos/rig/keyframes.mjs --beat w9-tour --out /private/tmp/claude-501/wilson-demos/p1
```

Workspace `<MEDIA>/<name>/`: `home/` `out/` (CSVs, CREDENTIALS.txt) `run/` (pid files, host.json, dashboard.log)
`chrome-udd/` (fresh each host start, deleted on shutdown) `<beat>/` (`video.webm`, `video.mp4`, `events.json`).

## Recording

Playwright `recordVideo` at 2880x1800 (viewport 1440x900, deviceScaleFactor 2; it records cleanly and sharp). After stop,
ffmpeg turns the VFR webm into a constant 30 fps H.264 MP4 (`-fps_mode cfr`, crf 16, yuv420p, faststart). The head of the
video (tab load) is trimmed so `t_ms = 0` is the first loaded frame; `events.json` offsets line up with the MP4.
The cursor is a small arrow drawn by an init script at the real pointer position (it hops into an open modal `<dialog>`
so it is not hidden by the top layer). The window must stay headed and foregrounded: the confirmation-card poller only
runs while the tab is visible.

## Agent attach (for beats with an agent side)

After `recording-started`, attach the agent to the same browser: `agent-browser --session s --cdp 9333 ...` (0.38.2 in
the spike dir; do NOT run `agent-browser close`). Only the recorded tab exists, so the agent cannot pick the wrong one.
Grants are per tab (sessionStorage), so a new recorded tab starts with zero tools. Declarative-form tools block until a
submit: call them with `--detach`.

## Beats (`beats/<id>.mjs`)

Export `meta`, `preState(page, ctx)` (unrecorded) and `humanScript(page, ctx)` (recorded). `ctx` has `h` (glide, click,
hold, type, scroll), `log(name, data, {keyframe})`, `api(path)`, `gotoTab`, `gotoTabHuman`, `paths`, `opts`. Scripts REACT
to DOM state (wait for the card, then press-and-hold); they never fabricate it. A failed precondition throws.

- `w9-tour`: human only. Overview, bridge panel (0 tools), Settings -> Agent access (kill switch ON, 25 Grant buttons, none
  granted), Activity ("No agent activity yet").
- `b5-propose`: preState imports both September CSVs through Transactions -> Import statement, runs `/categorize` in Chat with
  the local model, and requires Brightwell Pharmacy to still be Uncategorized. humanScript grants `categorize_transaction`,
  `transaction_search`, `spending_summary` in the bridge panel on camera, waits for a card (reads cards are handled too),
  holds Approve 1.2 s (or Reject with `--opts '{"decision":"deny"}'`), then shows the ledger row.

## Hooks for later beats

WebGPU model pre-warm: none needed for b5. A beat can add a `prewarm(ctx)` export later; the host does not call one yet.

## Known gaps

- The React dashboard has no login screen when auth is on (only legacy `html.ts` had one). The host signs in through the
  real `POST /api/auth/login` and stores the token where the app reads it, unrecorded. A recorded sign-in needs a product login UI.
- `/categorize` with `ollama:gemma4:12b` currently reports "1 batch errors ... [Ollama API] Invalid prompt: System messages
  are not allowed in the prompt or messages fields" (the other batches succeed).
