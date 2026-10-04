#!/usr/bin/env node
// keyframes: cut PNGs from the recorded MP4 at every event flagged keyframe, so the stills prove states that
// are in the video itself.   node demos/rig/keyframes.mjs --beat w9-tour [--name p1] [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, workspace, fail } from './lib/common.mjs';
const { flags } = parseArgs(process.argv.slice(2));
const ws = workspace(flags.name ?? 'p1');
const beat = flags.beat ?? fail('--beat required');
const dir = ws.beatDir(beat);
const log = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
const mp4 = path.join(dir, 'video.mp4');
if (!fs.existsSync(mp4)) fail('no video.mp4 in ' + dir);
const out = flags.out ?? path.join(ws.work, `keyframes-${beat}`);
fs.mkdirSync(out, { recursive: true });
const paths = [];
for (const ev of log.events.filter((e) => e.keyframe && e.t_ms !== null)) {
  const file = path.join(out, `${beat}-${String(ev.t_ms).padStart(6, '0')}-${ev.name}.png`);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (ev.t_ms / 1000).toFixed(3), '-i', mp4, '-frames:v', '1', '-vf', 'scale=1440:-2', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(r.stderr);
  paths.push(file);
}
console.log(paths.join('\n'));
