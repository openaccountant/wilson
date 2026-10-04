#!/usr/bin/env node
// CLI for run-beat.sh:  node ab-daemon.mjs stop --take-dir <dir>      stop the verified per-take daemon(s), nothing else
//                       node ab-daemon.mjs preflight --take-dir <dir>  refuse if the take's socket dir has a live daemon
import { parseArgs, assertScratch } from './lib/common.mjs';
import { resolveAgentBrowser, takeIsolation } from './lib/agent-browser.mjs';
import { stopDaemon, sessionsIn, preflightSocketDir } from './lib/ab-daemon.mjs';
const { flags, positional } = parseArgs(process.argv.slice(2));
const takeDir = assertScratch(String(flags['take-dir'] ?? ''));
const iso = takeIsolation(takeDir);
if (positional[0] === 'preflight') { try { preflightSocketDir(iso.socketDir); console.log('[ab-daemon] socket dir clean'); } catch (e) { console.error(e.message); process.exit(1); } }
else if (positional[0] === 'stop') {
  const { bin } = resolveAgentBrowser();
  const ss = sessionsIn(iso.socketDir);
  if (!ss.length) console.log('[ab-daemon] no daemon recorded for this take');
  for (const session of ss) console.log(`[ab-daemon] ${session}: ${await stopDaemon({ bin, socketDir: iso.socketDir, session })}`);
} else { console.error('usage: ab-daemon.mjs stop|preflight --take-dir <dir>'); process.exit(2); }
