import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { count, firstTxnId, grantTools, makeUser, mintTestToken, testScope, bfetch } from './mcp-helpers.js';
import { approveWebMcpOperation, callTool, cancelOperation, rejectOperation } from '../mcp/engine.js';
import { enableAuth } from '../dashboard/auth.js';
import { resolveClientToken } from '../mcp/client-tokens.js';
import { awaitOperationOutcome } from '../mcp/http-server.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { callServerToolAnswer, createOperationLedger, SESSION_HEADER, type ServerCallDeps } from '../dashboard/webmcp-bridge-core.js';
import { JUDGE_RUBRIC_VERSION } from '../training/judge-rubric.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Agents with a short tool-call timeout (~30 s) call a write, Wilson parks it behind a card, the client times out and
 * RETRIES the identical call. That retry must not stack a second card: it joins the pending operation, waits on the same
 * decision and gets the same outcome and operation id. Once the operation is decided, an identical call is a new request.
 */

const ops = (db: Database) => count(db, 'mcp_operations');
const auditRows = (db: Database, decision: string) =>
  db.prepare('SELECT * FROM mcp_audit_log WHERE decision = @decision ORDER BY id').all({ decision }) as Array<{ operation_id: string | null; tool_name: string }>;

function tabSetup() {
  const db = createTestDb();
  seedTestData(db);
  const scope = testScope();
  const grants = grantTools(db, scope, ['update_transaction']);
  const txnId = firstTxnId(db);
  const call = (args: Record<string, unknown>, s = scope) => callTool(db, s, grants.update_transaction, 'update_transaction', args, 'imperative');
  return { db, scope, grants, txnId, call };
}

function opOf(result: Awaited<ReturnType<typeof callTool>>) {
  if (!result.ok || result.kind !== 'operation') throw new Error(`expected an operation, got ${JSON.stringify(result)}`);
  return result.operation;
}

describe('identical calls while pending join one operation (engine)', () => {
  test('two identical calls -> one operation row, one card, the same id; a joined audit row names it', async () => {
    const { db, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'retry me' }));
    // Same arguments, different key order: canonical JSON makes them identical.
    const second = opOf(await call({ notes: 'retry me', id: txnId }));
    expect(second.id).toBe(first.id);
    expect(ops(db)).toBe(1);
    expect(count(db, 'mcp_operations', "status = 'pending'")).toBe(1);
    expect(auditRows(db, 'operation_created').map((r) => r.operation_id)).toEqual([first.id]);
    expect(auditRows(db, 'operation_joined').map((r) => r.operation_id)).toEqual([first.id]);
  });

  test('different args -> two operations', async () => {
    const { db, txnId, call } = tabSetup();
    const a = opOf(await call({ id: txnId, notes: 'one' }));
    const b = opOf(await call({ id: txnId, notes: 'two' }));
    expect(a.id).not.toBe(b.id);
    expect(ops(db)).toBe(2);
    expect(auditRows(db, 'operation_joined')).toEqual([]);
  });

  test('another user, or another profile, never joins', async () => {
    const db = createTestDb();
    seedTestData(db);
    const txnId = firstTxnId(db);
    const a = testScope({ profile: 'test' });
    const b = testScope({ profile: 'other' });
    const ga = grantTools(db, a, ['update_transaction']);
    const gb = grantTools(db, b, ['update_transaction']);
    const one = opOf(await callTool(db, a, ga.update_transaction, 'update_transaction', { id: txnId, notes: 'p' }, 'imperative'));
    const two = opOf(await callTool(db, b, gb.update_transaction, 'update_transaction', { id: txnId, notes: 'p' }, 'imperative'));
    expect(one.id).not.toBe(two.id);
    expect(ops(db)).toBe(2);
  });

  test('an identical call after the first was decided creates a new operation', async () => {
    const { db, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'again' }));
    expect(rejectOperation(db, first.id).outcome).toBe('rejected');
    const second = opOf(await call({ id: txnId, notes: 'again' }));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');

    expect(approveWebMcpOperation(db, second.id, 'test').outcome).toBe('committed');
    const third = opOf(await call({ id: txnId, notes: 'again' }));
    expect(third.id).not.toBe(second.id);
    expect(ops(db)).toBe(3);
  });

  test('an expired operation is not joined', async () => {
    const { db, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'late' }));
    db.prepare("UPDATE mcp_operations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = @id").run({ id: first.id });
    const second = opOf(await call({ id: txnId, notes: 'late' }));
    expect(second.id).not.toBe(first.id);
  });

  test('a join is not refused by the pending-approvals cap (it adds no card)', async () => {
    const { db, txnId, call } = tabSetup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call({ id: txnId, notes: `n${i}` });
      if (r.ok && r.kind === 'operation') ids.push(r.operation.id);
    }
    // Whatever the cap is, an identical retry of the first one still joins it.
    const again = opOf(await call({ id: txnId, notes: 'n0' }));
    expect(again.id).toBe(ids[0]);
  });

  test("the original caller's withdrawal leaves the card for the joined retry, which the decision resolves", async () => {
    const { db, scope, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'keep' }));
    opOf(await call({ id: txnId, notes: 'keep' }));
    // The first call's execute was aborted (client timeout): its tab withdraws it.
    expect(cancelOperation(db, scope, first.id)?.outcome).toBe('cancelled');
    expect(count(db, 'mcp_operations', "status = 'pending'")).toBe(1);
    expect(rejectOperation(db, first.id).outcome).toBe('rejected');
  });

  test('when every attached caller withdraws, the operation is withdrawn', async () => {
    const { db, scope, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'gone' }));
    opOf(await call({ id: txnId, notes: 'gone' }));
    cancelOperation(db, scope, first.id);
    expect(cancelOperation(db, scope, first.id)?.outcome).toBe('cancelled');
    const row = db.prepare('SELECT status, outcome_json FROM mcp_operations WHERE id = @id').get({ id: first.id }) as any;
    expect(row.status).toBe('rejected');
    expect(row.outcome_json).toContain('cancelled_by_agent');
  });

  test('a session that neither created nor joined it still cannot withdraw it', async () => {
    const { db, scope, txnId, call } = tabSetup();
    const first = opOf(await call({ id: txnId, notes: 'mine' }));
    expect(cancelOperation(db, { ...scope, sessionGeneration: crypto.randomUUID() }, first.id)).toBeNull();
    expect(count(db, 'mcp_operations', "status = 'pending'")).toBe(1);
  });
});

describe('proposals (propose_judgments, policy Ask) join too', () => {
  test('a retried propose_judgments joins the open card; approving inserts the proposals once', async () => {
    const db = createTestDb();
    const scope = testScope();
    const grants = grantTools(db, scope, ['propose_judgments']);
    const interactionId = (db.prepare(
      "INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, response_content, status) VALUES ('r1', 1, 'agent', 'gpt-4', 'openai', 'Q', 'A', 'ok')"
    ).run() as { lastInsertRowid: number }).lastInsertRowid as number;
    const args = { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [{ interactionId, rating: 4, rationale: 'grounded: matches the tool result' }] };
    const call = () => callTool(db, scope, grants.propose_judgments, 'propose_judgments', args, 'imperative');
    const first = opOf(await call());
    const second = opOf(await call());
    expect(second.id).toBe(first.id);
    expect(ops(db)).toBe(1);
    expect(approveWebMcpOperation(db, first.id, 'test').outcome).toBe('committed');
    expect(count(db, 'interaction_annotations')).toBe(1);
    // Decided: the same proposal again is a new card.
    expect(opOf(await call()).id).not.toBe(first.id);
  });
});

describe('identical calls join on /mcp (http-mcp)', () => {
  async function httpSetup() {
    const db = createTestDb();
    seedTestData(db);
    const admin = await makeUser(db, 'admin1', 'admin');
    enableAuth(db);
    const { token } = mintTestToken(db, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true });
    const resolved = resolveClientToken(db, token, 'test')!;
    const txnId = firstTxnId(db);
    const call = (r = resolved) => callTool(db, r.scope, r.grantByTool.get('update_transaction')!, 'update_transaction', { id: txnId, notes: 'via mcp' }, 'http-mcp');
    return { db, admin, resolved, call };
  }

  test('approve: both waiting callers get committed with the same operationId; one row', async () => {
    const { db, call } = await httpSetup();
    const a = opOf(await call());
    const waitA = awaitOperationOutcome(db, a.id, 5_000);
    const b = opOf(await call());
    const waitB = awaitOperationOutcome(db, b.id, 5_000);
    expect(b.id).toBe(a.id);
    expect(ops(db)).toBe(1);
    expect(approveWebMcpOperation(db, a.id, 'test').outcome).toBe('committed');
    const [outA, outB] = await Promise.all([waitA, waitB]);
    expect(outA).toMatchObject({ outcome: 'committed', operationId: a.id });
    expect(outB).toMatchObject({ outcome: 'committed', operationId: a.id });
    expect(outB).toEqual(outA);
  });

  test("reject: the retry resolves even though the first caller's wait already timed out", async () => {
    const { db, call } = await httpSetup();
    const a = opOf(await call());
    // The client gave up on its first call: its wait ends with `unknown`, the card stays open.
    expect(await awaitOperationOutcome(db, a.id, 10)).toMatchObject({ outcome: 'unknown', operationId: a.id });
    const b = opOf(await call());
    expect(b.id).toBe(a.id);
    const waitB = awaitOperationOutcome(db, b.id, 5_000);
    expect(rejectOperation(db, a.id).outcome).toBe('rejected');
    expect(await waitB).toMatchObject({ outcome: 'rejected', operationId: a.id });
    expect(ops(db)).toBe(1);
    expect(auditRows(db, 'operation_joined').map((r) => r.operation_id)).toEqual([a.id]);
  });

  test('a second client token that joined can read the outcome with get_operation_result', async () => {
    const { db, admin, resolved, call } = await httpSetup();
    const other = resolveClientToken(db, mintTestToken(db, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true, name: 'other' }).token, 'test')!;
    const a = opOf(await call(resolved));
    const b = opOf(await call(other));
    expect(b.id).toBe(a.id);
    rejectOperation(db, a.id);
    const read = await callTool(db, other.scope, other.grantByTool.get('get_operation_result')!, 'get_operation_result', { operationId: a.id }, 'http-mcp');
    expect(read.ok).toBe(true);
    if (read.ok && read.kind === 'read') expect(read.data).toMatchObject({ operationId: a.id, outcome: 'rejected' });
  });
});

describe('identical calls join on the in-page WebMCP path (real server, bridge client)', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    const base = `http://localhost:${result.server.port}`;
    const session = crypto.randomUUID();
    const grantRes = await bfetch(`${base}/api/mcp/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SESSION_HEADER]: session },
      body: JSON.stringify({ tools: ['update_transaction'] }),
    });
    const grantId = ((await grantRes.json()) as any).grants[0].id as string;
    const ledger = createOperationLedger();
    const deps: ServerCallDeps = {
      fetch: ((url: string, init?: RequestInit) => bfetch(base + url, init)) as ServerCallDeps['fetch'],
      sessionGeneration: session,
      authHeaders: () => ({}),
      pollIntervalMs: 20,
      timeoutMs: 10_000,
      ledger,
    };
    const txnId = firstTxnId(db);
    const call = (signal?: AbortSignal) =>
      callServerToolAnswer(deps, { grantId, tool: 'update_transaction', args: { id: txnId, notes: 'tab' }, transport: 'imperative', agentCall: ledger.beginCall('update_transaction') }, signal);
    const pendingIds = () => (db.prepare("SELECT id FROM mcp_operations WHERE status = 'pending'").all() as Array<{ id: string }>).map((r) => r.id);
    const decide = (id: string, verb: 'approve' | 'reject') =>
      bfetch(`${base}/api/mcp/operations/${id}/${verb}`, { method: 'POST', headers: { [SESSION_HEADER]: session } });
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    return { db, base, call, pendingIds, decide, until };
  }

  test('approve: two identical calls -> one card; both get committed with the same operationId', async () => {
    const { db, call, pendingIds, decide, until } = await start();
    const first = call();
    await until(() => pendingIds().length === 1);
    const second = call();
    await until(() => count(db, 'mcp_audit_log', "decision = 'operation_joined'") === 1);
    expect(count(db, 'mcp_operations')).toBe(1);
    const [id] = pendingIds();
    expect((await decide(id, 'approve')).status).toBe(200);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ type: 'value', value: expect.objectContaining({ outcome: 'committed', operationId: id }) });
    expect(b).toEqual({ type: 'value', value: expect.objectContaining({ outcome: 'committed', operationId: id }) });
    expect(count(db, 'mcp_operations')).toBe(1);
  });

  test("reject: the first call aborted (client timeout), the joined retry still gets the decision", async () => {
    const { db, call, pendingIds, decide, until } = await start();
    const controller = new AbortController();
    const first = call(controller.signal).catch((e: unknown) => e);
    await until(() => pendingIds().length === 1);
    const second = call();
    await until(() => count(db, 'mcp_audit_log', "decision = 'operation_joined'") === 1);
    const [id] = pendingIds();

    controller.abort();
    expect(((await first) as Error).name).toBe('AbortError');
    // The aborted caller let go; the card is still open for the retry.
    await until(() => count(db, 'mcp_audit_log', "decision = 'cancelled'") === 1);
    expect(pendingIds()).toEqual([id]);

    expect((await decide(id, 'reject')).status).toBe(200);
    expect(await second).toEqual({ type: 'value', value: expect.objectContaining({ outcome: 'rejected', operationId: id }) });
    expect(count(db, 'mcp_operations')).toBe(1);
  });
});
