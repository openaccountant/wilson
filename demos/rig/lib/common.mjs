// Shared helpers for the recording rig: workspace layout, arg parsing, pid files, tiny process utilities.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(RIG_DIR, '..', '..');
export const MEDIA_ROOT = '/private/tmp/claude-501/wilson-demos';
export const DEFAULT_MODEL = 'ollama:gemma4:12b';

/** `--flag`, `--key value`, `--key=value`. Everything after a bare `--` is returned untouched in `rest`. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional, rest };
}

/** One workspace per demo run: <MEDIA_ROOT>/<name>/{home,out,run,chrome-udd,<beat>/}. */
export function workspace(name = 'p1') {
  const work = path.join(MEDIA_ROOT, name);
  return {
    name,
    work,
    home: path.join(work, 'home'),
    out: path.join(work, 'out'),
    run: path.join(work, 'run'),
    chromeUdd: path.join(work, 'chrome-udd'),
    beatDir: (beat) => path.join(work, beat),
  };
}

export function assertScratch(p) {
  const real = path.resolve(p);
  if (!real.startsWith('/private/tmp/claude-501/')) throw new Error(`refusing to touch ${real}: not under /private/tmp/claude-501/`);
  return real;
}

export function readCreds(outDir) {
  const text = fs.readFileSync(path.join(outDir, 'CREDENTIALS.txt'), 'utf8');
  const username = /^username:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const password = /^password:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (!username || !password) throw new Error('CREDENTIALS.txt has no username/password');
  return { username, password };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Command line of a pid, to confirm a pid file still points at the process we started (pids get reused). */
export function pidCommand(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

export function writePid(ws, kind, pid, expect) {
  fs.mkdirSync(ws.run, { recursive: true });
  fs.writeFileSync(path.join(ws.run, `${kind}.pid`), JSON.stringify({ pid, expect, startedAt: new Date().toISOString() }));
}

export function readPid(ws, kind) {
  try { return JSON.parse(fs.readFileSync(path.join(ws.run, `${kind}.pid`), 'utf8')); } catch { return null; }
}

/** A pid file counts only if the process lives AND its command line still contains the marker we recorded. */
export function pidfileLive(ws, kind) {
  const rec = readPid(ws, kind);
  if (!rec || !pidAlive(rec.pid)) return null;
  return pidCommand(rec.pid).includes(rec.expect) ? rec : null;
}

export async function waitForHttp(url, { timeoutMs = 60000, ok = (r) => r.status < 500 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (ok(r)) return r; last = `status ${r.status}`; } catch (e) { last = e.message; }
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

export function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

export function readState(ws) {
  try { return JSON.parse(fs.readFileSync(path.join(ws.run, 'host.json'), 'utf8')); } catch { return null; }
}
