#!/usr/bin/env node
// actor: runs the REAL agent for a beat with the Claude Code CLI in headless mode. The model chooses its own actions.
// It may run exactly one thing: the vendored agent-browser, attached with --cdp <port> --session <name>.
//
//   node demos/rig/actor.mjs --beat b5-propose --take-dir <dir> [--cdp-port 9333] [--session s] [--model sonnet]
//                            [--timeout-s 600] [--claude claude]
//
// The HARNESS writes <take-dir>/actor.log (from the stream) and <take-dir>/actor.jsonl (raw stream-json).
// Exit codes: 0 finished, 2 setup problem, 3 timeout, 4 claude failed or reported an error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, safeSegment, assertScratch, RIG_DIR } from './lib/common.mjs';
import { resolveAgentBrowser, agentBrowserEnv, allowedBashPattern, SYSTEM_CHROME } from './lib/agent-browser.mjs';
import { createFormatter } from './lib/actor-log.mjs';

const die = (code, msg) => { console.error(`[actor] ${msg}`); process.exit(code); };
const { flags } = parseArgs(process.argv.slice(2));
const beat = flags.beat ? safeSegment(flags.beat, '--beat') : die(2, '--beat required');
const takeDir = flags['take-dir'] ? assertScratch(String(flags['take-dir'])) : die(2, '--take-dir required');
const cdpPort = Number(flags['cdp-port'] ?? 9333);
const session = safeSegment(flags.session ?? 's', '--session');
const model = String(flags.model ?? 'sonnet');
const timeoutS = Number(flags['timeout-s'] ?? 600);
const claudeBin = String(flags.claude ?? 'claude');
if (!Number.isInteger(cdpPort) || cdpPort < 1024) die(2, 'bad --cdp-port');

let ab;
try { ab = resolveAgentBrowser(); } catch (e) { die(2, e.message); }
if (!fs.existsSync(SYSTEM_CHROME)) die(2, `system Chrome not found at ${SYSTEM_CHROME}`);
const briefFile = path.join(RIG_DIR, 'beats', `${beat}.brief.md`);
if (!fs.existsSync(briefFile)) die(2, `no brief at ${briefFile}`);
const brief = fs.readFileSync(briefFile, 'utf8').replaceAll('{{AB}}', ab.bin).replaceAll('{{CDP}}', String(cdpPort)).replaceAll('{{SESSION}}', session);

const cwd = path.join(takeDir, 'actor-cwd'); // disposable, empty
fs.mkdirSync(cwd, { recursive: true });
const logFile = path.join(takeDir, 'actor.log');
const jsonlFile = path.join(takeDir, 'actor.jsonl');
fs.writeFileSync(logFile, '');
fs.writeFileSync(jsonlFile, '');

// Only Bash exists as a tool, and only the vendored agent-browser (exact path prefix, our port and session) is allowed.
// No --dangerously-skip-permissions: anything else is denied in headless mode.
const args = [
  '-p', '--model', model, '--output-format', 'stream-json', '--verbose',
  '--tools', 'Bash',
  '--allowedTools', allowedBashPattern(ab.bin, cdpPort, session),
  '--permission-mode', 'default',
  '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
  '--setting-sources', 'project',
];
console.log(`[actor] ${claudeBin} ${args.join(' ')}  (cwd ${cwd}, brief on stdin)`);
const fmt = createFormatter({ bin: ab.bin, cdpPort, session });
const child = spawn(claudeBin, args, { cwd, env: agentBrowserEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(brief);

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutS * 1000);

let buf = '';
let resultEv = null;
const handleLine = (line) => {
  if (!line.trim()) return;
  fs.appendFileSync(jsonlFile, line + '\n');
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'result') resultEv = ev;
  const lines = fmt.feed(ev, new Date());
  if (lines.length) fs.appendFileSync(logFile, lines.join('\n') + '\n');
};
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.on('error', (e) => die(2, `could not start ${claudeBin}: ${e.message}`));
child.on('close', (code, sig) => {
  clearTimeout(timer);
  if (buf.trim()) handleLine(buf);
  if (timedOut) { fs.appendFileSync(logFile, `[SUMMARY] (actor timed out after ${timeoutS}s)\n`); die(3, `timed out after ${timeoutS}s`); }
  if (code !== 0 || !resultEv || resultEv.is_error) {
    if (stderr.trim()) console.error(stderr.trim().slice(0, 2000));
    die(4, `claude exited ${code ?? sig}${resultEv?.is_error ? `, reported error: ${String(resultEv.result).slice(0, 300)}` : ''}${resultEv ? '' : ', no result event'}`);
  }
  console.log(`[actor] done: ${fmt.commands} commands. log ${logFile}`);
  process.exit(0);
});
