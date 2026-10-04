import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, count, firstTxnId, grantTools, makeUser, testScope } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth, disableAuth } from '../dashboard/auth.js';
import {
  callTool, approveWebMcpOperation, rejectOperation, cancelOperation, isOperationVisible,
  type RequestScope,
} from '../mcp/engine.js';
import { toOperationView } from '../mcp/operation-view.js';
import { getOperation } from '../mcp/store.js';
import type { Database } from '../db/compat-sqlite.js';
import type { McpOperation } from '../mcp/store.js';

/**
 * P0a approval hardening: expiry, ownership, role, live owner state, the
 * operations projection, and the server-derived "requested by".
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

async function http(base: string, path: string, init: RequestInit & { token?: string; session?: string } = {}) {
  const { token, session, ...rest } = init;
  const res = await bfetch(base + path, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'X-Wilson-Agent-Session': session } : {}),
      ...((rest.headers as Record<string, string>) ?? {}),
    },
  });
  const body = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: body as any };
}

async function login(base: string, username: string): Promise<string> {
  const res = await http(base, '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password: 'password123' }) });
  return res.body.token as string;
}

/** Prepare an edit through callTool and return the pending operation. */
async function prepareEdit(db: Database, scope: RequestScope, notes = 'approval test'): Promise<McpOperation> {
  const grants = grantTools(db, scope, ['edit_transaction']);
  const res = await callTool(db, scope, grants.edit_transaction, 'edit_transaction', { id: firstTxnId(db), notes }, 'imperative');
  if (!res.ok || res.kind !== 'operation') throw new Error(`prepare failed: ${JSON.stringify(res)}`);
  return res.operation;
}

function expire(db: Database, id: string) {
  db.prepare('UPDATE mcp_operations SET expires_at = @t WHERE id = @id').run({ id, t: new Date(Date.now() - 1000).toISOString() });
}

function notesOf(db: Database): string | null {
  return (db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: firstTxnId(db) }) as { notes: string | null }).notes;
}

describe('expiry', () => {
  test('approve after expires_at -> expired, no write', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await prepareEdit(db, testScope());
    expire(db, op.id);
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).toBe('expired');
    expect(notesOf(db)).toBeNull();
    expect(getOperation(db, op.id)!.status).toBe('expired');
    expect(count(db, 'mcp_approval_tokens')).toBe(0); // never even minted a token
  });

  test('reject after expires_at -> expired', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await prepareEdit(db, testScope());
    expire(db, op.id);
    expect(rejectOperation(db, op.id).outcome).toBe('expired');
    expect(getOperation(db, op.id)!.status).toBe('expired');
  });

  test('the approve route answers 409 expired and the row is untouched', async () => {
    const { db, base } = await startServer();
    const op = await prepareEdit(db, testScope());
    expire(db, op.id);
    const res = await http(base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(res.body.outcome).toBe('expired');
    expect(res.body.error.code).toBe('expired');
    expect(notesOf(db)).toBeNull();
  });

  test('a commit that races the window closing re-checks expiry before writing', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await prepareEdit(db, testScope());
    // Approval token minted while valid, window closes before the commit runs.
    const { issueApprovalToken } = await import('../mcp/store.js');
    const { commitWebMcpOperation } = await import('../mcp/engine.js');
    const { token } = issueApprovalToken(db, op.id);
    expire(db, op.id);
    expect(commitWebMcpOperation(db, op.id, token, 'test').outcome).toBe('expired');
    expect(notesOf(db)).toBeNull();
  });

  test('an unexpired operation approves normally', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await prepareEdit(db, testScope(), 'fine');
    expect(approveWebMcpOperation(db, op.id, 'test').outcome).toBe('committed');
    expect(notesOf(db)).toBe('fine');
  });
});

describe('live owner state at commit', () => {
  test('owner demoted between prepare and approve -> stale (owner_changed), no write', async () => {
    const db = createTestDb();
    seedTestData(db);
    const owner = await makeUser(db, 'owner1', 'admin');
    const op = await prepareEdit(db, testScope({ userId: owner.id }));
    db.prepare("UPDATE dashboard_users SET role = 'viewer' WHERE id = @id").run({ id: owner.id });
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).toBe('stale');
    expect(out.reason).toBe('owner_changed');
    expect(notesOf(db)).toBeNull();
  });

  test('owner deactivated -> stale', async () => {
    const db = createTestDb();
    seedTestData(db);
    const owner = await makeUser(db, 'owner2', 'admin');
    const op = await prepareEdit(db, testScope({ userId: owner.id }));
    db.prepare('UPDATE dashboard_users SET is_active = 0 WHERE id = @id').run({ id: owner.id });
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).toBe('stale');
    expect(out.reason).toBe('owner_changed');
    expect(notesOf(db)).toBeNull();
  });

  test('an unchanged owner commits', async () => {
    const db = createTestDb();
    seedTestData(db);
    const owner = await makeUser(db, 'owner3', 'admin');
    const op = await prepareEdit(db, testScope({ userId: owner.id }), 'owner ok');
    expect(approveWebMcpOperation(db, op.id, 'test').outcome).toBe('committed');
  });
});

describe('visibility and approver rules (auth on)', () => {
  async function authedServer() {
    const { db, base } = await startServer();
    const admin = await makeUser(db, 'admin1', 'admin');
    const admin2 = await makeUser(db, 'admin2', 'admin');
    const viewer = await makeUser(db, 'viewer1', 'viewer');
    enableAuth(db);
    return {
      db, base, admin, admin2, viewer,
      adminToken: await login(base, 'admin1'),
      admin2Token: await login(base, 'admin2'),
      viewerToken: await login(base, 'viewer1'),
    };
  }

  /** An operation raised while auth was still off (no owner), then auth is switched on: /mcp-style calls from that grant are refused now, but the row stays. */
  async function prepareOwnerless(s: { db: Database }): Promise<McpOperation> {
    disableAuth(s.db);
    try {
      return await prepareEdit(s.db, testScope({ userId: null }));
    } finally {
      enableAuth(s.db);
    }
  }

  test('auth on: viewer approve of a null-user op -> 404', async () => {
    const s = await authedServer();
    const op = await prepareOwnerless(s);
    const res = await http(s.base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST', token: s.viewerToken });
    expect(res.status).toBe(404);
    expect(notesOf(s.db)).toBeNull();
    // Nobody can act on an ownerless op once auth is on, not even an admin.
    const asAdmin = await http(s.base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST', token: s.adminToken });
    expect(asAdmin.status).toBe(404);
  });

  test("auth on: approve of another user's op -> 404", async () => {
    const s = await authedServer();
    const op = await prepareEdit(s.db, testScope({ userId: s.admin.id }));
    const res = await http(s.base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST', token: s.admin2Token });
    expect(res.status).toBe(404);
    expect(notesOf(s.db)).toBeNull();
    const reject = await http(s.base, `/api/mcp/operations/${op.id}/reject`, { method: 'POST', token: s.admin2Token });
    expect(reject.status).toBe(404);
  });

  test('auth on: viewer approve of their own mutation op -> 403', async () => {
    const s = await authedServer();
    // A viewer cannot be granted a mutating tool, so build the op as if the grant predated the demotion.
    const op = await prepareEdit(s.db, testScope({ userId: s.admin.id }));
    s.db.prepare('UPDATE mcp_operations SET user_id = @id WHERE id = @op').run({ id: s.viewer.id, op: op.id });
    const res = await http(s.base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST', token: s.viewerToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('role_forbidden');
    expect(notesOf(s.db)).toBeNull();
  });

  test("auth on: the owner approves their own op", async () => {
    const s = await authedServer();
    const op = await prepareEdit(s.db, testScope({ userId: s.admin.id }), 'mine');
    const res = await http(s.base, `/api/mcp/operations/${op.id}/approve`, { method: 'POST', token: s.adminToken });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('committed');
    expect(notesOf(s.db)).toBe('mine');
  });

  test('auth on: the operations list shows only the caller\'s operations', async () => {
    const s = await authedServer();
    // Ownerless first: turning auth back on expires every pending agent operation (auth.ts enableAuth, #156).
    await prepareOwnerless(s);
    const mine = await prepareEdit(s.db, testScope({ userId: s.admin.id }));
    await prepareEdit(s.db, testScope({ userId: s.admin2.id }));
    const list = await http(s.base, '/api/mcp/operations', { token: s.adminToken });
    expect(list.body.operations.map((o: any) => o.id)).toEqual([mine.id]);
  });

  test('isOperationVisible: auth off sees everything, auth on only the owner', () => {
    const op = { user_id: 7 } as McpOperation;
    expect(isOperationVisible(op, { userId: null, role: 'admin', authEnabled: false })).toBe(true);
    expect(isOperationVisible(op, { userId: 7, role: 'admin', authEnabled: true })).toBe(true);
    expect(isOperationVisible(op, { userId: 8, role: 'admin', authEnabled: true })).toBe(false);
    expect(isOperationVisible({ user_id: null } as McpOperation, { userId: 8, role: 'admin', authEnabled: true })).toBe(false);
  });
});

describe('operations API projection', () => {
  test('operations list never contains session_generation or grant_id', async () => {
    const { db, base } = await startServer();
    const scope = testScope();
    const op = await prepareEdit(db, scope);
    const list = await http(base, '/api/mcp/operations', { session: scope.sessionGeneration });
    expect(list.body.operations).toHaveLength(1);
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('session_generation');
    expect(raw).not.toContain('grant_id');
    expect(raw).not.toContain(scope.sessionGeneration);
    const one = await http(base, `/api/mcp/operations/${op.id}`, { session: scope.sessionGeneration });
    const rawOne = JSON.stringify(one.body);
    expect(rawOne).not.toContain('session_generation');
    expect(rawOne).not.toContain('grant_id');
    expect(rawOne).not.toContain(scope.sessionGeneration);
    expect(one.body.operation.id).toBe(op.id);
    expect(one.body.operation.summary).toContain('#');
  });
});

describe('requestedBy (server-derived)', () => {
  const baseOp = { id: 'op', tool_name: 'edit_transaction', summary: null, before_json: null, after_json: null, transaction_id: 1, status: 'pending', outcome_json: null, created_at: '', expires_at: '', resolved_at: null, grant_id: 'g', user_id: null };

  test('requestedBy is this_tab only for the requesting session', () => {
    const op = { ...baseOp, source: 'webmcp', session_generation: 'tab-a-session' } as unknown as McpOperation;
    expect(toOperationView(op, { sessionGeneration: 'tab-a-session' }).requestedBy).toEqual({ kind: 'this_tab', label: 'this tab' });
    const other = toOperationView(op, { sessionGeneration: 'tab-b-session' }).requestedBy;
    expect(other.kind).toBe('another_tab');
    expect(other.label).toMatch(/^another tab \(…[0-9a-f]{4}\)$/);
    expect(toOperationView(op, { sessionGeneration: null }).requestedBy.kind).toBe('another_tab');
  });

  test('http-mcp and chat are labelled by source, never as this tab', () => {
    const mcp = { ...baseOp, source: 'http-mcp', session_generation: 'x' } as unknown as McpOperation;
    const chat = { ...baseOp, source: 'chat', session_generation: 'dashboard-chat' } as unknown as McpOperation;
    expect(toOperationView(mcp, { sessionGeneration: 'x' }).requestedBy.kind).toBe('external_client');
    expect(toOperationView(chat, { sessionGeneration: 'dashboard-chat' }).requestedBy.kind).toBe('chat');
  });

  test('the view never carries the session id or grant id', () => {
    const op = { ...baseOp, source: 'webmcp', session_generation: 'secret-session' } as unknown as McpOperation;
    const raw = JSON.stringify(toOperationView(op, { sessionGeneration: 'secret-session' }));
    expect(raw).not.toContain('secret-session');
    expect(raw).not.toContain('grant');
  });

  test('over the API a second tab sees another_tab and the requesting tab sees this_tab', async () => {
    const { db, base } = await startServer();
    const scope = testScope();
    await prepareEdit(db, scope);
    const asRequester = await http(base, '/api/mcp/operations', { session: scope.sessionGeneration });
    const asOther = await http(base, '/api/mcp/operations', { session: crypto.randomUUID() });
    expect(asRequester.body.operations[0].requestedBy.kind).toBe('this_tab');
    expect(asOther.body.operations[0].requestedBy.kind).toBe('another_tab');
  });
});

describe('cancel', () => {
  test('cancel by the requester rejects the op with reason cancelled_by_agent; other sessions get null', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await prepareEdit(db, scope);
    expect(cancelOperation(db, testScope(), op.id)).toBeNull();
    expect(cancelOperation(db, scope, op.id)).toEqual({ outcome: 'cancelled' });
    const row = getOperation(db, op.id)!;
    expect(row.status).toBe('rejected');
    expect(JSON.parse(row.outcome_json!)).toEqual({ reason: 'cancelled_by_agent' });
    expect(notesOf(db)).toBeNull();
  });
});
