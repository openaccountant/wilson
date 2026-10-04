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

After `recording-started`, attach the agent to the same browser: `agent-browser --session s --cdp 9333 ...` (vendored 0.38.2 in `demos/rig/node_modules`, resolved by `lib/agent-browser.mjs`; do NOT run `agent-browser close`). `demos/run-beat.sh` drives all of this; `actor.mjs` is the real agent runner. Only the recorded tab exists, so the agent cannot pick the wrong one.
Grants are per tab (sessionStorage), so a new recorded tab starts with zero tools. Declarative-form tools block until a
submit: call them with `--detach`.

## Beats (`beats/<id>.mjs`)

Export `meta`, `preState(page, ctx)` (unrecorded) and `humanScript(page, ctx)` (recorded). `ctx` has `h` (glide, click,
hold, type, scroll), `log(name, data, {keyframe})`, `api(path)`, `gotoTab`, `gotoTabHuman`, `paths`, `opts`. Scripts REACT
to DOM state (wait for the card, then press-and-hold); they never fabricate it. A failed precondition throws.

- `w9-tour`: human only. Overview, bridge panel (0 tools), Settings -> Agent access (kill switch ON, 25 Grant buttons, none
  granted), Activity ("No agent activity yet").
- `b5-propose`: preState imports both September CSVs through Transactions -> Import statement, runs `/categorize` in Chat with
  the local model, and requires `SQ *KILN & CO STUDIO` to still be Uncategorized. humanScript grants `categorize_transaction`,
  `transaction_search`, `spending_summary` in the bridge panel on camera, waits for a card (reads cards are handled too),
  holds Approve 1.2 s (or Reject with `--opts '{"decision":"deny"}'`), then shows the ledger row.

## Hooks for later beats

WebGPU model pre-warm: none needed for b5. A beat can add a `prewarm(ctx)` export later; the host does not call one yet.

## Safety rails

- `--name` / `--beat` must be a plain segment (no `/`, no `..`). `assertScratch` resolves symlinks on the nearest existing
  parent and is applied to work, home, out, run, chrome-udd and the beat dir before anything is removed.
- `host.mjs` refuses to start if anything LISTENs on `--port`, `--cdp-port` or `--control-port` (`lsof`), and after launch
  verifies the pid listening on the CDP port is a Chrome with our `--user-data-dir` and `--remote-debugging-port`.
  So `--cdp <port>` can only ever reach the rig's own Chrome.
- Pid files carry a specific marker (`--dashboard --port <p>`, `--user-data-dir=<udd>`) and a start time. `stop.mjs` kills
  a pid only if both still match, signals the whole process group when the pid leads one, and reaps orphaned members of
  our dashboard group only when the pid record AND every member's command line (absolute `src/index.tsx --dashboard
  --port <p>`) check out; otherwise it logs the members and kills nothing. The dashboard runs with cwd = the scratch HOME. A stale or reused pid is reported and left alone.

## b5-propose: what the human script refuses to do

It never approves blindly. The target is explicit: `opts.target`, default `SQ *KILN & CO STUDIO` (-$240.00, Sep 22), the
row left uncategorized because it is ambiguous (business or personal). There is no fallback to another merchant: preState
FAILS if `/categorize` reports "batch errors occurred" or if the target row is not Uncategorized afterwards.

Before acting on a card it reads it. A change card must be tool `categorize_transaction`, contain the target description and
`-$240.00`, and carry a Category row going from Uncategorized to a real category (the agent's own choice). Read cards must
be for `transaction_search` / `spending_summary`. Anything else: log the card text, click Reject, exit with an error.
`opts.decision` is `approve` (default, hold Approve) or `deny` (click Reject, expect "Rejected. Nothing was changed.").

A test driver for the agent side (plain `agent-browser ... webmcp invoke transaction_search` then
`categorize_transaction {id, category}`, real calls) verified approve and reject end to end.

## Known gaps

- The React dashboard has no login screen when auth is on (only legacy `html.ts` had one). The host signs in through the
  real `POST /api/auth/login` and stores the token where the app reads it, unrecorded. A recorded sign-in needs a product login UI.
- The story line "Brightwell" does not hold with a local model that categorizes it; either change the seed so no model
  would, or accept the Kiln target.
