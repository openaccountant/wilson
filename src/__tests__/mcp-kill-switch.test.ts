import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, seedTestData, ensureTestProfile, testAgentAccessFile } from './helpers.js';
import { bfetch, count, firstTxnId, grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth, verifyLogin } from '../dashboard/auth.js';
import { approveWebMcpOperation, callTool, exposedTools, grantLocalAccess, listActiveGrants, setKillSwitch } from '../mcp/engine.js';
import { setPolicy } from '../mcp/policies.js';
import { toAgentResolvedView } from '../mcp/operation-view.js';
import { awaitOperationOutcome } from '../mcp/http-server.js';
import { getGrant, getOperation, validateGrant } from '../mcp/store.js';
import { schemaDigest } from '../mcp/tool-catalog.js';
import { listClientTokens, mintClientToken, resolveClientToken, updateClientTokenTools } from '../mcp/client-tokens.js';
import { handleMcpHttpRequest } from '../mcp/http-server.js';
import {
  DEFAULT_AGENT_ACCESS_FILE,
  getGlobalAgentState,
  getKillSwitchEpoch,
  isAgentAccessEnabled,
  setGlobalAgentState,
  setGlobalStateFile,
} from '../mcp/global-state.js';
import { OA_ROOT, resolveProfile } from '../profile/context.js';
import { resetActiveProfile } from '../profile/active.js';

/**
 * P1 global kill switch (spec Decisions, T35): process-global, kept in
 * agent-access.json (never a profile's settings.json), enforced in callTool,
 * and backed by killSwitchEpoch so grants left in other profiles stay dead.
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

async function pendingEdit(db: ReturnType<typeof createTestDb>, scope = testScope()) {
  const grants = grantTools(db, scope, ['edit_transaction', 'transaction_search']);
  const out = await callTool(db, scope, grants.edit_transaction, 'edit_transaction', { id: firstTxnId(db), notes: 'ks' }, 'imperative');
  if (!out.ok || out.kind !== 'operation') throw new Error('expected a pending operation');
  return { scope, grants, op: out.operation };
}

describe('switching agent access off', () => {
  test('exposedTools is [] and callTool answers 403 kill_switch', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    expect(exposedTools(db, scope)).toHaveLength(1);

    setKillSwitch(db, false);
    expect(exposedTools(db, scope)).toEqual([]);
    const out = await callTool(db, scope, grants.transaction_search, 'transaction_search', { query: 'x' }, 'imperative');
    expect(out).toMatchObject({ ok: false, status: 403, code: 'kill_switch' });
    expect(count(db, 'mcp_audit_log', "decision = 'denied_kill_switch'")).toBe(1);
  });

  test('a grant POST is refused while it is off', () => {
    const db = createTestDb();
    setKillSwitch(db, false);
    expect(grantLocalAccess(db, testScope(), ['transaction_search'])).toMatchObject({ ok: false, status: 403, code: 'kill_switch' });
    expect(count(db, 'mcp_grants')).toBe(0);
  });

  test('it revokes every active grant and rejects pending operations with reason kill_switch', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { op, grants } = await pendingEdit(db);
    const result = setKillSwitch(db, false);
    expect(result.revokedGrants).toBeGreaterThanOrEqual(2);
    expect(result.rejectedOperations).toBe(1);
    expect(getGrant(db, grants.transaction_search)!.revoked_at).not.toBeNull();
    const row = getOperation(db, op.id)!;
    expect(row.status).toBe('rejected');
    expect(JSON.parse(row.outcome_json!)).toEqual({ reason: 'kill_switch' });
    expect((db.prepare('SELECT notes FROM transactions WHERE id = @id').get({ id: firstTxnId(db) }) as any).notes).toBeNull();
  });

  test('an approved read-ask that was not yet fetched is not delivered after the switch is off', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const scope = testScope();
    setPolicy(db, { userId: null, role: 'admin', authEnabled: false }, 'transaction_search', 'ask');
    const grants = grantTools(db, scope, ['transaction_search']);
    const out = await callTool(db, scope, grants.transaction_search, 'transaction_search', { query: 'groceries' }, 'imperative');
    if (!out.ok || out.kind !== 'operation') throw new Error('expected a read-ask operation');
    expect(approveWebMcpOperation(db, out.operation.id, 'test').outcome).toBe('committed');
    expect(getOperation(db, out.operation.id)!.outcome_json).not.toBeNull();

    setKillSwitch(db, false);
    expect(getOperation(db, out.operation.id)!.outcome_json).toBeNull();
    const res = await bfetch(`${base}/api/mcp/operations/${out.operation.id}?view=agent`, { headers: { 'X-Wilson-Agent-Session': scope.sessionGeneration } });
    const text = await res.text();
    expect(text).not.toContain('Grocery');
    expect(text).not.toContain('"items"');
  });

  test('the delivery paths themselves refuse while it is off, even with a row left behind', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    setPolicy(db, { userId: null, role: 'admin', authEnabled: false }, 'transaction_search', 'ask');
    const grants = grantTools(db, scope, ['transaction_search']);
    const out = await callTool(db, scope, grants.transaction_search, 'transaction_search', { query: 'groceries' }, 'imperative');
    if (!out.ok || out.kind !== 'operation') throw new Error('expected a read-ask operation');
    approveWebMcpOperation(db, out.operation.id, 'test');
    // The switch flipped from another process (agent-access.json), so this db's rows were not cleaned.
    setGlobalAgentState({ enabled: false });
    const done = getOperation(db, out.operation.id)!;
    expect(toAgentResolvedView(db, done, { sessionGeneration: scope.sessionGeneration }).data).toBeUndefined();
    expect(JSON.stringify(await awaitOperationOutcome(db, out.operation.id, 10))).not.toContain('Grocery');
  });

  test('a client token cannot be minted or edited while it is off: kill_switch, not a policy message', () => {
    const db = createTestDb();
    const { id } = mintTestToken(db, ['transaction_search']);
    const viewer = { userId: null, role: 'admin' as const, authEnabled: false };
    setKillSwitch(db, false);
    expect(mintClientToken(db, { userId: null, role: 'admin', authEnabled: false, profile: 'test' } as any, { name: 'x', tools: ['transaction_search'] })).toMatchObject({ ok: false, status: 403, code: 'kill_switch' });
    expect(updateClientTokenTools(db, id, viewer, ['transaction_search'], 'test')).toMatchObject({ ok: false, status: 403, code: 'kill_switch' });
  });

  test('it also revokes the grants behind client tokens', () => {
    const db = createTestDb();
    const { id } = mintTestToken(db, ['transaction_search']);
    setKillSwitch(db, false);
    expect(count(db, 'mcp_grants', `session_generation = 'tok:${id}' AND revoked_at IS NULL`)).toBe(0);
  });

  test('it revokes the client tokens themselves: nothing comes back when it is turned on', () => {
    const db = createTestDb();
    const { token, id } = mintTestToken(db, ['transaction_search']);
    const viewer = { userId: null, role: 'admin' as const, authEnabled: false };
    setKillSwitch(db, false);
    setKillSwitch(db, true);
    expect(resolveClientToken(db, token, 'test')).toBeNull();
    expect(listClientTokens(db, viewer).find((t) => t.id === id)!.revoked_at).not.toBeNull();
    // The same bearer cannot be handed fresh grants through the tools editor.
    expect(updateClientTokenTools(db, id, viewer, ['transaction_search', 'category_summary'], 'test')).toBeNull();
    expect(count(db, 'mcp_grants', `session_generation = 'tok:${id}' AND revoked_at IS NULL`)).toBe(0);
  });

  test('/mcp tools/list is [] while it is off, and the token is not locked out of the list call', async () => {
    const db = createTestDb();
    seedTestData(db);
    const { token } = mintTestToken(db, ['transaction_search']);
    const list = async () => {
      const res = await handleMcpHttpRequest(
        db,
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        '127.0.0.1',
        'test',
      );
      return ((await res.json()) as any).result.tools as Array<{ name: string }>;
    };
    expect((await list()).map((t) => t.name)).toEqual(['transaction_search']);
    // Turning off the switch revokes the token's grants; even a fresh grant row could not bring a tool back.
    setGlobalAgentState({ enabled: false });
    expect(await list()).toEqual([]);
  });

  test('a viewer cannot toggle it (PUT /api/mcp/settings answers 403)', async () => {
    const db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    await makeUser(db, 'admin1', 'admin');
    await makeUser(db, 'viewer1', 'viewer');
    enableAuth(db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    const viewerToken = (await verifyLogin(db, 'viewer1', 'password123'))!.token;
    const adminToken = (await verifyLogin(db, 'admin1', 'password123'))!.token;
    const put = (token: string, body: unknown) =>
      bfetch(`${base}/api/mcp/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

    expect((await put(viewerToken, { enabled: false })).status).toBe(403);
    expect(isAgentAccessEnabled()).toBe(true);
    const ok = await put(adminToken, { enabled: false });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).enabled).toBe(false);
    expect(isAgentAccessEnabled()).toBe(false);
  });

  test('the settings route needs browser proof (a bare curl cannot flip it)', async () => {
    const db = createTestDb();
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const res = await fetch(`http://localhost:${server.port}/api/mcp/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
    expect(isAgentAccessEnabled()).toBe(true);
  });
});

describe('where the switch lives', () => {
  test('it persists in the agent-access.json file, not in the profile settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-ks-'));
    const file = join(dir, 'agent-access.json');
    ensureTestProfile();
    setGlobalStateFile(file);
    try {
      const db = createTestDb();
      setKillSwitch(db, false);
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      expect(stored.enabled).toBe(false);
      expect(typeof stored.killSwitchEpoch).toBe('number');
      expect(getGlobalAgentState().enabled).toBe(false);
    } finally {
      setGlobalStateFile(testAgentAccessFile());
    }
  });

  test('the default file is agent-access.json directly under OA_ROOT, outside any profile', () => {
    expect(DEFAULT_AGENT_ACCESS_FILE).toBe(join(OA_ROOT, 'agent-access.json'));
    expect(DEFAULT_AGENT_ACCESS_FILE.startsWith(resolveProfile('x').root)).toBe(false);
  });

  test('with HOME pointed at a temp dir, a write lands in <HOME>/.openaccountant/agent-access.json and nowhere else', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oa-home-'));
    const script = `
      import { setGlobalAgentState, getGlobalAgentState } from ${JSON.stringify(join(import.meta.dir, '../mcp/global-state.ts'))};
      setGlobalAgentState({ enabled: false, killSwitchEpoch: 123 });
      console.log(JSON.stringify(getGlobalAgentState()));
    `;
    const proc = Bun.spawn(['bun', '-e', script], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(out.trim())).toMatchObject({ enabled: false, killSwitchEpoch: 123 });
    const file = join(home, '.openaccountant', 'agent-access.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ enabled: false });
    expect(readdirSync(join(home, '.openaccountant'))).toEqual(['agent-access.json']); // no profile dir, no settings.json
  });
});

describe('a damaged agent-access.json', () => {
  test('fails closed: truncated JSON turns agent access off instead of on, and a missing file is still on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-ks-corrupt-'));
    const file = join(dir, 'agent-access.json');
    try {
      setGlobalStateFile(file);
      expect(isAgentAccessEnabled()).toBe(true); // never configured

      writeFileSync(file, '{"enabled": false, "killSwitchEpoch": 1');
      expect(isAgentAccessEnabled()).toBe(false);
      expect(getKillSwitchEpoch()).toBeGreaterThan(1);

      writeFileSync(file, '');
      expect(isAgentAccessEnabled()).toBe(false);

      // Writing through the switch repairs it, and it can be turned back on.
      setGlobalAgentState({ enabled: true });
      expect(isAgentAccessEnabled()).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8')).enabled).toBe(true);
    } finally {
      setGlobalStateFile(testAgentAccessFile());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a grant made before the damage is dead even if the switch is turned on again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-ks-corrupt-'));
    const file = join(dir, 'agent-access.json');
    try {
      setGlobalStateFile(file);
      const db = createTestDb();
      seedTestData(db);
      const scope = testScope();
      const grants = grantTools(db, scope, ['transaction_search']);
      writeFileSync(file, '{ not json');
      setGlobalAgentState({ enabled: true });
      const out = await callTool(db, scope, grants.transaction_search, 'transaction_search', { query: 'x' }, 'imperative');
      expect(out).toMatchObject({ ok: false, code: 'grant_invalid' });
    } finally {
      setGlobalStateFile(testAgentAccessFile());
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('across profiles', () => {
  test('a profile switch keeps the switch off (another profile database still answers 403)', async () => {
    const dbA = createTestDb();
    const dbB = createTestDb();
    seedTestData(dbB);
    const scope = testScope();
    const grants = grantTools(dbB, scope, ['transaction_search']);
    setKillSwitch(dbA, false);
    const out = await callTool(dbB, scope, grants.transaction_search, 'transaction_search', { query: 'x' }, 'imperative');
    expect(out).toMatchObject({ ok: false, code: 'kill_switch' });
  });

  test('a grant created before the switch went off is invalid in another profile after re-enable', async () => {
    const dbA = createTestDb();
    const dbB = createTestDb();
    seedTestData(dbB);
    const scope = testScope();
    const grants = grantTools(dbB, scope, ['transaction_search']);
    setKillSwitch(dbA, false); // only A's grants are revoked; B's row is untouched
    setKillSwitch(dbA, true);

    expect(getGrant(dbB, grants.transaction_search)!.revoked_at).toBeNull();
    const check = validateGrant(dbB, grants.transaction_search, 'transaction_search', schemaDigest('transaction_search'), scope);
    expect(check).toEqual({ ok: false, reason: 'kill_switch' });
    const out = await callTool(dbB, scope, grants.transaction_search, 'transaction_search', { query: 'x' }, 'imperative');
    expect(out).toMatchObject({ ok: false, status: 403, code: 'grant_invalid' });
    expect((out as { error: string }).error).toContain('kill_switch');

    // A grant made after re-enabling works, even when made immediately.
    const fresh = grantTools(dbB, scope, ['transaction_search']);
    const ok = await callTool(dbB, scope, fresh.transaction_search, 'transaction_search', { query: 'groceries' }, 'imperative');
    expect(ok).toMatchObject({ ok: true, kind: 'read' });
  });

  test('a grant the flip never touched is not listed or exposed either, only the fresh one is', () => {
    const dbA = createTestDb();
    const dbB = createTestDb();
    const scope = testScope();
    grantTools(dbB, scope, ['transaction_search']);
    expect(exposedTools(dbB, scope).map((t) => t.name)).toEqual(['transaction_search']);
    setKillSwitch(dbA, false);
    setKillSwitch(dbA, true);

    expect(exposedTools(dbB, scope)).toEqual([]);
    expect(listActiveGrants(dbB, scope)).toEqual([]);

    grantTools(dbB, scope, ['transaction_search']);
    expect(exposedTools(dbB, scope).map((t) => t.name)).toEqual(['transaction_search']);
    expect(listActiveGrants(dbB, scope)).toHaveLength(1);
  });

  test('a client token in another profile no longer resolves any tool after a flip it never saw', () => {
    const dbA = createTestDb();
    const dbB = createTestDb();
    const { token } = mintTestToken(dbB, ['transaction_search']);
    expect(resolveClientToken(dbB, token, 'test')!.grants).toHaveLength(1);
    setKillSwitch(dbA, false);
    setKillSwitch(dbA, true);
    expect(resolveClientToken(dbB, token, 'test')!.grants).toEqual([]);
  });

  test('callTool reads the switch with no active profile set (it never touches getSetting)', async () => {
    const db = createTestDb();
    seedTestData(db);
    const scope = testScope();
    const grants = grantTools(db, scope, ['transaction_search']);
    setKillSwitch(db, false);
    resetActiveProfile();
    const out = await callTool(db, scope, grants.transaction_search, 'transaction_search', { query: 'x' }, 'imperative');
    expect(out).toMatchObject({ ok: false, code: 'kill_switch' });
    expect(exposedTools(db, scope)).toEqual([]);
  });

  test('turning it back on does not resurrect revoked grants', () => {
    const db = createTestDb();
    const scope = testScope();
    grantTools(db, scope, ['transaction_search']);
    setKillSwitch(db, false);
    setKillSwitch(db, true);
    expect(exposedTools(db, scope)).toEqual([]);
  });
});
