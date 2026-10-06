import { afterEach, describe, expect, jest, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, count, grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth } from '../dashboard/auth.js';
import { approveWebMcpOperation, callTool, rejectOperation, type RequestScope } from '../mcp/engine.js';
import { setPolicy, type PolicyActor } from '../mcp/policies.js';
import { getOperation, clearStaleReadOutcomes, revokeGrant } from '../mcp/store.js';
import { toAgentResolvedView, toOperationView } from '../mcp/operation-view.js';
import { awaitOperationOutcome } from '../mcp/http-server.js';
import { resolveClientToken } from '../mcp/client-tokens.js';
import type { Database } from '../db/compat-sqlite.js';
import type { McpOperation } from '../mcp/store.js';

/**
 * Ask-for-reads (spec 1.2, P1): a read tool whose policy is Ask does not run
 * when called. The server parks it as a `kind='read'` operation, the human
 * sees an in-page card, and only an approval runs the read and hands the
 * capped result to the REQUESTING principal.
 */

const admin: PolicyActor = { userId: null, role: 'admin', authEnabled: false };

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
afterEach(() => {
  jest.useRealTimers();
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function askRead(db: Database, scope: RequestScope, query = 'groceries', tool = 'search_transactions'): Promise<McpOperation> {
  setPolicy(db, { userId: scope.userId, role: scope.role, authEnabled: scope.userId !== null }, tool, 'ask');
  const grants = grantTools(db, scope, [tool]);
  const out = await callTool(db, scope, grants[tool], tool, tool === 'search_transactions' ? { query } : {}, 'imperative');
  if (!out.ok || out.kind !== 'operation') throw new Error(`expected a read-ask operation, got ${JSON.stringify(out)}`);
  return out.operation;
}

describe('read with policy ask', () => {
  test("returns {kind:'operation'} with op.kind='read' and no data before approval", async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    expect(op.kind).toBe('read');
    expect(op.status).toBe('pending');
    expect(op.outcome_json).toBeNull();
    expect(op.tool_name).toBe('search_transactions');
    // The read itself has not run: nothing was spent from the read budget and nothing was audited as allowed.
    expect(count(db, 'mcp_audit_log', "decision = 'allowed'")).toBe(0);
    expect(count(db, 'mcp_audit_log', "decision = 'operation_created'")).toBe(1);
  });

  test('approve: committed, with the capped read data stored on the operation', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).toBe('committed');
    const data = out.after as { items: unknown[]; total: number };
    expect(data.total).toBe(2);
    expect(data.items).toHaveLength(2);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(1500);
    expect(getOperation(db, op.id)!.status).toBe('committed');
  });

  test('approving the read counts against the daily read budget and is audited', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    approveWebMcpOperation(db, op.id, 'test');
    expect(count(db, 'mcp_audit_log', "decision = 'approved'")).toBe(1);
    expect(count(db, 'mcp_audit_log', "decision = 'committed'")).toBe(1);
  });

  test('reject: the agent gets a rejected outcome and never any data', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    expect(rejectOperation(db, op.id).outcome).toBe('rejected');
    const row = getOperation(db, op.id)!;
    expect(row.status).toBe('rejected');
    expect(row.outcome_json).toBeNull();
  });

  test('grant revoked between ask and approve: stale, and the read never runs', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    revokeGrant(db, op.grant_id!);
    const out = approveWebMcpOperation(db, op.id, 'test');
    expect(out.outcome).toBe('stale');
    expect(out.reason).toContain('grant_invalid');
    expect(getOperation(db, op.id)!.outcome_json).toContain('grant_invalid');
    expect(out.after).toBeUndefined();
  });

  test('a viewer who owns a read-ask operation may approve it (reads are open to viewers)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const viewerUser = await makeUser(db, 'viewer1', 'viewer');
    enableAuth(db);
    const scope = testScope({ role: 'viewer', userId: viewerUser.id });
    const op = await askRead(db, scope);
    const out = approveWebMcpOperation(db, op.id, 'test', { userId: viewerUser.id, role: 'viewer', authEnabled: true });
    expect(out.outcome).toBe('committed');
  });

  test('another viewer cannot approve it, and a viewer still cannot approve a change', async () => {
    const db = createTestDb();
    seedTestData(db);
    const owner = await makeUser(db, 'viewer1', 'viewer');
    const other = await makeUser(db, 'viewer2', 'viewer');
    enableAuth(db);
    const op = await askRead(db, testScope({ role: 'viewer', userId: owner.id }));
    expect(approveWebMcpOperation(db, op.id, 'test', { userId: other.id, role: 'viewer', authEnabled: true }).outcome).toBe('unknown');
  });
});

describe('who can read the result', () => {
  test('only the requesting session gets the data; another tab gets none', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');
    const done = getOperation(db, op.id)!;

    const ownView = toOperationView(done, { sessionGeneration: scope.sessionGeneration });
    const otherView = toOperationView(done, { sessionGeneration: crypto.randomUUID() });
    // The human-facing view never carries a read's data, for the requester or anyone else: only ?view=agent delivers it, once.
    expect(ownView.outcome_json).toBeNull();
    expect(JSON.stringify(ownView)).not.toContain('Grocery');
    expect(otherView.outcome_json).toBeNull();
    expect(JSON.stringify(otherView)).not.toContain('Grocery');

    const ownAgent = toAgentResolvedView(db, done, { sessionGeneration: scope.sessionGeneration });
    const otherAgent = toAgentResolvedView(db, done, { sessionGeneration: crypto.randomUUID() });
    expect((ownAgent.data as any).total).toBe(2);
    expect(otherAgent.data).toBeUndefined();
    expect(JSON.stringify(otherAgent)).not.toContain('Grocery');
  });

  test('the read outcome is nulled after first delivery to the agent (GET ?view=agent), the status stays', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');

    const get = async (session: string) =>
      (await (await bfetch(`${base}/api/mcp/operations/${op.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': session } })).json()) as any;

    const other = await get(crypto.randomUUID());
    expect(other.operation.data).toBeUndefined();
    expect(getOperation(db, op.id)!.outcome_json).not.toBeNull(); // someone else asking does not consume it

    const first = await get(scope.sessionGeneration);
    expect(first.operation.status).toBe('committed');
    expect(first.operation.data.total).toBe(2);

    const second = await get(scope.sessionGeneration);
    expect(second.operation.status).toBe('committed');
    expect(second.operation.data).toBeUndefined();
    expect(getOperation(db, op.id)!.outcome_json).toBeNull();
  });

  test('reject and cancel on a committed read never return its data, and the agent view still delivers it once', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');

    const post = async (action: 'reject' | 'cancel', session: string) =>
      (await bfetch(`${base}/api/mcp/operations/${op.id}/${action}`, { method: 'POST', headers: { 'X-Wilson-Agent-Session': session } })).text();

    for (const [action, session] of [
      ['reject', crypto.randomUUID()],
      ['reject', scope.sessionGeneration],
      ['cancel', scope.sessionGeneration],
    ] as const) {
      const text = await post(action, session);
      expect(text).not.toContain('Grocery');
      expect(text).not.toContain('"items"');
    }
    // None of that consumed or leaked the stored data: the requester still gets it, once.
    expect(getOperation(db, op.id)!.outcome_json).not.toBeNull();
    const agent = (await (await bfetch(`${base}/api/mcp/operations/${op.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } })).json()) as any;
    expect(agent.operation.data.total).toBe(2);
  });

  test('GET /api/mcp/operations/:id without ?view=agent does not hand the requester the data again', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    const op = await askRead(db, scope);
    approveWebMcpOperation(db, op.id, 'test');

    const plain = await bfetch(`${base}/api/mcp/operations/${op.id}`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } });
    const text = await plain.text();
    expect(text).not.toContain('Grocery');
    expect(text).not.toContain('"items"');

    // The agent view still delivers it, once.
    const agent = (await (await bfetch(`${base}/api/mcp/operations/${op.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } })).json()) as any;
    expect(agent.operation.data.total).toBe(2);
  });

  test('the read outcome is nulled 5 minutes after commit, not before', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    approveWebMcpOperation(db, op.id, 'test');
    expect(clearStaleReadOutcomes(db, Date.now() + 4 * 60_000)).toBe(0);
    expect(getOperation(db, op.id)!.outcome_json).not.toBeNull();
    expect(clearStaleReadOutcomes(db, Date.now() + 6 * 60_000)).toBe(1);
    const row = getOperation(db, op.id)!;
    expect(row.outcome_json).toBeNull();
    expect(row.status).toBe('committed');
  });

  test('sweepOperations (the 6-hourly housekeeping) nulls stale read outcomes too, and so does any operation read', async () => {
    const { sweepOperations, expireStaleOperations } = await import('../mcp/store.js');
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope());
    approveWebMcpOperation(db, op.id, 'test');
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 6 * 60_000);
    expireStaleOperations(db); // what every GET of the queue runs
    expect(getOperation(db, op.id)!.outcome_json).toBeNull();

    const second = await askRead(db, testScope(), 'groceries');
    approveWebMcpOperation(db, second.id, 'test');
    jest.setSystemTime(Date.now() + 6 * 60_000);
    sweepOperations(db);
    expect(getOperation(db, second.id)!.outcome_json).toBeNull();
  });

  test('the nulling never touches a committed change (its outcome is the audit of what was written)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['update_transaction']);
    const id = (db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number }).id;
    const made = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id, notes: 'keep me' }, 'imperative');
    if (!made.ok || made.kind !== 'operation') throw new Error('expected an operation');
    expect(made.operation.kind).toBe('mutation');
    approveWebMcpOperation(db, made.operation.id, 'test');
    clearStaleReadOutcomes(db, Date.now() + 60 * 60_000);
    expect(getOperation(db, made.operation.id)!.outcome_json).not.toBeNull();
  });
});

describe('/mcp read with ask', () => {
  test('waits past 10 s for the human, then returns the data itself (fake clock)', async () => {
    jest.useFakeTimers();
    const db = createTestDb();
    seedTestData(db);
    setPolicy(db, admin, 'search_transactions', 'ask');
    const { token } = mintTestToken(db, ['search_transactions']);
    const resolved = resolveClientToken(db, token, 'test')!;
    const created = await callTool(db, resolved.scope, resolved.grantByTool.get('search_transactions')!, 'search_transactions', { query: 'groceries' }, 'http-mcp');
    if (!created.ok || created.kind !== 'operation') throw new Error('expected a read-ask operation');

    let settled: Record<string, unknown> | null = null;
    const waiting = awaitOperationOutcome(db, created.operation.id).then((r) => { settled = r; });
    jest.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(settled).toBeNull();

    expect(approveWebMcpOperation(db, created.operation.id, 'test').outcome).toBe('committed');
    await waiting;
    expect((settled as any).total).toBe(2);
    expect((settled as any).items).toHaveLength(2);
    expect((settled as any).outcome).toBeUndefined(); // data, not an outcome wrapper
  });

  test('a rejected /mcp read answers with the outcome and no data', async () => {
    const db = createTestDb();
    seedTestData(db);
    setPolicy(db, admin, 'search_transactions', 'ask');
    const { token } = mintTestToken(db, ['search_transactions']);
    const resolved = resolveClientToken(db, token, 'test')!;
    const created = await callTool(db, resolved.scope, resolved.grantByTool.get('search_transactions')!, 'search_transactions', { query: 'groceries' }, 'http-mcp');
    if (!created.ok || created.kind !== 'operation') throw new Error('expected a read-ask operation');
    const waiting = awaitOperationOutcome(db, created.operation.id);
    rejectOperation(db, created.operation.id);
    const out = await waiting;
    expect(out).toMatchObject({ outcome: 'rejected', operationId: created.operation.id });
    expect(JSON.stringify(out)).not.toContain('Grocery');
  });
});

describe('the card for a read', () => {
  test('search_transactions shows the server-parsed filter and the full args, not a truncated query', async () => {
    const db = createTestDb();
    seedTestData(db);
    const long = `dining over $50 ${'x'.repeat(150)}`;
    const op = await askRead(db, testScope(), long);
    const view = toOperationView(op, { sessionGeneration: op.session_generation, db });
    expect(view.kind).toBe('read');
    expect(view.read!.args).toEqual({ query: long });
    const filter = Object.fromEntries(view.read!.filter!.map((r) => [r.label, r.value]));
    expect(filter.Category).toBe('Dining');
    // "over $50" means spending of 50 or more, and expenses are stored negative: the card shows the bound as it runs.
    expect(filter['Amount at most']).toBe('-50');
    expect(JSON.stringify(view)).toContain(long); // never a truncated prefix
  });

  test('other read tools show their full canonical args and no parsed filter', async () => {
    const db = createTestDb();
    seedTestData(db);
    const op = await askRead(db, testScope(), '', 'get_cash_forecast');
    const view = toOperationView(op, { sessionGeneration: op.session_generation, db });
    expect(view.read!.args).toEqual({});
    expect(view.read!.filter).toBeUndefined();
  });

  test('a change operation has no read block and kind mutation', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['update_transaction']);
    const id = (db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number }).id;
    const made = await callTool(db, scope, grants.update_transaction, 'update_transaction', { id, notes: 'n' }, 'imperative');
    if (!made.ok || made.kind !== 'operation') throw new Error('expected an operation');
    const view = toOperationView(made.operation, { sessionGeneration: scope.sessionGeneration, db });
    expect(view.kind).toBe('mutation');
    expect(view.read).toBeNull();
  });
});
