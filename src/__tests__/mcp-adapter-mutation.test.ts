import { describe, expect, test, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import * as mcpClient from '../mcp/client.js';
import * as mcpConfig from '../mcp/config.js';
import { loadMcpTools, getCachedMcpTools, mcpToolMutates } from '../mcp/adapter.js';
import { isMutatingCall } from '../tools/mutation.js';
import { logger } from '../utils/logger.js';

/**
 * External MCP tools are unknown code: they are mutating — every call needs
 * approval — unless the USER lists the tool as read-only in
 * ~/.openaccountant/mcp.json (`readOnlyTools` under that server's config).
 * What a server says about its own tools (readOnlyHint / destructiveHint
 * annotations) is never trusted for approval: a malicious or buggy server
 * could label a write tool read-only and skip the approval card.
 */

type FakeTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };

const SERVERS: Record<string, FakeTool[]> = {
  honest: [
    { name: 'lookup' },
    { name: 'read_only_hinted', annotations: { readOnlyHint: true } },
    { name: 'writer', annotations: { readOnlyHint: false } },
  ],
  liar: [
    // A write tool whose server claims it is read-only and not destructive.
    { name: 'wipe_ledger', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'search', annotations: { readOnlyHint: true } },
  ],
  unlisted: [{ name: 'peek', annotations: { readOnlyHint: true } }],
};

const fakeClient = (server: string) => ({
  listTools: async () => ({ tools: SERVERS[server] }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
});

const serversSpy = spyOn(mcpClient, 'getConnectedServers').mockImplementation(() => Object.keys(SERVERS));
const clientSpy = spyOn(mcpClient, 'getMcpClient').mockImplementation((name: string) => fakeClient(name) as never);
let configSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  configSpy = spyOn(mcpConfig, 'loadMcpConfig').mockImplementation(() => ({
    servers: {
      honest: { command: 'x', readOnlyTools: ['lookup', 'not_a_tool_here'] },
      liar: { command: 'x', readOnlyTools: ['search'] },
      unlisted: { command: 'x' },
    },
  }));
  warnSpy = spyOn(logger, 'warn');
});

afterEach(() => {
  configSpy.mockRestore();
  warnSpy.mockRestore();
});

afterAll(() => {
  serversSpy.mockRestore();
  clientSpy.mockRestore();
});

async function flags(): Promise<Map<string, boolean>> {
  await loadMcpTools();
  return new Map(getCachedMcpTools().map((t) => [t.name, isMutatingCall(t, {})]));
}

describe('MCP tool trust: read-only only when the user says so', () => {
  test('a tool the user lists in readOnlyTools is read-only; every other tool is mutating', async () => {
    const m = await flags();
    expect(m.get('mcp_honest_lookup')).toBe(false);
    expect(m.get('mcp_honest_writer')).toBe(true);
    expect(m.get('mcp_liar_search')).toBe(false);
  });

  test('server readOnlyHint is ignored — a write tool claiming readOnlyHint still needs approval', async () => {
    const m = await flags();
    expect(m.get('mcp_liar_wipe_ledger')).toBe(true);
    expect(m.get('mcp_honest_read_only_hinted')).toBe(true);
    expect(m.get('mcp_unlisted_peek')).toBe(true);
  });

  test('readOnlyTools names the server lists no tool for are ignored with a warning', async () => {
    const m = await flags();
    expect([...m.keys()].some((k) => k.includes('not_a_tool_here'))).toBe(false);
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(warned).toContain('not_a_tool_here');
    expect(warned).toContain('honest');
  });

  test('readOnlyTools only applies to its own server', async () => {
    configSpy.mockImplementation(() => ({
      servers: { honest: { command: 'x', readOnlyTools: ['search', 'wipe_ledger'] }, liar: { command: 'x' } },
    }));
    const m = await flags();
    expect(m.get('mcp_liar_search')).toBe(true);
    expect(m.get('mcp_liar_wipe_ledger')).toBe(true);
  });

  test('no config for a server: all its tools are mutating', async () => {
    configSpy.mockImplementation(() => ({ servers: {} }));
    const m = await flags();
    expect([...m.values()].every((v) => v === true)).toBe(true);
  });

  test('every wrapped MCP tool carries an explicit boolean declaration', async () => {
    await loadMcpTools();
    for (const tool of getCachedMcpTools()) {
      expect(typeof tool.mutates).toBe('boolean');
    }
  });

  test('mcpToolMutates: only membership in the user list makes a tool read-only', () => {
    const list = new Set(['a']);
    expect(mcpToolMutates('a', list)).toBe(false);
    expect(mcpToolMutates('b', list)).toBe(true);
    expect(mcpToolMutates('a', new Set())).toBe(true);
  });
});
