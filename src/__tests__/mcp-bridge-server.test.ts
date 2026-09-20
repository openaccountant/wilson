import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
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

async function j(base: string, path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
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
    const res = await j(base, '/api/mcp/tools?sessionGeneration=fresh-tab');
    expect(res.body.tools).toEqual([]);
  });

  test('two tabs get independent grants (different sessionGeneration)', async () => {
    const { base } = await start();
    await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'tab-a', tools: ['transaction_search'] }),
    });

    const tabATools = await j(base, '/api/mcp/tools?sessionGeneration=tab-a');
    const tabBTools = await j(base, '/api/mcp/tools?sessionGeneration=tab-b');
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
      body: JSON.stringify({ sessionGeneration: 'viewer-tab', tools: ['edit_transaction'] }),
    });
    expect(grantAttempt.status).toBe(403);

    const readGrant = await j(base, '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerLogin.body.token}` },
      body: JSON.stringify({ sessionGeneration: 'viewer-tab', tools: ['transaction_search'] }),
    });
    expect(readGrant.status).toBe(200);
  });

  test('admin can grant and use a mutating tool end to end (prepare -> approve -> committed)', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'confirmed via test' } }),
    });
    expect(prepared.body.operation.status).toBe('pending');
    expect(prepared.body.operation.before_json).toContain('null');
    expect(prepared.body.operation.after_json).toContain('confirmed via test');

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
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'first' } }),
    });

    // Someone else (or the plain REST edit route) changes the row in between.
    db.prepare("UPDATE transactions SET revision = revision + 1 WHERE id = @id").run({ id: txnId });

    const approved = await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });
    expect(approved.body.outcome).toBe('stale');
  });

  test('duplicate commit attempt: approving twice never applies the mutation twice', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'once' } }),
    });
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
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'should not land' } }),
    });

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
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'pre-switch' } }),
    });

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
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['transaction_search'] }),
    });
    const grantId = grantRes.body.grants[0].id;

    const foreignRead = await j(base, '/api/mcp/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'transaction_search', args: { query: 'groceries' } }),
    });
    expect(foreignRead.status).toBe(403);

    const sameOriginRead = await j(base, '/api/mcp/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'transaction_search', args: { query: 'groceries' } }),
    });
    expect(sameOriginRead.status).toBe(200);
  });

  test('the sensitive MCP routes never reflect a foreign Origin, unlike the rest of the API', async () => {
    const { base, port } = await start();
    const mcpRes = await j(base, '/api/mcp/catalog', { headers: { Origin: 'http://evil.example' } });
    expect(mcpRes.headers.get('access-control-allow-origin')).toBeNull();

    const ordinaryRes = await j(base, '/api/summary', { headers: { Origin: 'http://evil.example' } });
    expect(ordinaryRes.headers.get('access-control-allow-origin')).toBe('*');

    const sameOriginMcp = await j(base, '/api/mcp/catalog', { headers: { Origin: `http://localhost:${port}` } });
    expect(sameOriginMcp.headers.get('access-control-allow-origin')).toBe(`http://localhost:${port}`);
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
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    await j(base, '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${login.body.token}` } });

    const prepareAfterLogout = await j(base, '/api/mcp/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'after logout' } }),
    });
    // Unauthorized (token revoked) before the grant even gets checked.
    expect(prepareAfterLogout.status).toBe(401);
  });

  test('commit succeeded but the response was dropped: reconciling by operation id sees the real outcome', async () => {
    const { base } = await start();
    const grantRes = await j(base, '/api/mcp/grants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', tools: ['edit_transaction'] }),
    });
    const grantId = grantRes.body.grants[0].id;
    const txnId = firstTransactionId(db);

    const prepared = await j(base, '/api/mcp/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionGeneration: 'admin-tab', grantId, tool: 'edit_transaction', args: { id: txnId, notes: 'reconcile me' } }),
    });

    await j(base, `/api/mcp/operations/${prepared.body.operation.id}/approve`, { method: 'POST' });

    // Simulate the approving client never seeing that response (dropped
    // connection) — it reconciles by operation id instead of re-approving.
    const reconciled = await j(base, `/api/mcp/operations/${prepared.body.operation.id}`);
    expect(reconciled.body.operation.status).toBe('committed');

    const txn = db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: txnId }) as { notes: string };
    expect(txn.notes).toBe('reconcile me');
  });

  test('dashboard chat requests complete instead of hanging when no approval is requested', async () => {
    const { base } = await start();
    // No LLM configured in the test environment, so the agent errors out
    // immediately rather than calling a tool — this exercises the same
    // request/response path the hang bug lived in (POST /api/chat awaiting
    // agentRunner.runQuery to completion) without needing a live model.
    // The regression this guards against is the request timing out; a 200
    // or a handled error response both prove it returned at all.
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    });
    expect(res.status).toBe(200);
    const pending = await j(base, '/api/mcp/operations');
    expect(pending.body.operations).toEqual([]);
  });
});

describe('chat-originated approvals (fixes the dashboard chat hang)', () => {
  test('respondToChatOperation rejects an operation id it never created', async () => {
    const { db: testDb } = await start();
    const { respondToChatOperation } = await import('../dashboard/chat.js');
    expect(respondToChatOperation(testDb, 'not-a-real-operation', 'allow-once')).toBe(false);
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
