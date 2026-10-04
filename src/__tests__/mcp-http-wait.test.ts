import { describe, expect, test, afterEach, jest } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { firstTxnId, makeUser, mintTestToken } from './mcp-helpers.js';
import { enableAuth } from '../dashboard/auth.js';
import { callTool, approveWebMcpOperation } from '../mcp/engine.js';
import { resolveClientToken } from '../mcp/client-tokens.js';
import { MUTATION_APPROVAL_WAIT_MS, awaitOperationOutcome } from '../mcp/http-server.js';
import { DASHBOARD_IDLE_TIMEOUT_S } from '../dashboard/server.js';

/**
 * A `/mcp` write call holds its connection open while a human answers the
 * card. Bun's idle timeout is 255 s at most, so the wait is capped at 240 s and
 * the client reconciles with `get_operation_result` afterwards.
 */

afterEach(() => {
  jest.useRealTimers();
});

async function pendingOperation() {
  const db = createTestDb();
  seedTestData(db);
  const admin = await makeUser(db, 'admin1', 'admin');
  enableAuth(db);
  const { token } = mintTestToken(db, ['update_transaction', 'get_operation_result'], { userId: admin.id, authEnabled: true });
  const resolved = resolveClientToken(db, token, 'test')!;
  const created = await callTool(db, resolved.scope, resolved.grantByTool.get('update_transaction')!, 'update_transaction', { id: firstTxnId(db), notes: 'wait' }, 'http-mcp');
  if (!created.ok || created.kind !== 'operation') throw new Error('expected a pending operation');
  return { db, operationId: created.operation.id };
}

describe('/mcp approval wait', () => {
  test('the wait is 240 s, inside the 255 s server idle timeout', () => {
    expect(MUTATION_APPROVAL_WAIT_MS).toBe(240_000);
    expect(DASHBOARD_IDLE_TIMEOUT_S).toBe(255);
    expect(MUTATION_APPROVAL_WAIT_MS / 1000).toBeLessThan(DASHBOARD_IDLE_TIMEOUT_S);
  });

  test("a mutation wait returns {outcome:'unknown', operationId} at 240 s, not before", async () => {
    jest.useFakeTimers();
    const { db, operationId } = await pendingOperation();
    let settled: Record<string, unknown> | null = null;
    const waiting = awaitOperationOutcome(db, operationId).then((r) => { settled = r; });

    jest.advanceTimersByTime(MUTATION_APPROVAL_WAIT_MS - 1_000);
    await Promise.resolve();
    expect(settled).toBeNull();

    jest.advanceTimersByTime(1_000);
    await waiting;
    expect(settled).toMatchObject({ outcome: 'unknown', operationId });
    expect((settled as any).reason).toContain('get_operation_result');
  });

  test('a human answering inside the window ends the wait with the real outcome', async () => {
    const { db, operationId } = await pendingOperation();
    const waiting = awaitOperationOutcome(db, operationId);
    expect(approveWebMcpOperation(db, operationId, 'test').outcome).toBe('committed');
    const out = await waiting;
    expect(out).toMatchObject({ outcome: 'committed', operationId });
  });

  test('an operation whose window closed answers expired, not unknown', async () => {
    const { db, operationId } = await pendingOperation();
    db.prepare("UPDATE mcp_operations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = @id").run({ id: operationId });
    const out = await awaitOperationOutcome(db, operationId, 10);
    expect(out).toMatchObject({ outcome: 'expired', operationId });
  });
});
