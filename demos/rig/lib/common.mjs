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
export function safeSegment(v, what) {
  const s = String(v);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) || s.includes('..') || s.includes('/')) throw new Error(`invalid ${what} ${JSON.stringify(s)}: use letters, digits, . _ - only (no '/', no '..')`);
  return s;
}

export function workspace(name = 'p1') {
  safeSegment(name, '--name');
  const work = path.join(MEDIA_ROOT, name);
  return {
    name,
    work,
    home: path.join(work, 'home'),
    out: path.join(work, 'out'),
    run: path.join(work, 'run'),
    chromeUdd: path.join(work, 'chrome-udd'),
    beatDir: (beat) => path.join(work, safeSegment(beat, '--beat')),
  };
}

const SCRATCH_ROOT = '/private/tmp/claude-501/';

/** Resolve symlinks on the nearest existing ancestor, so a link inside the scratch tree cannot lead outside it. */
export function assertScratch(p) {
  const abs = path.resolve(p);
  let probe = abs;
  const tail = [];
  while (!fs.existsSync(probe)) { tail.unshift(path.basename(probe)); const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const real = path.join(fs.realpathSync(probe), ...tail);
  if (!real.startsWith(SCRATCH_ROOT) || real === SCRATCH_ROOT.slice(0, -1)) throw new Error(`refusing to touch ${abs} (resolves to ${real}): not under ${SCRATCH_ROOT}`);
  return real;
}

/** pids LISTENing on a TCP port (lsof). */
export function listeners(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; } // lsof exits 1 when nothing matches
}

export function assertPortsFree(ports) {
  for (const [label, p] of Object.entries(ports)) {
    const l = listeners(p);
    if (l.length) throw new Error(`${label} port ${p} is already in use by pid ${l.join(',')} (${pidCommand(l[0]).slice(0, 120)}); refusing to start`);
  }
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

/** Seconds since a pid started (ps etimes is not on macOS; parse etime [[dd-]hh:]mm:ss). */
export function pidAgeSec(pid) {
  try {
    const t = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const [d, rest] = t.includes('-') ? t.split('-') : [0, t];
    const parts = rest.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  } catch { return null; }
}

export function pidPgid(pid) {
  try { return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return null; }
}

/**
 * A pid file counts only if the process lives, its command line still contains the specific marker we recorded, AND it
 * started when we recorded it (a reused pid belongs to a process that started later).
 */
export function pidfileLive(ws, kind) {
  const rec = readPid(ws, kind);
  if (!rec || !pidAlive(rec.pid)) return null;
  if (!pidCommand(rec.pid).includes(rec.expect)) return null;
  const age = pidAgeSec(rec.pid);
  const recordedAge = (Date.now() - Date.parse(rec.startedAt)) / 1000;
  // process age should be >= time since the pid file was written (minus a little slack for spawn-then-write)
  if (age === null || age + 8 < recordedAge) return null;
  return rec;
}

/** SIGTERM then SIGKILL; the whole process group when the pid leads one (so orphaned children cannot keep ports busy). */
export async function killVerified(pid) {
  const group = pidPgid(pid) === pid;
  const sig = (s) => { try { process.kill(group ? -pid : pid, s); } catch {} };
  sig('SIGTERM');
  for (let i = 0; i < 12 && pidAlive(pid); i++) await sleep(250);
  if (pidAlive(pid) || group) sig('SIGKILL');
  return group;
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

/** Age in seconds of a recorded pid record (time since the pid file was written). */
function recordAgeSec(rec) { return (Date.now() - Date.parse(rec.startedAt)) / 1000; }

/**
 * Decide whether an orphaned process group (leader gone, children still alive) is provably ours.
 * Pure function over injected process facts so it can be unit tested with a fake stale record.
 *
 *   rec:      the pid record {pid, expect, startedAt}
 *   members:  [{pid, pgid, command, ageSec}] for every process whose pgid equals rec.pid
 *   markers:  strings; EVERY member's command line must contain at least one marker
 *
 * Passes only when: the record is well formed and carries a marker; every member really is in group rec.pid; every
 * member started AFTER the record was written (a reused pgid belongs to something older or unrelated) and every
 * member's command line matches a marker. Otherwise returns {ok:false, reason}: the caller logs and kills nothing.
 */
export function judgeOrphanGroup(rec, members, markers, now = Date.now()) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1 || typeof rec.expect !== 'string' || !rec.expect || !Number.isFinite(Date.parse(rec.startedAt))) return { ok: false, reason: 'pid record is missing or malformed' };
  if (!markers?.length) return { ok: false, reason: 'no command-line markers to verify against' };
  if (!members.length) return { ok: false, reason: 'no group members' };
  const recAge = (now - Date.parse(rec.startedAt)) / 1000;
  for (const m of members) {
    if (m.pgid !== rec.pid) return { ok: false, reason: `member ${m.pid} is in group ${m.pgid}, not ${rec.pid}` };
    if (m.ageSec === null || m.ageSec === undefined || m.ageSec > recAge + 8) return { ok: false, reason: `member ${m.pid} (age ${m.ageSec}s) is older than the pid record (${Math.round(recAge)}s): not started by us` };
    if (!markers.some((k) => m.command.includes(k))) return { ok: false, reason: `member ${m.pid} command does not match our markers: ${m.command.slice(0, 160)}` };
  }
  return { ok: true, reason: 'record and every member verified' };
}

/** Members of process group `pgid` with command and age (live ps lookups). */
export function groupMembers(pgid) {
  let pids = [];
  try { pids = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch {}
  return pids.map((pid) => ({ pid, pgid: pidPgid(pid), command: pidCommand(pid), ageSec: pidAgeSec(pid) }));
}

/**
 * Reap orphaned children of a dead dashboard group leader. Signals the group ONLY if judgeOrphanGroup passes; otherwise
 * logs the members and kills nothing. `deps` is injectable for tests.
 */
export async function reapOrphanGroup(rec, markers, deps = {}) {
  const { members = groupMembers, kill = (sig, pgid) => process.kill(-pgid, sig), log = console.log, wait = sleep } = deps;
  if (!rec) return { killed: false, reason: 'no record' };
  const list = members(rec.pid);
  if (!list.length) return { killed: false, reason: 'no members' };
  const verdict = judgeOrphanGroup(rec, list, markers);
  if (!verdict.ok) {
    log(`[stop] group ${rec.pid} has live members but is NOT provably ours (${verdict.reason}); killing nothing. Members:`);
    for (const m of list) log(`[stop]   pid ${m.pid} pgid ${m.pgid} age ${m.ageSec}s: ${m.command.slice(0, 200)}`);
    return { killed: false, reason: verdict.reason };
  }
  log(`[stop] orphaned members of our dashboard process group ${rec.pid}: ${list.map((m) => m.pid).join(',')}`);
  try { kill('SIGTERM', rec.pid); } catch {}
  await wait(800);
  try { kill('SIGKILL', rec.pid); } catch {}
  return { killed: true, reason: verdict.reason };
}
