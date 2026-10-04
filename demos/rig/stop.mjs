#!/usr/bin/env node
// stop: stop recording (if any), encode, shut the host down, and kill ONLY the processes the rig started
// (verified against the pid files: the pid must still be alive AND its command line must still match what we recorded).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, workspace, readState, readPid, pidfileLive, pidAlive, sleep, killVerified, listeners } from './lib/common.mjs';
import { execFileSync } from 'node:child_process';
// If the dashboard group leader died but children kept running, they still share the pgid we recorded (a pgid cannot be
// reused while members exist), so signalling that group hits only what we spawned.
async function reapOrphanGroup(rec) {
  if (!rec) return;
  let members = [];
  try { members = execFileSync('pgrep', ['-g', String(rec.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch {}
  if (!members.length) return;
  console.log(`[stop] orphaned members of our dashboard process group ${rec.pid}: ${members.join(',')}`);
  try { process.kill(-rec.pid, 'SIGTERM'); } catch {}
  await sleep(800);
  try { process.kill(-rec.pid, 'SIGKILL'); } catch {}
}
const { flags } = parseArgs(process.argv.slice(2));
const ws = workspace(flags.name ?? 'p1');
const st = readState(ws);
if (st) {
  const base = `http://127.0.0.1:${st.controlPort}`;
  try {
    const s = await (await fetch(base + '/status')).json();
    if (s.phase === 'recording') {
      console.log('[stop] stopping recording and encoding...');
      const r = await fetch(base + '/stop-recording', { method: 'POST' });
      console.log('[stop]', await r.text());
    }
    await fetch(base + '/shutdown', { method: 'POST' });
  } catch (e) { console.log('[stop] control channel not answering:', e.message); }
  for (let i = 0; i < 40 && pidAlive(st.pid); i++) await sleep(250);
}
for (const kind of ['chrome', 'dashboard', 'host']) {
  const rec = pidfileLive(ws, kind);
  if (rec) {
    const group = await killVerified(rec.pid);
    console.log(`[stop] killed leftover ${kind} pid ${rec.pid}${group ? ' (process group)' : ''}`);
  } else if (readPid(ws, kind)) {
    console.log(`[stop] ${kind} pid file is stale or its pid was reused by another process; NOT killing anything`);
  }
  if (kind === 'dashboard') await reapOrphanGroup(readPid(ws, kind));
  if (readPid(ws, kind)) fs.rmSync(path.join(ws.run, `${kind}.pid`), { force: true });
}
fs.rmSync(path.join(ws.run, 'host.json'), { force: true });
const left = [st?.port].filter(Boolean).flatMap((p) => listeners(p));
if (left.length) console.log(`[stop] WARNING: port ${st.port} still has listener pid ${left.join(',')} (not ours to kill unless pid-file verified)`);
console.log('[stop] done');
