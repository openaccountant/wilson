import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { bfetch } from './mcp-helpers.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Integration coverage for the acceptance matrix from GitHub issue #50:
 * two tabs with different grants, viewer vs admin, profile switch mid-
 * approval, stale revision, duplicate commit, revoke-before-commit,
 * foreign origin, and reconciliation after a dropped response. Each case
 * proves no old grant or approval becomes valid in a new context.
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
  return { db, base: `http://localhost:${result.server.port}`, port: result.server.port };
}

/** The dashboard page's request: allowlisted Origin and `Sec-Fetch-Site: same-origin` (what P0b requires of grant and approval routes). */
async function j(base: string, path: string, init?: RequestInit) {
  const res = await bfetch(base + path, init);
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: body as any, headers: res.headers };
}

function firstTransactionId(database: Database): number {
  return (database.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number }).id;
}

describe('WebMCP bridge acceptance matrix', () => {
  test('zero grants means zero exposed tools', async () => {
    const { base } = await start();
    const res = await j(base, '/api/mcp/tools?sessionGeneration=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(res.body.tools).toEqual([]);
  });

  test('two tabs get independent grants (different sessionGeneration)', async () => {
    const { base } = await start();
    await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', tools: ['transaction_search'] }),
    });

    const tabATools = await j(base, '/api/mcp/tools?sessionGeneration=cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const tabBTools = await j(base, '/api/mcp/tools?sessionGeneration=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(tabATools.body.tools.map((t: any) => t.name)).toEqual(['transaction_search']);
    expect(tabBTools.body.tools).toEqual([]);
  });

  test('viewer role is blocked from granting a mutating tool', async () => {
    const { base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    await createUser(db, 'viewer1', 'password123', 'viewer');
    const adminLogin = await j(base, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin1', password: 'password123' }),
    });
    await j(base, '/api/auth/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminLogin.body.token}` },
      body: JSON.stringify({ auth_enabled: true }),
    });
    const viewerLogin = await j(base, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer1', password: 'password123' }),
    });

    const grantAttempt = await j(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerLogin.body.token}` },
      body: JSON.stringify({ sessionGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tools: ['edit_transaction'] }),
    });
    expect(grantAttempt.status).toBe(403);

    const readGrant = await j(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerLogin.body.token}` },
      body: JSON.stringify({ sessionGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tools: ['transaction_search'] }),
    });
    expect(readGrant.status).toBe(200);
  });

  test('admin can grant and use a mutating tool end to end (prepare -> approve -> committed)', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'confirmed via test' } });
    expect(prepared.body.operation.status).toBe('pending');
    // The AGENT's copy carries no row text: no before/after delta and no summary.
    expect(prepared.body.operation.before_json).toBeUndefined();
    expect(prepared.body.operation.after_json).toBeUndefined();
    expect(prepared.body.operation.summary).toBeUndefined();
    // The human's card (the operations route) keeps the server-computed summary
    // and delta — semantic context, not just a field delta.
    const card = await j(base, `/api/mcp/operations/${prepared.body.operation.id}`);
    expect(card.body.operation.before_json).toContain('null');
    expect(card.body.operation.after_json).toContain('confirmed via test');
    expect(typeof card.body.operation.summary).toBe('string');
    expect(card.body.operation.summary).toContain(`#${txnId}`);

    const approved = await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('committed');

    const txn = db.prepare('SELECT notes, revision FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string; revision: number };
    expect(txn.notes).toBe('confirmed via test');
    expect(txn.revision).toBe(2);
  });

  test('stale revision: a row changed after prepare cannot be committed', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'first' } });

    // Someone else (or the plain REST edit route) changes the row in between.
    db.prepare("UPDATE transactions SET revision = revision + 1 WHERE id = @id").run({ id: txnId });

    const approved = await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('stale');
  });

  test('duplicate commit attempt: approving twice never applies the mutation twice', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'once' } });
    const opId = prepared.body.operation.id;

    const first = await j(base, `/api/mcp/operations/${opId}/approve`, { method: 'POST' });
    const second = await j(base, `/api/mcp/operations/${opId}/approve`, { method: 'POST' });
    expect(first.body.outcome).toBe('committed');
    expect(second.body.outcome).toBe('committed'); // idempotent readback, not a replay

    const txn = db.prepare('SELECT revision FROM transactions WHERE id = @id').get({ id: txnId }) as { revision: number };
    expect(txn.revision).toBe(2); // bumped exactly once
  });

  test('revoke-before-commit: revoking the grant after prepare blocks the later approval', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'should not land' } });

    await j(base, `/api/mcp/grants/${grantId}`, { method: 'DELETE' });

    const approved = await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('stale');

    const txn = db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string | null };
    expect(txn.notes).not.toBe('should not land');
  });

  test('profile switch while an approval is pending invalidates it', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'pre-switch' } });

    // Switch the active profile out from under the pending approval.
    setInitialProfile('a-different-profile', db);

    const approved = await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('stale');
  });

  test('foreign origin cannot use a grant bound to this origin', async () => {
    const { base, port } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['transaction_search'] }),
    });
    const grantId = grantRes.body.grants[0].id;

    const foreignRead = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'transaction_search', args: { query: 'groceries' } }, { Origin: 'http://evil.example' });
    expect(foreignRead.status).toBe(403);

    const sameOriginRead = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'transaction_search', args: { query: 'groceries' } }, { Origin: `http://localhost:${port}` });
    expect(sameOriginRead.status).toBe(200);
  });

  test('no route reflects a foreign Origin, and there is no wildcard anywhere', async () => {
    const { base, port } = await start();
    const mcpRes = await j(base, '/api/mcp/catalog', { headers: { Origin: 'http://evil.example' } });
    expect(mcpRes.headers.get('access-control-allow-origin')).toBeNull();

    const ordinaryRes = await j(base, '/api/summary', { headers: { Origin: 'http://evil.example' } });
    expect(ordinaryRes.headers.get('access-control-allow-origin')).toBeNull();

    const sameOriginMcp = await j(base, '/api/mcp/catalog', { headers: { Origin: `http://localhost:${port}` } });
    expect(sameOriginMcp.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`);
    const sameOriginOrdinary = await j(base, '/api/summary', { headers: { Origin: `http://localhost:${port}` } });
    expect(sameOriginOrdinary.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`);
  });

  test('logout revokes every grant for that user', async () => {
    const { base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    const login = await j(base, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin1', password: 'password123' }),
    });
    await j(base, '/api/auth/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
      body: JSON.stringify({ auth_enabled: true }),
    });

    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    await j(base, '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.body.token}` } });

    const prepareAfterLogout = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'after logout' } }, { Authorization: `Bearer ${login.body.token}` });
    // Unauthorized (token revoked) before the grant even gets checked.
    expect(prepareAfterLogout.status).toBe(401);
  });

  test('commit succeeded but the response was dropped: reconciling by operation id sees the real outcome', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await mcpCall(base, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'reconcile me' } });

    await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });

    // Simulate the approving client never seeing that response (dropped
    // connection) — it reconciles by operation id instead of re-approving.
    const reconciled = await j(base, `/api/mcp/operations/${prepared.body.operation.id}`);
    expect(reconciled.body.operation.status).toBe('committed');

    const txn = db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string };
    expect(txn.notes).toBe('reconcile me');
  });

});

describe('chat-originated approvals (fixes the dashboard chat hang)', () => {
  test('respondToChatOperation rejects an operation id it never created', async () => {
    const { db: testDb } = await start();
    const { respondToChatOperation } = await import('../dashboard/chat.js');
    expect(respondToChatOperation(testDb, 'not-a-real-operation', 'allow-once')).toMatchObject({ ok: false });
  });

  test('a chat-sourced pending operation renders through the same /api/mcp/operations queue as WebMCP', async () => {
    const { base } = await start();
    const { createOperation } = await import('../mcp/store.js');
    // Simulate what getPendingChatOperation does when the agent runner has
    // an in-flight approval request — proves the confirmation queue is
    // genuinely shared across sources, not a WebMCP-only concept.
    const op = createOperation(db, {
      source: 'chat', grantId: null, toolName: 'categorize', args: { limit: 10 },
      before: null, after: null, transactionId: null, revisionAtPrepare: null,
      profile: 'test', origin: 'dashboard-chat', sessionGeneration: 'dashboard-chat',
      userId: null, role: 'admin',
    });
    const pending = await j(base, '/api/mcp/operations');
    expect(pending.body.operations.some((o: any) => o.id === op.id && o.source === 'chat')).toBe(true);
  });
});

// ── P0a: ownership, the single /api/mcp/call path, cancel ──────────────────

const SESSION_HEADER = 'X-Wilson-Agent-Session';

function post(base: string, path: string, body: unknown, extra: Record<string, string> = {}) {
  return j(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
}

/** The one tool path, as the page calls it: `POST /api/mcp/call`, the session in a header and never in the body. */
function mcpCall(base: string, session: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return post(base, '/api/mcp/call', body, { [SESSION_HEADER]: session, ...extra });
}

async function grantVia(base: string, session: string, tools: string[], extra: Record<string, string> = {}) {
  const res = await post(base, '/api/mcp/grants', { tools }, { [SESSION_HEADER]: session, ...extra });
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.grants.map((g: any) => [g.tool_name, g.id])) as Record<string, string>;
}

async function loginAs(base: string, username: string): Promise<string> {
  const res = await post(base, '/api/auth/login', { username, password: 'password123' });
  return res.body.token;
}

describe('grant and operation ownership', () => {
  async function authed() {
    const { base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    await createUser(db, 'viewer1', 'password123', 'viewer');
    enableAuth(db);
    return {
      base,
      adminAuth: { Authorization: `Bearer ${await loginAs(base, 'admin1')}` },
      viewerAuth: { Authorization: `Bearer ${await loginAs(base, 'viewer1')}` },
    };
  }

  test('viewer cannot DELETE admin grant (404), and the grant stays live', async () => {
    const { base, adminAuth, viewerAuth } = await authed();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction'], adminAuth);
    const del = await j(base, `/api/mcp/grants/${grants.edit_transaction}`, { method: 'DELETE', headers: { ...viewerAuth, [SESSION_HEADER]: session } });
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('not_found');
    const still = await j(base, '/api/mcp/grants', { headers: { ...adminAuth, [SESSION_HEADER]: session } });
    expect(still.body.grants).toHaveLength(1);
    // The owner can.
    const ownDel = await j(base, `/api/mcp/grants/${grants.edit_transaction}`, { method: 'DELETE', headers: { ...adminAuth, [SESSION_HEADER]: session } });
    expect(ownDel.status).toBe(200);
  });

  test("GET grants for another user's session returns []", async () => {
    const { base, adminAuth, viewerAuth } = await authed();
    const session = crypto.randomUUID();
    await grantVia(base, session, ['transaction_search'], adminAuth);
    const asViewer = await j(base, '/api/mcp/grants', { headers: { ...viewerAuth, [SESSION_HEADER]: session } });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.grants).toEqual([]);
    const asAdmin = await j(base, '/api/mcp/grants', { headers: { ...adminAuth, [SESSION_HEADER]: session } });
    expect(asAdmin.body.grants).toHaveLength(1);
  });

  test("revoke-session by another user revokes nothing", async () => {
    const { base, adminAuth, viewerAuth } = await authed();
    const session = crypto.randomUUID();
    await grantVia(base, session, ['transaction_search'], adminAuth);
    const res = await post(base, '/api/mcp/grants/revoke-session', {}, { ...viewerAuth, [SESSION_HEADER]: session });
    expect(res.body.revoked).toBe(0);
    const still = await j(base, '/api/mcp/grants', { headers: { ...adminAuth, [SESSION_HEADER]: session } });
    expect(still.body.grants).toHaveLength(1);
  });

  test('grant responses never include the session generation', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const res = await post(base, '/api/mcp/grants', { tools: ['transaction_search'] }, { [SESSION_HEADER]: session });
    expect(JSON.stringify(res.body)).not.toContain(session);
    expect(JSON.stringify(res.body)).not.toContain('session_generation');
  });
});

describe('the agent-facing operation view carries no row text', () => {
  test('/api/mcp/call returns only id, status, tool, expiry, requester and outcome status, for every transport the client reports', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const txnId = firstTransactionId(db);
    db.prepare("UPDATE transactions SET description = 'SECRET MERCHANT 4111 1111 1111 1111', notes = 'private note' WHERE id = @id").run({ id: txnId });
    const imperative = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: txnId, notes: 'x' } }, { [SESSION_HEADER]: session });
    const declarative = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: txnId, notes: 'y' }, transport: 'declarative' }, { [SESSION_HEADER]: session });
    for (const res of [imperative, declarative]) {
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('operation');
      const op = res.body.operation;
      expect(Object.keys(op).sort()).toEqual(['expires_at', 'id', 'outcome', 'requestedBy', 'status', 'tool']);
      expect(op.tool).toBe('edit_transaction');
      expect(op.outcome).toBeNull();
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('SECRET MERCHANT');
      expect(raw).not.toContain('private note');
      expect(raw).not.toContain('4111');
    }
  });

  test('the poll the bridge uses (?view=agent) hands back a sanitized committed result', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const txnId = firstTransactionId(db);
    const res = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: txnId, notes: 'z' } }, { [SESSION_HEADER]: session });
    const id = res.body.operation.id;
    await j(base, `/api/mcp/operations/${id}/approve`, { method: 'POST' });
    const agent = await j(base, `/api/mcp/operations/${id}?view=agent`, { headers: { [SESSION_HEADER]: session } });
    expect(agent.status).toBe(200);
    expect(agent.body.operation.status).toBe('committed');
    expect(agent.body.operation.outcome).toBe('committed');
    expect(agent.body.operation.result.id).toBe(txnId);
    expect(agent.body.operation.before_json).toBeUndefined();
    expect(agent.body.operation.summary).toBeUndefined();
  });
});

describe('POST /api/mcp/call', () => {
  test("read path returns {kind:'read'} with the capped envelope", async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['transaction_search']);
    const res = await post(base, '/api/mcp/call', { grantId: grants.transaction_search, tool: 'transaction_search', args: { query: 'groceries' } }, { [SESSION_HEADER]: session });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('read');
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.note).toContain('data');
  });

  test("mutating path returns {kind:'operation'} with a projected, pending operation", async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const txnId = firstTransactionId(db);
    const res = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: txnId, notes: 'via call' }, transport: 'declarative' }, { [SESSION_HEADER]: session });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('operation');
    expect(res.body.operation.status).toBe('pending');
    expect(res.body.operation.requestedBy.kind).toBe('this_tab');
    expect(JSON.stringify(res.body)).not.toContain('session_generation');
    expect(JSON.stringify(res.body)).not.toContain(session);
    // Nothing written until a human approves.
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: txnId }) as any).notes).toBeNull();
    const approved = await j(base, `/api/mcp/operations/${res.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('committed');
  });

  test('the server, not the client, decides read vs mutating: a write is only ever an operation, whatever the client reports', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const txnId = firstTransactionId(db);
    for (const transport of ['imperative', 'declarative', 'page']) {
      const res = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: txnId, notes: 'sneaky' }, transport }, { [SESSION_HEADER]: session });
      expect(res.body.kind, transport).toBe('operation');
    }
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: txnId }) as any).notes).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_operations WHERE status = 'pending'").get() as any).n).toBe(3);
  });

  test('validation errors are 400 with an actionable body, and create no operation', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const res = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: 1, amount: '12abc' } }, { [SESSION_HEADER]: session });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_args');
    expect(res.body.error.message).toContain('amount must be a number');
    expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_operations").get() as any).n).toBe(0);
  });

  test('the body is strict: unknown keys, a missing session header and a malformed one are all 400', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['transaction_search']);
    const body = { grantId: grants.transaction_search, tool: 'transaction_search', args: { query: 'x' } };
    expect((await post(base, '/api/mcp/call', { ...body, extra: 1 }, { [SESSION_HEADER]: session })).status).toBe(400);
    expect((await post(base, '/api/mcp/call', body)).status).toBe(400);
    expect((await post(base, '/api/mcp/call', body, { [SESSION_HEADER]: 'not-a-uuid' })).status).toBe(400);
    expect((await post(base, '/api/mcp/call', { ...body, grantId: 'nope' }, { [SESSION_HEADER]: session })).status).toBe(400);
    expect((await post(base, '/api/mcp/call', { ...body, transport: 'http-mcp' }, { [SESSION_HEADER]: session })).status).toBe(400);
    expect((await post(base, '/api/mcp/call', body, { [SESSION_HEADER]: session })).status).toBe(200);
  });

  test('another tab cannot use this tab\'s grant', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['transaction_search']);
    const res = await post(base, '/api/mcp/call', { grantId: grants.transaction_search, tool: 'transaction_search', args: { query: 'x' } }, { [SESSION_HEADER]: crypto.randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('grant_invalid');
  });

  test('the deprecated sessionGeneration parameter still works and says so', async () => {
    const { base } = await start();
    const res = await j(base, '/api/mcp/tools?sessionGeneration=ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe('true');
    const modern = await j(base, '/api/mcp/tools', { headers: { [SESSION_HEADER]: crypto.randomUUID() } });
    expect(modern.headers.get('deprecation')).toBeNull();
  });

  test('429 carries Retry-After', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['transaction_search']);
    let last: Awaited<ReturnType<typeof post>> | undefined;
    for (let i = 0; i < 21; i++) {
      last = await post(base, '/api/mcp/call', { grantId: grants.transaction_search, tool: 'transaction_search', args: { query: 'groceries' } }, { [SESSION_HEADER]: session });
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('rate_limited');
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('cancel', () => {
  test('cancel by the requester rejects the op; cancel by another session -> 404', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    const grants = await grantVia(base, session, ['edit_transaction']);
    const prepared = await post(base, '/api/mcp/call', { grantId: grants.edit_transaction, tool: 'edit_transaction', args: { id: firstTransactionId(db), notes: 'cancel me' } }, { [SESSION_HEADER]: session });
    const opId = prepared.body.operation.id;

    const other = await post(base, `/api/mcp/operations/${opId}/cancel`, {}, { [SESSION_HEADER]: crypto.randomUUID() });
    expect(other.status).toBe(404);
    expect((await j(base, `/api/mcp/operations/${opId}`)).body.operation.status).toBe('pending');

    const own = await post(base, `/api/mcp/operations/${opId}/cancel`, {}, { [SESSION_HEADER]: session });
    expect(own.status).toBe(200);
    expect(own.body.outcome).toBe('cancelled');
    const row = (await j(base, `/api/mcp/operations/${opId}`)).body.operation;
    expect(row.status).toBe('rejected');
    expect(JSON.parse(row.outcome_json)).toEqual({ reason: 'cancelled_by_agent' });

    // A late approve cannot revive it.
    const late = await j(base, `/api/mcp/operations/${opId}/approve`, { method: 'POST' });
    expect(late.body.outcome).toBe('rejected');
    expect((db.prepare('SELECT notes FROM transactions WHERE id=@id').get({ id: firstTransactionId(db) }) as any).notes).toBeNull();
  });
});

describe('GET /api/mcp/audit', () => {
  test('lists the calls the agent made; a viewer sees only their own rows', async () => {
    const { base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    await createUser(db, 'viewer1', 'password123', 'viewer');
    enableAuth(db);
    const adminAuth = { Authorization: `Bearer ${await loginAs(base, 'admin1')}` };
    const viewerAuth = { Authorization: `Bearer ${await loginAs(base, 'viewer1')}` };

    for (const [auth, query] of [[adminAuth, 'groceries'], [viewerAuth, 'dining']] as const) {
      const session = crypto.randomUUID();
      const grants = await grantVia(base, session, ['transaction_search'], auth);
      const res = await post(base, '/api/mcp/call', { grantId: grants.transaction_search, tool: 'transaction_search', args: { query } }, { [SESSION_HEADER]: session, ...auth });
      expect(res.status).toBe(200);
    }

    const asAdmin = await j(base, '/api/mcp/audit', { headers: adminAuth });
    expect(asAdmin.body.entries.map((e: any) => e.decision)).toEqual(['allowed', 'allowed']);
    const asViewer = await j(base, '/api/mcp/audit', { headers: viewerAuth });
    expect(asViewer.body.entries).toHaveLength(1);
    expect(asViewer.body.entries[0].args_preview).toContain('dining');
    expect(JSON.stringify(asViewer.body)).not.toContain('grant_id');
  });

  test('rejects a bad query with 400', async () => {
    const { base } = await start();
    const res = await j(base, '/api/mcp/audit?limit=5000');
    expect(res.status).toBe(400);
  });
});

describe('exposed tools', () => {
  test('a grant issued against an older schema is listed in Settings but not offered to the agent', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    await grantVia(base, session, ['transaction_search', 'net_worth']);
    db.prepare("UPDATE mcp_grants SET schema_digest = 'old-schema' WHERE tool_name = 'net_worth'").run();
    const tools = await j(base, '/api/mcp/tools', { headers: { [SESSION_HEADER]: session } });
    expect(tools.body.tools.map((t: any) => t.name)).toEqual(['transaction_search']);
    const grants = await j(base, '/api/mcp/grants', { headers: { [SESSION_HEADER]: session } });
    expect(grants.body.grants.map((g: any) => g.tool_name).sort()).toEqual(['net_worth', 'transaction_search']);
  });

  test('every exposed tool carries classification and the full annotation set', async () => {
    const { base } = await start();
    const session = crypto.randomUUID();
    await grantVia(base, session, ['transaction_search', 'edit_transaction']);
    const tools = await j(base, '/api/mcp/tools', { headers: { [SESSION_HEADER]: session } });
    const byName = Object.fromEntries(tools.body.tools.map((t: any) => [t.name, t]));
    expect(byName.transaction_search.classification).toBe('read');
    expect(byName.transaction_search.annotations.untrustedContentHint).toBe(true);
    expect(byName.edit_transaction.classification).toBe('mutating');
    expect(byName.edit_transaction.annotations.consequentialHint).toBe(true);
    expect(byName.edit_transaction.inputSchema.additionalProperties).toBe(false);
  });

  test('the catalog route lists server-side classification, minRole and transports', async () => {
    const { base } = await start();
    const catalog = await j(base, '/api/mcp/catalog');
    const names = catalog.body.tools.map((t: any) => t.name).sort();
    expect(names).toContain('tax_summary');
    const edit = catalog.body.tools.find((t: any) => t.name === 'edit_transaction');
    expect(edit).toMatchObject({ classification: 'mutating', minRole: 'admin' });
    expect(edit.transports.sort()).toEqual(['http-mcp', 'webmcp']);
  });
});

// ── P0b: browser proof (threat model T05) ──────────────────────────────────────

describe('browser proof: no localhost fallback for a missing Origin', () => {
  const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const noProof = (base: string, path: string, init: RequestInit = {}) => fetch(base + path, init);
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': SESSION };

  test('no Origin and no Sec-Fetch-Site → 403 origin_required on grants, tools and the call route', async () => {
    const { base, db: sdb } = await start();
    const grant = await noProof(base, '/api/mcp/grants', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ tools: ['transaction_search'] }) });
    expect(grant.status).toBe(403);
    expect(((await grant.json()) as any).error.code).toBe('origin_required');
    expect((sdb.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n).toBe(0);

    for (const [path, init] of [
      ['/api/mcp/tools', { headers: jsonHeaders }],
      ['/api/mcp/grants', { headers: jsonHeaders }],
      ['/api/mcp/call', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ grantId: crypto.randomUUID(), tool: 'transaction_search', args: { query: 'a' } }) }],
    ] as const) {
      const res = await noProof(base, path, init);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as any).error.code).toBe('origin_required');
    }
  });

  test('Sec-Fetch-Site same-origin derives the Host origin, the same one an Origin-bearing POST is bound to', async () => {
    const { base, port } = await start();
    const created = await noProof(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { ...jsonHeaders, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ tools: ['transaction_search'] }),
    });
    expect(created.status).toBe(200);

    // The same tab's later GET: a browser sends no Origin on a same-origin GET, only Sec-Fetch-Site.
    const listed = await noProof(base, '/api/mcp/grants', { headers: { ...jsonHeaders, 'Sec-Fetch-Site': 'same-origin' } });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as any).grants.map((g: any) => g.tool_name)).toEqual(['transaction_search']);

    // Sec-Fetch-Site same-site (another localhost port) proves nothing.
    const sameSite = await noProof(base, '/api/mcp/grants', { headers: { ...jsonHeaders, 'Sec-Fetch-Site': 'same-site' } });
    expect(sameSite.status).toBe(403);
  });

  async function pendingOp(base: string) {
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: SESSION, tools: ['edit_transaction'] }),
    });
    const prepared = await mcpCall(base, SESSION, { grantId: grantRes.body.grants[0].id, tool: 'edit_transaction', args: { id: firstTransactionId(db), notes: 'proof test' } });
    return prepared.body.operation.id as string;
  }

  test('approve with no Origin → 403 origin_required, and nothing is written', async () => {
    const { base } = await start();
    const id = await pendingOp(base);
    const res = await noProof(base, `/api/mcp/operations/${id}/approve`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('origin_required');
    const txn = db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: firstTransactionId(db) }) as { notes: string | null };
    expect(txn.notes).not.toBe('proof test');
    expect((db.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id }) as { status: string }).status).toBe('pending');
  });

  test('approve and reject with an allowlisted Origin but Sec-Fetch-Site same-site → 403; with both → 200', async () => {
    const { base, port } = await start();
    const id = await pendingOp(base);
    const origin = `http://localhost:${port}`;
    for (const verb of ['approve', 'reject']) {
      const res = await noProof(base, `/api/mcp/operations/${id}/${verb}`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-site' } });
      expect(res.status, verb).toBe(403);
      const missing = await noProof(base, `/api/mcp/operations/${id}/${verb}`, { method: 'POST', headers: { Origin: origin } });
      expect(missing.status, `${verb} without Sec-Fetch-Site`).toBe(403);
    }
    expect((db.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id }) as { status: string }).status).toBe('pending');

    const approved = await noProof(base, `/api/mcp/operations/${id}/approve`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as any).outcome).toBe('committed');
  });

  test('a tab cannot be granted a /mcp-only tool (get_operation_result belongs to client tokens)', async () => {
    const { base } = await start();
    const res = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: SESSION, tools: ['get_operation_result'] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('not available in the dashboard tab');
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n).toBe(0);
  });

  test('revoking grants needs browser proof too (DELETE one, revoke-session)', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: SESSION, tools: ['transaction_search'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    expect((await noProof(base, `/api/mcp/grants/${grantId}`, { method: 'DELETE', headers: jsonHeaders })).status).toBe(403);
    expect((await noProof(base, '/api/mcp/grants/revoke-session', { method: 'POST', headers: jsonHeaders, body: '{}' })).status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_grants WHERE revoked_at IS NULL').get() as { n: number }).n).toBe(1);
  });
});

// ── P1: dwell floor, the shared state endpoint, grant TTL ────────────────────

describe('P1 user control', () => {
  const P1_SESSION = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
  const sessionHeaders = { 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': P1_SESSION };

  async function prepared(base: string) {
    const grantRes = await j(base, '/api/mcp/grants', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ tools: ['edit_transaction'] }) });
    const grantId = grantRes.body.grants[0].id;
    const call = await j(base, '/api/mcp/call', {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ grantId, tool: 'edit_transaction', args: { id: firstTransactionId(db), notes: 'dwell' } }),
    });
    return call.body.operation.id as string;
  }

  test('approve less than 1 s after prepare answers 409 approval_too_fast and the operation stays pending', async () => {
    const { setApprovalDwellMs } = await import('../mcp/engine.js');
    const { base } = await start();
    setApprovalDwellMs(null); // restore the real floor (createTestDb relaxes it for every other test)
    const id = await prepared(base);
    const early = await j(base, `/api/mcp/operations/${id}/approve`, { method: 'POST' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('approval_too_fast');
    expect(early.body.outcome).toBe('approval_too_fast');
    expect((db.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id }) as any).status).toBe('pending');
    expect((db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: firstTransactionId(db) }) as any).notes).toBeNull();

    // The window is measured from the operation's own creation time: once it has passed, approve works.
    db.prepare('UPDATE mcp_operations SET created_at = @t WHERE id = @id').run({ id, t: new Date(Date.now() - 1500).toISOString() });
    const later = await j(base, `/api/mcp/operations/${id}/approve`, { method: 'POST' });
    expect(later.status).toBe(200);
    expect(later.body.outcome).toBe('committed');
    setApprovalDwellMs(0);
  });

  test('reject is never held back by the dwell floor', async () => {
    const { setApprovalDwellMs } = await import('../mcp/engine.js');
    const { base } = await start();
    setApprovalDwellMs(null);
    const id = await prepared(base);
    const res = await j(base, `/api/mcp/operations/${id}/reject`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('rejected');
    setApprovalDwellMs(0);
  });

  test('GET /api/mcp/state reflects grants, policies, pending approvals and the kill switch', async () => {
    const { base } = await start();
    const empty = await j(base, '/api/mcp/state', { headers: { 'X-Wilson-Agent-Session': P1_SESSION } });
    expect(empty.status).toBe(200);
    expect(empty.body.enabled).toBe(true);
    expect(empty.body.role).toBe('admin');
    expect(empty.body.grantTtlMinutes).toBe(60);
    expect(empty.body.ttlOptions).toEqual([15, 60, 240, 720]);
    expect(empty.body.pending).toEqual([]);
    const row = (name: string, state = empty) => state.body.tools.find((t: any) => t.name === name);
    expect(row('transaction_search')).toMatchObject({ classification: 'read', policy: 'allow', grant: null, policyLocked: false });
    expect(row('edit_transaction')).toMatchObject({ classification: 'mutating', policy: 'ask' });
    expect(row('get_operation_result')).toBeUndefined(); // /mcp-only: not a tab tool
    expect(JSON.stringify(empty.body)).not.toContain(P1_SESSION);

    await j(base, '/api/mcp/policies/forecast', { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({ policy: 'ask' }) });
    const id = await prepared(base);
    const state = await j(base, '/api/mcp/state', { headers: { 'X-Wilson-Agent-Session': P1_SESSION } });
    expect(row('forecast', state).policy).toBe('ask');
    expect(row('edit_transaction', state).grant).toMatchObject({ id: expect.any(String), expiresAt: expect.any(String) });
    expect(state.body.pending.map((o: any) => o.id)).toEqual([id]);
    expect(state.body.pending[0].requestedBy).toEqual({ kind: 'this_tab', label: 'this tab' });
    expect(state.body.auditTail.length).toBeGreaterThan(0);
    expect(state.body.auditTail.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(state.body)).not.toContain('session_generation');
  });

  test('another tab sees the same pending approvals but not this tab\'s grants', async () => {
    const { base } = await start();
    await prepared(base);
    const other = await j(base, '/api/mcp/state', { headers: { 'X-Wilson-Agent-Session': 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2' } });
    expect(other.body.tools.every((t: any) => t.grant === null)).toBe(true);
    expect(other.body.pending[0].requestedBy.kind).toBe('another_tab');
  });

  test('PUT /api/mcp/policies/:tool: allow on a change is a 400 with the reason; ask and off work', async () => {
    const { base } = await start();
    const put = (tool: string, policy: string) =>
      j(base, `/api/mcp/policies/${tool}`, { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({ policy }) });
    const refused = await put('edit_transaction', 'allow');
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('Changes always require approval; choose Ask or Off.');
    expect((await put('edit_transaction', 'off')).body).toEqual({ tool: 'edit_transaction', policy: 'off', effective: 'off' });
    expect((await put('forecast', 'ask')).body).toEqual({ tool: 'forecast', policy: 'ask', effective: 'ask' });
    expect((await put('forecast', 'maybe')).status).toBe(400);
    const list = await j(base, '/api/mcp/policies');
    expect(list.body.policies.find((p: any) => p.tool === 'forecast')).toEqual({ tool: 'forecast', policy: 'ask', effective: 'ask' });
  });

  test('policy routes need browser proof', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/mcp/policies/forecast`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'off' }) });
    expect(res.status).toBe(403);
  });

  test('a viewer cannot PUT /api/mcp/settings, and cannot set a policy on a change tool', async () => {
    const { base } = await start();
    await createUser(db, 'admin1', 'password123', 'admin');
    await createUser(db, 'viewer1', 'password123', 'viewer');
    const login = async (u: string) =>
      ((await (await bfetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) })).json()) as any).token as string;
    const adminTok = await login('admin1');
    const viewerTok = await login('viewer1');
    enableAuth(db);
    const as = (token: string) => ({ ...sessionHeaders, Authorization: `Bearer ${token}` });
    expect((await j(base, '/api/mcp/settings', { method: 'PUT', headers: as(viewerTok), body: JSON.stringify({ grantTtlMinutes: 15 }) })).status).toBe(403);
    expect((await j(base, '/api/mcp/policies/edit_transaction', { method: 'PUT', headers: as(viewerTok), body: JSON.stringify({ policy: 'off' }) })).status).toBe(403);
    expect((await j(base, '/api/mcp/policies/forecast', { method: 'PUT', headers: as(viewerTok), body: JSON.stringify({ policy: 'ask' }) })).status).toBe(200);
    const state = await j(base, '/api/mcp/state', { headers: as(viewerTok) });
    expect(state.body.role).toBe('viewer');
    expect(state.body.tools.find((t: any) => t.name === 'edit_transaction')).toMatchObject({ policyLocked: true });
    expect(state.body.tools.find((t: any) => t.name === 'edit_transaction').lockReason).toBeTruthy();
    expect((await j(base, '/api/mcp/settings', { method: 'PUT', headers: as(adminTok), body: JSON.stringify({ grantTtlMinutes: 15 }) })).status).toBe(200);
  });

  test('PUT /api/mcp/settings is strict: an unknown key or a TTL outside the options is a 400', async () => {
    const { base } = await start();
    const put = (body: unknown) => j(base, '/api/mcp/settings', { method: 'PUT', headers: sessionHeaders, body: JSON.stringify(body) });
    expect((await put({ grantTtlMinutes: 30 })).status).toBe(400);
    expect((await put({ surprise: true })).status).toBe(400);
    expect((await put({ grantTtlMinutes: 240 })).body.grantTtlMinutes).toBe(240);
    await put({ grantTtlMinutes: 60 });
  });

  test('judgeDailyLimit: shown in the state, admin-only to change, 1..2000, and a viewer cannot raise it', async () => {
    const { base, db } = await start();
    const put = (body: unknown, headers: Record<string, string> = sessionHeaders) => j(base, '/api/mcp/settings', { method: 'PUT', headers, body: JSON.stringify(body) });
    try {
      expect((await j(base, '/api/mcp/state', { headers: sessionHeaders })).body.judgeDailyLimit).toBe(300);
      expect((await put({ judgeDailyLimit: 25 })).body.judgeDailyLimit).toBe(25);
      expect((await j(base, '/api/mcp/state', { headers: sessionHeaders })).body.judgeDailyLimit).toBe(25);
      for (const bad of [0, 2001, 1.5, '50']) expect((await put({ judgeDailyLimit: bad })).status, String(bad)).toBe(400);

      await createUser(db, 'admin1', 'password123', 'admin');
      await createUser(db, 'viewer1', 'password123', 'viewer');
      const login = async (u: string) =>
        ((await (await bfetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) })).json()) as any).token as string;
      const adminTok = await login('admin1');
      const viewerTok = await login('viewer1');
      enableAuth(db);
      const as = (token: string) => ({ ...sessionHeaders, Authorization: `Bearer ${token}` });
      expect((await put({ judgeDailyLimit: 2000 }, as(viewerTok))).status).toBe(403);
      expect((await j(base, '/api/mcp/state', { headers: as(viewerTok) })).body.judgeDailyLimit).toBe(25);
      expect((await put({ judgeDailyLimit: 2000 }, as(adminTok))).status).toBe(200);
    } finally {
      const { setJudgeDailyLimit } = await import('../mcp/agent-settings.js');
      setJudgeDailyLimit(300);
    }
  });

  test('the grant TTL setting applies to new grants only', async () => {
    const { base } = await start();
    const put = (body: unknown) => j(base, '/api/mcp/settings', { method: 'PUT', headers: sessionHeaders, body: JSON.stringify(body) });
    const grant = async (tool: string) =>
      (await j(base, '/api/mcp/grants', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ tools: [tool] }) })).body.grants[0] as { expires_at: string };
    try {
      const hourGrant = await grant('forecast');
      const hourMs = new Date(hourGrant.expires_at).getTime() - Date.now();
      expect(hourMs).toBeGreaterThan(55 * 60_000);
      expect(hourMs).toBeLessThanOrEqual(60 * 60_000);

      await put({ grantTtlMinutes: 15 });
      const shortGrant = await grant('profit_loss');
      const shortMs = new Date(shortGrant.expires_at).getTime() - Date.now();
      expect(shortMs).toBeGreaterThan(14 * 60_000);
      expect(shortMs).toBeLessThanOrEqual(15 * 60_000);

      // The earlier grant kept its expiry.
      const grants = (await j(base, '/api/mcp/grants', { headers: { 'X-Wilson-Agent-Session': P1_SESSION } })).body.grants as any[];
      expect(grants.find((g) => g.tool_name === 'forecast').expires_at).toBe(hourGrant.expires_at);
    } finally {
      await put({ grantTtlMinutes: 60 });
    }
  });

  test('the settings kill switch ends in-flight work: grants are revoked and the state says off', async () => {
    const { base } = await start();
    await prepared(base);
    const off = await j(base, '/api/mcp/settings', { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({ enabled: false }) });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.pending).toEqual([]);
    expect(off.body.tools.every((t: any) => t.grant === null)).toBe(true);
    const tools = await j(base, '/api/mcp/tools', { headers: { 'X-Wilson-Agent-Session': P1_SESSION } });
    expect(tools.body.tools).toEqual([]);
    const refused = await j(base, '/api/mcp/grants', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ tools: ['forecast'] }) });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('kill_switch');
    await j(base, '/api/mcp/settings', { method: 'PUT', headers: sessionHeaders, body: JSON.stringify({ enabled: true }) });
  });
});
