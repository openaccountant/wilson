import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, deactivateUser, enableAuth, getUserCount, isAuthEnabled } from '../dashboard/auth.js';
import { createGrants, createOperation, getOperation, listGrantsForSession, validateGrant, type Role } from '../mcp/store.js';
import { callReadTool, prepareOperation } from '../mcp/engine.js';
import { schemaDigest } from '../mcp/tool-catalog.js';
import { HTTP_MCP_ORIGIN } from '../mcp/http-server.js';

/**
 * Security review follow-up to #156: approving a WebMCP / HTTP-MCP operation
 * must obey the same RBAC as every other dashboard write.
 *
 * The reviewer's sequence: auth off -> an HTTP-MCP token is granted
 * categorize_transaction (user_id null, role admin, 12h TTL) -> admin and
 * viewer created, auth enabled -> the external client prepares an operation
 * (user_id null) -> the viewer sees it and approves it -> the category is
 * written. Each layer of the fix is covered on its own below.
 */

type Op = { id: string; source: string; tool_name: string; status: string; user_id: number | null };

describe('WebMCP/HTTP-MCP approval hardening', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;

  const call = (path: string, token: string | null, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
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

  /**
   * An external (HTTP-MCP) client's pending categorize_transaction, prepared
   * through the real engine under a grant bound to `owner`. Grants are
   * minted at the store level so the test can place an operation in states
   * the routes alone would refuse to create.
   */
  function prepareExternal(owner: { userId: number | null; role: Role }, token: string, id: number, newCategory = 'PWNED'): Op {
    const scope = { userId: owner.userId, role: owner.role, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: token };
    const [grant] = createGrants(db, {
      ...scope,
      tools: [{ name: 'categorize_transaction', schemaDigest: schemaDigest('categorize_transaction') }],
    });
    const prepared = prepareOperation(db, scope, 'http-mcp', grant.id, 'categorize_transaction', { id, category: newCategory });
    if (!prepared.ok) throw new Error(prepared.error);
    return prepared.operation as Op;
  }

  beforeEach(async () => {
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
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
      const { viewer, viewerToken } = await withUsers();
      const id = txnId();
      // Bound to the viewer, so every visibility rule shows it to them; only
      // the role check stands between this card and a write.
      const op = prepareExternal({ userId: viewer.id, role: 'viewer' }, 'ext-viewer-token', id);
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
      const { viewer, viewerToken } = await withUsers();
      const id = txnId();
      const scope = { userId: viewer.id, role: 'viewer' as Role, profile: 'test', origin: 'http://localhost', sessionGeneration: 'viewer-tab' };
      const [grant] = createGrants(db, { ...scope, tools: [{ name: 'categorize_transaction', schemaDigest: schemaDigest('categorize_transaction') }] });
      const prepared = prepareOperation(db, scope, 'webmcp', grant.id, 'categorize_transaction', { id, category: 'PWNED' });
      if (!prepared.ok) throw new Error(prepared.error);

      expect((await call(`/api/mcp/operations/${prepared.operation.id}/approve`, viewerToken, 'POST')).status).toBe(403);
      expect(category(id)).toBe('Dining');
    });

    test('an admin still approves their own HTTP-MCP operation', async () => {
      const { admin, adminToken } = await withUsers();
      const id = txnId();
      const op = prepareExternal({ userId: admin.id, role: 'admin' }, 'ext-admin-token', id, 'Restaurants');
      const res = await call(`/api/mcp/operations/${op.id}/approve`, adminToken, 'POST');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe('committed');
      expect(category(id)).toBe('Restaurants');
    });
  });

  describe('2. with auth on, an operation with no owner is visible only to admins', () => {
    test('a viewer cannot list, read, approve or reject an unowned operation; an admin sees it, and approving cannot commit', async () => {
      const id = txnId();
      // The reviewer's state: an operation prepared under a grant minted
      // while auth was off (user_id null, role admin), still pending once
      // auth is on. enableAuth() now expires such rows and nothing can mint
      // them with auth on, so this is a legacy row: prepared with auth off,
      // then the flag is flipped in the DB without enableAuth's sweep.
      const op = prepareExternal({ userId: null, role: 'admin' }, 'ext-auth-off-token', id);
      expect(op.user_id).toBeNull();
      await createUser(db, 'admin', 'adminpass', 'admin');
      await createUser(db, 'viewer', 'viewerpass', 'viewer');
      db.prepare("INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')").run();
      const adminToken = await login('admin', 'adminpass');
      const viewerToken = await login('viewer', 'viewerpass');

      expect((await listOps(viewerToken)).map((o) => o.id)).not.toContain(op.id);
      expect((await call(`/api/mcp/operations/${op.id}`, viewerToken)).status).toBe(404);
      expect((await call(`/api/mcp/operations/${op.id}/approve`, viewerToken, 'POST')).status).toBe(404);
      expect((await call(`/api/mcp/operations/${op.id}/reject`, viewerToken, 'POST')).status).toBe(404);
      expect(category(id)).toBe('Dining');
      expect(getOperation(db, op.id)?.status).toBe('pending');

      expect((await listOps(adminToken)).map((o) => o.id)).toContain(op.id);
      expect((await call(`/api/mcp/operations/${op.id}`, adminToken)).status).toBe(200);
      // Its grant has no owner while auth is on, so the commit-time grant
      // re-check refuses it: the admin's approval goes stale, nothing written.
      const approved = await call(`/api/mcp/operations/${op.id}/approve`, adminToken, 'POST');
      expect(((await approved.json()) as { outcome: string }).outcome).toBe('stale');
      expect(category(id)).toBe('Dining');
    });

    test('with auth off, an unowned operation stays visible to the (single, implicit) user', async () => {
      const op = prepareExternal({ userId: null, role: 'admin' }, 'ext-no-auth-token', txnId());
      expect((await listOps(null)).map((o) => o.id)).toContain(op.id);
      expect((await call(`/api/mcp/operations/${op.id}`, null)).status).toBe(200);
    });
  });

  const clients: Client[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
  });

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: 'external-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
    return client;
  }

  /**
   * Start a request whose JSON body is held open: the server has already run
   * its auth middleware (headers are in) but is still awaiting req.json().
   * `finish()` sends the rest of the body and resolves to the response.
   */
  async function heldRequest(path: string, body: unknown, opts: { method?: string; token?: string | null; origin?: string } = {}) {
    const text = JSON.stringify(body);
    const split = Math.floor(text.length / 2);
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    const res = fetch(base + path, {
      method: opts.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.origin ? { Origin: opts.origin } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    ctl.enqueue(new TextEncoder().encode(text.slice(0, split)));
    // Let the server receive the headers and enter the handler.
    await new Promise((r) => setTimeout(r, 100));
    return {
      finish: async () => {
        ctl.enqueue(new TextEncoder().encode(text.slice(split)));
        ctl.close();
        return res;
      },
    };
  }

  describe('3. enabling auth revokes every grant and expires pending operations minted while it was off', () => {

    /** While auth is off: an HTTP-MCP token granted categorize_transaction, and a WebMCP tab with a pending operation. */
    async function mintWhileAuthOff(id: number) {
      const grant = await call('/api/mcp/grants', null, 'POST', { sessionGeneration: 'ext-token', tools: ['categorize_transaction'] });
      expect(grant.status).toBe(200);
      expect((await (await mcpClient('ext-token')).listTools()).tools.map((t) => t.name)).toEqual(['categorize_transaction']);

      const tab = (await (await call('/api/mcp/grants', null, 'POST', { sessionGeneration: 'tab-1', tools: ['categorize_transaction'] })).json()) as { grants: { id: string }[] };
      const prepared = (await (await call('/api/mcp/prepare', null, 'POST', {
        sessionGeneration: 'tab-1', grantId: tab.grants[0].id, tool: 'categorize_transaction', args: { id, category: 'PWNED' },
      })).json()) as { operation: Op };
      expect(prepared.operation.status).toBe('pending');
      expect(prepared.operation.user_id).toBeNull();
      return { pendingOpId: prepared.operation.id };
    }

    test('reviewer sequence via /api/auth/setup: nothing minted while auth was off survives; admins can re-grant', async () => {
      const id = txnId();
      const { pendingOpId } = await mintWhileAuthOff(id);

      const setup = (await (await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' })).json()) as { token: string; user: { id: number } };
      const adminToken = setup.token;
      expect((await call('/api/auth/users', adminToken, 'POST', { username: 'viewer', password: 'viewerpass', role: 'viewer' })).status).toBe(200);
      const viewerToken = await login('viewer', 'viewerpass');

      // The external client's grant is gone: it sees no tools and cannot prepare anything.
      expect(listGrantsForSession(db, 'ext-token')).toEqual([]);
      expect(listGrantsForSession(db, 'tab-1')).toEqual([]);
      expect((await (await mcpClient('ext-token')).listTools()).tools).toEqual([]);

      // The operation prepared while auth was off is expired, listed to no one, and cannot commit.
      expect(getOperation(db, pendingOpId)?.status).toBe('expired');
      expect(await listOps(viewerToken)).toEqual([]);
      expect(await listOps(adminToken)).toEqual([]);
      expect((await call(`/api/mcp/operations/${pendingOpId}/approve`, viewerToken, 'POST')).status).not.toBe(200);
      const adminRetry = await call(`/api/mcp/operations/${pendingOpId}/approve`, adminToken, 'POST');
      expect(((await adminRetry.json()) as { outcome: string }).outcome).not.toBe('committed');
      expect(category(id)).toBe('Dining');

      // An admin can grant again; the new grant is bound to them.
      const regrant = await call('/api/mcp/grants', adminToken, 'POST', { sessionGeneration: 'ext-token-2', tools: ['categorize_transaction'] });
      expect(regrant.status).toBe(200);
      expect(listGrantsForSession(db, 'ext-token-2').map((g) => g.user_id)).toEqual([setup.user.id]);
      expect((await (await mcpClient('ext-token-2')).listTools()).tools.map((t) => t.name)).toEqual(['categorize_transaction']);
    });

    test('PATCH /api/auth/config turning auth on revokes the same way; re-sending "on" while on revokes nothing', async () => {
      const id = txnId();
      // Users can be created while auth is off; enabling it is what counts.
      expect((await call('/api/auth/users', null, 'POST', { username: 'admin', password: 'adminpass', role: 'admin' })).status).toBe(200);
      const { pendingOpId } = await mintWhileAuthOff(id);

      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, 'ext-token')).toEqual([]);
      expect(getOperation(db, pendingOpId)?.status).toBe('expired');
      expect((await (await mcpClient('ext-token')).listTools()).tools).toEqual([]);
      expect(category(id)).toBe('Dining');

      const adminToken = await login('admin', 'adminpass');
      expect((await call('/api/mcp/grants', adminToken, 'POST', { sessionGeneration: 'admin-tab', tools: ['transaction_search'] })).status).toBe(200);
      expect((await call('/api/auth/config', adminToken, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, 'admin-tab').map((g) => g.tool_name)).toEqual(['transaction_search']);
    });

    test('turning auth off and on again revokes grants minted in between', async () => {
      const { adminToken } = await withUsers();
      expect((await call('/api/auth/config', adminToken, 'PATCH', { auth_enabled: false })).status).toBe(200);
      expect((await call('/api/mcp/grants', null, 'POST', { sessionGeneration: 'ext-token', tools: ['categorize_transaction'] })).status).toBe(200);
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(listGrantsForSession(db, 'ext-token')).toEqual([]);
    });
  });
  describe('4. scope is decided at write time: nothing ownerless is minted once auth is on', () => {
    test("reviewer probe: a grant whose body completes after auth is enabled is refused; /mcp gets no tools", async () => {
      // Request starts while auth is off (no login needed), body held open.
      const held = await heldRequest('/api/mcp/grants', { sessionGeneration: 'race-token', tools: ['categorize_transaction'] }, { origin: HTTP_MCP_ORIGIN });
      // Auth turned on while the grant request is still in flight.
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);
      expect(isAuthEnabled(db)).toBe(true);

      const res = await held.finish();
      expect(res.status).toBe(401);
      expect(listGrantsForSession(db, 'race-token')).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id IS NULL AND revoked_at IS NULL').get() as { n: number }).n).toBe(0);
      expect((await (await mcpClient('race-token')).listTools()).tools).toEqual([]);
    });

    test('a WebMCP prepare whose body completes after auth is enabled is refused and creates no operation', async () => {
      const id = txnId();
      const tab = (await (await call('/api/mcp/grants', null, 'POST', { sessionGeneration: 'tab-race', tools: ['categorize_transaction'] })).json()) as { grants: { id: string }[] };
      const held = await heldRequest('/api/mcp/prepare', {
        sessionGeneration: 'tab-race', grantId: tab.grants[0].id, tool: 'categorize_transaction', args: { id, category: 'PWNED' },
      });
      expect((await call('/api/auth/config', null, 'PATCH', { auth_enabled: true })).status).toBe(200);

      const res = await held.finish();
      expect(res.status).toBe(401);
      expect((db.prepare("SELECT COUNT(*) AS n FROM mcp_operations WHERE status = 'pending'").get() as { n: number }).n).toBe(0);
      expect(category(id)).toBe('Dining');
    });

    test('engine and store refuse an ownerless scope while auth is on (defence in depth)', async () => {
      enableAuth(db);
      const scope = { userId: null, role: 'admin' as Role, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: 'direct' };
      expect(() => createGrants(db, { ...scope, tools: [{ name: 'categorize_transaction', schemaDigest: schemaDigest('categorize_transaction') }] })).toThrow();
      expect(listGrantsForSession(db, 'direct')).toEqual([]);

      const prepared = prepareOperation(db, scope, 'http-mcp', 'any-grant', 'categorize_transaction', { id: txnId(), category: 'PWNED' });
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.status).toBe(401);

      expect(() => createOperation(db, {
        source: 'http-mcp', grantId: null, toolName: 'categorize_transaction', args: {}, before: null, after: null,
        transactionId: null, revisionAtPrepare: null, profile: 'test', origin: HTTP_MCP_ORIGIN, sessionGeneration: 'direct',
        userId: null, role: 'admin',
      })).toThrow();
    });

    test('a /mcp bearer whose ownerless grant somehow survives the enable gets no tools', async () => {
      // Legacy row: minted while auth was off, flag flipped without enableAuth's sweep.
      expect((await call('/api/mcp/grants', null, 'POST', { sessionGeneration: 'legacy-token', tools: ['categorize_transaction'] })).status).toBe(200);
      db.prepare("INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')").run();
      expect((await (await mcpClient('legacy-token')).listTools()).tools).toEqual([]);
    });

    test('/api/auth/setup: a second setup whose body completes after the first is refused', async () => {
      const held = await heldRequest('/api/auth/setup', { username: 'attacker', password: 'attackerpass' });
      const first = await call('/api/auth/setup', null, 'POST', { username: 'admin', password: 'adminpass' });
      expect(first.status).toBe(200);

      const res = await held.finish();
      expect(res.status).toBe(400);
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
      // The soon-deactivated admin's external client: granted through the
      // real route, then a pending write prepared under it.
      expect((await call('/api/mcp/grants', opsToken, 'POST', { sessionGeneration: 'ops-ext', tools: ['categorize_transaction', 'transaction_search'] })).status).toBe(200);
      expect((await (await mcpClient('ops-ext')).listTools()).tools.map((t) => t.name).sort()).toEqual(['categorize_transaction', 'transaction_search']);
      const op = prepareExternal({ userId: ops.id, role: 'admin' }, 'ops-ext-2', txnId());
      // Someone else's grant must survive.
      expect((await call('/api/mcp/grants', adminToken, 'POST', { sessionGeneration: 'admin-ext', tools: ['transaction_search'] })).status).toBe(200);
      return { admin, adminToken, ops, op };
    }

    test('DELETE /api/auth/users/:id revokes the user\'s grants and expires their pending operations; /mcp gets no tools', async () => {
      const { adminToken, ops, op } = await setupDeactivation();
      expect((await call(`/api/auth/users/${ops.id}`, adminToken, 'DELETE')).status).toBe(200);

      expect(listGrantsForSession(db, 'ops-ext')).toEqual([]);
      expect(listGrantsForSession(db, 'ops-ext-2')).toEqual([]);
      expect((await (await mcpClient('ops-ext')).listTools()).tools).toEqual([]);
      expect(getOperation(db, op.id)?.status).toBe('expired');
      const approve = await call(`/api/mcp/operations/${op.id}/approve`, adminToken, 'POST');
      expect(((await approve.json()) as { outcome?: string }).outcome).not.toBe('committed');
      expect(category(txnId())).toBe('Dining');

      expect(listGrantsForSession(db, 'admin-ext').map((g) => g.tool_name)).toEqual(['transaction_search']);
    });

    test('deactivateUser() itself revokes and expires (not only the route)', async () => {
      const { ops, op } = await setupDeactivation();
      expect(deactivateUser(db, ops.id)).toBe(true);
      expect(listGrantsForSession(db, 'ops-ext')).toEqual([]);
      expect(getOperation(db, op.id)?.status).toBe('expired');
      expect(listGrantsForSession(db, 'admin-ext')).toHaveLength(1);
    });

    test('a grant whose user is inactive is rejected even if the row survives (defence in depth)', async () => {
      const { ops } = await setupDeactivation();
      // Deactivated behind deactivateUser's back: the grant rows stay live.
      db.prepare('UPDATE dashboard_users SET is_active = 0 WHERE id = @id').run({ id: ops.id });
      const [grant] = listGrantsForSession(db, 'ops-ext').filter((g) => g.tool_name === 'transaction_search');
      expect(grant).toBeDefined();

      expect((await (await mcpClient('ops-ext')).listTools()).tools).toEqual([]);
      const scope = { userId: ops.id, role: 'admin' as Role, profile: grant.profile, origin: grant.origin, sessionGeneration: 'ops-ext' };
      const validation = validateGrant(db, grant.id, 'transaction_search', schemaDigest('transaction_search'), scope);
      expect(validation.ok).toBe(false);
      const read = await callReadTool(db, scope, grant.id, 'transaction_search', { query: 'Restaurant' });
      expect(read.ok).toBe(false);
    });
  });
  describe('6. grant routes act only on the caller\'s own grants (any grant for an admin)', () => {
    type G = { id: string; tool_name: string; user_id: number | null };
    const grantsVia = async (token: string, sessionGeneration: string): Promise<G[]> =>
      ((await (await call(`/api/mcp/grants?sessionGeneration=${sessionGeneration}`, token)).json()) as { grants: G[] }).grants;
    const live = (sessionGeneration: string) => listGrantsForSession(db, sessionGeneration).map((g) => g.id);

    async function setupGrants() {
      const users = await withUsers();
      const mint = async (token: string, sessionGeneration: string, tools: string[]) =>
        ((await (await call('/api/mcp/grants', token, 'POST', { sessionGeneration, tools })).json()) as { grants: G[] }).grants;
      const adminGrants = await mint(users.adminToken, 'admin-tab', ['transaction_search', 'categorize_transaction']);
      const viewerGrants = await mint(users.viewerToken, 'viewer-tab', ['transaction_search']);
      // Same session generation used by both (e.g. a guessed or reused id).
      const sharedAdmin = await mint(users.adminToken, 'shared', ['transaction_search']);
      const sharedViewer = await mint(users.viewerToken, 'shared', ['spending_summary']);
      return { ...users, adminGrants, viewerGrants, sharedAdmin, sharedViewer };
    }

    test("GET: a viewer does not see an admin's grants; an admin sees everyone's", async () => {
      const { adminToken, viewerToken, viewer, admin } = await setupGrants();
      expect(await grantsVia(viewerToken, 'admin-tab')).toEqual([]);
      expect((await grantsVia(viewerToken, 'shared')).map((g) => g.user_id)).toEqual([viewer.id]);
      expect((await grantsVia(viewerToken, 'viewer-tab')).map((g) => g.user_id)).toEqual([viewer.id]);
      expect((await grantsVia(adminToken, 'viewer-tab')).map((g) => g.user_id)).toEqual([viewer.id]);
      expect((await grantsVia(adminToken, 'shared')).map((g) => g.user_id).sort()).toEqual([admin.id, viewer.id].sort());
    });

    test("DELETE: a viewer revoking an admin's grant gets 404 and the grant is unchanged", async () => {
      const { viewerToken, adminGrants, viewerGrants } = await setupGrants();
      const res = await call(`/api/mcp/grants/${adminGrants[0].id}`, viewerToken, 'DELETE');
      expect([403, 404]).toContain(res.status);
      expect(live('admin-tab')).toContain(adminGrants[0].id);

      expect((await call(`/api/mcp/grants/${viewerGrants[0].id}`, viewerToken, 'DELETE')).status).toBe(200);
      expect(live('viewer-tab')).toEqual([]);
    });

    test("DELETE: an admin can revoke a viewer's grant", async () => {
      const { adminToken, viewerGrants } = await setupGrants();
      expect((await call(`/api/mcp/grants/${viewerGrants[0].id}`, adminToken, 'DELETE')).status).toBe(200);
      expect(live('viewer-tab')).toEqual([]);
    });

    test("revoke-session: a viewer revokes only their own grants in that session", async () => {
      const { viewerToken, adminGrants, sharedAdmin } = await setupGrants();
      const other = await call('/api/mcp/grants/revoke-session', viewerToken, 'POST', { sessionGeneration: 'admin-tab' });
      expect(((await other.json()) as { revoked: number }).revoked).toBe(0);
      expect(live('admin-tab').sort()).toEqual(adminGrants.map((g) => g.id).sort());

      const shared = await call('/api/mcp/grants/revoke-session', viewerToken, 'POST', { sessionGeneration: 'shared' });
      expect(((await shared.json()) as { revoked: number }).revoked).toBe(1);
      expect(live('shared')).toEqual([sharedAdmin[0].id]);
    });

    test('revoke-session started unauthenticated while auth was off is refused once auth is on', async () => {
      await createUser(db, 'admin', 'adminpass', 'admin');
      const held = await heldRequest('/api/mcp/grants/revoke-session', { sessionGeneration: 'admin-tab' });
      enableAuth(db);
      const adminToken = await login('admin', 'adminpass');
      expect((await call('/api/mcp/grants', adminToken, 'POST', { sessionGeneration: 'admin-tab', tools: ['transaction_search'] })).status).toBe(200);

      expect((await held.finish()).status).toBe(401);
      expect(live('admin-tab')).toHaveLength(1);
    });

    test('revoke-session: an admin revokes every grant in the session', async () => {
      const { adminToken } = await setupGrants();
      const res = await call('/api/mcp/grants/revoke-session', adminToken, 'POST', { sessionGeneration: 'shared' });
      expect(((await res.json()) as { revoked: number }).revoked).toBe(2);
      expect(live('shared')).toEqual([]);
    });
  });
});
