# Remotion B5 "It proposes. You decide." (53.0s, 1920x1080, 30fps, H.264)

Output: /private/tmp/claude-501/wilson-demos/bakeoff/remotion-b5.mp4 (+ remotion-b5-contact.png, 1 frame / 3s)
Source: src/B5.tsx (composition `B5`), scripts/b5-data.mjs (parses actor.log + events.json -> src/b5-data.json).
Render: `node scripts/b5-data.mjs && cp <take1>/video.mp4 public/b5/video.mp4 && npx remotion render src/index.ts B5 out.mp4 --crf=18`

## Numbers
- Time to first render: ~1.5 min to the first (failed) still after install; ~6 min to the first correct frame (two bugs below).
- Render time: 65-66s for 1590 frames (concurrency 4, 2880x1800 source via OffthreadVideo).
- npm install 10s (node_modules was absent in the worktree).

## Cuts (source seconds, from events.json t_ms): 17-30, 50.5-61, 65.5-68.5, 92-110.5, 119.5-124.5, plus a 3s title card.
Dead time dropped: 30-50 (idle, no agent output), 61-65, 68.5-92 (four searches/summaries), 110.5-119.5, 124.5+.

## Honesty
- Dashboard footage untouched apart from trims and scale. Transcript lines are verbatim from actor.log (the `agent-browser ` prefix is stripped from `$` lines; long outputs capped at 12 lines, the `webmcp list` output at 1 line, marked "... not shown ...").
- Transcript timestamps have 1s resolution, mapped to video via recordingStartedAt (15:45:16.011 = t0), so terminal timing is +-1s.
- Commands whose real time falls in a cut appear at the start of the next kept segment, preceded by "... cut to the next moment ...". Their outputs are the real ones.
- The [SUMMARY] line has no timestamp; it is shown at the final segment (after the ledger-after moment).
- Callouts/captions are pinned to event names (grants-applied 28.9s, card-shown 102.4s, card-checked 106.2s, approve-held 107.4s). Caption text only restates event-log / transcript facts.

## Friction
- Bug 1: public/ symlink to /private/tmp 404s in the OffthreadVideo proxy; had to copy the 10MB file (gitignored).
- Bug 2 (mine): Body Sequence is already offset by the title, and I offset inner Sequences again, giving 3s black video and a 3s caption/terminal drift. Nested Sequence offsets are relative; cost ~4 min and a needless re-encode experiment. A contact-sheet check caught it, not typecheck.
- google-fonts loaded all weights/subsets (96+ network requests) until restricted.
- No seek/sync issues in OffthreadVideo itself: startFrom + cuts were frame accurate; sparse 8s keyframes caused no problems.

## Would change
- Drive terminal timing from a typed cue list with explicit "elided" markers rather than inferring from cuts.
- Tighten callout 1 to sit beside the grants popup instead of over empty dashboard space; trim the 3s title to 2s.
- Add an automated check (black-frame / luminance scan) after render.
