import { describe, expect, test, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, count, firstTxnId, makeUser, mintTestToken } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { disableAuth, enableAuth, verifyLogin } from '../dashboard/auth.js';
import { callTool, approveWebMcpOperation } from '../mcp/engine.js';
import {
  checkTokenTools,
  listClientTokens,
  mintClientToken,
  resolveClientToken,
  rotateClientToken,
  revokeClientToken,
} from '../mcp/client-tokens.js';
import { visibleToolDefs } from '../mcp/http-server.js';
import { setLimiterFor, RateLimiter } from '../mcp/rate-limit.js';
import { MCP_TOOL_CATALOG, getToolDef, schemaDigest } from '../mcp/tool-catalog.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Dedicated `/mcp` client tokens (threat model T06, T07): shown once, stored as
 * sha256, revocable and rotatable, scoped from live state on every request, and
 * never able to carry a write tool while dashboard auth is off.
 */

let db: Database;
const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function start() {
  db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  return { db, base: `http://localhost:${result.server.port}` };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function connect(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'token-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

/** A bare JSON-RPC initialize, to read the HTTP status and error body the SDK client would hide. */
function rawInit(base: string, bearer?: string) {
  return fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
}

async function mintViaRoute(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await bfetch(base + '/api/mcp/client-tokens', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

describe('mint', () => {
  test('the plaintext is returned once and the database holds only its sha256', async () => {
    const { base, db: sdb } = await start();
    const minted = await mintViaRoute(base, { name: 'Hronaut laptop', tools: ['search_transactions'], expiresInDays: 7 });
    expect(minted.status).toBe(200);
    const token: string = minted.body.token;
    expect(token.startsWith('wmcp_')).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(5 + 43); // 32 bytes as base64url is 43 characters

    const row = sdb.prepare('SELECT * FROM mcp_client_tokens').get() as any;
    expect(row.token_hash).toBe(sha256(token));
    expect(row.token_prefix).toBe(token.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.name).toBe('Hronaut laptop');
    expect(row.user_id).toBeNull();
    // The expiry honours expiresInDays (7 days, give or take a minute).
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThan(7 * 86_400_000 + 60_000);

    // The token's tools are grants bound to 'tok:<id>' and the fixed client origin.
    const grants = sdb.prepare('SELECT * FROM mcp_grants').all() as any[];
    expect(grants.map((g) => g.tool_name)).toEqual(['search_transactions']);
    expect(grants[0].session_generation).toBe(`tok:${row.id}`);
    expect(grants[0].origin).toBe('http-mcp-client');
    expect(minted.body.meta.id).toBe(row.id);
    expect(minted.body.meta.tools).toEqual(['search_transactions']);
  });

  test('defaults to a 30 day expiry; an expiry outside 1/7/30/90 is a 400', async () => {
    const { base, db: sdb } = await start();
    const ok = await mintViaRoute(base, { name: 'default', tools: ['get_cash_forecast'] });
    expect(ok.status).toBe(200);
    const row = sdb.prepare('SELECT expires_at FROM mcp_client_tokens').get() as { expires_at: string };
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(30 * 86_400_000 - 60_000);
    for (const bad of [0, 2, 365]) {
      expect((await mintViaRoute(base, { name: 'bad', tools: ['get_cash_forecast'], expiresInDays: bad })).status).toBe(400);
    }
  });

  test('GET never returns the plaintext or the hash', async () => {
    const { base } = await start();
    const minted = await mintViaRoute(base, { name: 'a', tools: ['search_transactions', 'get_cash_forecast'] });
    const res = await bfetch(base + '/api/mcp/client-tokens');
    const text = await res.text();
    expect(text).not.toContain(minted.body.token);
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain(sha256(minted.body.token));
    const list = JSON.parse(text).tokens;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: minted.body.meta.id, name: 'a', token_prefix: minted.body.token.slice(0, 12), revoked_at: null });
    expect(list[0].tools).toEqual(['get_cash_forecast', 'search_transactions']);
  });

  test('mint with categorize_transaction while auth is disabled → 400', async () => {
    const { base, db: sdb } = await start();
    const res = await mintViaRoute(base, { name: 'writer', tools: ['categorize_transaction'] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Enable dashboard auth');
    expect(count(sdb, 'mcp_client_tokens')).toBe(0);
    expect(count(sdb, 'mcp_grants')).toBe(0);
  });

  test('the mint rules in one place: unknown tool, tab-only tool, write tool without auth, viewer and write tool', () => {
    const tabOnly = { name: 'tab_probe', classification: 'read', transports: ['webmcp'], minRole: 'viewer' } as any;
    const lookup = (name: string) => (name === 'tab_probe' ? tabOnly : getToolDef(name));
    const owner = { role: 'admin' as const, authEnabled: true };

    expect(checkTokenTools(['search_transactions'], owner, lookup)).toBeNull();
    expect(checkTokenTools(['nope'], owner, lookup)).toMatchObject({ status: 400, code: 'unknown_tool' });
    const tab = checkTokenTools(['tab_probe'], owner, lookup)!;
    expect(tab).toMatchObject({ status: 400, code: 'invalid_args' });
    expect(tab.error).toContain('tab_probe');
    expect(tab.error).toContain('only works inside the dashboard tab');
    expect(checkTokenTools(['update_transaction'], { role: 'admin', authEnabled: false }, lookup)).toMatchObject({ status: 400 });
    expect(checkTokenTools(['update_transaction'], { role: 'viewer', authEnabled: true }, lookup)).toMatchObject({ status: 403, code: 'role_forbidden' });
    expect(checkTokenTools(['update_transaction'], owner, lookup)).toBeNull();
  });

  test('a viewer cannot mint a write tool, an admin with auth on can', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    await makeUser(sdb, 'viewer1', 'viewer');
    enableAuth(sdb);
    const viewerToken = (await verifyLogin(sdb, 'viewer1', 'password123'))!.token;
    const adminToken = (await verifyLogin(sdb, 'admin1', 'password123'))!.token;

    const refused = await mintViaRoute(base, { name: 'v', tools: ['categorize_transaction'] }, { Authorization: `Bearer ${viewerToken}` });
    expect(refused.status).toBe(403);
    const allowedRead = await mintViaRoute(base, { name: 'v', tools: ['search_transactions'] }, { Authorization: `Bearer ${viewerToken}` });
    expect(allowedRead.status).toBe(200);
    const allowedWrite = await mintViaRoute(base, { name: 'a', tools: ['categorize_transaction', 'get_operation_result'] }, { Authorization: `Bearer ${adminToken}` });
    expect(allowedWrite.status).toBe(200);
    expect((sdb.prepare('SELECT user_id FROM mcp_client_tokens WHERE id = @id').get({ id: allowedWrite.body.meta.id }) as any).user_id).toBe(admin.id);
  });

  test('the client-token routes need browser proof (no Origin → 403 origin_required)', async () => {
    const { base, db: sdb } = await start();
    const minted = await mintViaRoute(base, { name: 'a', tools: ['get_cash_forecast'] });
    const id = minted.body.meta.id;
    const noProof = (path: string, method: string, body?: unknown) =>
      fetch(base + path, { method, headers: JSON_HEADERS, body: body ? JSON.stringify(body) : undefined });

    for (const [path, method, body] of [
      ['/api/mcp/client-tokens', 'POST', { name: 'x', tools: ['get_cash_forecast'] }],
      [`/api/mcp/client-tokens/${id}`, 'DELETE', undefined],
      [`/api/mcp/client-tokens/${id}/rotate`, 'POST', undefined],
    ] as const) {
      const res = await noProof(path, method, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error.code).toBe('origin_required');
    }
    expect(count(sdb, 'mcp_client_tokens')).toBe(1);
    expect(count(sdb, 'mcp_client_tokens', 'revoked_at IS NOT NULL')).toBe(0);
  });

  test('minting is limited to 5 per hour per user', async () => {
    const { base, db: sdb } = await start();
    setLimiterFor(sdb, new RateLimiter());
    for (let i = 0; i < 5; i++) expect((await mintViaRoute(base, { name: `t${i}`, tools: ['get_cash_forecast'] })).status).toBe(200);
    const sixth = await bfetch(base + '/api/mcp/client-tokens', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 't6', tools: ['get_cash_forecast'] }) });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('Retry-After')).not.toBeNull();
  });
});

describe('/mcp authentication', () => {
  test('a minted token lists exactly its granted, http-mcp capable tools and can call a read tool', async () => {
    const { base, db: sdb } = await start();
    const { token } = mintTestToken(sdb, ['search_transactions', 'get_cash_forecast']);
    const client = await connect(base, token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['get_cash_forecast', 'search_transactions']);
    const result = await client.callTool({ name: 'search_transactions', arguments: { query: 'groceries' } });
    expect(JSON.parse((result.content as any)[0].text).total).toBe(2);
    await client.close();
  });

  test('a tab sessionGeneration as the bearer → 401 with the migration hint', async () => {
    const { base } = await start();
    const res = await rawInit(base, '10000000-0000-4000-8000-000000000099');
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('no longer accepts the tab session id');
    expect(body.error.message).toContain('Settings → Agent access → External MCP clients');
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  test('no bearer, and a wmcp_ token nobody minted, are 401 too', async () => {
    const { base } = await start();
    expect((await rawInit(base)).status).toBe(401);
    expect((await rawInit(base, 'wmcp_' + 'A'.repeat(43))).status).toBe(401);
  });

  test('revoked → zero tools, 401, and its grants are revoked', async () => {
    const { base, db: sdb } = await start();
    const minted = await mintViaRoute(base, { name: 'a', tools: ['search_transactions'] });
    const token: string = minted.body.token;
    expect((await rawInit(base, token)).status).toBe(200);

    const res = await bfetch(`${base}/api/mcp/client-tokens/${minted.body.meta.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).revoked).toBe(true);

    expect((await rawInit(base, token)).status).toBe(401);
    const listed = listClientTokens(sdb, { userId: null, role: 'admin', authEnabled: false });
    expect(listed[0].tools).toEqual([]);
    expect(listed[0].revoked_at).not.toBeNull();
    expect(count(sdb, 'mcp_grants', 'revoked_at IS NULL')).toBe(0);
    // Revoking a token that is already revoked, or does not exist, is a 404.
    const again = await bfetch(`${base}/api/mcp/client-tokens/${minted.body.meta.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  test('rotate: the old token is 401 at once, the new one works with the same tools', async () => {
    const { base, db: sdb } = await start();
    const minted = await mintViaRoute(base, { name: 'laptop', tools: ['search_transactions', 'get_cash_forecast'], expiresInDays: 90 });
    const oldToken: string = minted.body.token;

    const res = await bfetch(`${base}/api/mcp/client-tokens/${minted.body.meta.id}/rotate`, { method: 'POST' });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as any;
    expect(rotated.token).not.toBe(oldToken);
    expect(rotated.token.startsWith('wmcp_')).toBe(true);
    expect(rotated.meta.name).toBe('laptop');
    expect(rotated.meta.tools).toEqual(['get_cash_forecast', 'search_transactions']);

    expect((await rawInit(base, oldToken)).status).toBe(401);
    const client = await connect(base, rotated.token);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_cash_forecast', 'search_transactions']);
    await client.close();

    const newRow = sdb.prepare('SELECT rotated_from FROM mcp_client_tokens WHERE id = @id').get({ id: rotated.meta.id }) as { rotated_from: string };
    expect(newRow.rotated_from).toBe(minted.body.meta.id);
    expect((sdb.prepare('SELECT revoked_at FROM mcp_client_tokens WHERE id = @id').get({ id: minted.body.meta.id }) as any).revoked_at).not.toBeNull();
  });

  test('rotate re-applies the mint rules (auth turned off since the write token was minted → 400, old token kept)', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const minted = mintTestToken(sdb, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true });
    disableAuth(sdb);
    const out = rotateClientToken(sdb, minted.id, { userId: admin.id, role: 'admin', authEnabled: false }, 'test');
    expect(out && out.ok).toBe(false);
    expect((sdb.prepare('SELECT revoked_at FROM mcp_client_tokens WHERE id = @id').get({ id: minted.id }) as any).revoked_at).toBeNull();
  });

  test('D3: an http-mcp operation raised while auth was on is stale (auth_disabled) if auth is turned off before it is approved', async () => {
    const { db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const { token } = mintTestToken(sdb, ['update_transaction'], { userId: admin.id, authEnabled: true });
    const resolved = resolveClientToken(sdb, token, 'test')!;
    const txnId = firstTxnId(sdb);
    const before = (sdb.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string | null }).notes;
    const created = await callTool(sdb, resolved.scope, resolved.grantByTool.get('update_transaction')!, 'update_transaction', { id: txnId, notes: 'sneaky' }, 'http-mcp');
    expect(created.ok && created.kind === 'operation').toBe(true);
    const operationId = (created as any).operation.id as string;

    disableAuth(sdb);
    const outcome = approveWebMcpOperation(sdb, operationId, 'test');
    expect(outcome).toEqual({ outcome: 'stale', reason: 'auth_disabled' });
    const row = sdb.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id: operationId }) as { status: string };
    expect(row.status).toBe('stale');
    expect((sdb.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string | null }).notes).toBe(before);
  });

  test('D5: rotate is owner-only: an admin cannot mint a credential attributed to another user, but can still revoke', async () => {
    const { db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    const other = await makeUser(sdb, 'admin2', 'admin');
    enableAuth(sdb);
    const mine = mintTestToken(sdb, ['get_cash_forecast'], { userId: other.id, authEnabled: true, name: 'theirs' });
    const asAdmin = { userId: admin.id, role: 'admin' as const, authEnabled: true };
    expect(rotateClientToken(sdb, mine.id, asAdmin, 'test')).toBeNull();
    expect(count(sdb, 'mcp_client_tokens')).toBe(1);
    expect((sdb.prepare('SELECT revoked_at FROM mcp_client_tokens WHERE id = @id').get({ id: mine.id }) as any).revoked_at).toBeNull();
    // The owner can.
    const rotated = rotateClientToken(sdb, mine.id, { userId: other.id, role: 'admin', authEnabled: true }, 'test');
    expect(rotated && rotated.ok).toBe(true);
    // An admin can still revoke somebody else's token.
    const another = mintTestToken(sdb, ['get_cash_forecast'], { userId: other.id, authEnabled: true, name: 'again' });
    expect(revokeClientToken(sdb, another.id, asAdmin)).toBe(true);
  });

  test('D5: the rotate route answers 404 for an admin rotating another user\'s token', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    const other = await makeUser(sdb, 'admin2', 'admin');
    enableAuth(sdb);
    const human = (await verifyLogin(sdb, 'admin1', 'password123'))!.token;
    const theirs = mintTestToken(sdb, ['get_cash_forecast'], { userId: other.id, authEnabled: true });
    const res = await bfetch(`${base}/api/mcp/client-tokens/${theirs.id}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${human}` } });
    expect(res.status).toBe(404);
    expect(admin.id).not.toBe(other.id);
  });

  test('expired → 401', async () => {
    const { base, db: sdb } = await start();
    const { token } = mintTestToken(sdb, ['search_transactions']);
    expect((await rawInit(base, token)).status).toBe(200);
    sdb.prepare("UPDATE mcp_client_tokens SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await rawInit(base, token)).status).toBe(401);
  });

  test('a profile switch → 401: the token lives in the other profile database', async () => {
    const { base, db: sdb } = await start();
    const { token } = mintTestToken(sdb, ['search_transactions']);
    expect((await rawInit(base, token)).status).toBe(200);
    setInitialProfile('other-profile', createTestDb()); // the active profile (and its database) changes
    expect((await rawInit(base, token)).status).toBe(401);
  });

  test('a deactivated user → 401', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const { token } = mintTestToken(sdb, ['search_transactions'], { userId: admin.id, authEnabled: true });
    expect((await rawInit(base, token)).status).toBe(200);
    sdb.prepare('UPDATE dashboard_users SET is_active = 0 WHERE id = @id').run({ id: admin.id });
    expect((await rawInit(base, token)).status).toBe(401);
  });

  test('an ownerless token (minted with auth off) stops working once auth is enabled', async () => {
    const { base, db: sdb } = await start();
    const { token } = mintTestToken(sdb, ['search_transactions']);
    expect((await rawInit(base, token)).status).toBe(200);
    await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    expect((await rawInit(base, token)).status).toBe(401);
  });

  test('a demoted user loses the write tools from tools/list, and a write call is 403', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const { token, id } = mintTestToken(sdb, ['search_transactions', 'update_transaction'], { userId: admin.id, authEnabled: true });

    let client = await connect(base, token);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['search_transactions', 'update_transaction']);
    await client.close();

    sdb.prepare("UPDATE dashboard_users SET role = 'viewer' WHERE id = @id").run({ id: admin.id });
    client = await connect(base, token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['search_transactions']);
    // Reads keep working for the demoted user.
    const read = await client.callTool({ name: 'search_transactions', arguments: { query: 'groceries' } });
    expect(JSON.parse((read.content as any)[0].text).total).toBe(2);
    await client.close();

    // The engine refuses the write on its own, whatever the tool list showed.
    const resolved = resolveClientToken(sdb, token, 'test')!;
    expect(resolved.id).toBe(id);
    const grantId = resolved.grantByTool.get('update_transaction')!;
    const refused = await callTool(sdb, resolved.scope, grantId, 'update_transaction', { id: firstTxnId(sdb), notes: 'x' }, 'http-mcp');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(403);
    expect(count(sdb, 'mcp_operations')).toBe(0);
  });

  test('auth disabled after mint hides the write tools from tools/list and refuses them at call time', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const { token } = mintTestToken(sdb, ['search_transactions', 'update_transaction'], { userId: admin.id, authEnabled: true });
    disableAuth(sdb);

    const client = await connect(base, token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['search_transactions']);
    await client.close();

    const resolved = resolveClientToken(sdb, token, 'test')!;
    const refused = await callTool(sdb, resolved.scope, resolved.grantByTool.get('update_transaction')!, 'update_transaction', { id: firstTxnId(sdb), notes: 'x' }, 'http-mcp');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(403);
    expect(count(sdb, 'mcp_operations')).toBe(0);
  });

  test('tools/list excludes a tool without http-mcp in its transports, a stale digest, and admin tools for a viewer', () => {
    const mk = (name: string, over: Record<string, unknown>) => ({ name, classification: 'read', minRole: 'viewer', transports: ['webmcp', 'http-mcp'], ...over }) as any;
    const catalog = [
      mk('both', {}),
      mk('tab_only', { transports: ['webmcp'] }),
      mk('stale', {}),
      mk('writer', { classification: 'mutating', minRole: 'admin' }),
      mk('admin_read', { minRole: 'admin' }),
    ];
    const grants = ['both', 'tab_only', 'stale', 'writer', 'admin_read'].map((tool_name) => ({ tool_name, schema_digest: tool_name === 'stale' ? 'old' : 'ok' })) as any;
    const names = (ctx: { authEnabled: boolean; liveRole: 'admin' | 'viewer' }) => visibleToolDefs(catalog, grants, ctx, () => 'ok').map((d) => d.name);

    expect(names({ authEnabled: true, liveRole: 'admin' })).toEqual(['both', 'writer', 'admin_read']);
    expect(names({ authEnabled: false, liveRole: 'admin' })).toEqual(['both', 'admin_read']);
    expect(names({ authEnabled: true, liveRole: 'viewer' })).toEqual(['both']);
  });

  test('a valid token still works while the invalid-bearer bucket is exhausted', async () => {
    const { base, db: sdb } = await start();
    setLimiterFor(sdb, new RateLimiter());
    const { token } = mintTestToken(sdb, ['search_transactions']);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await rawInit(base, `wmcp_${'B'.repeat(42)}${i % 10}`)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);

    const client = await connect(base, token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['search_transactions']);
    await client.close();
  });

  test('a token touches last_used_at at most once per 60 seconds', async () => {
    const { db: sdb } = await start();
    const { token, id } = mintTestToken(sdb, ['search_transactions']);
    const last = () => (sdb.prepare('SELECT last_used_at FROM mcp_client_tokens WHERE id = @id').get({ id }) as { last_used_at: string | null }).last_used_at;
    expect(last()).toBeNull();
    resolveClientToken(sdb, token, 'test');
    const first = last();
    expect(first).not.toBeNull();
    sdb.prepare('UPDATE mcp_client_tokens SET last_used_at = @v WHERE id = @id').run({ id, v: '2000-01-01T00:00:00.000Z' });
    // Within a minute of the recorded use: untouched.
    sdb.prepare('UPDATE mcp_client_tokens SET last_used_at = @v WHERE id = @id').run({ id, v: new Date(Date.now() - 5_000).toISOString() });
    const recent = last();
    resolveClientToken(sdb, token, 'test');
    expect(last()).toBe(recent);
    // Older than a minute: refreshed.
    sdb.prepare('UPDATE mcp_client_tokens SET last_used_at = @v WHERE id = @id').run({ id, v: new Date(Date.now() - 120_000).toISOString() });
    resolveClientToken(sdb, token, 'test');
    expect(new Date(last()!).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe('get_operation_result', () => {
  function setup() {
    const sdb = createTestDb();
    seedTestData(sdb);
    return sdb;
  }

  test('is a read tool offered on /mcp only', () => {
    const def = getToolDef('get_operation_result')!;
    expect(def.classification).toBe('read');
    expect([...def.transports]).toEqual(['http-mcp']);
    expect(MCP_TOOL_CATALOG.filter((d) => !d.transports.includes('webmcp')).map((d) => d.name)).toEqual(['get_operation_result']);
    expect(schemaDigest('get_operation_result')).not.toBe('');
  });

  test('returns the outcome of an operation this token created, and 404 for anyone else', async () => {
    const sdb = setup();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const a = mintTestToken(sdb, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true, name: 'A' });
    const b = mintTestToken(sdb, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true, name: 'B' });
    const ra = resolveClientToken(sdb, a.token, 'test')!;
    const rb = resolveClientToken(sdb, b.token, 'test')!;

    const txnId = firstTxnId(sdb);
    const created = await callTool(sdb, ra.scope, ra.grantByTool.get('update_transaction')!, 'update_transaction', { id: txnId, notes: 'from A' }, 'http-mcp');
    expect(created.ok && created.kind === 'operation').toBe(true);
    const operationId = (created as any).operation.id as string;

    const fetchResult = (r: typeof ra, id: string) =>
      callTool(sdb, r.scope, r.grantByTool.get('get_operation_result')!, 'get_operation_result', { operationId: id }, 'http-mcp');

    const pending = await fetchResult(ra, operationId);
    expect(pending.ok && pending.kind === 'read' && (pending.data as any).outcome).toBe('pending');

    const other = await fetchResult(rb, operationId);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(404);
    const missing = await fetchResult(ra, '00000000-0000-4000-8000-000000000000');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    expect(approveWebMcpOperation(sdb, operationId, 'test').outcome).toBe('committed');
    const done = await fetchResult(ra, operationId);
    expect(done.ok && done.kind === 'read').toBe(true);
    const data = (done as any).data;
    expect(data.outcome).toBe('committed');
    expect(data.operationId).toBe(operationId);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(1500);
  });

  test('is not reachable from a browser tab (/api/mcp/call is the webmcp transport)', async () => {
    const sdb = setup();
    const result = await callTool(sdb, { role: 'admin', userId: null, profile: 'test', origin: 'http://localhost:3141', sessionGeneration: crypto.randomUUID() }, 'x', 'get_operation_result', { operationId: crypto.randomUUID() }, 'imperative');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

describe('token audit and operation labels', () => {
  test('a /mcp read is audited as principal_kind client_token with the token id, never the secret', async () => {
    const { base, db: sdb } = await start();
    const { token, id } = mintTestToken(sdb, ['search_transactions']);
    const client = await connect(base, token);
    await client.callTool({ name: 'search_transactions', arguments: { query: 'groceries' } });
    await client.close();
    const row = sdb.prepare("SELECT principal_kind, principal_id, transport FROM mcp_audit_log WHERE decision = 'allowed'").get() as any;
    expect(row).toEqual({ principal_kind: 'client_token', principal_id: id, transport: 'http-mcp' });
    expect(JSON.stringify(sdb.prepare('SELECT * FROM mcp_audit_log').all())).not.toContain(token);
  });

  test('an operation raised by a token is labelled with the token name for the human', async () => {
    const { base, db: sdb } = await start();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    enableAuth(sdb);
    const humanToken = (await verifyLogin(sdb, 'admin1', 'password123'))!.token;
    const { token } = mintTestToken(sdb, ['update_transaction'], { userId: admin.id, authEnabled: true, name: 'Hronaut laptop' });
    const resolved = resolveClientToken(sdb, token, 'test')!;
    await callTool(sdb, resolved.scope, resolved.grantByTool.get('update_transaction')!, 'update_transaction', { id: firstTxnId(sdb), notes: 'x' }, 'http-mcp');

    const res = await bfetch(base + '/api/mcp/operations', { headers: { Authorization: `Bearer ${humanToken}`, 'X-Wilson-Agent-Session': crypto.randomUUID() } });
    const ops = ((await res.json()) as any).operations;
    expect(ops).toHaveLength(1);
    expect(ops[0].requestedBy.kind).toBe('external_client');
    expect(ops[0].requestedBy.label).toContain('Hronaut laptop');
    expect(JSON.stringify(ops)).not.toContain('tok:');
  });
});

describe('mint rules in the module', () => {
  test('mintClientToken refuses an empty tool list and a hidden-character name', () => {
    const sdb = createTestDb();
    const owner = { userId: null, role: 'admin' as const, profile: 'test', authEnabled: false };
    expect(mintClientToken(sdb, owner, { name: 'x', tools: [] })).toMatchObject({ ok: false, status: 400 });
    expect(mintClientToken(sdb, owner, { name: 'bad‮name', tools: ['get_cash_forecast'] })).toMatchObject({ ok: false, status: 400 });
    expect(mintClientToken(sdb, owner, { name: '   ', tools: ['get_cash_forecast'] })).toMatchObject({ ok: false, status: 400 });
  });

  test('a viewer lists and revokes only their own tokens; an admin sees all', async () => {
    const sdb = createTestDb();
    const admin = await makeUser(sdb, 'admin1', 'admin');
    const viewer = await makeUser(sdb, 'viewer1', 'viewer');
    enableAuth(sdb);
    const a = mintTestToken(sdb, ['get_cash_forecast'], { userId: admin.id, authEnabled: true, name: 'admin token' });
    mintTestToken(sdb, ['get_cash_forecast'], { userId: viewer.id, role: 'viewer', authEnabled: true, name: 'viewer token' });

    const asViewer = { userId: viewer.id, role: 'viewer' as const, authEnabled: true };
    const asAdmin = { userId: admin.id, role: 'admin' as const, authEnabled: true };
    expect(listClientTokens(sdb, asViewer).map((t) => t.name)).toEqual(['viewer token']);
    expect(listClientTokens(sdb, asAdmin).map((t) => t.name).sort()).toEqual(['admin token', 'viewer token']);
    expect(revokeClientToken(sdb, a.id, asViewer)).toBe(false);
    expect(revokeClientToken(sdb, a.id, asAdmin)).toBe(true);
  });
});

describe('P1: change a token\'s tools', () => {
  async function adminWithAuth() {
    const d = createTestDb();
    seedTestData(d);
    const admin = await makeUser(d, 'admin1', 'admin');
    enableAuth(d);
    return { d, admin };
  }

  test('re-issues the grant set: the new list replaces the old, the token and its expiry stay', async () => {
    const { updateClientTokenTools } = await import('../mcp/client-tokens.js');
    const { d, admin } = await adminWithAuth();
    const { id, token } = mintTestToken(d, ['search_transactions'], { userId: admin.id, authEnabled: true });
    const before = listClientTokens(d, { userId: admin.id, role: 'admin', authEnabled: true })[0];
    const out = updateClientTokenTools(d, id, { userId: admin.id, role: 'admin', authEnabled: true }, ['get_cash_forecast', 'update_transaction', 'get_operation_result'], 'test');
    expect(out && out.ok).toBe(true);
    const after = listClientTokens(d, { userId: admin.id, role: 'admin', authEnabled: true })[0];
    expect(after.tools.sort()).toEqual(['get_cash_forecast', 'get_operation_result', 'update_transaction']);
    expect(after.expires_at).toBe(before.expires_at);
    const resolved = resolveClientToken(d, token, 'test')!;
    expect(resolved.grantByTool.has('search_transactions')).toBe(false);
    expect(resolved.grantByTool.has('get_cash_forecast')).toBe(true);
  });

  test('the mint rules apply again: a write tool with auth off is refused and the old set is kept', async () => {
    const { updateClientTokenTools } = await import('../mcp/client-tokens.js');
    const d = createTestDb();
    const { id } = mintTestToken(d, ['search_transactions']);
    const out = updateClientTokenTools(d, id, { userId: null, role: 'admin', authEnabled: false }, ['update_transaction'], 'test');
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(listClientTokens(d, { userId: null, role: 'admin', authEnabled: false })[0].tools).toEqual(['search_transactions']);
  });

  test('a tool whose policy is Off cannot be added; a revoked token and a stranger get null', async () => {
    const { updateClientTokenTools } = await import('../mcp/client-tokens.js');
    const { setPolicy } = await import('../mcp/policies.js');
    const { d, admin } = await adminWithAuth();
    const other = await makeUser(d, 'viewer1', 'viewer');
    const { id } = mintTestToken(d, ['search_transactions'], { userId: admin.id, authEnabled: true });
    setPolicy(d, { userId: admin.id, role: 'admin', authEnabled: true }, 'get_cash_forecast', 'off');
    expect(updateClientTokenTools(d, id, { userId: admin.id, role: 'admin', authEnabled: true }, ['get_cash_forecast'], 'test')).toMatchObject({ ok: false, status: 400 });
    expect(updateClientTokenTools(d, id, { userId: other.id, role: 'viewer', authEnabled: true }, ['search_transactions'], 'test')).toBeNull();
    revokeClientToken(d, id, { userId: admin.id, role: 'admin', authEnabled: true });
    expect(updateClientTokenTools(d, id, { userId: admin.id, role: 'admin', authEnabled: true }, ['search_transactions'], 'test')).toBeNull();
  });

  test('minting a token with a tool whose policy is Off is refused (Off means not grantable, for clients too)', async () => {
    const { setPolicy } = await import('../mcp/policies.js');
    const d = createTestDb();
    setPolicy(d, { userId: null, role: 'admin', authEnabled: false }, 'get_cash_forecast', 'off');
    const out = mintClientToken(d, { userId: null, role: 'admin', profile: 'test', authEnabled: false }, { name: 'x', tools: ['get_cash_forecast'] });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(count(d, 'mcp_client_tokens')).toBe(0);
  });

  test('PUT /api/mcp/client-tokens/:id/tools: browser proof required; owner changes the set', async () => {
    const { d, admin } = await adminWithAuth();
    setInitialProfile('test', d);
    const { server } = await startDashboardServer(d, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const bearer = (await verifyLogin(d, 'admin1', 'password123'))!.token;
    const { id } = mintTestToken(d, ['search_transactions'], { userId: admin.id, authEnabled: true });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
    const body = JSON.stringify({ tools: ['get_cash_forecast'] });
    expect((await fetch(`${base}/api/mcp/client-tokens/${id}/tools`, { method: 'PUT', headers, body })).status).toBe(403);
    const ok = await bfetch(`${base}/api/mcp/client-tokens/${id}/tools`, { method: 'PUT', headers, body });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).meta.tools).toEqual(['get_cash_forecast']);
  });
});
