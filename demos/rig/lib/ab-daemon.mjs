// Ownership of the agent-browser daemon the actor causes to start. The daemon is a background process that agent-browser
// spawns on first use; with AGENT_BROWSER_SOCKET_DIR pointing into the take dir it keeps <session>.pid/.sock/... there
// and nowhere else. We only ever signal a pid that is VERIFIED to be (a) the vendored native binary and (b) listening on
// <socketDir>/<session>.sock. We never run `agent-browser close` (that would close the attached recording browser).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function readPidFile(socketDir, session) {
  try { const n = Number(fs.readFileSync(path.join(socketDir, `${session}.pid`), 'utf8').trim()); return Number.isInteger(n) && n > 1 ? n : null; } catch { return null; }
}

/** Max unix socket path on macOS is 104 bytes (108 on Linux). Fail early with a clear message instead of a daemon error. */
export function checkSocketPathLength(socketDir, session) {
  const p = path.join(socketDir, `${session}.sock`);
  if (Buffer.byteLength(p) > 100) throw new Error(`socket path is ${Buffer.byteLength(p)} bytes (limit ~104): ${p}. Use a shorter take dir or session name.`);
}

/**
 * Is `pid` the vendored agent-browser daemon for this socket dir + session?
 * `ab-bin` is the vendored bin path (…/agent-browser/bin/agent-browser.js); the daemon is a sibling native binary.
 * Opts `psCommand`/`lsof` exist for tests.
 */
export function verifyDaemon({ pid, bin, socketDir, session }, opts = {}) {
  const psCommand = opts.psCommand ?? ((p) => sh('ps', ['-o', 'command=', '-p', String(p)]).trim());
  const lsof = opts.lsof ?? ((p) => sh('lsof', ['-nP', '-p', String(p)]));
  if (!pid || !pidAlive(pid)) return { ok: false, problem: `pid ${pid} is not alive` };
  const cmd = psCommand(pid);
  const dir = path.dirname(bin) + path.sep;
  if (!cmd.startsWith(dir + 'agent-browser')) return { ok: false, problem: `pid ${pid} command is not the vendored binary under ${dir}: ${cmd.slice(0, 160)}` };
  const sock = path.join(socketDir, `${session}.sock`);
  if (!lsof(pid).split('\n').some((l) => l.trimEnd().endsWith(sock))) return { ok: false, problem: `pid ${pid} does not hold socket ${sock}` };
  return { ok: true, pid };
}

/** Refuse if any daemon recorded in this socket dir is still alive (a leftover from another run must never be adopted). */
export function preflightSocketDir(socketDir) {
  if (!fs.existsSync(socketDir)) return;
  for (const f of fs.readdirSync(socketDir)) {
    if (!f.endsWith('.pid')) continue;
    const pid = Number(fs.readFileSync(path.join(socketDir, f), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1 && pidAlive(pid)) throw new Error(`socket dir ${socketDir} already has a live daemon (${f}: pid ${pid}); refusing to reuse it`);
  }
}

/** Stop the verified daemon (SIGTERM, then SIGKILL if it is still the verified daemon). Returns a status string. */
export async function stopDaemon({ bin, socketDir, session }) {
  const pid = readPidFile(socketDir, session);
  if (!pid) return 'no daemon pid file; nothing to stop';
  if (!pidAlive(pid)) return `daemon pid ${pid} already gone`;
  const v = verifyDaemon({ pid, bin, socketDir, session });
  if (!v.ok) return `NOT stopping pid ${pid}: ${v.problem}`;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250);
  if (pidAlive(pid) && verifyDaemon({ pid, bin, socketDir, session }).ok) { process.kill(pid, 'SIGKILL'); await sleep(300); return `daemon pid ${pid} killed (SIGKILL)`; }
  return `daemon pid ${pid} stopped`;
}

/** Sessions that have a pid file in the socket dir. */
export function sessionsIn(socketDir) {
  try { return fs.readdirSync(socketDir).filter((f) => f.endsWith('.pid')).map((f) => f.slice(0, -4)); } catch { return []; }
}
