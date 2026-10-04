import { describe, expect, test, afterAll, spyOn } from 'bun:test';
import * as mcpClient from '../mcp/client.js';
import { loadMcpTools, getCachedMcpTools } from '../mcp/adapter.js';
import { isMutatingCall } from '../tools/mutation.js';

/**
 * #152 — tools from external MCP servers are unknown code: they write by
 * default and need approval, unless the server declares the tool read-only
 * (annotations.readOnlyHint === true, and not also destructiveHint: true).
 */

type FakeTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };

const FAKE_TOOLS: FakeTool[] = [
  { name: 'no_annotations' },
  { name: 'empty_annotations', annotations: {} },
  { name: 'read_only', annotations: { readOnlyHint: true } },
  { name: 'read_only_destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: 'read_only_not_destructive', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'explicit_writer', annotations: { readOnlyHint: false } },
  { name: 'truthy_string', annotations: { readOnlyHint: 'true' } },
  { name: 'destructive_only', annotations: { destructiveHint: true } },
];

const fakeClient = {
  listTools: async () => ({ tools: FAKE_TOOLS }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};

const serversSpy = spyOn(mcpClient, 'getConnectedServers').mockImplementation(() => ['fake']);
const clientSpy = spyOn(mcpClient, 'getMcpClient').mockImplementation(() => fakeClient as never);

afterAll(() => {
  serversSpy.mockRestore();
  clientSpy.mockRestore();
});

describe('MCP tool wrapper mutation flag (#152)', () => {
  test('external tools are mutating unless the server declares readOnlyHint: true (and not destructive)', async () => {
    await loadMcpTools();
    const byName = new Map(getCachedMcpTools().map((t) => [t.name, t]));
    const mutating = (name: string) => isMutatingCall(byName.get(`mcp_fake_${name}`)!, {});

    expect(mutating('no_annotations')).toBe(true);
    expect(mutating('empty_annotations')).toBe(true);
    expect(mutating('explicit_writer')).toBe(true);
    expect(mutating('truthy_string')).toBe(true);
    expect(mutating('destructive_only')).toBe(true);
    expect(mutating('read_only_destructive')).toBe(true);

    expect(mutating('read_only')).toBe(false);
    expect(mutating('read_only_not_destructive')).toBe(false);
  });

  test('every wrapped MCP tool carries an explicit boolean declaration', async () => {
    await loadMcpTools();
    for (const tool of getCachedMcpTools()) {
      expect(typeof tool.mutates).toBe('boolean');
    }
  });
});
