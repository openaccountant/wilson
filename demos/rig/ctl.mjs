#!/usr/bin/env node
// ctl: talk to a running host. 
//   node demos/rig/ctl.mjs status|events
//   node demos/rig/ctl.mjs start-recording | run-human | stop-recording | shutdown
//   node demos/rig/ctl.mjs wait <event> [timeoutMs]
//   node demos/rig/ctl.mjs event <name> [jsonData] [--keyframe]
import { parseArgs, workspace, readState, fail } from './lib/common.mjs';
const { flags, positional } = parseArgs(process.argv.slice(2));
const ws = workspace(flags.name ?? 'p1');
const st = readState(ws) ?? fail(`no running host for workspace ${ws.name}`);
const base = `http://127.0.0.1:${flags['control-port'] ?? st.controlPort}`;
const [cmd, a, b] = positional;
let r;
switch (cmd) {
  case 'status': r = await fetch(base + '/status'); break;
  case 'events': r = await fetch(base + '/events'); break;
  case 'wait': r = await fetch(`${base}/wait?event=${encodeURIComponent(a)}&timeout=${b ?? 60000}`); break;
  case 'event': r = await fetch(base + '/event', { method: 'POST', body: JSON.stringify({ name: a, data: b ? JSON.parse(b) : {}, keyframe: !!flags.keyframe }) }); break;
  case 'start-recording': case 'run-human': case 'stop-recording': case 'shutdown': r = await fetch(`${base}/${cmd}`, { method: 'POST' }); break;
  default: fail('unknown command ' + cmd);
}
const text = await r.text();
console.log(text);
process.exit(r.ok ? 0 : 1);
