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
