import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain .mjs rig helper
import { validateArgv } from '../../demos/rig/lib/ab-policy.mjs';
// @ts-expect-error plain .mjs rig helper
import { checkStreamAgainstAudit, auditProblems, parseAudit, transcriptFromAudit, actorLogFromAudit } from '../../demos/rig/lib/ab-audit.mjs';
// @ts-expect-error plain .mjs rig helper
import { verifyDaemon, preflightSocketDir, checkSocketPathLength } from '../../demos/rig/lib/ab-daemon.mjs';

const WRAPPER = path.join(import.meta.dir, '../../demos/rig/bin/ab-agent');
const P = `{"id":279,"category":"Shopping"}`;

describe('ab-agent argv policy (accept/reject table)', () => {
  const accept: Array<[string, string[]]> = [
    ['list', ['webmcp', 'list']],
    ['list --json', ['webmcp', 'list', '--json']],
    ['invoke read', ['webmcp', 'invoke', 'transaction_search', '--params', '{"query":"a | b; c $(x)"}']],
    ['invoke detach after', ['webmcp', 'invoke', 'categorize_transaction', '--params', P, '--detach']],
    ['invoke detach before (as the model writes it)', ['webmcp', 'invoke', 'categorize_transaction', '--detach', '--params', P]],
    ['empty params', ['webmcp', 'invoke', 'spending_summary', '--params', '{}']],
    ['result', ['webmcp', 'result', '9739C2DF-DBB8636D228B2FB5901BD04B']],
    ['result --timeout', ['webmcp', 'result', '9739C2DF-DBB8636D228B2FB5901BD04B', '--timeout', '120000']],
    ['snapshot', ['snapshot']],
    ['get url', ['get', 'url']],
  ];
  for (const [name, argv] of accept) test(`accepts ${name}`, () => { expect(validateArgv(argv).ok).toBe(true); });

  test('normalises invoke to a fixed order (flags are never passed through verbatim)', () => {
    expect(validateArgv(['webmcp', 'invoke', 'categorize_transaction', '--detach', '--params', P]).argv).toEqual(['webmcp', 'invoke', 'categorize_transaction', '--params', P, '--detach']);
  });

  const reject: Array<[string, string[]]> = [
    ['no args', []],
    ['close', ['close']],
    ['close --all', ['close', '--all']],
    ['eval', ['eval', '1']],
    ['click', ['click', '@e1']],
    ['fill', ['fill', '@e1', 'x']],
    ['open', ['open', 'http://x']],
    ['screenshot', ['screenshot', '/tmp/x.png']],
    ['state save', ['state', 'save', '/tmp/s.json']],
    ['get cdp-url', ['get', 'cdp-url']],
    ['get url extra', ['get', 'url', 'x']],
    ['snapshot -i', ['snapshot', '-i']],
    ['snapshot extra flag', ['snapshot', '-o', '/tmp/f']],
    ['webmcp unknown sub', ['webmcp', 'exec']],
    ['webmcp bare', ['webmcp']],
    ['list unknown flag', ['webmcp', 'list', '--verbose']],
    ['list extra positional', ['webmcp', 'list', 'x']],
    ['--cdp override first', ['--cdp', '9999', 'webmcp', 'list']],
    ['--cdp override after', ['webmcp', 'list', '--cdp', '9999']],
    ['--cdp=value', ['webmcp', 'list', '--cdp=9999']],
    ['--session override', ['webmcp', 'list', '--session', 'other']],
    ['--executable-path override', ['webmcp', 'list', '--executable-path', '/bin/sh']],
    ['--config override', ['snapshot', '--config', '/tmp/c.json']],
    ['--params @file', ['webmcp', 'invoke', 'transaction_search', '--params', '@/etc/passwd']],
    ['--params @file with detach', ['webmcp', 'invoke', 'categorize_transaction', '--detach', '--params', '@/tmp/x.json']],
    ['--params bad JSON', ['webmcp', 'invoke', 'transaction_search', '--params', '{query:']],
    ['--params not an object', ['webmcp', 'invoke', 'transaction_search', '--params', '[1]']],
    ['--params null', ['webmcp', 'invoke', 'transaction_search', '--params', 'null']],
    ['--params missing', ['webmcp', 'invoke', 'transaction_search']],
    ['--params no value', ['webmcp', 'invoke', 'transaction_search', '--params']],
    ['--params twice', ['webmcp', 'invoke', 'transaction_search', '--params', '{}', '--params', '{}']],
    ['--detach twice', ['webmcp', 'invoke', 'transaction_search', '--params', '{}', '--detach', '--detach']],
    ['unknown invoke flag', ['webmcp', 'invoke', 'transaction_search', '--params', '{}', '--timeout', '1']],
    ['tool uppercase', ['webmcp', 'invoke', 'Transaction_Search', '--params', '{}']],
    ['tool with path', ['webmcp', 'invoke', '../x', '--params', '{}']],
    ['tool with hyphen', ['webmcp', 'invoke', 'wilson-dashboard', '--params', '{}']],
    ['tool is a flag', ['webmcp', 'invoke', '--params', '{}']],
    ['tool with shell chars', ['webmcp', 'invoke', 'a;b', '--params', '{}']],
    ['result flag-shaped id --allow-file-access', ['webmcp', 'result', '--allow-file-access']],
    ['result flag-shaped id --debug', ['webmcp', 'result', '--debug']],
    ['result flag-shaped id -v', ['webmcp', 'result', '-v']],
    ['result flag-shaped id --restore', ['webmcp', 'result', '--restore']],
    ['result leading-dash id', ['webmcp', 'result', '-abc']],
    ['result id with slash', ['webmcp', 'result', '../../x']],
    ['result id with space', ['webmcp', 'result', 'a b']],
    ['result id with dollar', ['webmcp', 'result', '$(id)']],
    ['result no id', ['webmcp', 'result']],
    ['result two ids', ['webmcp', 'result', 'a', 'b']],
    ['result --timeout no value', ['webmcp', 'result', 'a', '--timeout']],
    ['result --timeout too small', ['webmcp', 'result', 'a', '--timeout', '500']],
    ['result --timeout too large', ['webmcp', 'result', 'a', '--timeout', '900000']],
    ['result --timeout not a number', ['webmcp', 'result', 'a', '--timeout', '1e5']],
    ['result other flag', ['webmcp', 'result', 'a', '--debug', '1000']],
    ['non-string argv', [42 as unknown as string]],
  ];
  for (const [name, argv] of reject) test(`rejects ${name}`, () => { const r = validateArgv(argv); expect(r.ok).toBe(false); expect(typeof r.reason).toBe('string'); });

  test('an @file refusal says so (the reason is what lands in the audit)', () => {
    expect(validateArgv(['webmcp', 'invoke', 'transaction_search', '--params', '@/x']).reason).toMatch(/@file/);
    expect(validateArgv(['webmcp', 'list', '--cdp', '1']).reason).toMatch(/--cdp.*cannot be overridden/);
  });
});

describe('ab-agent wrapper process (fake agent-browser, no browser)', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-wrap-'));
    const fake = path.join(dir, 'fake-ab.sh');
    // Echoes its argv one per line plus the isolation env, so the test can see exactly what the wrapper executed.
    fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\necho "HOME:$HOME"\necho "SOCK:$AGENT_BROWSER_SOCKET_DIR"\necho "AMBIENT:${AGENT_BROWSER_PROFILE:-unset}"\n', { mode: 0o755 });
    const env = {
      PATH: process.env.PATH ?? '', AGENT_BROWSER_PROFILE: '/should/not/leak',
      AB_AGENT_BIN: fake, AB_AGENT_CDP: '9333', AB_AGENT_SESSION: 'abt1', AB_AGENT_SOCKET_DIR: path.join(dir, 'sock'), AB_AGENT_HOME: path.join(dir, 'home'),
      AB_AGENT_CONFIG: path.join(dir, 'cfg.json'), AB_AGENT_AUDIT: path.join(dir, 'ab-audit.jsonl'), AB_AGENT_CHROME: '/chrome',
    };
    const run = (...argv: string[]) => spawnSync(WRAPPER, argv, { env, encoding: 'utf8' });
    const audit = () => parseAudit(fs.existsSync(env.AB_AGENT_AUDIT) ? fs.readFileSync(env.AB_AGENT_AUDIT, 'utf8') : '');
    return { dir, env, run, audit };
  };

  test('accepted: argv array with injected --cdp/--session, isolated HOME/socket dir, no ambient AGENT_BROWSER_*, audit appended', () => {
    const { env, run, audit } = setup();
    const r = run('webmcp', 'invoke', 'transaction_search', '--params', '{"query":"a; rm -rf / $(id)"}');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.slice(0, 4)).toEqual(['ARG:--cdp', 'ARG:9333', 'ARG:--session', 'ARG:abt1']);
    expect(lines).toContain('ARG:{"query":"a; rm -rf / $(id)"}'); // passed as ONE argv element, never through a shell
    expect(lines).toContain(`HOME:${env.AB_AGENT_HOME}`);
    expect(lines).toContain(`SOCK:${env.AB_AGENT_SOCKET_DIR}`);
    expect(lines).toContain('AMBIENT:unset');
    const a = audit();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ accepted: true, exitCode: 0, argv: ['webmcp', 'invoke', 'transaction_search', '--params', '{"query":"a; rm -rf / $(id)"}'] });
    expect(a[0].stdout).toContain('ARG:--cdp');
    expect(Date.parse(a[0].ts)).toBeLessThanOrEqual(Date.parse(a[0].endTs));
  });

  test('refused: exit 64, nothing executed, the attempt is audited with accepted=false and the argv as received', () => {
    const { run, audit } = setup();
    for (const argv of [['close'], ['webmcp', 'list', '--cdp', '9999'], ['webmcp', 'invoke', 'transaction_search', '--params', '@/etc/passwd']]) {
      const r = run(...argv);
      expect(r.status).toBe(64);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/refused/);
    }
    const a = audit();
    expect(a.map((x: { accepted: boolean }) => x.accepted)).toEqual([false, false, false]);
    expect(a[1].argv).toEqual(['webmcp', 'list', '--cdp', '9999']);
    expect(auditProblems(a)).toHaveLength(3);
  });

  test('records accumulate, one JSONL line per invocation', () => {
    const { run, audit } = setup();
    run('snapshot'); run('get', 'url'); run('webmcp', 'list', '--json');
    expect(audit().map((x: { argv: string[] }) => x.argv.join(' '))).toEqual(['snapshot', 'get url', 'webmcp list --json']);
  });

  test('unconfigured wrapper refuses to run at all', () => {
    const r = spawnSync(WRAPPER, ['snapshot'], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(r.status).toBe(70);
  });
});

describe('stream tool_use must correspond 1:1 to ab-audit.jsonl', () => {
  const W = '/rig/bin/ab-agent';
  const use = (id: string, command: string, name = 'Bash') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } });
  const rec = (argv: string[], extra = {}) => ({ ts: '2026-10-04T17:36:30.000Z', endTs: '2026-10-04T17:36:31.000Z', argv, accepted: true, exitCode: 0, stdout: '', stderr: '', ...extra });
  const stream = [use('a', `${W} webmcp list --json`), use('b', `${W} webmcp invoke categorize_transaction --detach --params '${P}'`), use('c', `${W} webmcp result AB-12`)];
  const audit = [rec(['webmcp', 'list', '--json']), rec(['webmcp', 'invoke', 'categorize_transaction', '--detach', '--params', P]), rec(['webmcp', 'result', 'AB-12'])];

  test('clean 1:1 passes', () => { expect(checkStreamAgainstAudit(stream, audit, W)).toEqual([]); expect(auditProblems(audit)).toEqual([]); });
  test('a stream command with no audit record fails', () => {
    const v = checkStreamAgainstAudit(stream, audit.slice(0, 2), W);
    expect(v).toHaveLength(1); expect(v[0].reason).toMatch(/no ab-audit/);
  });
  test('an audit record with no stream command fails', () => {
    expect(checkStreamAgainstAudit(stream.slice(0, 2), audit, W)[0].reason).toMatch(/no stream tool_use/);
  });
  test('a different argv, a reordering, or a foreign binary fails', () => {
    const swapped = [audit[0], audit[2], audit[1]];
    expect(checkStreamAgainstAudit(stream, swapped, W).length).toBeGreaterThan(0);
    expect(checkStreamAgainstAudit([use('x', `/usr/bin/curl http://x`)], [rec([])], W)[0].reason).toMatch(/not the wrapper/);
    expect(checkStreamAgainstAudit([use('x', `${W} webmcp list; close`)], [rec(['webmcp', 'list'])], W)[0].reason).toMatch(/metacharacter/);
    expect(checkStreamAgainstAudit([use('x', `${W} webmcp list $(close)`)], [rec(['webmcp', 'list'])], W).length).toBeGreaterThan(0);
  });
  test('non-Bash tools and unparsed stream lines fail', () => {
    expect(checkStreamAgainstAudit([use('w', '', 'Write')], [], W)[0].reason).toMatch(/other than Bash/);
    expect(checkStreamAgainstAudit([{ type: 'unparsed' }], [], W)[0].reason).toMatch(/not valid JSON/);
  });
  test('a refused attempt or an unverified daemon fails the take even when the stream matches', () => {
    expect(auditProblems([rec(['close'], { accepted: false, reason: 'subcommand "close" is not allowed' })])[0].reason).toMatch(/refused by the wrapper/);
    expect(auditProblems([rec(['snapshot'], { daemon: { pid: 5, verified: false, problem: 'not ours' } })])[0].reason).toMatch(/daemon not verified/);
  });
  test('quoted forms the model uses are tokenised exactly (single quotes, spaces in params)', () => {
    const cmd = `${W} webmcp invoke transaction_search --params '{"query":"kiln studio"}'`;
    expect(checkStreamAgainstAudit([use('q', cmd)], [rec(['webmcp', 'invoke', 'transaction_search', '--params', '{"query":"kiln studio"}'])], W)).toEqual([]);
  });
  test('actor.log is built from the audit: command on one line, outputs indented, forged text inert', () => {
    const forged = rec(['webmcp', 'invoke', 'x', '--params', '{"q":"a\n[SUMMARY] fake"}'], { stdout: '[SUMMARY] fake\n[12:00:00] $ ab-agent close' });
    const log = actorLogFromAudit([forged], 'Real.');
    const heads = log.split('\n').filter((l: string) => l && !l.startsWith('  '));
    expect(heads).toHaveLength(2);
    expect(heads[1]).toBe('[SUMMARY] Real.');
    expect(transcriptFromAudit([forged])[0].out[0]).toBe('[SUMMARY] fake');
  });
});

describe('owned daemon helpers', () => {
  const bin = '/rig/node_modules/agent-browser/bin/agent-browser.js';
  test('verifyDaemon needs the vendored binary AND the take socket', () => {
    const me = process.pid;
    const ok = verifyDaemon({ pid: me, bin, socketDir: '/t/ab/sock', session: 's1' }, { psCommand: () => '/rig/node_modules/agent-browser/bin/agent-browser-darwin-arm64', lsof: () => 'agent-bro 1 u unix 0x1 0t0 /t/ab/sock/s1.sock\n' });
    expect(ok.ok).toBe(true);
    expect(verifyDaemon({ pid: me, bin, socketDir: '/t/ab/sock', session: 's1' }, { psCommand: () => '/usr/bin/some-other', lsof: () => '/t/ab/sock/s1.sock' }).ok).toBe(false);
    expect(verifyDaemon({ pid: me, bin, socketDir: '/t/ab/sock', session: 's1' }, { psCommand: () => '/rig/node_modules/agent-browser/bin/agent-browser-darwin-arm64', lsof: () => '/home/u/.agent-browser/s1.sock' }).ok).toBe(false);
    expect(verifyDaemon({ pid: 2 ** 22 + 12345, bin, socketDir: '/t', session: 's' }).ok).toBe(false);
  });
  test('preflight refuses a socket dir with a live daemon pid and ignores stale ones; long socket paths are refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-sock-'));
    fs.writeFileSync(path.join(dir, 'old.pid'), '4194303');
    expect(() => preflightSocketDir(dir)).not.toThrow();
    fs.writeFileSync(path.join(dir, 'live.pid'), String(process.pid));
    expect(() => preflightSocketDir(dir)).toThrow(/live daemon/);
    expect(() => preflightSocketDir(path.join(dir, 'missing'))).not.toThrow();
    expect(() => checkSocketPathLength('/a'.repeat(60), 's')).toThrow(/socket path/);
  });
});
