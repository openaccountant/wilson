import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import { grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { nextArrival } from './held-request-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, deactivateUser, enableAuth, getUserCount, isAuthEnabled } from '../dashboard/auth.js';
import { createGrants, createOperation, getOperation, listGrantsForSession, validateGrant, type McpOperation, type Role } from '../mcp/store.js';
import { callTool, type RequestScope } from '../mcp/engine.js';
import { schemaDigest } from '../mcp/tool-catalog.js';
import { HTTP_MCP_ORIGIN } from '../mcp/http-server.js';
import { SESSION_HEADER } from '../mcp/schemas.js';

/**
 * Security review follow-up to #156: approving a WebMCP / HTTP-MCP operation
 * must obey the same RBAC as every other dashboard write.
 *
 * The reviewer's sequence: auth off -> an HTTP-MCP token is granted
 * categorize_transaction (user_id null, role admin, 12h TTL) -> admin and
 * viewer created, auth enabled -> the external client prepares an operation
 * (user_id null) -> the viewer sees it and approves it -> the category is
 * written. Each layer of the fix is covered on its own below.
 *
 * Ported to the WebMCP surface: tab sessions are UUID v4 (sent as the
 * X-Wilson-Agent-Session header), grant/approve routes need the browser proof
 * the dashboard page sends, external clients reach /mcp with a minted wmcp_
 * token (and can only read while auth is off), and categorize_transaction is
 * admin-only. Where WebMCP is stricter than the original fix (an ownerless
 * operation is visible to nobody once auth is on, not only to admins), the
 * assertion follows the stricter rule.
 */

type Op = { id: string; source: string; tool_name: string; status: string; user_id: number | null };

describe('WebMCP/HTTP-MCP approval hardening', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;

  /** One stable UUID v4 per readable session name, so the scenarios keep their names. */
  const sessions = new Map<string, string>();
  const S = (name: string): string => {
    if (!sessions.has(name)) sessions.set(name, crypto.randomUUID());
    return sessions.get(name)!;
  };

  const call = (path: string, token: string | null, method = 'GET', body?: unknown, session?: string) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // What the dashboard page sends: grant and approve routes need this browser proof (origin-gate.ts).
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        ...(session ? { [SESSION_HEADER]: session } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (username: string, password: string) =>
    ((await (await call('/api/auth/login', null, 'POST', { username, password })).json()) as { token: string }).token;
  const listOps = async (token: string | null): Promise<Op[]> =>
    ((await (await call('/api/mcp/operations', token)).json()) as { operations: Op[] }).operations;
  const txnId = () => (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  const category = (id: number) => (db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id }) as { category: string }).category;
  /** Grant `tools` to the named tab session through the real route, as the dashboard page would. */
  const grantVia = (token: string | null, session: string, tools: string[]) =>
    call('/api/mcp/grants', token, 'POST', { tools }, S(session));

  /**
   * A pending categorize_transaction prepared through the real engine under a
   * grant bound to `owner` (minted at the store level, so the test can place an
   * operation in states the routes alone would refuse to create).
   */
  async function prepareAs(
    owner: { userId: number | null; role: Role },
    transport: 'webmcp' | 'http-mcp',
    id: number,
    newCategory = 'Groceries'
  ): Promise<McpOperation> {
    const scope: RequestScope =
      transport === 'http-mcp'
        ? { userId: owner.userId, role: owner.role, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: `tok:${crypto.randomUUID()}` }
        : testScope({ userId: owner.userId, role: owner.role });
    const grants = grantTools(db, scope, ['categorize_transaction']);
    const result = await callTool(db, scope, grants.categorize_transaction, 'categorize_transaction', { id, category: newCategory }, transport === 'http-mcp' ? 'http-mcp' : 'imperative');
    if (!result.ok || result.kind !== 'operation') throw new Error(`prepare failed: ${JSON.stringify(result)}`);
    return result.operation;
  }

  /** A viewer cannot be granted categorize_transaction, so build the operation as an admin's, then hand it to the viewer. */
  function handTo(op: McpOperation, user: { id: number }, role: Role) {
    db.prepare('UPDATE mcp_operations SET user_id = @userId, role = @role WHERE id = @id').run({ userId: user.id, role, id: op.id });
  }

  beforeEach(async () => {
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    sessions.clear();
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* already stopped */ }
    closeAll();
  });

  async function withUsers() {
    const admin = await createUser(db, 'admin', 'adminpass', 'admin');
    const viewer = await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);
    return { admin, viewer, adminToken: await login('admin', 'adminpass'), viewerToken: await login('viewer', 'viewerpass') };
  }

  describe('1. approving any operation source requires canWrite', () => {
    test('a viewer cannot approve an HTTP-MCP operation it can see: 403, nothing written, still pending', async () => {
      const { admin, viewer, viewerToken } = await withUsers();
      const id = txnId();
      // Bound to the viewer, so every visibility rule shows it to them; only
      // the role check stands between this card and a write.
      const op = await prepareAs({ userId: admin.id, role: 'admin' }, 'http-mcp', id);
      handTo(op, viewer, 'viewer');
      expect((await listOps(viewerToken)).map((o) => o.id)).toContain(op.id);

      const res = await call(`/api/mcp/operations/${op.id}/approve`, viewerToken, 'POST');
      expect(res.status).toBe(403);
      expect(category(id)).toBe('Dining');
      expect(getOperation(db, op.id)?.status).toBe('pending');

      // Rejecting never writes, so it stays open to a viewer.
      const rejected = await call(`/api/mcp/operations/${op.id}/reject`, viewerToken, 'POST');
      expect(rejected.status).toBe(200);
      expect(((await rejected.json()) as { outcome: string }).outcome).toBe('rejected');
      expect(category(id)).toBe('Dining');
    });

    test('a viewer cannot approve a WebMCP operation either', async () => {
      const { admin, viewer, viewerToken } = await withUsers();
      const id = txnId();
      const op = await prepareAs({ userId: admin.id, role: 'admin' }, 'webmcp', id);
      handTo(op, viewer, 'viewer');

      expect((await call(`/api/mcp/operations/${op.id}/approve`, viewerToken, 'POST')).status).toBe(403);
      expect(category(id)).toBe('Dining');
    });

    test('an admin still approves their own HTTP-MCP operation', async () => {
      const { admin, adminToken } = await withUsers();
      const id = txnId();
      const op = await prepareAs({ userId: admin.id, role: 'admin' }, 'http-mcp', id, 'Groceries');
      const res = await call(`/api/mcp/operations/${op.id}/approve`, adminToken, 'POST');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe('committed');
      expect(category(id)).toBe('Groceries');
    });
  });

  describe('2. with auth on, an operation with no owner is visible to no one', () => {
    test('neither a viewer nor an admin can list, read, approve or reject an unowned operation; nothing is written', async () => {
      const id = txnId();
      // The reviewer's state: an operation prepared under a grant minted
      // while auth was off (user_id null, role admin), still pending once
      // auth is on. enableAuth() now expires such rows and nothing can mint
      // them with auth on, so this is a legacy row: prepared with auth off,
      // then the flag is flipped in the DB without enableAuth's sweep.
      // (External clients only read while auth is off, so it is a tab's.)
      const op = await prepareAs({ userId: null, role: 'admin' }, 'webmcp', id);
      expect(op.user_id).toBeNull();
      await createUser(db, 'admin', 'adminpass', 'admin');
      await createUser(db, 'viewer', 'viewerpass', 'viewer');
      db.prepare("INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')").run();
      const adminToken = await login('admin', 'adminpass');
      const viewerToken = await login('viewer', 'viewerpass');

      for (const token of [viewerToken, adminToken]) {
        expect((await listOps(token)).map((o) => o.id)).not.toContain(op.id);
        expect((await call(`/api/mcp/operations/${op.id}`, token)).status).toBe(404);
        expect((await call(`/api/mcp/operations/${op.id}/approve`, token, 'POST')).status).toBe(404);
        expect((await call(`/api/mcp/operations/${op.id}/reject`, token, 'POST')).status).toBe(404);
      }
      expect(category(id)).toBe('Dining');
      expect(getOperation(db, op.id)?.status).toBe('pending');
    });

    test('with auth off, an unowned operation stays visible to the (single, implicit) user', async () => {
      const op = await prepareAs({ userId: null, role: 'admin' }, 'webmcp', txnId());
      expect((await listOps(null)).map((o) => o.id)).toContain(op.id);
      expect((await call(`/api/mcp/operations/${op.id}`, null)).status).toBe(200);
    });
  });

  const clients: Client[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
  });

  /** The tool names a /mcp client holding `token` is offered; [] when the server refuses the bearer outright. */
  async function mcpTools(token: string): Promise<string[]> {
    const client = new Client({ name: 'external-client', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
    } catch {
      return [];
    }
    clients.push(client);
    return (await client.listTools()).tools.map((t) => t.name).sort();
  }

  /**
   * Start a request whose JSON body is held open: the server has already run
   * its auth middleware (headers are in) but is still awaiting req.json().
   * `finish()` sends the rest of the body and resolves to the response.
   */
  async function heldRequest(path: string, body: unknown, opts: { method?: string; token?: string | null; session?: string } = {}) {
    const text = JSON.stringify(body);
    const split = Math.floor(text.length / 2);
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    // Deterministic: resolves when the server has read the auth flag for THIS request, i.e. it has seen the
    // headers (and is about to wait on the body). A fixed sleep could let the test race ahead of a slow runner.
    const arrived = nextArrival(db);
    const res = fetch(base + path, {
      method: opts.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        ...(opts.session ? { [SESSION_HEADER]: opts.session } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    ctl.enqueue(new TextEncoder().encode(text.slice(0, split)));
    await arrived;
    return {
      finish: async () => {
        ctl.enqueue(new TextEncoder().encode(text.slice(split)));
        ctl.close();
        return res;
      },
    };
  }

  describe('3. enabling auth revokes every grant and expires pending operations minted while it was off', () => {

    /** While auth is off: an external client token (reads only, auth off) and a WebMCP tab with a pending operation. */
    async function mintWhileAuthOff(id: number) {
      const client = mintTestToken(db, ['search_transactions'], { authEnabled: false });
      expect(await mcpTools(client.token)).toEqual(['search_transactions']);

      const tab = (await (await grantVia(null, 'tab-1', ['categorize_transaction'])).json()) as { grants: { id: string }[] };
      const prepared = (await (await call('/api/mcp/call', null, 'POST', {
        grantId: tab.grants[0].id, tool: 'categorize_transaction', args: { id, category: 'Groceries' },
      }, S('tab-1'))).json()) as { operation: Op };
      expect(prepared.operation.status).toBe('pending');
      expect(getOperation(db, prepared.operation.id)?.user_id).toBeNull();
      return { pendingOpId: prepared.operation.id, clientToken: client.token, clientSession: `tok:${client.id}` };
    }

    test('reviewer sequence via /api/auth/setup: nothing minted while auth was off survives; admins can re-grant', async () => {
      const id = txnId();
      const { pendingOpId, clientToken, clientSession } = await mintWhileAuthOff(id);

      const setup = (await (await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' })).json()) as { token: string; user: { id: number } };
      const adminToken = setup.token;
      expect((await call('/api/auth/users', adminToken, 'POST', { username: 'viewer', password: 'viewerpass', role: 'viewer' })).status).toBe(200);
      const viewerToken = await login('viewer', 'viewerpass');

      // The external client's grant is gone: it sees no tools and cannot prepare anything.
      expect(listGrantsForSession(db, clientSession)).toEqual([]);
      expect(listGrantsForSession(db, S('tab-1'))).toEqual([]);
      expect(await mcpTools(clientToken)).toEqual([]);

      // The operation prepared while auth was off is expired, listed to no one, and cannot commit.
      expect(getOperation(db, pendingOpId)?.status).toBe('expired');
      expect(await listOps(viewerToken)).toEqual([]);
      expect(await listOps(adminToken)).toEqual([]);
      expect((await call(`/api/mcp/operations/${pendingOpId}/approve`, viewerToken, 'POST')).status).not.toBe(200);
      const adminRetry = await call(`/api/mcp/operations/${pendingOpId}/approve`, adminToken, 'POST');
      expect(((await adminRetry.json()) as { outcome?: string }).outcome).not.toBe('committed');
      expect(category(id)).toBe('Dining');

      // An admin can grant again; the new grant is bound to them.
      expect((await grantVia(adminToken, 'tab-2', ['categorize_transaction'])).status).toBe(200);
      expect(listGrantsForSession(db, S('tab-2')).map((g) => g.user_id)).toEqual([setup.user.id]);
      const regranted = mintTestToken(db, ['categorize_transaction'], { userId: setup.user.id, role: 'admin', authEnabled: true });
      expect(await mcpTools(regranted.token)).toEqual(['categorize_transaction']);
    });

    test('PATCH /api/auth/config turning auth on revokes the same way; re-sending "on" while on revokes nothing', async () => {
      const id = txnId();
      // Users can be created while auth is off; enabling it is what counts.
      expect((await call('/api/auth/users', null, 'POST', { username: 'admin', password: 'adminpass', role: 'admin' })).status).toBe(200);
      const { pendingOpId, clientToken } = await mintWhileAuthOff(id);

      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, S('tab-1'))).toEqual([]);
      expect(getOperation(db, pendingOpId)?.status).toBe('expired');
      expect(await mcpTools(clientToken)).toEqual([]);
      expect(category(id)).toBe('Dining');

      const adminToken = await login('admin', 'adminpass');
      expect((await grantVia(adminToken, 'admin-tab', ['search_transactions'])).status).toBe(200);
      expect((await call('/api/auth/config', adminToken, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, S('admin-tab')).map((g) => g.tool_name)).toEqual(['search_transactions']);
    });

    test('turning auth off and on again revokes grants minted in between', async () => {
      const { adminToken } = await withUsers();
      expect((await call('/api/auth/config', adminToken, 'PATCH', { auth_enabled: false })).status).toBe(200);
      expect((await grantVia(null, 'tab-off', ['categorize_transaction'])).status).toBe(200);
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, S('tab-off'))).toEqual([]);
    });
  });
  describe('4. scope is decided at write time: nothing ownerless is minted once auth is on', () => {
    test('reviewer probe: a grant whose body completes after auth is enabled is refused', async () => {
      // Request starts while auth is off (no login needed), body held open.
      const held = await heldRequest('/api/mcp/grants', { tools: ['categorize_transaction'] }, { session: S('race-tab') });
      // Enabling auth needs an active admin (#157), so one exists before auth is switched on.
      await makeUser(db, 'admin', 'admin');
      // Auth turned on while the grant request is still in flight.
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(isAuthEnabled(db)).toBe(true);

      const res = await held.finish();
      expect(res.status).toBe(401);
      expect(listGrantsForSession(db, S('race-tab'))).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id IS NULL AND revoked_at IS NULL').get() as { n: number }).n).toBe(0);
    });

    test('a WebMCP call whose body completes after auth is enabled is refused and creates no operation', async () => {
      const id = txnId();
      const tab = (await (await grantVia(null, 'tab-race', ['categorize_transaction'])).json()) as { grants: { id: string }[] };
      const held = await heldRequest('/api/mcp/call', {
        grantId: tab.grants[0].id, tool: 'categorize_transaction', args: { id, category: 'Groceries' },
      }, { session: S('tab-race') });
      await makeUser(db, 'admin', 'admin');
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);

      const res = await held.finish();
      // Enabling auth revoked the grant (403 grant_invalid); an ownerless scope is refused too (401).
      expect([401, 403]).toContain(res.status);
      expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_operations WHERE status = 'pending'").get() as { n: number }).n).toBe(0);
      expect(category(id)).toBe('Dining');
    });

    test('engine and store refuse an ownerless scope while auth is on (defence in depth)', async () => {
      enableAuth(db);
      const scope = { userId: null, role: 'admin' as Role, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: 'direct' };
      expect(() => createGrants(db, { ...scope, tools: [{ name: 'categorize_transaction', schemaDigest: schemaDigest('categorize_transaction') }] })).toThrow();
      expect(listGrantsForSession(db, 'direct')).toEqual([]);

      const prepared = await callTool(db, scope, crypto.randomUUID(), 'categorize_transaction', { id: txnId(), category: 'Groceries' }, 'http-mcp');
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect([401, 403]).toContain(prepared.status);

      expect(() => createOperation(db, {
        source: 'http-mcp', grantId: null, toolName: 'categorize_transaction', args: {}, before: null, after: null,
        transactionId: null, revisionAtPrepare: null, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: 'direct',
        userId: null, role: 'admin',
      })).toThrow();
    });

    test('a /mcp bearer whose ownerless grant somehow survives the enable gets no tools', async () => {
      // Legacy row: minted while auth was off, flag flipped without enableAuth's sweep.
      const legacy = mintTestToken(db, ['search_transactions'], { authEnabled: false });
      expect(await mcpTools(legacy.token)).toEqual(['search_transactions']);
      db.prepare("INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')").run();
      expect(await mcpTools(legacy.token)).toEqual([]);
    });

    test('/api/auth/setup: a second setup whose body completes after the first is refused', async () => {
      const held = await heldRequest('/api/auth/setup', { username: 'attacker', password: 'attackerpass' });
      const first = await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' });
      expect(first.status).toBe(200);

      const res = await held.finish();
      // Refused centrally (401: auth turned on while the body was in flight) before the route's own "Admin already exists" (400).
      expect(res.status).toBe(401);
      expect(getUserCount(db)).toBe(1);
      expect((await call('/api/auth/login', null, 'POST', { username: 'attacker', password: 'attackerpass' })).status).toBe(401);
    });

    test('an unauthenticated PATCH /api/auth/config started while auth was off cannot turn it back off', async () => {
      const held = await heldRequest('/api/auth/config', { auth_enabled: false }, { method: 'PATCH' });
      expect((await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' })).status).toBe(200);

      const res = await held.finish();
      expect(res.status).toBe(401);
      expect(isAuthEnabled(db)).toBe(true);
    });

    test('an unauthenticated user-create started while auth was off is refused once auth is on', async () => {
      const held = await heldRequest('/api/auth/users', { username: 'sneaky', password: 'sneakypass', role: 'admin' });
      expect((await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' })).status).toBe(200);

      const res = await held.finish();
      expect(res.status).toBe(401);
      expect(getUserCount(db)).toBe(1);
    });
  });
  describe('5. deactivating a user kills their MCP access', () => {
    async function setupDeactivation() {
      const { admin, adminToken } = await withUsers();
      const ops = await createUser(db, 'ops', 'opspass', 'admin');
      const opsToken = await login('ops', 'opspass');
      // The soon-deactivated admin's tab, granted through the real route; their
      // external client; and a pending write prepared under one of their grants.
      expect((await grantVia(opsToken, 'ops-tab', ['categorize_transaction', 'search_transactions'])).status).toBe(200);
      const client = mintTestToken(db, ['categorize_transaction', 'search_transactions'], { userId: ops.id, role: 'admin', authEnabled: true });
      expect(await mcpTools(client.token)).toEqual(['categorize_transaction', 'search_transactions']);
      const op = await prepareAs({ userId: ops.id, role: 'admin' }, 'http-mcp', txnId());
      // Someone else's grant must survive.
      expect((await grantVia(adminToken, 'admin-tab', ['search_transactions'])).status).toBe(200);
      return { admin, adminToken, ops, op, client };
    }

    test('DELETE /api/auth/users/:id revokes the user\'s grants and expires their pending operations; /mcp gets no tools', async () => {
      const { adminToken, ops, op, client } = await setupDeactivation();
      expect((await call(`/api/auth/users/${ops.id}`, adminToken, 'DELETE')).status).toBe(200);

      expect(listGrantsForSession(db, S('ops-tab'))).toEqual([]);
      expect(listGrantsForSession(db, `tok:${client.id}`)).toEqual([]);
      expect(await mcpTools(client.token)).toEqual([]);
      expect(getOperation(db, op.id)?.status).toBe('expired');
      const approve = await call(`/api/mcp/operations/${op.id}/approve`, adminToken, 'POST');
      expect(((await approve.json()) as { outcome?: string }).outcome).not.toBe('committed');
      expect(category(txnId())).toBe('Dining');

      expect(listGrantsForSession(db, S('admin-tab')).map((g) => g.tool_name)).toEqual(['search_transactions']);
    });

    test('deactivateUser() itself revokes and expires (not only the route)', async () => {
      const { ops, op } = await setupDeactivation();
      expect(deactivateUser(db, ops.id)).toBe(true);
      expect(listGrantsForSession(db, S('ops-tab'))).toEqual([]);
      expect(getOperation(db, op.id)?.status).toBe('expired');
      expect(listGrantsForSession(db, S('admin-tab'))).toHaveLength(1);
    });

    test('a grant whose user is inactive is rejected even if the row survives (defence in depth)', async () => {
      const { ops, client } = await setupDeactivation();
      // Deactivated behind deactivateUser's back: the grant rows stay live.
      db.prepare('UPDATE dashboard_users SET is_active = 0 WHERE id = @id').run({ id: ops.id });
      const [grant] = listGrantsForSession(db, S('ops-tab')).filter((g) => g.tool_name === 'search_transactions');
      expect(grant).toBeDefined();

      expect(await mcpTools(client.token)).toEqual([]);
      const scope = { userId: ops.id, role: 'admin' as Role, profile: grant.profile, origin: grant.origin, sessionGeneration: S('ops-tab') };
      const validation = validateGrant(db, grant.id, 'search_transactions', schemaDigest('search_transactions'), scope);
      expect(validation.ok).toBe(false);
      const read = await callTool(db, scope, grant.id, 'search_transactions', { query: 'Restaurant' }, 'imperative');
      expect(read.ok).toBe(false);
    });
  });
  describe('6. grant routes act only on the caller\'s own grants (any grant for an admin)', () => {
    type G = { id: string; tool_name: string };
    const userOf = (grantId: string) => (db.prepare('SELECT user_id FROM mcp_grants WHERE id = @id').get({ id: grantId }) as { user_id: number | null }).user_id;
    const grantsVia = async (token: string, session: string): Promise<G[]> =>
      ((await (await call('/api/mcp/grants', token, 'GET', undefined, S(session))).json()) as { grants: G[] }).grants;
    const live = (session: string) => listGrantsForSession(db, S(session)).map((g) => g.id);

    async function setupGrants() {
      const users = await withUsers();
      const mint = async (token: string, session: string, tools: string[]) =>
        ((await (await grantVia(token, session, tools)).json()) as { grants: G[] }).grants;
      const adminGrants = await mint(users.adminToken, 'admin-tab', ['search_transactions', 'categorize_transaction']);
      const viewerGrants = await mint(users.viewerToken, 'viewer-tab', ['search_transactions']);
      // Same session generation used by both (e.g. a guessed or reused id).
      const sharedAdmin = await mint(users.adminToken, 'shared', ['search_transactions']);
      const sharedViewer = await mint(users.viewerToken, 'shared', ['get_spending_summary']);
      return { ...users, adminGrants, viewerGrants, sharedAdmin, sharedViewer };
    }

    test("GET: a viewer does not see an admin's grants; an admin sees everyone's", async () => {
      const { adminToken, viewerToken, viewer, admin } = await setupGrants();
      expect(await grantsVia(viewerToken, 'admin-tab')).toEqual([]);
      expect((await grantsVia(viewerToken, 'shared')).map((g) => userOf(g.id))).toEqual([viewer.id]);
      expect((await grantsVia(viewerToken, 'viewer-tab')).map((g) => userOf(g.id))).toEqual([viewer.id]);
      expect((await grantsVia(adminToken, 'viewer-tab')).map((g) => userOf(g.id))).toEqual([viewer.id]);
      expect((await grantsVia(adminToken, 'shared')).map((g) => userOf(g.id)).sort()).toEqual([admin.id, viewer.id].sort());
    });

    test("DELETE: a viewer revoking an admin's grant gets 404 and the grant is unchanged", async () => {
      const { viewerToken, adminGrants, viewerGrants } = await setupGrants();
      const res = await call(`/api/mcp/grants/${adminGrants[0].id}`, viewerToken, 'DELETE', undefined, S('viewer-tab'));
      expect([403, 404]).toContain(res.status);
      expect(live('admin-tab')).toContain(adminGrants[0].id);

      expect((await call(`/api/mcp/grants/${viewerGrants[0].id}`, viewerToken, 'DELETE', undefined, S('viewer-tab'))).status).toBe(200);
      expect(live('viewer-tab')).toEqual([]);
    });

    test("DELETE: an admin can revoke a viewer's grant", async () => {
      const { adminToken, viewerGrants } = await setupGrants();
      expect((await call(`/api/mcp/grants/${viewerGrants[0].id}`, adminToken, 'DELETE', undefined, S('admin-tab'))).status).toBe(200);
      expect(live('viewer-tab')).toEqual([]);
    });

    test("revoke-session: a viewer revokes only their own grants in that session", async () => {
      const { viewerToken, adminGrants, sharedAdmin } = await setupGrants();
      const other = await call('/api/mcp/grants/revoke-session', viewerToken, 'POST', {}, S('admin-tab'));
      expect(((await other.json()) as { revoked: number }).revoked).toBe(0);
      expect(live('admin-tab').sort()).toEqual(adminGrants.map((g) => g.id).sort());

      const shared = await call('/api/mcp/grants/revoke-session', viewerToken, 'POST', {}, S('shared'));
      expect(((await shared.json()) as { revoked: number }).revoked).toBe(1);
      expect(live('shared')).toEqual([sharedAdmin[0].id]);
    });

    test('revoke-session started unauthenticated while auth was off is refused once auth is on', async () => {
      await createUser(db, 'admin', 'adminpass', 'admin');
      const held = await heldRequest('/api/mcp/grants/revoke-session', {}, { session: S('admin-tab') });
      enableAuth(db);
      const adminToken = await login('admin', 'adminpass');
      expect((await grantVia(adminToken, 'admin-tab', ['search_transactions'])).status).toBe(200);

      expect((await held.finish()).status).toBe(401);
      expect(live('admin-tab')).toHaveLength(1);
    });

    test('revoke-session: an admin revokes every grant in the session', async () => {
      const { adminToken } = await setupGrants();
      const res = await call('/api/mcp/grants/revoke-session', adminToken, 'POST', {}, S('shared'));
      expect(((await res.json()) as { revoked: number }).revoked).toBe(2);
      expect(live('shared')).toEqual([]);
    });
  });
});
