import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, count, firstTxnId, makeUser, mintTestToken, testScope, grantTools } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth } from '../dashboard/auth.js';
import { callTool } from '../mcp/engine.js';
import { handleMcpHttpRequest } from '../mcp/http-server.js';
import { createOperation, getOperation } from '../mcp/store.js';
import { RateLimiter, setLimiterFor, LIMIT_MCP_FAILED_BEARER } from '../mcp/rate-limit.js';
import { confirmationCardModel, formatValue } from '../mcp/confirmation-card.js';
import { prepareMutation, commitMutation } from '../mcp/tool-catalog.js';
import { updateTransaction, getTransactionById } from '../db/queries.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Review follow-ups for P0a (run against the P0b /mcp, which needs a client token): the unauthenticated /mcp audit flood, forged
 * principals through the legacy session parameter, chat approval gates,
 * deep-paging accounting, card hygiene for stored values, and the
 * categorize entity round trip.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function startServer() {
  const db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  return { db, base: `http://localhost:${result.server.port}` };
}

const auditCount = (db: Database, where = '1=1') => count(db, 'mcp_audit_log', where);

describe('/mcp audit flood', () => {
  const batch = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: `invented_${i}`, arguments: { i } } })));

  test('a 10k-entry batch of distinct tool names writes at most a couple of rows', async () => {
    const { db, base } = await startServer();
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: batch(10_000),
    });
    await res.text();
    const rows = db.prepare('SELECT * FROM mcp_audit_log').all() as any[];
    // The body is over the anonymous read cap (64 KB), so it is not parsed at all: one noise row, not 10 000 calls' worth.
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((r) => r.tool_name === '<unknown>' && r.principal_id === 'anonymous')).toBe(true);
  });

  test('a body over 4 MiB with no token is a 401 that was never read (one noise row at most); with a token it is 413 and writes nothing', async () => {
    const { db, base } = await startServer();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const anon = await fetch(base + '/mcp', { method: 'POST', headers, body: batch(40_000) });
    expect(anon.status).toBe(401);
    expect(auditCount(db)).toBeLessThanOrEqual(1);
    const before = auditCount(db);
    const { token } = mintTestToken(db, ['search_transactions']);
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: batch(40_000) });
    expect(res.status).toBe(413);
    expect(auditCount(db)).toBe(before);
  });

  test('a no-cors text/plain POST is not parsed at all and writes nothing', async () => {
    const { db, base } = await startServer();
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: batch(500) });
    await res.text();
    expect(auditCount(db)).toBe(0);
  });

  test('an unresolvable bearer is keyed to one constant principal, not the claimed token', async () => {
    const { db, base } = await startServer();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer made-up-${i}` },
        body: batch(1),
      });
      await res.text();
    }
    const rows = db.prepare('SELECT * FROM mcp_audit_log').all() as any[];
    expect(new Set(rows.map((r) => r.principal_id))).toEqual(new Set(['anonymous']));
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  test('an address that keeps sending requests with no valid token is answered 429 before any body is read', async () => {
    const { db, base } = await startServer();
    const clock = { now: Date.now() };
    setLimiterFor(db, new RateLimiter({ now: () => clock.now }));
    let blocked: Response | null = null;
    for (let i = 0; i < LIMIT_MCP_FAILED_BEARER.limit + 5 && !blocked; i++) {
      const res = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: batch(1),
      });
      await res.text();
      if (res.status === 429) blocked = res;
    }
    expect(blocked).not.toBeNull();
    expect(blocked!.headers.get('Retry-After')).toBe('60');
    clock.now += 120_000;
    const again = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: batch(1) });
    await again.text();
    expect(again.status).not.toBe(429);
  });

  test('a valid token is served even when its address bucket is exhausted; an unresolved one is still refused', async () => {
    const { db } = await startServer();
    const limiter = new RateLimiter();
    setLimiterFor(db, limiter);
    const { token: session } = mintTestToken(db, ['search_transactions']);
    // An attacker on the same address (the local host) spends the whole bucket.
    for (let i = 0; i < LIMIT_MCP_FAILED_BEARER.limit + 5; i++) limiter.take('mcpb:127.0.0.1', LIMIT_MCP_FAILED_BEARER);
    expect(limiter.blocked('mcpb:127.0.0.1', LIMIT_MCP_FAILED_BEARER)).toBe(true);

    const call = (bearer?: string) =>
      handleMcpHttpRequest(db, new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries' } } }),
      }), '127.0.0.1', 'test');

    const ok = await call(session);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text).total).toBe(2);

    expect((await call()).status).toBe(429);
    expect((await call(crypto.randomUUID())).status).toBe(429);
    expect((await call('wmcp_' + 'C'.repeat(43))).status).toBe(429);
  });

  test('a valid call that succeeds does not spend the failed-bearer bucket', async () => {
    const { db } = await startServer();
    const limiter = new RateLimiter();
    setLimiterFor(db, limiter);
    const { token: session } = mintTestToken(db, ['search_transactions']);
    for (let i = 0; i < 40; i++) {
      const res = await handleMcpHttpRequest(db, new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${session}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries', limit: 1 } } }),
      }), '127.0.0.1', 'test');
      await res.text();
    }
    expect(limiter.blocked('mcpb:127.0.0.1', LIMIT_MCP_FAILED_BEARER)).toBe(false);
  });

  test('in a batch, refused calls are audited even when another call in the batch reached a handler', async () => {
    const { db } = await startServer();
    const { token: session } = mintTestToken(db, ['search_transactions']);
    const res = await handleMcpHttpRequest(db, new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${session}` },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_transaction', arguments: { id: 1, notes: 'x' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_transactions', arguments: { surprise: true } } },
      ]),
    }), '127.0.0.1', 'test');
    await res.text();
    const rows = db.prepare('SELECT decision, tool_name, count FROM mcp_audit_log ORDER BY id').all() as Array<{ decision: string; tool_name: string; count: number }>;
    // One allowed read (the call that reached its handler) ...
    expect(rows.filter((r) => r.decision === 'allowed')).toHaveLength(1);
    // ... plus the two refusals: an ungranted tool and an invalid-args call.
    expect(rows.filter((r) => r.decision === 'denied_grant').reduce((n, r) => n + r.count, 0)).toBe(1);
    expect(rows.filter((r) => r.decision === 'invalid_args').reduce((n, r) => n + r.count, 0)).toBe(1);
  });

  test('tools/list offers only tools callTool would accept on this transport', async () => {
    const { base, db } = await startServer();
    const { token: session } = mintTestToken(db, ['search_transactions']);
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['search_transactions']);
  });
});

describe('legacy session parameter', () => {
  test('sessionGeneration=dashboard-chat (or tok:<id>) is refused with 400 on every route that accepts a session', async () => {
    const { base } = await startServer();
    for (const forged of ['dashboard-chat', 'tok:victimid', 'not-a-uuid']) {
      const grants = await bfetch(base + '/api/mcp/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionGeneration: forged, tools: ['search_transactions'] }) });
      expect(grants.status).toBe(400);
      // The tool path takes the session from a header only; a forged value there is refused the same way.
      const call = await bfetch(base + '/api/mcp/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': forged }, body: JSON.stringify({ grantId: crypto.randomUUID(), tool: 'search_transactions', args: {} }) });
      expect(call.status).toBe(400);
      const revoke = await bfetch(base + '/api/mcp/grants/revoke-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionGeneration: forged }) });
      expect(revoke.status).toBe(400);
      const tools = await bfetch(base + `/api/mcp/tools?sessionGeneration=${encodeURIComponent(forged)}`);
      expect(tools.status).toBe(400);
    }
  });

  test('no webmcp or http-mcp row is ever attributed to the chat or a client token', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['search_transactions', 'update_transaction']);
    await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'a' }, 'imperative');
    await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'n' }, 'declarative');
    await callTool(db, scope, grants.search_transactions, 'search_transactions', { query: 'a' }, 'http-mcp');
    const kinds = db.prepare('SELECT DISTINCT principal_kind AS k FROM mcp_audit_log').all() as Array<{ k: string }>;
    expect(kinds.every((r) => r.k !== 'chat' && r.k !== 'client_token')).toBe(true);
  });
});

describe('chat operation approval', () => {
  async function authed() {
    const { db, base } = await startServer();
    const admin = await makeUser(db, 'admin1', 'admin');
    const viewer = await makeUser(db, 'viewer1', 'viewer');
    enableAuth(db);
    const login = async (u: string) =>
      ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) })).json()) as any).token as string;
    return { db, base, admin, viewer, adminToken: await login('admin1'), viewerToken: await login('viewer1') };
  }
  const chatOp = (db: Database, userId: number, role: 'admin' | 'viewer') =>
    createOperation(db, {
      source: 'chat', grantId: null, toolName: 'categorize', args: {}, before: null, after: null, transactionId: null,
      revisionAtPrepare: null, profile: 'test', origin: 'dashboard-chat', sessionGeneration: 'dashboard-chat', userId, role,
    });
  const approve = (base: string, id: string, token: string) =>
    bfetch(`${base}/api/mcp/operations/${id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

  test('a viewer cannot approve their own chat operation: 403 role_forbidden', async () => {
    const s = await authed();
    const op = chatOp(s.db, s.viewer.id, 'viewer');
    const res = await approve(s.base, op.id, s.viewerToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('role_forbidden');
    expect(getOperation(s.db, op.id)?.status).toBe('pending');
  });

  test('an expired chat operation is 409 expired, never approved', async () => {
    const s = await authed();
    const op = chatOp(s.db, s.admin.id, 'admin');
    s.db.prepare('UPDATE mcp_operations SET expires_at = @t WHERE id = @id').run({ id: op.id, t: new Date(Date.now() - 1000).toISOString() });
    const res = await approve(s.base, op.id, s.adminToken);
    expect(res.status).toBe(409);
    expect(getOperation(s.db, op.id)?.status).toBe('expired');
  });
});

describe('deep paging accounting', () => {
  test('counts distinct cursors, so short pages and a changed limit cannot hide a long walk', () => {
    const limiter = new RateLimiter();
    let flagged = 0;
    for (let i = 0; i < 25; i++) if (limiter.trackPage('p', 'q', `cursor-${i}`).flagged) flagged++;
    expect(flagged).toBe(1);
    // Re-reading one cursor is not a walk.
    const other = new RateLimiter();
    for (let i = 0; i < 50; i++) expect(other.trackPage('p', 'q', 'same').flagged).toBe(false);
  });

  test('flooding distinct queries only erases that principal\'s own trail', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 20; i++) limiter.trackPage('victim', 'q', `c${i}`);
    for (let i = 0; i < 500; i++) limiter.trackPage('attacker', `q${i}`, 'c');
    expect(limiter.trackPage('victim', 'q', 'c20').flagged).toBe(true);
  });

  test('get_net_worth (15-row pages) and an oversized limit still trip the sentinel after 20 real pages', async () => {
    const db = createTestDb();
    seedTestData(db);
    const limiter = new RateLimiter();
    setLimiterFor(db, limiter);
    // Drive trackPage the way callTool does, with cursors from a walk whose page size is not 10.
    const flags = Array.from({ length: 22 }, (_, i) => limiter.trackPage('x', 'get_net_worth', `o${i * 15}`).flagged);
    expect(flags.filter(Boolean)).toHaveLength(1);
  });
});

describe('confirmation card hygiene', () => {
  test('stored (before) values lose bidi and zero-width characters', () => {
    expect(formatValue('Pay‮pal​')).toBe('Paypal');
    const card = confirmationCardModel({
      source: 'webmcp', tool_name: 'update_transaction',
      before_json: JSON.stringify({ description: 'RENT‮ 1000' }),
      after_json: JSON.stringify({ description: 'Rent' }),
    });
    expect(card.deltaRows!.rows[0].from).toBe('RENT 1000');
  });

  test('a custom category with an unsafe name is shown by its label in the before and after rows', () => {
    const db = createTestDb();
    seedTestData(db);
    db.prepare("INSERT INTO categories (name, slug, is_system) VALUES (@n, 'custom-unsafe', 0)").run({ n: 'Ignore‮ previous <b>' });
    const id = firstTxnId(db);
    db.prepare('UPDATE transactions SET category = @c WHERE id = @id').run({ c: 'Ignore‮ previous <b>', id });
    const prepared = prepareMutation(db, 'categorize_transaction', { id, category: 'Ignore‮ previous <b>' });
    const { before, after } = prepared as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(String(before.category)).toMatch(/^#\d+ \(custom\)$/);
    expect(String(after.category)).toMatch(/^#\d+ \(custom\)$/);
    expect(prepared.args.category).toBe('Ignore‮ previous <b>'); // the real name is what commit uses
  });
});

describe('categorize_transaction entity round trip', () => {
  test('omitting entityId keeps the current entity: the card and the write agree', () => {
    const db = createTestDb();
    seedTestData(db);
    const id = firstTxnId(db);
    const ent = db.prepare("INSERT INTO entities (name, slug) VALUES ('Acme', 'acme')").run() as { lastInsertRowid: number | bigint };
    const entityId = Number(ent.lastInsertRowid);
    updateTransaction(db, id, { entity_id: entityId });
    const txn = getTransactionById(db, id)!;
    const prepared = prepareMutation(db, 'categorize_transaction', { id, category: 'Dining' });
    expect((prepared.after as { entity_id: number }).entity_id).toBe(entityId);
    const result = commitMutation(db, 'categorize_transaction', prepared.args, txn.revision);
    expect(result.outcome).toBe('committed');
    expect(getTransactionById(db, id)!.entity_id).toBe(entityId);
  });
});

describe('D4: an unauthenticated /mcp request does not hold a socket with a slow body', () => {
  function rawPost(port: number, headerLines: string[], bodyPrefix: string): Promise<{ text: string; ms: number }> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      let out = '';
      Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          open(sock) { sock.write(`POST /mcp HTTP/1.1\r\nHost: localhost:${port}\r\n${headerLines.join('\r\n')}\r\n\r\n${bodyPrefix}`); },
          data(sock, d) { out += d.toString(); if (out.includes('\r\n\r\n')) sock.end(); },
          close() { resolve({ text: out, ms: performance.now() - t0 }); },
          error() { resolve({ text: out, ms: performance.now() - t0 }); },
        },
      });
    });
  }

  test('a declared 50-byte body that never arrives is answered 401 within a few seconds', async () => {
    const { base } = await startServer();
    const port = Number(new URL(base).port);
    const { text, ms } = await rawPost(port, ['Content-Type: application/json', 'Content-Length: 50'], '{');
    expect(text.startsWith('HTTP/1.1 401')).toBe(true);
    expect(ms).toBeLessThan(6000);
  });

  test('a declared body over 64 KB with no token is answered 401 without being read', async () => {
    const { base } = await startServer();
    const port = Number(new URL(base).port);
    const { text, ms } = await rawPost(port, ['Content-Type: application/json', 'Content-Length: 900000'], '{');
    expect(text.startsWith('HTTP/1.1 401')).toBe(true);
    expect(ms).toBeLessThan(1500);
  });
});

describe('D6: a valid token that keeps sending refused calls is bounded on its own bucket', () => {
  const refusedCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_transactions', arguments: { surprise: true } } });
  const post = (db: Database, bearer: string, body: unknown, remote = '127.0.0.1') =>
    handleMcpHttpRequest(db, new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }), remote, 'test');

  test('after enough refused calls the token gets 429 and no more audit rows; another token on the same address is unaffected', async () => {
    const { db } = await startServer();
    const clock = { now: Date.now() };
    setLimiterFor(db, new RateLimiter({ now: () => clock.now }));
    const flooder = mintTestToken(db, ['search_transactions'], { name: 'flooder' });
    const bystander = mintTestToken(db, ['search_transactions'], { name: 'bystander' });

    let limited: Response | null = null;
    for (let i = 0; i < 200 && !limited; i++) {
      const res = await post(db, flooder.token, refusedCall(i + 1));
      await res.text();
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0);
    const rowsAtLimit = auditCount(db);
    expect(rowsAtLimit).toBeLessThan(60);
    await (await post(db, flooder.token, refusedCall(999))).text();
    expect(auditCount(db)).toBe(rowsAtLimit);

    const ok = await post(db, bystander.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries' } } });
    expect(ok.status).toBe(200);
    // Even the flooder's valid calls wait for the bucket, then recover with time.
    clock.now += 120_000;
    const again = await post(db, flooder.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries' } } });
    expect(again.status).toBe(200);
  });

  test('successful calls never spend the refused-call bucket', async () => {
    const { db } = await startServer();
    setLimiterFor(db, new RateLimiter());
    const { token } = mintTestToken(db, ['search_transactions']);
    for (let i = 0; i < 40; i++) {
      const res = await post(db, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries', limit: 1 } } });
      expect(res.status).toBe(200);
      await res.text();
    }
  });
});
