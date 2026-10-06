import { describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { count, grantTools, mintTestToken, testScope } from './mcp-helpers.js';
import { callTool, exposedTools, grantLocalAccess } from '../mcp/engine.js';
import { handleMcpHttpRequest } from '../mcp/http-server.js';
import { checkTokenTools, mintClientToken, updateClientTokenTools } from '../mcp/client-tokens.js';
import { getConfiguredPolicy, setPolicy, type PolicyActor } from '../mcp/policies.js';
import { createOperation, getOperation } from '../mcp/store.js';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';
import { RETIRED_TOOL_NAMES } from '../mcp/tool-names.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * A retired tool name grants nothing (specs/webmcp-tool-naming.md §4.7, I6, I6d): refused with `unknown_tool` and a
 * "renamed to" hint on every path, never registered, never stored. Plus the policy write rules that keep a stale
 * old-name mirror row from out-voting a deliberate change (AR-P1, AR-P3).
 */

const admin: PolicyActor = { userId: null, role: 'admin', authEnabled: false };
const PAIRS = Object.entries(RETIRED_TOOL_NAMES);
const hintFor = (old: string) => `renamed to "${RETIRED_TOOL_NAMES[old]!.name}" in 0.10.0`;

describe('I6 a retired name is refused with a hint on every path', () => {
  test('callTool: 404 unknown_tool with the hint, no operation, nothing granted', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions']);
    for (const [old] of PAIRS) {
      for (const transport of ['imperative', 'declarative', 'page', 'http-mcp'] as const) {
        const out = await callTool(db, scope, grants.search_transactions, old, { query: 'x' }, transport);
        expect(out.ok, old).toBe(false);
        if (out.ok) continue;
        expect(out.status).toBe(404);
        expect(out.code).toBe('unknown_tool');
        expect(out.error).toContain(hintFor(old));
      }
    }
    expect(count(db, 'mcp_operations')).toBe(0);
  });

  test('POST /api/mcp/grants path (grantLocalAccess): 404 with the hint, and no grant row is written', () => {
    const db = createTestDb();
    for (const [old] of PAIRS) {
      const out = grantLocalAccess(db, testScope(), [old]);
      expect(out.ok, old).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(404);
        expect(out.error).toContain(hintFor(old));
      }
    }
    expect(count(db, 'mcp_grants')).toBe(0);
    expect(grantLocalAccess(db, testScope(), ['not_a_tool'])).toMatchObject({ ok: false, status: 400 });
  });

  test('client token create and tools update: 404 with the hint, and no grant is stored', () => {
    const db = createTestDb();
    for (const [old] of PAIRS) {
      expect(checkTokenTools([old], { role: 'admin', authEnabled: true })).toMatchObject({ status: 404, code: 'unknown_tool' });
      const minted = mintClientToken(db, { userId: null, role: 'admin', profile: 'test', authEnabled: false }, { name: 'x', tools: [old] });
      expect(minted).toMatchObject({ ok: false, status: 404 });
      if (!minted.ok) expect(minted.error).toContain(hintFor(old));
    }
    const { id } = mintTestToken(db, ['get_operation_result']);
    const owner = { userId: null, role: 'admin' as const, authEnabled: false };
    expect(updateClientTokenTools(db, id, owner, ['transaction_search'], 'test')).toMatchObject({ ok: false, status: 404 });
    expect(count(db, 'mcp_grants', "tool_name = 'transaction_search'")).toBe(0);
    expect(checkTokenTools(['not_a_tool'], { role: 'admin', authEnabled: true })).toMatchObject({ status: 400 });
  });

  test('PUT /api/mcp/policies/:tool path (setPolicy): 404 with the hint, and no row is written', () => {
    const db = createTestDb();
    for (const [old] of PAIRS) {
      const out = setPolicy(db, admin, old, 'off');
      expect(out, old).toMatchObject({ ok: false, status: 404, code: 'unknown_tool' });
      if (!out.ok) expect(out.error).toContain(hintFor(old));
    }
    expect(count(db, 'mcp_tool_policies')).toBe(0);
  });

  test('tools/list for a tab or a token never contains a retired name', () => {
    const db = createTestDb();
    const scope = testScope();
    grantTools(db, scope, MCP_TOOL_CATALOG.filter((d) => d.transports.includes('webmcp')).map((d) => d.name));
    const names = exposedTools(db, scope).map((t) => t.name);
    expect(names.length).toBeGreaterThan(10);
    for (const [old] of PAIRS) expect(names).not.toContain(old);
  });
});

function mcpRequest(token: string | null, body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
const call = (id: number, name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const noiseRows = (db: Database) => db.prepare("SELECT tool_name, decision, count FROM mcp_audit_log WHERE tier = 'noise'").all() as Array<{ tool_name: string; decision: string; count: number }>;

describe('I6d the /mcp hint path grants nothing', () => {
  test('a single tools/call for a retired name gets isError and the hint, runs no handler, and writes a noise row', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { token } = mintTestToken(db, ['search_transactions']);
    const res = await handleMcpHttpRequest(db, mcpRequest(token, call(7, 'transaction_search', { query: 'x' })), '127.0.0.1', 'test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(7);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('unknown_tool');
    expect(body.result.content[0].text).toContain('renamed to "search_transactions" in 0.10.0');
    expect(count(db, 'mcp_operations')).toBe(0);
    expect(noiseRows(db)).toHaveLength(1);
    expect(noiseRows(db)[0]).toMatchObject({ decision: 'denied_grant', count: 1 });
    // The token holds search_transactions: the retired name must not be an alias for it. The audit label is generic.
    expect(noiseRows(db)[0]!.tool_name).not.toBe('transaction_search');
  });

  test('a batched body gets the SDK error and no hint', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { token } = mintTestToken(db, ['search_transactions']);
    const res = await handleMcpHttpRequest(db, mcpRequest(token, [call(1, 'transaction_search', { query: 'x' }), call(2, 'search_transactions', { query: 'x' })]), '127.0.0.1', 'test');
    const text = await res.text();
    expect(text).not.toContain('renamed to');
    expect(text.toLowerCase()).toContain('not found');
  });

  test('with no token the response is the 401 and carries no hint', async () => {
    const db = createTestDb();
    const res = await handleMcpHttpRequest(db, mcpRequest(null, call(1, 'transaction_search')), '127.0.0.1', 'test');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('renamed to');
  });

  test('tools/list is unchanged by the short-circuit and never lists a retired name', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { token } = mintTestToken(db, ['search_transactions', 'get_cash_forecast']);
    await handleMcpHttpRequest(db, mcpRequest(token, call(1, 'forecast')), '127.0.0.1', 'test');
    const res = await handleMcpHttpRequest(db, mcpRequest(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), '127.0.0.1', 'test');
    const names = ((await res.json()) as any).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['get_cash_forecast', 'search_transactions']);
  });

  test('the current name still works over /mcp for the same token', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { token } = mintTestToken(db, ['search_transactions']);
    const res = await handleMcpHttpRequest(db, mcpRequest(token, call(3, 'search_transactions', { query: 'a' })), '127.0.0.1', 'test');
    const body = (await res.json()) as any;
    expect(body.result.isError).not.toBe(true);
  });
});

describe('policy writes with a retired mirror row (AR-P1, AR-P3)', () => {
  const put = (db: Database, k: number, tool: string, p: string) =>
    db.prepare('INSERT OR REPLACE INTO mcp_tool_policies (user_key, tool_name, policy) VALUES (@k, @t, @p)').run({ k, t: tool, p });
  const raw = (db: Database, k: number, tool: string) =>
    (db.prepare('SELECT policy FROM mcp_tool_policies WHERE user_key = @k AND tool_name = @t').get({ k, t: tool }) as { policy: string } | undefined)?.policy;

  test('set loosens past a stale old row: Allow over an old Off leaves effective Allow, and the mirror follows', () => {
    const db = createTestDb();
    put(db, 0, 'spending_summary', 'off');
    expect(getConfiguredPolicy(db, null, 'get_spending_summary')).toBe('off');
    expect(setPolicy(db, admin, 'get_spending_summary', 'allow')).toMatchObject({ ok: true, effective: 'allow' });
    expect(raw(db, 0, 'spending_summary')).toBe('allow');
    expect(raw(db, 0, 'get_spending_summary')).toBe('allow');
  });

  test('set off reaches the old-name row so an old-name build on the same database enforces it', () => {
    const db = createTestDb();
    expect(setPolicy(db, admin, 'get_net_worth', 'off')).toMatchObject({ ok: true, effective: 'off' });
    expect(raw(db, 0, 'net_worth')).toBe('off');
    expect(raw(db, 0, 'get_net_worth')).toBe('off');
    expect(setPolicy(db, admin, 'update_transaction', 'ask')).toMatchObject({ ok: true });
    expect(raw(db, 0, 'edit_transaction')).toBe('ask');
  });

  test('a tool that was never renamed gets exactly one row', () => {
    const db = createTestDb();
    setPolicy(db, admin, 'categorize_transaction', 'off');
    expect(count(db, 'mcp_tool_policies')).toBe(1);
  });

  test('set off rejects an old-name pending op, and never touches a chat card with the same name', () => {
    const db = createTestDb();
    const mk = (source: 'webmcp' | 'chat', toolName: string) =>
      createOperation(db, {
        source, grantId: null, toolName, args: {}, before: null, after: null, transactionId: null, revisionAtPrepare: null,
        profile: 'test', origin: 'o', sessionGeneration: source === 'chat' ? 'dashboard-chat' : 's', userId: null, role: 'admin',
      });
    const web = mk('webmcp', 'edit_transaction');
    const chat = mk('chat', 'edit_transaction');
    const current = mk('webmcp', 'update_transaction');
    expect(setPolicy(db, admin, 'update_transaction', 'off').ok).toBe(true);
    expect(getOperation(db, web.id)!.status).toBe('rejected');
    expect(getOperation(db, current.id)!.status).toBe('rejected');
    expect(getOperation(db, chat.id)!.status).toBe('pending');
  });

  test('setPolicy stores def.name and answers with it', () => {
    const db = createTestDb();
    const out = setPolicy(db, admin, 'get_cash_forecast', 'ask');
    expect(out).toMatchObject({ ok: true, tool: 'get_cash_forecast', policy: 'ask' });
    expect(raw(db, 0, 'get_cash_forecast')).toBe('ask');
  });
});
