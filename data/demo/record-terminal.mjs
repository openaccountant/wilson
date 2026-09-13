// record-terminal.mjs — VHS replacement for TUI demo tapes (Playwright + ttyd).
// VHS's frame capture (go-rod CDP screencast) produces zero frames on this
// machine with current Chrome; Playwright recordVideo does the same job and
// already powers record-dashboard.mjs / make-cards.mjs here.
//
// Usage:  bun data/demo/record-terminal.mjs <spec.json>
// Output: data/demo/tape-video/<name>.webm + per-step screenshots (PNG),
// then ffmpeg converts to <spec.output> (default data/demo/<name>.mp4).
//
// Spec format (JSON):
// {
//   "name": "boe-demo-v2",
//   "width": 1400, "height": 860, "fontSize": 18, "typingSpeedMs": 55,
//   "theme": { "background": "#0a0f1a", ... ttyd xterm theme },
//   "cmd": ["./data/demo/run-demo.sh"],          // what ttyd serves (default: zsh)
//   "output": "data/demo/boe-demo-v2.mp4",
//   "steps": [
//     { "type": "type", "text": "...", "enter": true },   // type into the shell
//     { "type": "sleep", "seconds": 14 },
//     { "type": "shot", "file": "shot-v2-00-boot.png" },  // full-page PNG
//     { "type": "wait", "pattern": "tokens", "timeout": 180 }  // waits for a NEW
//                                   // match vs. the on-screen count (old beats' stats lines stay visible)
//   ]
// }

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const specPath = process.argv[2];
if (!specPath) {
  console.error('Usage: bun data/demo/record-terminal.mjs <spec.json>');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const {
  name,
  width = 1400,
  height = 860,
  fontSize = 18,
  typingSpeedMs = 55,
  theme = { background: '#0a0f1a', foreground: '#e5e7eb', cursor: '#22c55e', selection: '#166534' },
  cmd,
  output = `data/demo/${name}.mp4`,
  steps = [],
} = spec;
if (!name) { console.error('spec needs a "name"'); process.exit(1); }

const PORT = 17683;
const OUTDIR = 'data/demo/tape-video';
const SHOTDIR = 'data/demo';
mkdirSync(OUTDIR, { recursive: true });

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ttyd client options: font size + xterm theme JSON
const clientOpts = [`fontSize=${fontSize}`, `theme=${JSON.stringify(theme)}`];
const ttydArgs = ['-p', String(PORT), '-W', '-t', 'rendererType=dom', ...clientOpts.flatMap((o) => ['-t', o]), ...(cmd ?? ['zsh', '-il'])];

const ttyd = spawn('ttyd', ttydArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
ttyd.stderr.on('data', () => {}); // ttyd is chatty; keep the recording log clean
process.on('exit', () => ttyd.kill('SIGTERM'));

// wait for ttyd to listen
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`);
    if (r.ok) break;
  } catch {}
  await sleep(0.25);
}

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width, height },
  recordVideo: { dir: OUTDIR, size: { width, height } },
  colorScheme: 'dark',
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.xterm-rows', { timeout: 10000 });

const bufferText = () =>
  page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');

// Wall-clock timeline sidecar: post-processing (tighten-by-timing.ts) needs the
// real armed/fired boundaries of 'idle'/'wait' steps to speed-ramp the think
// pause without relying on freezedetect (an animated spinner defeats it, and
// it ends up cutting the answer reveal instead of the dead air).
const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const timeline = [];

let stepNum = 0;
for (const step of steps) {
  stepNum++;
  const tStart = elapsed();
  let armedAt, firedAt;
  if (step.type === 'type' || step.text !== undefined) {
    await page.keyboard.type(step.text, { delay: typingSpeedMs });
    if (step.enter !== false) await page.keyboard.press('Enter');
  } else if (step.type === 'sleep' || step.seconds !== undefined) {
    await sleep(step.seconds ?? 1);
  } else if (step.type === 'shot') {
    await page.screenshot({ path: `${SHOTDIR}/${step.file}`, fullPage: false });
    console.log(`  shot -> ${SHOTDIR}/${step.file}`);
  } else if (step.type === 'idle') {
    // Deterministic "beat finished" signal. The TUI's working indicator is
    // "<rotating verb>... (esc to interrupt)" (src/components/working-indicator.ts)
    // — the verb rotates through ~30 words, but the suffix is constant and
    // appears ONLY while a query is in flight. Arm on busy appearing, fire
    // when it has been gone for ~1.5s (3 clean polls, guards repaint gaps).
    const busyRe = /esc to interrupt/;
    const deadline = Date.now() + (step.timeout ?? 300) * 1000;
    const armDeadline = Date.now() + 20000;
    let armed = false;
    while (!armed && Date.now() < armDeadline) {
      if (busyRe.test(await bufferText())) armed = true;
      else await sleep(0.25);
    }
    if (armed) armedAt = elapsed();
    if (!armed) console.log('  idle: never saw busy marker; assuming already done');
    let clean = 0;
    let ok = !armed; // if never armed, don't sit through the whole timeout
    while (!ok && Date.now() < deadline) {
      if (busyRe.test(await bufferText())) clean = 0;
      else if (++clean >= 3) ok = true;
      if (!ok) await sleep(0.5);
    }
    if (ok && armed) firedAt = elapsed();
    if (!ok) console.log('  IDLE TIMEOUT (continuing)');
  } else if (step.type === 'wait') {
    const re = new RegExp(step.pattern);
    // The DOM renderer only exposes the viewport — old stats lines scroll away,
    // so occurrence counting fails. Instead watch the tail of the buffer:
    // phase A (arm): wait until the pattern is NOT near the bottom (streaming
    // output has pushed the previous beat's stats line out of the tail),
    // phase B (fire): wait until it IS (this beat's stats line just printed).
    const tailOf = (t) => t.slice(-300);
    const deadline = Date.now() + (step.timeout ?? 180) * 1000;
    let armed = !re.test(tailOf(await bufferText()));
    const armDeadline = Date.now() + 20000;
    while (!armed && Date.now() < armDeadline) {
      await sleep(0.5);
      armed = !re.test(tailOf(await bufferText()));
    }
    if (armed) armedAt = elapsed();
    if (!armed) console.log('  wait: arm phase expired (previous stats still in tail); watching anyway');
    let ok = false;
    while (Date.now() < deadline) {
      if (re.test(tailOf(await bufferText()))) { ok = true; break; }
      await sleep(0.5);
    }
    if (ok) firedAt = elapsed();
    if (!ok) console.log(`  WAIT TIMEOUT on /${step.pattern}/ (continuing)`);
  }
  const tEnd = elapsed();
  timeline.push({ i: stepNum, type: step.type ?? (step.text !== undefined ? 'type' : 'sleep'), tStart, tEnd, armedAt, firedAt });
}

const video = page.video();
await ctx.close();
await browser.close();
ttyd.kill('SIGTERM');

const webmPath = OUTDIR + '/' + (await video.path().then((p) => p.split('/').pop()));
await video.path(); // ensure finalized
const rawWebm = await video.path();
const namedWebm = `${OUTDIR}/${name}.webm`;
try { renameSync(rawWebm, namedWebm); } catch { /* same name already */ }

// webm -> mp4 (faststart, yuv420p for compatibility with tighten.ts/polish.sh)
if (output && existsSync(namedWebm)) {
  execSync(`ffmpeg -y -loglevel error -i "${namedWebm}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${output}"`);
  console.log(`wrote ${output}`);
}

const timingPath = `${OUTDIR}/${name}.timing.json`;
writeFileSync(timingPath, JSON.stringify({ name, steps: timeline }, null, 2));
console.log(`wrote ${timingPath}`);
console.log('DONE');
