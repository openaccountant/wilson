import { describe, expect, test, spyOn, afterEach } from 'bun:test';
import * as fs from 'fs';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isHiddenTool, isRemoteServer, resolveHiddenTools, loadMcpConfig, validateRemoteUrl, validateServers, type McpServerConfig, type McpTransportKind } from '../mcp/config.js';
import { connectServer, transportPlan, type ConnectableClient, type ConnectDeps } from '../mcp/client.js';
import { logger } from '../utils/logger.js';

describe('remote MCP config validation', () => {
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  let readSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    warnSpy?.mockRestore();
    readSpy?.mockRestore();
    warnSpy = readSpy = undefined;
  });

  const validate = (servers: Record<string, unknown>) => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    return validateServers(servers as Record<string, McpServerConfig>);
  };

  test('accepts an https http-transport server unchanged', () => {
    const server = { transport: 'http', url: 'https://www.openaccountants.com/api/mcp', readOnlyTools: ['list_skills'] };
    expect(validate({ oa: { ...server } })).toEqual({ oa: server as McpServerConfig });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('plain http is allowed only for localhost / 127.0.0.1 / [::1]', () => {
    expect(validateRemoteUrl('http://localhost:8787/mcp')).toBeNull();
    expect(validateRemoteUrl('http://127.0.0.1:3000/sse')).toBeNull();
    expect(validateRemoteUrl('http://[::1]:3000/mcp')).toBeNull();
    expect(validateRemoteUrl('http://example.com/mcp')).toContain('https');
    expect(validateRemoteUrl('http://localhost.evil.com/mcp')).toContain('https');
    expect(validateRemoteUrl('ftp://example.com/mcp')).toContain('https');
    expect(validateRemoteUrl('not a url')).toContain('not a valid URL');
    expect(validateRemoteUrl(undefined)).toContain('required');
  });

  test('drops a remote server whose URL is not https (fail closed) and warns', () => {
    const out = validate({
      bad: { transport: 'http', url: 'http://tax.example.com/mcp' },
      bareBad: { url: 'http://tax.example.com/sse' },
      noUrl: { transport: 'sse' },
      ok: { url: 'https://tax.example.com/mcp' },
      local: { command: 'node', args: ['server.js'] },
    });
    expect(Object.keys(out).sort()).toEqual(['local', 'ok']);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  test('drops an unknown transport and resets an invalid egress policy', () => {
    const out = validate({
      ws: { transport: 'websocket', url: 'wss://x.example.com' },
      e: { transport: 'http', url: 'https://x.example.com/mcp', egress: 'allow' },
      b: { transport: 'http', url: 'https://x.example.com/mcp', egress: 'block' },
    });
    expect(out.ws).toBeUndefined();
    expect(out.e).toEqual({ transport: 'http', url: 'https://x.example.com/mcp' });
    expect(out.b?.egress).toBe('block');
  });

  test('a valid hiddenTools list passes; an invalid one drops the server (fail closed)', () => {
    const out = validate({
      ok: { transport: 'http', url: 'https://x.example.com/mcp', hiddenTools: ['compute'] },
      empty: { transport: 'http', url: 'https://x.example.com/mcp', hiddenTools: [] },
      str: { transport: 'http', url: 'https://x.example.com/mcp', hiddenTools: 'compute' },
      mixed: { transport: 'http', url: 'https://x.example.com/mcp', hiddenTools: ['compute', 1] },
    });
    expect(Object.keys(out).sort()).toEqual(['empty', 'ok']);
    expect(out.ok?.hiddenTools).toEqual(['compute']);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('loadMcpConfig applies the URL rule to the file it reads', () => {
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ servers: { a: { transport: 'http', url: 'https://a.example.com/mcp' }, b: { url: 'http://b.example.com' } } }),
    );
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    expect(Object.keys(loadMcpConfig().servers)).toEqual(['a']);
  });

  test('isRemoteServer: http/sse/bare url are remote, command and explicit stdio are not', () => {
    expect(isRemoteServer({ transport: 'http', url: 'https://x' })).toBe(true);
    expect(isRemoteServer({ transport: 'sse', url: 'https://x' })).toBe(true);
    expect(isRemoteServer({ url: 'https://x' })).toBe(true);
    expect(isRemoteServer({ command: 'node' })).toBe(false);
    expect(isRemoteServer({ transport: 'stdio', command: 'node', url: 'https://x' })).toBe(false);
    expect(isRemoteServer(undefined)).toBe(false);
  });
});

describe('transport selection and SSE fallback', () => {
  test('transportPlan', () => {
    expect(transportPlan({ url: 'https://x.example.com/mcp' })).toEqual(['http', 'sse']);
    expect(transportPlan({ transport: 'http', url: 'https://x.example.com/mcp' })).toEqual(['http']);
    expect(transportPlan({ transport: 'sse', url: 'https://x.example.com/sse' })).toEqual(['sse']);
    expect(transportPlan({ command: 'node' })).toEqual(['stdio']);
  });

  /** Fake SDK: a client per attempt; `failing` transports reject on connect. */
  function fakeDeps(failing: ReadonlySet<McpTransportKind>) {
    const attempts: McpTransportKind[] = [];
    const closed: McpTransportKind[] = [];
    const deps: ConnectDeps<ConnectableClient & { kind?: McpTransportKind }> = {
      createTransport: (kind) => ({ kind } as unknown as Transport),
      createClient: () => {
        const client: ConnectableClient & { kind?: McpTransportKind } = {
          async connect(transport) {
            const kind = (transport as unknown as { kind: McpTransportKind }).kind;
            client.kind = kind;
            attempts.push(kind);
            if (failing.has(kind)) throw new Error(`${kind} refused`);
          },
          async listTools() {
            return { tools: [] };
          },
          async close() {
            if (client.kind) closed.push(client.kind);
          },
        };
        return client;
      },
    };
    return { deps, attempts, closed };
  }

  test('a bare url connects over Streamable HTTP when it works', async () => {
    const { deps, attempts } = fakeDeps(new Set());
    const res = await connectServer('oa', { url: 'https://x.example.com/mcp' }, deps);
    expect(res.kind).toBe('http');
    expect(attempts).toEqual(['http']);
  });

  test('a bare url falls back to SSE when the HTTP connect fails, with a fresh client', async () => {
    const { deps, attempts, closed } = fakeDeps(new Set<McpTransportKind>(['http']));
    const res = await connectServer('legacy', { url: 'https://x.example.com/sse' }, deps);
    expect(res.kind).toBe('sse');
    expect(attempts).toEqual(['http', 'sse']);
    expect(closed).toEqual(['http']);
    expect((res.client as { kind?: string }).kind).toBe('sse');
  });

  test('explicit transport: "http" does not fall back', async () => {
    const { deps, attempts } = fakeDeps(new Set<McpTransportKind>(['http']));
    await expect(connectServer('oa', { transport: 'http', url: 'https://x.example.com/mcp' }, deps)).rejects.toThrow('http refused');
    expect(attempts).toEqual(['http']);
  });

  test('explicit transport: "sse" stays SSE', async () => {
    const { deps, attempts } = fakeDeps(new Set());
    const res = await connectServer('s', { transport: 'sse', url: 'https://x.example.com/sse' }, deps);
    expect(res.kind).toBe('sse');
    expect(attempts).toEqual(['sse']);
  });

  test('both transports failing reports both', async () => {
    const { deps } = fakeDeps(new Set<McpTransportKind>(['http', 'sse']));
    await expect(connectServer('x', { url: 'https://x.example.com/mcp' }, deps)).rejects.toThrow(/http or sse: sse refused/);
  });

  test('refuses a non-https remote URL before any connect attempt', async () => {
    const { deps, attempts } = fakeDeps(new Set());
    await expect(connectServer('x', { url: 'http://x.example.com/mcp' }, deps)).rejects.toThrow('https');
    expect(attempts).toEqual([]);
  });
});

describe('resolveHiddenTools', () => {
  test('matches without regard to case', () => {
    const hidden = resolveHiddenTools('oa', { transport: 'http', url: 'https://example.com/mcp', hiddenTools: ['compute'] });
    expect(isHiddenTool('compute', hidden)).toBe(true);
    expect(isHiddenTool('Compute', hidden)).toBe(true);
    expect(isHiddenTool('search_skills', hidden)).toBe(false);
  });

  test('a configured server with no hiddenTools hides nothing, even under a preset name', () => {
    const hidden = resolveHiddenTools('openaccountants', { transport: 'http', url: 'https://example.com/mcp' });
    expect(hidden.size).toBe(0);
  });

  test('a server missing from the config falls back to the preset of the same name', () => {
    expect(isHiddenTool('compute', resolveHiddenTools('openaccountants', undefined))).toBe(true);
    expect(resolveHiddenTools('someone-else', undefined).size).toBe(0);
  });
});
