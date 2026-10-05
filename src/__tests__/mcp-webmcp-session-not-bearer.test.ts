import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, count, mintTestToken } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, verifyLogin } from '../dashboard/auth.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * #158: a WebMCP (browser-origin) grant's session id must never work as a
 * `/mcp` bearer. `/mcp` accepts only minted client tokens (`wmcp_...`); the tab
 * session id is a browser-side handle, not a credential for external clients.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
});

async function start(): Promise<{ db: Database; base: string }> {
  const db = createTestDb();
  seedTestData(db);
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  return { db, base: `http://localhost:${result.server.port}` };
}

function rawMcp(base: string, bearer: string | null, body: unknown) {
  return fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
const CALL = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'groceries' } } };

/** Mint a real WebMCP grant the way the dashboard tab does: a same-origin browser POST with its own session header. */
async function mintBrowserGrant(base: string, extraHeaders: Record<string, string> = {}): Promise<string> {
  const session = crypto.randomUUID();
  const res = await bfetch(base + '/api/mcp/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': session, ...extraHeaders },
    body: JSON.stringify({ tools: ['search_transactions'] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { grants: Array<{ session_generation?: string }> };
  expect(body.grants.length).toBe(1);
  return session;
}

describe('#158: WebMCP session id is not a /mcp bearer', () => {
  test('auth off: the session id of a live browser grant is a 401 on initialize and on tools/call', async () => {
    const { base, db } = await start();
    const session = await mintBrowserGrant(base);
    expect(count(db, 'mcp_grants', `session_generation = '${session}' AND revoked_at IS NULL`)).toBe(1);

    expect((await rawMcp(base, session, INIT)).status).toBe(401);
    const call = await rawMcp(base, session, CALL);
    expect(call.status).toBe(401);
    expect(count(db, 'mcp_operations')).toBe(0);
  });

  test('auth on: a dashboard login token plus its session id still cannot reach /mcp; neither can the session id alone', async () => {
    const { base, db } = await start();
    await createUser(db, 'admin', 'adminpass', 'admin');
    enableAuth(db);
    const loggedIn = await verifyLogin(db, 'admin', 'adminpass');
    expect(loggedIn).not.toBeNull();
    const dashToken = (loggedIn as { token: string }).token;

    const session = crypto.randomUUID();
    const res = await bfetch(base + '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}`, 'X-Wilson-Agent-Session': session },
      body: JSON.stringify({ tools: ['search_transactions'] }),
    });
    expect(res.status).toBe(200);

    expect((await rawMcp(base, session, INIT)).status).toBe(401);
    // A dashboard login token is not an MCP client token either.
    expect((await rawMcp(base, dashToken, INIT)).status).toBe(401);
  });

  test('a minted client token\'s own internal session (tok:<id>) is not a bearer; the minted wmcp_ token still is', async () => {
    const { base, db } = await start();
    const { token, id } = mintTestToken(db, ['search_transactions']);
    expect((await rawMcp(base, `tok:${id}`, INIT)).status).toBe(401);
    expect((await rawMcp(base, id, INIT)).status).toBe(401);
    expect((await rawMcp(base, token, INIT)).status).toBe(200);
  });
});
