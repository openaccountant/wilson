import { describe, expect, test, afterEach, afterAll, spyOn } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as mcpClient from '../mcp/client.js';
import * as mcpConfig from '../mcp/config.js';
import { createRemoteFetch, createSdkTransport } from '../mcp/client.js';
import { loadMcpTools, getCachedMcpTools, remoteCallMutates } from '../mcp/adapter.js';
import { scrubEgressArgs } from '../mcp/egress.js';
import { formatMcpToolListLine } from '../mcp/mcp-command.js';
import { gateToolCall } from '../agent/approval-gate.js';
import type { ToolApprovalRequest } from '../agent/types.js';
import { isMutatingCall, sessionApprovalScope } from '../tools/mutation.js';
import { defineTool } from '../tools/define-tool.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// ── 1. Remote MCP calls are never approved for the whole session ─────────────

describe('remote MCP tools: approval is asked for each call', () => {
  const serversSpy = spyOn(mcpClient, 'getConnectedServers').mockImplementation(() => ['oa', 'local']);
  const clientSpy = spyOn(mcpClient, 'getMcpClient').mockImplementation((name: string) => ({
    listTools: async () => ({
      tools: (name === 'oa' ? ['search_skills', 'submit_feedback'] : ['echo']).map((t) => ({
        name: t, inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      })),
    }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }) as never);
  const kindSpy = spyOn(mcpClient, 'getServerTransportKind').mockImplementation((name: string) => (name === 'oa' ? 'http' : 'stdio'));
  const configSpy = spyOn(mcpConfig, 'loadMcpConfig').mockImplementation(() => ({
    servers: {
      oa: { transport: 'http', url: 'https://remote.example.com/mcp', readOnlyTools: ['search_skills'] },
      local: { command: 'node' },
    },
  }));
  const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  afterAll(() => {
    serversSpy.mockRestore(); clientSpy.mockRestore(); kindSpy.mockRestore(); configSpy.mockRestore(); warnSpy.mockRestore();
  });

  const tool = (name: string) => {
    const t = getCachedMcpTools().find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  test('the adapter marks every remote tool approveEachCall, and no stdio tool', async () => {
    await loadMcpTools();
    expect(tool('mcp_oa_submit_feedback').approveEachCall).toBe(true);
    expect(tool('mcp_oa_search_skills').approveEachCall).toBe(true);
    expect(tool('mcp_local_echo').approveEachCall).toBeFalsy();
  });

  test('a remote call has no session scope, so the card offers no "don\'t ask again"', async () => {
    await loadMcpTools();
    const t = tool('mcp_oa_submit_feedback');
    expect(sessionApprovalScope(t.name, t, { query: 'x' })).toBeNull();
    const requests: ToolApprovalRequest[] = [];
    await gateToolCall(t.name, t, { query: 'x' }, async (r) => { requests.push(r); return 'allow-once'; }, new Set());
    expect(requests[0]!.session).toBeNull();
  });

  test('answering allow-session does not let a later call with different args skip approval', async () => {
    await loadMcpTools();
    const t = tool('mcp_oa_submit_feedback');
    const approved = new Set<string>();
    const requests: ToolApprovalRequest[] = [];
    const handler = async (r: ToolApprovalRequest) => { requests.push(r); return 'allow-session' as const; };
    await gateToolCall(t.name, t, { query: 'the answer was wrong' }, handler, approved);
    expect(approved.size).toBe(0);
    const second = await gateToolCall(t.name, t, { query: 'my notes: something else entirely' }, handler, approved);
    expect(second.asked).toBe(true);
    expect(requests).toHaveLength(2);
  });

  test('a stale session key for a remote tool is ignored', async () => {
    await loadMcpTools();
    const t = tool('mcp_oa_submit_feedback');
    const gate = await gateToolCall(t.name, t, { query: 'x' }, async () => 'deny', new Set([t.name]));
    expect(gate).toEqual({ asked: true, decision: 'deny', allowed: false });
  });

  test('a read-only short lookup still needs no approval at all', async () => {
    await loadMcpTools();
    const t = tool('mcp_oa_search_skills');
    const gate = await gateToolCall(t.name, t, { query: 'QBI threshold 2025' }, async () => { throw new Error('asked'); }, new Set());
    expect(gate).toMatchObject({ asked: false, allowed: true });
  });

  test('a local tool keeps its session option', async () => {
    await loadMcpTools();
    const t = tool('mcp_local_echo');
    expect(sessionApprovalScope(t.name, t, {})).toEqual({ key: t.name });
  });

  test('defineTool passes approveEachCall through', () => {
    const t = defineTool({ name: 'x', description: 'x', schema: z.object({}), func: async () => '', approveEachCall: true });
    expect(t.approveEachCall).toBe(true);
    expect(sessionApprovalScope('x', t, {})).toBeNull();
  });
});

// ── 2. Egress: numbers split across object keys and sibling fields ───────────

describe('egress guard: numbers split across keys and sibling fields', () => {
  test('digit-bearing keys and values of one object are judged together', () => {
    for (const args of [
      { '1234': '5678', '9012': 'x' },
      { '1234': 'a', '5678': 'b', '9012': 'c' },
      { a: '1234', b: '5678', c: '9012' },
      { q: { a: 123, b: 45, c: 6789 } },
    ]) {
      const scan = scrubEgressArgs(args);
      expect(JSON.stringify(scan.value)).not.toMatch(/\d/);
      expect(scan.redactions).toBeGreaterThan(0);
    }
  });

  test('replaced keys stay distinct, so no field is lost', () => {
    const scan = scrubEgressArgs({ '1234': 'a', '5678': 'b', '9012': 'c' });
    expect(Object.keys(scan.value as object)).toHaveLength(3);
  });

  test('benign objects pass unchanged', () => {
    for (const args of [
      { query: 'Form 8995 vs 8995-A', tax_year: 2025, limit: 10 },
      { query: 'QBI deduction threshold 2025 married filing jointly' },
      { years: [2023, 2024, 2025], due: ['2025-04-15', '2025-06-15'] },
      { '2025': 'brackets', form: '1040' },
    ]) {
      const scan = scrubEgressArgs(args);
      expect(scan.redactions).toBe(0);
      expect(scan.value).toBe(args);
    }
  });
});

describe('read-only remote calls: 9+ digits spread across groups asks for approval', () => {
  const flag = remoteCallMutates('search_skills', new Set(['search_skills']));
  const mutates = (args: Record<string, unknown>) => isMutatingCall({ mutates: flag }, args);

  test('digits split by letters, across keys or across fields ask', () => {
    expect(mutates({ query: '1234 a 5678 b 9012' })).toBe(true);
    expect(mutates({ query: '123x45y6789' })).toBe(true);
    expect(mutates({ '1234': '5678', '9012': 'x' })).toBe(true);
    expect(mutates({ '1234': 'a', q: 'b56', r: 'c789' })).toBe(true);
    expect(mutates({ a: 1234, b: 'x5678y9012' })).toBe(true);
    expect(mutates({ a: 'id 1234', b: { c: 'ref 56789' } })).toBe(true);
  });

  test('short lookups still need no approval', () => {
    expect(mutates({ query: 'QBI deduction threshold 2025 married filing jointly' })).toBe(false);
    expect(mutates({ query: 'Form 8995 vs 8995-A', tax_year: 2025, limit: 10 })).toBe(false);
    expect(mutates({ query: 'Form 1040 Schedule C line 31' })).toBe(false);
    expect(mutates({ query: 'UK VAT 2025' })).toBe(false);
  });
});

// ── 3. `wilson --mcp` prints remote names and descriptions safely ────────────

describe('formatMcpToolListLine', () => {
  test('terminal escapes and other control characters are removed', () => {
    const line = formatMcpToolListLine('evil\u001b[2J\u001b]0;pwned\u0007', 'desc \u001b[31mred\u001b[0m\u009b2J\r\nnext', false);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toContain('evil');
    expect(line).toContain('red');
  });

  test('a plain tool reads as before', () => {
    expect(formatMcpToolListLine('search_skills', 'Search skills', false)).toBe('    - search_skills: Search skills');
    expect(formatMcpToolListLine('compute', undefined, true)).toBe('    - compute (hidden: not offered to the model): (no description)');
  });

  test('the description stays bounded', () => {
    const line = formatMcpToolListLine('t', 'x'.repeat(500), false);
    expect(line.length).toBeLessThan(100);
  });
});

// ── 4. Remote transports refuse redirects off the server's origin ───────────

describe('remote MCP fetch: redirects', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

  const serve = (handler: (req: Request) => Response | Promise<Response>) => {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  };

  test('a redirect to another origin is refused and the target is never contacted', async () => {
    let targetHits = 0;
    const target = serve(() => { targetHits++; return new Response('{}'); });
    const origin = serve(() => new Response(null, { status: 307, headers: { location: `${target}/steal` } }));
    const f = createRemoteFetch(`${origin}/mcp`);
    await expect(f(`${origin}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow(/redirect/i);
    expect(targetHits).toBe(0);
  });

  test('a redirect to plain http from an https server is refused', async () => {
    const fake = async (url: string | URL) =>
      String(url).startsWith('https://remote.example.com')
        ? new Response(null, { status: 302, headers: { location: 'http://remote.example.com/mcp' } })
        : new Response('{}');
    const f = createRemoteFetch('https://remote.example.com/mcp', fake as FetchLike);
    await expect(f('https://remote.example.com/mcp')).rejects.toThrow(/redirect/i);
  });

  test('a redirect to a private address is refused', async () => {
    const fake = async () => new Response(null, { status: 301, headers: { location: 'https://169.254.169.254/latest' } });
    const f = createRemoteFetch('https://remote.example.com/mcp', fake as FetchLike);
    await expect(f('https://remote.example.com/mcp')).rejects.toThrow(/redirect/i);
  });

  test('a same-origin redirect is followed, manually', async () => {
    const inits: Array<RequestInit | undefined> = [];
    const fake = async (url: string | URL, init?: RequestInit) => {
      inits.push(init);
      return String(url).endsWith('/old')
        ? new Response(null, { status: 308, headers: { location: '/mcp' } })
        : new Response('ok');
    };
    const f = createRemoteFetch('https://remote.example.com/old', fake as FetchLike);
    const res = await f('https://remote.example.com/old', { method: 'POST', body: '{}' });
    expect(await res.text()).toBe('ok');
    expect(inits.every((i) => i?.redirect === 'manual')).toBe(true);
    expect(inits[1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  test('too many redirects are refused', async () => {
    const fake = async () => new Response(null, { status: 302, headers: { location: '/again' } });
    const f = createRemoteFetch('https://remote.example.com/mcp', fake as FetchLike);
    await expect(f('https://remote.example.com/mcp')).rejects.toThrow(/redirect/i);
  });

  for (const kind of ['http', 'sse'] as const) {
    test(`the ${kind} transport uses it: a cross-origin redirect never reaches the target`, async () => {
      let targetHits = 0;
      const target = serve(() => { targetHits++; return new Response('{}'); });
      const origin = serve(() => new Response(null, { status: 307, headers: { location: `${target}/mcp` } }));
      const transport = createSdkTransport(kind, { transport: kind, url: `${origin}/mcp` });
      const client = new Client({ name: 'test', version: '0.0.0' });
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close().catch(() => {});
      expect(targetHits).toBe(0);
    });
  }
});
