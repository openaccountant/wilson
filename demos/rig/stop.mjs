#!/usr/bin/env node
// stop: stop recording (if any), encode, shut the host down, and kill ONLY the processes the rig started
// (verified against the pid files: the pid must still be alive AND its command line must still match what we recorded).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, workspace, readState, readPid, pidfileLive, pidAlive, sleep } from './lib/common.mjs';
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
    console.log(`[stop] killing leftover ${kind} pid ${rec.pid}`);
    try { process.kill(rec.pid, 'SIGTERM'); } catch {}
    await sleep(800);
    if (pidAlive(rec.pid)) try { process.kill(rec.pid, 'SIGKILL'); } catch {}
  }
  if (readPid(ws, kind)) fs.rmSync(path.join(ws.run, `${kind}.pid`), { force: true });
}
fs.rmSync(path.join(ws.run, 'host.json'), { force: true });
console.log('[stop] done');
