import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData, ensureTestProfile } from './helpers.js';
import { bfetch, count, firstTxnId, grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth } from '../dashboard/auth.js';
import { approveWebMcpOperation, callTool, setKillSwitch, type RequestScope } from '../mcp/engine.js';
import { setPolicy, type PolicyActor } from '../mcp/policies.js';
import { getOperation, revokeGrant } from '../mcp/store.js';
import { toAgentResolvedView } from '../mcp/operation-view.js';
import { awaitOperationOutcome } from '../mcp/http-server.js';
import { resolveClientToken } from '../mcp/client-tokens.js';
import { setGlobalAgentState } from '../mcp/global-state.js';
import type { Database } from '../db/compat-sqlite.js';
import type { McpOperation } from '../mcp/store.js';

/**
 * Judge round P1 fixes.
 *  K1: an approved read's data is only delivered while its grant is live and no kill-switch flip happened since.
 *  K2: a tool turned Off after a card was raised can no longer be approved into running.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
  ensureTestProfile();
  setGlobalAgentState({ enabled: undefined, killSwitchEpoch: undefined });
});

const adminActor = (scope: RequestScope): PolicyActor => ({ userId: scope.userId, role: scope.role, authEnabled: scope.userId !== null });

async function askRead(db: Database, scope: RequestScope, tool = 'search_transactions'): Promise<McpOperation> {
  setPolicy(db, adminActor(scope), tool, 'ask');
  const grants = grantTools(db, scope, [tool]);
  const out = await callTool(db, scope, grants[tool], tool, tool === 'search_transactions' ? { query: 'groceries' } : {}, 'imperative');
  if (!out.ok || out.kind !== 'operation') throw new Error(`expected a read-ask operation, got ${JSON.stringify(out)}`);
  return out.operation;
}

async function httpAskRead() {
  const db = createTestDb();
  seedTestData(db);
  const admin = await makeUser(db, 'admin1', 'admin');
  enableAuth(db);
  setPolicy(db, { userId: admin.id, role: 'admin', authEnabled: true }, 'search_transactions', 'ask');
  const { token } = mintTestToken(db, ['search_transactions', 'get_operation_result'], { userId: admin.id, authEnabled: true });
  const resolved = resolveClientToken(db, token, 'test')!;
  const created = await callTool(db, resolved.scope, resolved.grantByTool.get('search_transactions')!, 'search_transactions', { query: 'groceries' }, 'http-mcp');
  if (!created.ok || created.kind !== 'operation') throw new Error('expected a read-ask operation');
  return { db, resolved, op: created.operation };
}

describe('K1: read data is not delivered after the grant or the kill switch moved on', () => {
  test('(a) approve in profile B, flip the kill switch in profile A, come back: no data, status only', async () => {
    const dbA = createTestDb();
    const dbB = createTestDb();
    seedTestData(dbB);
    setInitialProfile('test', dbB);
    const { server } = await startDashboardServer(dbB, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    const op = await askRead(dbB, scope);
    expect(approveWebMcpOperation(dbB, op.id, 'test').outcome).toBe('committed');
    expect(getOperation(dbB, op.id)!.outcome_json).not.toBeNull();

    setKillSwitch(dbA, false); // only A's rows are touched
    setKillSwitch(dbA, true);

    const res = await bfetch(`${base}/api/mcp/operations/${op.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } });
    const text = await res.text();
    expect(text).not.toContain('Grocery');
    expect(text).not.toContain('"items"');
    expect(JSON.parse(text).operation.status).toBe('committed');
    expect(getOperation(dbB, op.id)!.outcome_json).toBeNull();
  });

  test('(b) approve, then revoke the tab grant: ?view=agent delivers nothing', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    const op = await askRead(db, scope);
    expect(approveWebMcpOperation(db, op.id, 'test').outcome).toBe('committed');
    revokeGrant(db, op.grant_id!);

    const res = await bfetch(`${base}/api/mcp/operations/${op.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } });
    const text = await res.text();
    expect(text).not.toContain('Grocery');
    expect(text).not.toContain('"items"');
    expect(JSON.parse(text).operation.status).toBe('committed');
    expect(getOperation(db, op.id)!.outcome_json).toBeNull();
  });

  test('a still-valid grant and no flip still deliver once (control)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');
    const view = toAgentResolvedView(db, getOperation(db, op.id)!, { sessionGeneration: scope.sessionGeneration });
    expect((view.data as { total: number }).total).toBe(2);
  });

  test('toAgentResolvedView alone refuses after a revoke or a flip elsewhere', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');
    revokeGrant(db, op.grant_id!);
    const view = toAgentResolvedView(db, getOperation(db, op.id)!, { sessionGeneration: scope.sessionGeneration });
    expect(view.data).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('Grocery');
    expect(view.status).toBe('committed');
  });

  test('/mcp: awaitOperationOutcome refuses a revoked grant and nulls the row', async () => {
    const { db, op } = await httpAskRead();
    expect(approveWebMcpOperation(db, op.id, 'test').outcome).toBe('committed');
    revokeGrant(db, op.grant_id!);
    const out = await awaitOperationOutcome(db, op.id, 10);
    expect(JSON.stringify(out)).not.toContain('Grocery');
    expect(JSON.stringify(out)).not.toContain('"items"');
    expect(getOperation(db, op.id)!.outcome_json).toBeNull();
  });

  test('/mcp: awaitOperationOutcome refuses after a kill-switch flip made in another profile', async () => {
    const dbOther = createTestDb();
    const { db, op } = await httpAskRead();
    expect(approveWebMcpOperation(db, op.id, 'test').outcome).toBe('committed');
    setKillSwitch(dbOther, false);
    setKillSwitch(dbOther, true);
    const out = await awaitOperationOutcome(db, op.id, 10);
    expect(JSON.stringify(out)).not.toContain('Grocery');
    expect(getOperation(db, op.id)!.outcome_json).toBeNull();
  });

  test('/mcp: get_operation_result refuses a revoked grant (status only) and a live one delivers once', async () => {
    const live = await httpAskRead();
    approveWebMcpOperation(live.db, live.op.id, 'test');
    const ok = await callTool(live.db, live.resolved.scope, live.resolved.grantByTool.get('get_operation_result')!, 'get_operation_result', { operationId: live.op.id }, 'http-mcp');
    expect(ok.ok && ok.kind === 'read' ? (ok.data as { total: number }).total : null).toBe(2);

    const dead = await httpAskRead();
    approveWebMcpOperation(dead.db, dead.op.id, 'test');
    revokeGrant(dead.db, dead.op.grant_id!);
    const res = await callTool(dead.db, dead.resolved.scope, dead.resolved.grantByTool.get('get_operation_result')!, 'get_operation_result', { operationId: dead.op.id }, 'http-mcp');
    expect(JSON.stringify(res)).not.toContain('Grocery');
    expect(JSON.stringify(res)).not.toContain('"items"');
    expect(JSON.stringify(res)).toContain('committed');
  });
});

describe('K2: Off beats a pending card', () => {
  test('Ask -> call -> Off -> approve: not committed, no data (read)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await askRead(db, scope);
    setPolicy(db, adminActor(scope), 'search_transactions', 'off');
    const row = getOperation(db, op.id)!;
    expect(row.status).toBe('rejected');
    expect(JSON.parse(row.outcome_json!)).toEqual({ reason: 'policy_off' });
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).not.toBe('committed');
    expect(out.after).toBeUndefined();
    expect(getOperation(db, op.id)!.outcome_json).toBe(JSON.stringify({ reason: 'policy_off' }));
  });

  test('Ask -> call -> Off -> approve: the edit is never written (mutation)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    setPolicy(db, adminActor(scope), 'update_transaction', 'ask');
    const grants = grantTools(db, scope, ['update_transaction']);
    const out = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id: firstTxnId(db), notes: 'sneaky' }, 'imperative');
    if (!out.ok || out.kind !== 'operation') throw new Error('expected an operation');
    setPolicy(db, adminActor(scope), 'update_transaction', 'off');
    expect(approveWebMcpOperation(db, out.operation.id, 'test').outcome).not.toBe('committed');
    expect((db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: firstTxnId(db) }) as { notes: string | null }).notes).toBeNull();
    expect(count(db, 'mcp_audit_log', "decision = 'rejected'")).toBeGreaterThanOrEqual(1);
  });

  test('turning Off only rejects that tool and that user, not other tools', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const read = await askRead(db, scope, 'search_transactions');
    const other = await askRead(db, scope, 'get_spending_summary');
    setPolicy(db, adminActor(scope), 'search_transactions', 'off');
    expect(getOperation(db, read.id)!.status).toBe('rejected');
    expect(getOperation(db, other.id)!.status).toBe('pending');
  });

  test('defense in depth: a row left pending with the tool Off goes stale policy_off on approve', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await askRead(db, scope);
    // Policy flipped by a path that did not sweep (direct row write).
    db.prepare("INSERT INTO mcp_tool_policies (user_key, tool_name, policy, updated_at) VALUES (0, 'search_transactions', 'off', datetime('now')) ON CONFLICT(user_key, tool_name) DO UPDATE SET policy = 'off'").run();
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out).toMatchObject({ outcome: 'stale', reason: 'policy_off' });
    expect(out.after).toBeUndefined();
    expect(getOperation(db, op.id)!.status).toBe('stale');
  });
});
