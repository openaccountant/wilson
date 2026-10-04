#!/usr/bin/env bun
// Tighten a VHS demo clip by jump-cutting the dead "model is thinking" pause.
//
// The model runs locally, so a real query leaves ~15-30s of near-static spinner in
// the recording. This finds the longest gap between on-screen scene changes
// (= the think-pause) and cuts most of it out, keeping a brief honest beat of
// "thinking" plus the full typing intro and answer reveal.
//
// Usage:  bun demos/tighten.ts <raw.mp4> <out.mp4> [keepBeforeSec] [keepAfterSec]
//   keepBeforeSec: seconds of think-pause to keep after the question (default 2.0)
//   keepAfterSec : lead-in seconds kept before the answer burst (default 0.4)

import { spawnSync } from 'bun';

const [raw, out, kb = '2.0', ka = '0.4'] = process.argv.slice(2);
if (!raw || !out) {
  console.error('Usage: bun demos/tighten.ts <raw.mp4> <out.mp4> [keepBeforeSec] [keepAfterSec]');
  process.exit(1);
}
const keepBefore = parseFloat(kb);
const keepAfter = parseFloat(ka);

function sh(cmd: string[]): string {
  const r = spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
}

// total duration
const dur = parseFloat(
  sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]).trim()
);

// freezedetect: terminal text barely moves ffmpeg's global "scene" score, but the
// model think-pause is a near-static frame, so freezedetect finds it cleanly.
const fd = sh([
  'ffmpeg', '-i', raw,
  '-vf', 'freezedetect=n=-50dB:d=1.5',
  '-map', '0:v', '-f', 'null', '/dev/null',
]);
const starts = [...fd.matchAll(/freeze_start:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
const ends = [...fd.matchAll(/freeze_end:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));

// pair starts with ends in order; an unmatched final start runs to EOF
let gapStart = 0, gapEnd = dur, best = 0;
for (let i = 0; i < starts.length; i++) {
  const s = starts[i];
  const e = i < ends.length ? ends[i] : dur;
  if (e - s > best) { best = e - s; gapStart = s; gapEnd = e; }
}

const cutTo = Math.min(gapStart + keepBefore, dur);     // end of part A
const cutFrom = Math.max(gapEnd - keepAfter, cutTo);    // start of part B
const removed = cutFrom - cutTo;

console.log(`duration=${dur.toFixed(1)}s  think-pause=[${gapStart.toFixed(1)},${gapEnd.toFixed(1)}] (${best.toFixed(1)}s)`);
console.log(`keep [0,${cutTo.toFixed(1)}] + [${cutFrom.toFixed(1)},${dur.toFixed(1)}]  -> removing ${removed.toFixed(1)}s`);

if (removed < 1.5) {
  console.log('think-pause too short to cut; copying as-is');
  sh(['ffmpeg', '-y', '-i', raw, '-c', 'copy', out]);
} else {
  const fc =
    `[0:v]trim=0:${cutTo.toFixed(3)},setpts=PTS-STARTPTS[a];` +
    `[0:v]trim=${cutFrom.toFixed(3)}:${dur.toFixed(3)},setpts=PTS-STARTPTS[b];` +
    `[a][b]concat=n=2:v=1[v]`;
  sh(['ffmpeg', '-y', '-i', raw, '-filter_complex', fc, '-map', '[v]', '-r', '24', out]);
}
const newDur = parseFloat(
  sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).trim()
);
console.log(`wrote ${out}  (${newDur.toFixed(1)}s)`);
