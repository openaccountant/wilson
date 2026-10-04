import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs rig helper
import { createFormatter, displayCommand, hms } from '../../demos/rig/lib/actor-log.mjs';
// @ts-expect-error plain .mjs rig helper
import { resolveAgentBrowser, parseVersion, allowedBashPattern, agentBrowserEnv, AGENT_BROWSER_VERSION } from '../../demos/rig/lib/agent-browser.mjs';

const BIN = '/rig/node_modules/agent-browser/bin/agent-browser.js';
const pre = `${BIN} --cdp 9333 --session s`;
const at = (s: string) => new Date(`2026-10-04T15:46:${s}Z`);

// A recorded-shape stream-json fixture: system init, tool_use, tool_result (string and block forms), final result.
const FIXTURE = [
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking first.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `${pre} webmcp list --json` } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"success":true}\n' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: `${pre} webmcp invoke categorize_transaction --params '{"id":279,"category":"Shopping"}' --detach` } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ABC123: pending' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: `${pre} webmcp result ABC123` } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ABC123: completed\n{\n  "outcome": "committed"\n}' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Proposed Kiln as Shopping.\nApproved.' },
];

describe('actor.log formatting from stream-json', () => {
  test('commands are timestamped and stripped of binary/--cdp/--session; outputs verbatim; SUMMARY from final result', () => {
    const f = createFormatter({ bin: BIN, cdpPort: 9333, session: 's' });
    const times = ['38', '38', '41', '41', '45', '46', '46', '59'];
    const lines: string[] = [];
    FIXTURE.forEach((ev, i) => lines.push(...f.feed(ev, at(times[i]))));
    expect(lines).toEqual([
      '[15:46:38] $ agent-browser webmcp list --json',
      '{"success":true}',
      `[15:46:41] $ agent-browser webmcp invoke categorize_transaction --params '{"id":279,"category":"Shopping"}' --detach`,
      'ABC123: pending',
      '[15:46:46] $ agent-browser webmcp result ABC123',
      'ABC123: completed',
      '{',
      '  "outcome": "committed"',
      '}',
      '[SUMMARY] Proposed Kiln as Shopping. Approved.',
    ]);
    expect(f.commands).toBe(3);
    expect(f.summary).toBe('Proposed Kiln as Shopping. Approved.');
  });

  test('text blocks and unrelated results produce no lines; non-Bash tool attempts are recorded', () => {
    const f = createFormatter({ bin: BIN, cdpPort: 9333, session: 's' });
    expect(f.feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, at('00'))).toEqual([]);
    expect(f.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zzz', content: 'x' }] } }, at('00'))).toEqual([]);
    expect(f.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: {} }] } }, at('01'))).toEqual(['[15:46:01] $ [Write attempted]']);
  });

  test('empty tool output and a foreign command are kept honestly', () => {
    expect(displayCommand('ls /', BIN, 9333, 's')).toBe('ls /');
    expect(displayCommand(`${pre}`, BIN, 9333, 's')).toBe('agent-browser');
    const f = createFormatter({ bin: BIN, cdpPort: 9333, session: 's' });
    f.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: `${pre} get url` } }] } }, at('02'));
    expect(f.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] } }, at('02'))).toEqual(['(no output)']);
    expect(hms(new Date('2026-10-04T05:06:07Z'))).toBe('05:06:07');
  });
});

describe('vendored agent-browser resolver', () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ab-'));
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const real = path.join(dir, 'real-agent-browser');
    fs.writeFileSync(real, '#!/bin/sh\n');
    fs.symlinkSync(real, path.join(dir, 'node_modules', '.bin', 'agent-browser'));
    return { dir, real: fs.realpathSync(real) };
  };

  test('pins 0.38.2 and parses version output', () => {
    expect(AGENT_BROWSER_VERSION).toBe('0.38.2');
    expect(parseVersion('agent-browser 0.38.2\n')).toBe('0.38.2');
    expect(parseVersion('nonsense')).toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../demos/rig/package.json'), 'utf8'));
    expect(pkg.dependencies['agent-browser']).toBe('0.38.2');
    const root = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../package.json'), 'utf8'));
    expect(JSON.stringify(root)).not.toContain('agent-browser');
  });

  test('resolves the local binary when the version matches', () => {
    const { dir, real } = mk();
    const r = resolveAgentBrowser({ rigDir: dir, exec: () => 'agent-browser 0.38.2\n' });
    expect(r).toEqual({ bin: real, version: '0.38.2' });
  });

  test('fails clearly on a wrong version (the old global 0.27.1) or a missing install', () => {
    const { dir } = mk();
    expect(() => resolveAgentBrowser({ rigDir: dir, exec: () => 'agent-browser 0.27.1' })).toThrow(/0\.27\.1.*need exactly 0\.38\.2/);
    expect(() => resolveAgentBrowser({ rigDir: dir, exec: () => 'garbage' })).toThrow(/need exactly 0\.38\.2/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ab-empty-'));
    expect(() => resolveAgentBrowser({ rigDir: empty, exec: () => '' })).toThrow(/not found.*npm install/);
  });

  test('allow pattern is the exact absolute-path prefix; env forces system Chrome', () => {
    expect(allowedBashPattern(BIN, 9333, 's')).toBe(`Bash(${BIN} --cdp 9333 --session s:*)`);
    expect(agentBrowserEnv({ A: '1' }, '/chrome').AGENT_BROWSER_EXECUTABLE_PATH).toBe('/chrome');
  });
});
