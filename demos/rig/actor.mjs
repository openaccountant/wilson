#!/usr/bin/env node
// actor: runs the REAL agent for a beat with the Claude Code CLI in headless mode. The model chooses its own actions.
// It may run exactly one thing: the argv-validating wrapper demos/rig/bin/ab-agent, which accepts only
//   webmcp list [--json] | webmcp invoke <tool> --params <json> [--detach] | webmcp result <id> | snapshot | get url
// injects the fixed --cdp/--session and an isolated daemon environment (socket dir + HOME under the take dir; nothing in
// ~/.agent-browser), runs the vendored agent-browser with an argv array, and appends every attempt to <take-dir>/ab-audit.jsonl.
//
//   node demos/rig/actor.mjs --beat b5-propose --take-dir <dir> [--cdp-port 9333] [--session <unique>] [--model sonnet]
//                            [--timeout-s 600] [--claude claude]
//
// The HARNESS writes <take-dir>/ab-audit.jsonl (source of truth for commands and outputs), actor.jsonl (raw stream-json,
// the model's own text + SUMMARY, harness receipt time `_rx`) and actor.log (readable view built from the audit).
// Exit codes: 0 finished, 2 setup problem, 3 timeout, 4 claude failed or reported an error,
//             5 policy violation (a refused command, or stream tool_use not 1:1 with ab-audit.jsonl),
//             6 the agent-browser daemon could not be verified as ours.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, safeSegment, assertScratch, RIG_DIR } from './lib/common.mjs';
import { resolveAgentBrowser, allowedBashPatterns, wrapperEnv, takeIsolation, WRAPPER, SYSTEM_CHROME } from './lib/agent-browser.mjs';
import { parseJsonl, summaryFromStream, countToolUses } from './lib/actor-log.mjs';
import { parseAudit, checkStreamAgainstAudit, auditProblems, actorLogFromAudit } from './lib/ab-audit.mjs';
import { preflightSocketDir, checkSocketPathLength, stopDaemon, sessionsIn } from './lib/ab-daemon.mjs';

const die = (code, msg) => { console.error(`[actor] ${msg}`); process.exit(code); };
const { flags } = parseArgs(process.argv.slice(2));
const beat = flags.beat ? safeSegment(flags.beat, '--beat') : die(2, '--beat required');
const takeDir = flags['take-dir'] ? assertScratch(String(flags['take-dir'])) : die(2, '--take-dir required');
const cdpPort = Number(flags['cdp-port'] ?? 9333);
const session = safeSegment(flags.session ?? `abt-${crypto.randomBytes(4).toString('hex')}`, '--session'); // unique per take
const model = String(flags.model ?? 'sonnet');
const timeoutS = Number(flags['timeout-s'] ?? 600);
const claudeBin = String(flags.claude ?? 'claude');
if (!Number.isInteger(cdpPort) || cdpPort < 1024) die(2, 'bad --cdp-port');

let ab;
try { ab = resolveAgentBrowser(); } catch (e) { die(2, e.message); }
if (!fs.existsSync(SYSTEM_CHROME)) die(2, `system Chrome not found at ${SYSTEM_CHROME}`);
if (!fs.existsSync(WRAPPER)) die(2, `wrapper missing: ${WRAPPER}`);
try { fs.accessSync(WRAPPER, fs.constants.X_OK); } catch { die(2, `wrapper is not executable: chmod +x ${WRAPPER}`); }
const briefFile = path.join(RIG_DIR, 'beats', `${beat}.brief.md`);
if (!fs.existsSync(briefFile)) die(2, `no brief at ${briefFile}`);
const brief = fs.readFileSync(briefFile, 'utf8').replaceAll('{{AB}}', WRAPPER);

// Isolated, owned daemon state under the take dir. Refuse to start if the socket dir already holds a live daemon.
const iso = takeIsolation(takeDir);
try { checkSocketPathLength(iso.socketDir, session); preflightSocketDir(iso.socketDir); } catch (e) { die(2, e.message); }
fs.mkdirSync(iso.socketDir, { recursive: true });
fs.mkdirSync(iso.home, { recursive: true });
fs.writeFileSync(iso.config, '{}\n');

const cwd = path.join(takeDir, 'actor-cwd'); // disposable, empty
fs.mkdirSync(cwd, { recursive: true });
const logFile = path.join(takeDir, 'actor.log');
const jsonlFile = path.join(takeDir, 'actor.jsonl');
fs.writeFileSync(logFile, '');
fs.writeFileSync(jsonlFile, '');
fs.writeFileSync(iso.audit, '');
fs.writeFileSync(path.join(takeDir, 'actor-meta.json'), JSON.stringify({ bin: ab.bin, wrapper: WRAPPER, cdpPort, session, beat, model, socketDir: iso.socketDir }, null, 2));

// Only Bash exists as a tool, and only the wrapper (one pattern: its absolute path). The wrapper validates argv exactly,
// so close/eval/click/fill/screenshot/state/open and any --cdp/--session retargeting never reach agent-browser.
// No --dangerously-skip-permissions: anything else is denied in headless mode.
const args = [
  '-p', '--model', model, '--output-format', 'stream-json', '--verbose',
  '--tools', 'Bash',
  '--allowedTools', ...allowedBashPatterns(WRAPPER),
  '--permission-mode', 'default',
  '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
  '--setting-sources', 'project',
];
console.log(`[actor] ${claudeBin} ${args.join(' ')}  (cwd ${cwd}, session ${session}, socket dir ${iso.socketDir}, brief on stdin)`);
const child = spawn(claudeBin, args, { cwd, env: { ...process.env, ...wrapperEnv({ bin: ab.bin, cdpPort, session, takeDir }) }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdin.end(brief);

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutS * 1000);

let buf = '';
let resultEv = null;
const handleLine = (line) => {
  if (!line.trim()) return;
  const now = new Date();
  let ev; try { ev = JSON.parse(line); } catch { fs.appendFileSync(jsonlFile, JSON.stringify({ type: 'unparsed', _rx: now.toISOString(), raw: line.slice(0, 2000) }) + '\n'); return; }
  fs.appendFileSync(jsonlFile, JSON.stringify({ ...ev, _rx: now.toISOString() }) + '\n');
  if (ev.type === 'result') resultEv = ev;
};
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.on('error', (e) => die(2, `could not start ${claudeBin}: ${e.message}`));
child.on('close', async (code, sig) => {
  clearTimeout(timer);
  if (buf.trim()) handleLine(buf);
  const stream = parseJsonl(fs.readFileSync(jsonlFile, 'utf8'));
  const audit = parseAudit(fs.readFileSync(iso.audit, 'utf8'));
  // actor.log: the harness's view, built from the audit (commands + outputs) and the stream's final text.
  const { summary } = summaryFromStream(stream);
  fs.writeFileSync(logFile, actorLogFromAudit(audit, timedOut ? `(actor timed out after ${timeoutS}s)` : summary));

  // The daemon this take started: verified ours, then stopped by its verified pid (never `close` on the attached browser).
  const daemonProblems = [];
  for (const rec of audit) if (rec.daemon && rec.daemon.verified === false) daemonProblems.push(rec.daemon.problem ?? 'unverified');
  const stopped = [];
  for (const sname of sessionsIn(iso.socketDir)) stopped.push(`${sname}: ${await stopDaemon({ bin: ab.bin, socketDir: iso.socketDir, session: sname })}`);
  if (stopped.length) console.log(`[actor] daemon: ${stopped.join('; ')}`);

  const violations = [...checkStreamAgainstAudit(stream, audit, WRAPPER), ...auditProblems(audit)];
  if (violations.length) {
    fs.appendFileSync(logFile, `[POLICY] ${violations.length} problem(s) with the actor's commands\n`);
    die(5, `policy violation: ${violations.map((v) => `${JSON.stringify(String(v.command).slice(0, 200))} (${v.reason})`).join('; ')}`);
  }
  if (daemonProblems.length) die(6, `agent-browser daemon not verified as ours: ${[...new Set(daemonProblems)].join('; ')}`);
  if (timedOut) die(3, `timed out after ${timeoutS}s`);
  if (code !== 0 || !resultEv || resultEv.is_error) {
    if (stderr.trim()) console.error(stderr.trim().slice(0, 2000));
    die(4, `claude exited ${code ?? sig}${resultEv?.is_error ? `, reported error: ${String(resultEv.result).slice(0, 300)}` : ''}${resultEv ? '' : ', no result event'}`);
  }
  console.log(`[actor] done: ${countToolUses(stream)} commands, ${audit.length} audited. log ${logFile}`);
  process.exit(0);
});
