#!/usr/bin/env bun
// Tighten a record-terminal.mjs clip using its *.timing.json sidecar instead of
// freezedetect. tighten.ts's freeze-detection trap: an animated spinner (rotating
// verb + braille glyph) keeps every frame of the think-pause "moving" as far as
// ffmpeg's freezedetect is concerned, while the answer *reveal* can render in a
// burst of near-identical frames — so freezedetect ends up flagging the reveal
// as the freeze and cutting it instead of the dead air.
//
// This script knows the real segment boundaries from wall-clock timestamps:
//   [0, typeStart]           static boot screen -> hard-trimmed to a short glimpse
//   [typeStart, typeEnd]     the prompt being typed -> kept at real time
//   [typeEnd, revealStart]   the model "thinking" (idle/wait armed..firedAt-hold)
//                            -> speed-ramped (setpts), factor solved for targetSec
//   [revealStart, dur]       the answer settling (reveal hold) -> kept at real time
//
// Usage:  bun demos/scripts/tighten-by-timing.ts <raw.mp4> <timing.json> <out.mp4> [targetSec=13] [holdSec=2.5] [maxSpeed=14] [bootTrimSec=1.5] [tailCapSec=3.0]

import { spawnSync } from 'bun';
import { readFileSync } from 'node:fs';

const [raw, timingPath, out, targetArg = '13', holdArg = '2.5', maxSpeedArg = '14', bootTrimArg = '1.5', tailCapArg = '3.0'] =
  process.argv.slice(2);
if (!raw || !timingPath || !out) {
  console.error('Usage: bun demos/scripts/tighten-by-timing.ts <raw.mp4> <timing.json> <out.mp4> [targetSec] [holdSec] [maxSpeed] [bootTrimSec] [tailCapSec]');
  process.exit(1);
}
const target = parseFloat(targetArg);
const hold = parseFloat(holdArg);
const maxSpeed = parseFloat(maxSpeedArg);
const bootTrim = parseFloat(bootTrimArg);
const tailCap = parseFloat(tailCapArg);

function sh(cmd: string[]): string {
  const r = spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
}

const dur = parseFloat(
  sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]).trim()
);

const timing = JSON.parse(readFileSync(timingPath, 'utf8'));
const steps = timing.steps ?? [];

// The thinking window is the 'idle' (interactive TUI) or 'wait' (headless) step
// with the longest armedAt..firedAt span.
const candidates = steps.filter(
  (s: any) => (s.type === 'idle' || s.type === 'wait') && s.armedAt != null && s.firedAt != null
);
if (candidates.length === 0) {
  console.error('no idle/wait step with armedAt/firedAt found in timing.json; copying as-is');
  sh(['ffmpeg', '-y', '-i', raw, '-c', 'copy', out]);
  process.exit(0);
}
const think = candidates.reduce((a: any, b: any) => (b.firedAt - b.armedAt > a.firedAt - a.armedAt ? b : a));
const thinkEnd = think.firedAt;

// The prompt-typing step directly preceding the think window (if any).
const typeStep = [...steps]
  .filter((s: any) => s.type === 'type' && s.tEnd <= think.tStart)
  .sort((a: any, b: any) => a.tEnd - b.tEnd)
  .pop();
const typeStart = typeStep ? typeStep.tStart : think.armedAt;
const typeEnd = typeStep ? typeStep.tEnd : think.armedAt;

const W = thinkEnd - typeEnd; // thinking window to speed-ramp
const H = Math.min(hold, Math.max(W, 0)); // never hold longer than the window itself
const revealStart = thinkEnd - H;

const bootKeep = Math.min(bootTrim, typeStart); // real-time glimpse of the booted screen
const bootCutFrom = typeStart - bootKeep;

const typeDur = typeEnd - typeStart;
const speedWindow = revealStart - typeEnd;
// Trailing dead time (post-reveal sleeps, shell prompt sitting idle) is just as
// safe to hard-trim as the boot screen — cap how much of it we keep.
const tailEnd = Math.min(dur, revealStart + tailCap);
const tail = tailEnd - revealStart;

const nonSped = bootKeep + typeDur + tail;
let speed = speedWindow > 0 ? speedWindow / Math.max(target - nonSped, 0.5) : 1;
speed = Math.max(1, Math.min(speed, maxSpeed));

console.log(
  `duration=${dur.toFixed(1)}s  type=[${typeStart.toFixed(1)},${typeEnd.toFixed(1)}]  think=[${typeEnd.toFixed(1)},${thinkEnd.toFixed(1)}] (${W.toFixed(1)}s)  hold=${H.toFixed(1)}s  speed=${speed.toFixed(2)}x`
);

if (speedWindow <= 0.3 && bootCutFrom <= 0.1) {
  console.log('nothing meaningful to trim/ramp; copying as-is');
  sh(['ffmpeg', '-y', '-i', raw, '-c', 'copy', out]);
} else {
  const fc =
    `[0:v]trim=${bootCutFrom.toFixed(3)}:${typeStart.toFixed(3)},setpts=PTS-STARTPTS[a];` +
    `[0:v]trim=${typeStart.toFixed(3)}:${typeEnd.toFixed(3)},setpts=PTS-STARTPTS[b];` +
    `[0:v]trim=${typeEnd.toFixed(3)}:${revealStart.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(4)}[c];` +
    `[0:v]trim=${revealStart.toFixed(3)}:${tailEnd.toFixed(3)},setpts=PTS-STARTPTS[d];` +
    `[a][b][c][d]concat=n=4:v=1[v]`;
  sh(['ffmpeg', '-y', '-i', raw, '-filter_complex', fc, '-map', '[v]', '-r', '24', out]);
}

const newDur = parseFloat(
  sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).trim()
);
console.log(`wrote ${out}  (${newDur.toFixed(1)}s)`);
