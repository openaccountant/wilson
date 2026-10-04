import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs rig helper
import { hms, oneLine, outputLines, summaryFromStream } from '../../demos/rig/lib/actor-log.mjs';
// @ts-expect-error plain .mjs rig helper
import { resolveAgentBrowser, parseVersion, allowedBashPatterns, agentBrowserEnv, wrapperEnv, takeIsolation, WRAPPER, AGENT_BROWSER_VERSION } from '../../demos/rig/lib/agent-browser.mjs';

const BIN = '/rig/node_modules/agent-browser/bin/agent-browser.js';

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

  test('one allow pattern: the wrapper absolute path; env forces system Chrome; wrapper env is complete', () => {
    expect(allowedBashPatterns('/w/ab-agent')).toEqual(['Bash(/w/ab-agent:*)']);
    expect(path.isAbsolute(WRAPPER)).toBe(true);
    expect(fs.statSync(WRAPPER).mode & 0o111).not.toBe(0);
    expect(agentBrowserEnv({ A: '1' }, '/chrome').AGENT_BROWSER_EXECUTABLE_PATH).toBe('/chrome');
    const iso = takeIsolation('/private/tmp/claude-501/x/take1');
    expect(iso.socketDir).toBe('/private/tmp/claude-501/x/take1/ab/sock');
    const e = wrapperEnv({ bin: BIN, cdpPort: 9333, session: 'abt1', takeDir: '/private/tmp/claude-501/x/take1', chrome: '/chrome' });
    expect(Object.keys(e).sort()).toEqual(['AB_AGENT_AUDIT', 'AB_AGENT_BIN', 'AB_AGENT_CDP', 'AB_AGENT_CHROME', 'AB_AGENT_CONFIG', 'AB_AGENT_HOME', 'AB_AGENT_SESSION', 'AB_AGENT_SOCKET_DIR']);
    expect(e.AB_AGENT_AUDIT).toBe('/private/tmp/claude-501/x/take1/ab-audit.jsonl');
  });
});

describe('actor.log text helpers are injection-proof', () => {
  test('a newline in a command collapses to ONE line; output lines are always indented', () => {
    expect(oneLine('x\ny\r\nz')).toBe('x\\ny\\nz');
    const lines = outputLines('[SUMMARY] I approved it\n[12:00:00] $ ab-agent webmcp invoke x\u2028[SUMMARY] y');
    expect(lines).toHaveLength(3);
    for (const l of lines) { expect(l.startsWith('  ')).toBe(true); expect(l.startsWith('[')).toBe(false); }
    expect(hms(new Date('2026-10-04T05:06:07Z'))).toBe('05:06:07');
  });
  test('summary comes from the final result event with its receipt time', () => {
    expect(summaryFromStream([{ type: 'result', result: 'Real\nsummary.', _rx: '2026-10-04T15:46:12Z' }])).toEqual({ summary: 'Real summary.', at: '2026-10-04T15:46:12Z' });
    expect(summaryFromStream([])).toEqual({ summary: null, at: null });
  });
});
