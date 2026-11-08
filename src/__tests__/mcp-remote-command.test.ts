import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMcpCommand } from '../mcp/mcp-command.js';
import { addMcpServerToConfig } from '../mcp/config.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-cmd-'));
  path = join(dir, 'mcp.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const readJson = () => JSON.parse(readFileSync(path, 'utf-8'));

describe('/mcp add openaccountants', () => {
  test('writes the http entry with the read-only list; tools that send user data are NOT read-only', () => {
    const out = runMcpCommand('add openaccountants', path);
    expect(readJson()).toEqual({
      servers: {
        openaccountants: {
          transport: 'http',
          url: 'https://www.openaccountants.com/api/mcp',
          readOnlyTools: [
            'start',
            'search_skills',
            'get_skill',
            'search_rules',
            'get_deadlines',
            'list_jurisdictions',
            'list_verifiers',
          ],
          hiddenTools: ['compute'],
        },
      },
    });
    for (const sends of [
      'submit_feedback', 'share_with_openaccountants', 'compute', 'get_quote', 'validate_vat_number', 'check_audit_exemption',
    ]) {
      expect(readJson().servers.openaccountants.readOnlyTools).not.toContain(sends);
    }
    expect(out).toContain('third-party');
    expect(out).toContain('asks before sending');
    expect(out).toContain('compute tool is hidden');
    expect(out).not.toContain('stripped');
  });

  test('/mcp list shows the hidden tools and how to opt in', () => {
    runMcpCommand('add openaccountants', path);
    const out = runMcpCommand('list', path);
    expect(out).toContain('read-only: start, search_skills, get_skill, search_rules, get_deadlines, list_jurisdictions, list_verifiers');
    expect(out).toContain('hidden: compute');
    expect(out).toContain('remove from hiddenTools');
  });

  test('a server with nothing hidden lists no hidden part', () => {
    runMcpCommand('add other https://tax.example.com/mcp', path);
    expect(runMcpCommand('list', path)).not.toContain('hidden');
  });

  test('keeps other servers and top-level keys, and the "mcpServers" key if that is what the file uses', () => {
    writeFileSync(path, JSON.stringify({ comment: 'mine', mcpServers: { local: { command: 'node', args: ['s.js'] } } }));
    runMcpCommand('add openaccountants', path);
    const json = readJson();
    expect(json.comment).toBe('mine');
    expect(json.servers).toBeUndefined();
    expect(json.mcpServers.local).toEqual({ command: 'node', args: ['s.js'] });
    expect(json.mcpServers.openaccountants.transport).toBe('http');
  });

  test('writes atomically: no temp file is left behind and the file is private', () => {
    runMcpCommand('add openaccountants', path);
    expect(readdirSync(dir)).toEqual(['mcp.json']);
    const { statSync } = require('fs') as typeof import('fs');
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test('re-adding replaces the entry in place', () => {
    runMcpCommand('add openaccountants', path);
    expect(runMcpCommand('add openaccountants', path)).toContain('Updated');
    expect(Object.keys(readJson().servers)).toEqual(['openaccountants']);
  });

  test('never overwrites an mcp.json that is not valid JSON', () => {
    writeFileSync(path, '{ "servers": { broken');
    const out = runMcpCommand('add openaccountants', path);
    expect(out).toContain('Could not update');
    expect(readFileSync(path, 'utf-8')).toBe('{ "servers": { broken');
  });

  test('unknown preset is refused', () => {
    expect(runMcpCommand('add nope', path)).toContain('Unknown preset');
  });
});

describe('/mcp add <name> <url>, list, remove', () => {
  test('a custom remote server must be https', () => {
    expect(runMcpCommand('add tax http://tax.example.com/mcp', path)).toContain('https');
    runMcpCommand('add tax https://tax.example.com/mcp', path);
    expect(readJson().servers.tax).toEqual({ url: 'https://tax.example.com/mcp' });
  });

  test('server names are restricted', () => {
    expect(() => addMcpServerToConfig('bad name', { url: 'https://x.example.com' }, path)).toThrow();
  });

  test('list shows servers; remove drops only the named one', () => {
    writeFileSync(path, JSON.stringify({ servers: { local: { command: 'node' } } }));
    runMcpCommand('add openaccountants', path);
    const listed = runMcpCommand('list', path);
    expect(listed).toContain('openaccountants');
    expect(listed).toContain('local');
    expect(runMcpCommand('remove openaccountants', path)).toContain('Removed');
    expect(readJson()).toEqual({ servers: { local: { command: 'node' } } });
    expect(runMcpCommand('remove openaccountants', path)).toContain('No MCP server');
  });

  test('list with no file', () => {
    expect(runMcpCommand('', path)).toContain('No MCP servers configured');
  });
});
