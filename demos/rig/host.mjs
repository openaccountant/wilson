#!/usr/bin/env node
// host: the long-running recording host.
//
//   node demos/rig/host.mjs --beat w9-tour [--name p1] [--port 3141] [--cdp-port 9333] [--control-port 9400]
//                           [--auto-human] [--dsf 2|1] [--keep-udd]
//
// It starts the dashboard against the workspace HOME, launches system Chrome (headed, WebMCPTesting, remote
// debugging) through Playwright, logs in as the admin, runs the beat's preState (UNRECORDED, on a scratch tab),
// then waits on the control channel. `start-recording` opens a fresh tab that records; `run-human` (or --auto-human)
// plays the beat's humanScript on it; `stop-recording` finalizes the video and encodes a constant-frame-rate MP4.
//
// Nothing here fakes UI. Recording is a screencast of the real product tab; the cursor overlay only draws where the
// real pointer is.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  parseArgs, workspace, assertScratch, assertPortsFree, listeners, pidCommand, readCreds, sleep, waitForHttp, writePid, pidfileLive, fail, REPO, RIG_DIR,
} from './lib/common.mjs';
import { CURSOR_INIT_SCRIPT, humanFor } from './lib/human.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const beatId = flags.beat ?? fail('--beat <id> is required');
const ws = workspace(flags.name ?? 'p1');
const port = Number(flags.port ?? 3141);
const cdpPort = Number(flags['cdp-port'] ?? 9333);
const controlPort = Number(flags['control-port'] ?? 9400);
const dsf = Number(flags.dsf ?? 2);
const VIEW = { width: 1440, height: 900 };
const baseUrl = `http://localhost:${port}`;
const beatDir = ws.beatDir(beatId);

for (const p of [ws.work, ws.home, ws.out, ws.run, ws.chromeUdd, beatDir]) assertScratch(p);
if (!fs.existsSync(path.join(ws.out, 'CREDENTIALS.txt'))) fail(`no seeded workspace at ${ws.work}; run reset.mjs first`);
if (pidfileLive(ws, 'host')) fail(`a host for workspace ${ws.name} is already running`);

try { assertPortsFree({ dashboard: port, cdp: cdpPort, control: controlPort }); } catch (e) { fail(e.message); }
if (new Set([port, cdpPort, controlPort]).size !== 3) fail('--port, --cdp-port and --control-port must differ');

const beat = await import(pathToFileURL(path.join(RIG_DIR, 'beats', `${beatId}.mjs`)).href);
if (typeof beat.humanScript !== 'function') fail(`beat ${beatId} must export humanScript`);

fs.rmSync(beatDir, { recursive: true, force: true });
fs.mkdirSync(beatDir, { recursive: true });
fs.mkdirSync(ws.run, { recursive: true });
writePid(ws, 'host', process.pid, 'host.mjs');

// ---------- event log ----------
const events = [];
let recCreated = null;
let trimMs = 0;
let recStart = null; // Date.now() when the recording page was created
const eventsFile = path.join(beatDir, 'events.json');
function log(name, data = {}, opts = {}) {
  const now = Date.now();
  const ev = { name, wall: new Date(now).toISOString(), t_ms: recStart ? now - recStart : null, ...(opts.keyframe ? { keyframe: true } : {}), ...data };
  events.push(ev);
  fs.writeFileSync(eventsFile, JSON.stringify({ beat: beatId, recordingStartedAt: recStart ? new Date(recStart).toISOString() : null, events }, null, 2));
  console.log(`[event] ${ev.t_ms === null ? '   --  ' : String(ev.t_ms).padStart(7)}ms ${name}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}`);
  waiters.forEach((w) => w(ev));
  return ev;
}
const waiters = new Set();
function waitEvent(name, timeoutMs) {
  const have = events.find((e) => e.name === name);
  if (have) return Promise.resolve(have);
  return new Promise((resolve) => {
    const to = setTimeout(() => { waiters.delete(w); resolve(null); }, timeoutMs);
    const w = (ev) => { if (ev.name === name) { clearTimeout(to); waiters.delete(w); resolve(ev); } };
    waiters.add(w);
  });
}

// ---------- processes we start ----------
let dashboard = null;
let context = null;
let shuttingDown = false;
const started = { dashboardPid: null, chromePid: null };

async function startDashboard() {
  const shim = path.join(ws.home, '.webmcp-live-bin');
  if (!fs.existsSync(path.join(shim, 'security'))) throw new Error('keychain shim missing; re-run reset.mjs');
  const logFd = fs.openSync(path.join(ws.run, 'dashboard.log'), 'w');
  dashboard = spawn('bun', ['run', 'src/index.tsx', '--dashboard', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, HOME: ws.home, PATH: `${shim}:${process.env.PATH}` },
    stdio: ['ignore', logFd, logFd],
    detached: true, // own process group so shutdown can take down bun's children too
  });
  started.dashboardPid = dashboard.pid;
  writePid(ws, 'dashboard', dashboard.pid, `--dashboard --port ${port}`);
  dashboard.on('exit', (code) => { if (!shuttingDown) { console.error(`dashboard exited early (${code}); see ${path.join(ws.run, 'dashboard.log')}`); void shutdown(1); } });
  await waitForHttp(baseUrl + '/', { timeoutMs: 90000 });
}

async function launchChrome() {
  fs.rmSync(ws.chromeUdd, { recursive: true, force: true });
  fs.mkdirSync(ws.chromeUdd, { recursive: true });
  context = await chromium.launchPersistentContext(ws.chromeUdd, {
    channel: 'chrome',
    headless: false,
    viewport: VIEW,
    deviceScaleFactor: dsf,
    args: ['--enable-features=WebMCPTesting', `--remote-debugging-port=${cdpPort}`, '--no-first-run', '--no-default-browser-check', '--disable-infobars'],
    recordVideo: { dir: path.join(beatDir, 'raw'), size: { width: VIEW.width * dsf, height: VIEW.height * dsf } },
  });
  await context.addInitScript(CURSOR_INIT_SCRIPT);
  // Prove the CDP endpoint is OUR Chrome: whoever listens on cdpPort must be a chrome launched with our user-data-dir.
  const owners = listeners(cdpPort);
  const mine = owners.filter((p) => { const c = pidCommand(p); return /chrome/i.test(c) && c.includes(`--user-data-dir=${ws.chromeUdd}`) && c.includes(`--remote-debugging-port=${cdpPort}`); });
  if (!owners.length || mine.length !== owners.length) throw new Error(`CDP port ${cdpPort} is not owned by our Chrome (listeners: ${owners.map((p) => `${p}: ${pidCommand(p).slice(0, 100)}`).join(' | ') || 'none'})`);
  const pid = mine[0];
  started.chromePid = pid; writePid(ws, 'chrome', pid, `--user-data-dir=${ws.chromeUdd}`);
  const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  log('chrome-launched', { browser: ver.Browser, cdpPort, dsf, pid });
}

// The React dashboard has no login screen (only the legacy html.ts page had one), so the rig signs in through the
// real POST /api/auth/login and stores the token where the app reads it. Unrecorded, in the scratch tab.
async function login(page, creds) {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(async (c) => {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.token) { localStorage.setItem('wilson_auth_token', j.token); localStorage.setItem('oa_token', j.token); }
    return { status: res.status, role: j.user?.role };
  }, creds);
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Overview', exact: true }).waitFor({ timeout: 30000 });
  await page.getByText(/Couldn't load|API 401/).waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
}

// ---------- beat context ----------
const creds = readCreds(ws.out);
function beatCtx(page, recording) {
  return {
    beatId, baseUrl, creds, recording, context, page,
    paths: { home: ws.home, out: ws.out, work: ws.work, beatDir, csv: { checking: path.join(ws.out, 'checking-2026-09.csv'), card: path.join(ws.out, 'card-2026-09.csv') } },
    h: humanFor(page),
    log, sleep, waitEvent,
    /** Authenticated GET against the dashboard API from inside the page (read-only checks). */
    async api(p) {
      return page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { Authorization: 'Bearer ' + (localStorage.getItem('wilson_auth_token') || '') } });
        return { status: r.status, body: await r.json().catch(() => null) };
      }, p);
    },
    async gotoTab(name) {
      await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    },
    /** Same, but with the visible cursor gliding to the tab like a person would. */
    async gotoTabHuman(name) {
      await this.h.click(page.getByRole('navigation').getByRole('button', { name, exact: true }), { pause: 700 });
    },
    opts: flags.opts ? JSON.parse(flags.opts) : {},
  };
}

let scratchPage = null;
let recPage = null;
let phase = 'starting';
let humanState = 'idle';
let humanPromise = null;
let result = null;

async function startRecording() {
  if (phase !== 'ready') throw new Error(`cannot start recording in phase ${phase}`);
  recPage = await context.newPage();
  recCreated = Date.now();
  // The scratch tab (login + preState) goes away so only the recorded tab exists for an attached agent.
  const rawScratch = scratchPage.video();
  await scratchPage.close();
  try { fs.rmSync(await rawScratch.path(), { force: true }); } catch {}
  scratchPage = null;
  await recPage.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await recPage.getByRole('button', { name: 'Overview', exact: true }).waitFor({ timeout: 30000 });
  await recPage.bringToFront();
  phase = 'recording';
  recStart = Date.now(); // t=0 of the delivered MP4: the first loaded frame
  trimMs = recStart - recCreated;
  log('recording-started', { viewport: VIEW, dsf, note: 't_ms is relative to the first loaded frame; MP4 head is trimmed to match', trimMs });
  if (flags['auto-human']) void runHuman();
}

async function runHuman() {
  if (phase !== 'recording') throw new Error('run-human needs phase recording');
  if (humanState === 'running') throw new Error('humanScript already running');
  humanState = 'running';
  const ctx = beatCtx(recPage, true);
  log('human-script-start');
  humanPromise = (async () => {
    try {
      await beat.humanScript(recPage, ctx);
      humanState = 'done';
      log('human-script-done');
    } catch (e) {
      humanState = 'error';
      log('human-script-error', { message: String(e?.message ?? e).slice(0, 500) });
      try { await recPage.screenshot({ path: path.join(beatDir, 'human-error.png') }); } catch {}
    }
  })();
}

function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'json', file], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).streams[0]; } catch { return null; }
}

async function stopRecording() {
  if (phase !== 'recording') throw new Error(`not recording (phase ${phase})`);
  if (humanState === 'running') await Promise.race([humanPromise, sleep(5000)]);
  await sleep(600); // let the last frame land
  log('recording-stopping');
  const video = recPage.video();
  const blank = await context.newPage(); // keep a window alive while the recorded tab closes
  await recPage.close();
  const raw = await video.path();
  const webm = path.join(beatDir, 'video.webm');
  fs.copyFileSync(raw, webm);
  const mp4 = path.join(beatDir, 'video.mp4');
  // VFR webm -> CFR 30 fps H.264 (yuv420p, faststart).
  const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', (trimMs / 1000).toFixed(3), '-i', webm, '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '30', '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
  if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr}`);
  const info = ffprobe(mp4);
  result = { webm, mp4, probe: info, bytes: fs.statSync(mp4).size };
  recStart = recStart; // keep for the final log offsets
  phase = 'stopped';
  log('recording-encoded', { mp4, width: info?.width, height: info?.height, rate: info?.r_frame_rate, frames: info?.nb_frames, duration: info?.duration });
  await blank.close().catch(() => {});
  return result;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  phase = 'shutting-down';
  console.log('[host] shutting down');
  try { if (recPage && !recPage.isClosed()) { recPage.video()?.path().catch(() => {}); } } catch {}
  try { await context?.close(); } catch {}
  if (dashboard && dashboard.exitCode === null) {
    const g = (sig) => { try { process.kill(-dashboard.pid, sig); } catch { try { dashboard.kill(sig); } catch {} } };
    g('SIGTERM'); await sleep(800); if (dashboard.exitCode === null) g('SIGKILL');
  }
  if (!flags['keep-udd']) fs.rmSync(ws.chromeUdd, { recursive: true, force: true });
  for (const k of ['host', 'dashboard', 'chrome']) fs.rmSync(path.join(ws.run, `${k}.pid`), { force: true });
  fs.rmSync(path.join(ws.run, 'host.json'), { force: true });
  control?.close();
  process.exit(code);
}

// ---------- control channel ----------
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const control = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, { beat: beatId, phase, humanState, baseUrl, cdpPort, events: events.length, result });
    if (req.method === 'GET' && url.pathname === '/events') return send(res, 200, events);
    if (req.method === 'GET' && url.pathname === '/wait') {
      const ev = await waitEvent(url.searchParams.get('event'), Number(url.searchParams.get('timeout') ?? 60000));
      return send(res, ev ? 200 : 408, ev ?? { error: 'timeout' });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (url.pathname === '/start-recording') { await startRecording(); return send(res, 200, { phase }); }
    if (url.pathname === '/run-human') { await runHuman(); return send(res, 202, { humanState }); }
    if (url.pathname === '/stop-recording') { const r = await stopRecording(); return send(res, 200, r); }
    if (url.pathname === '/event') {
      let body = ''; for await (const c of req) body += c;
      const j = body ? JSON.parse(body) : {};
      return send(res, 200, log(String(j.name ?? 'external'), { source: 'external', ...(j.data ?? {}) }, { keyframe: !!j.keyframe }));
    }
    if (url.pathname === '/shutdown') { send(res, 200, { ok: true }); setTimeout(() => void shutdown(0), 50); return; }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e?.message ?? e) });
  }
});

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

// ---------- main ----------
try {
  console.log(`[host] beat=${beatId} workspace=${ws.work}`);
  await startDashboard();
  log('dashboard-up', { baseUrl, pid: started.dashboardPid });
  await launchChrome();
  scratchPage = context.pages()[0] ?? (await context.newPage());
  await login(scratchPage, creds);
  log('logged-in', { user: creds.username });
  if (typeof beat.preState === 'function' && !flags['no-prestate']) {
    log('prestate-start');
    await beat.preState(scratchPage, beatCtx(scratchPage, false));
    log('prestate-done');
  }
  phase = 'ready';
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));
  fs.writeFileSync(path.join(ws.run, 'host.json'), JSON.stringify({ controlPort, cdpPort, port, beat: beatId, pid: process.pid }));
  log('ready', { controlPort, cdpPort, baseUrl });
  console.log(`READY control=http://127.0.0.1:${controlPort} cdp=${cdpPort} dashboard=${baseUrl}`);
} catch (e) {
  console.error('[host] startup failed:', e);
  try { await scratchPage?.screenshot({ path: path.join(beatDir, 'startup-error.png') }); } catch {}
  await shutdown(1);
}
