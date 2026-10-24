// @invariant NN-05
import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';

/**
 * The judgement, mcp, sync and prelabel route families answer a request the client got wrong with a 4xx and a short
 * message, never a 500 (and never parser, URIError, SQLite or stack text). The auth and origin gates still run
 * before any body or path parameter is looked at: a bad body from a caller who is not allowed in is a 401/403/421,
 * not a 400.
 */

const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962';

/** Text that would mean an internal error leaked into a response body. */
const LEAK = /\/Users\/|\/private\/|node_modules|\.ts:\d+|\bat \w+ \(|SQLite|SQLITE_|URIError|TypeError|SyntaxError|datatype mismatch/;

describe('route 400 sweep: judgement, mcp, sync, prelabel', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  afterEach(() => {
    for (const s of servers) { try { stopDashboardServer(s); } catch { /* */ } }
    servers.length = 0;
    closeAll();
  });

  async function start(opts: { auth?: boolean } = {}) {
    const db = createTestDb();
    if (opts.auth) {
      await createUser(db, 'admin1', 'password123', 'admin');
      enableAuth(db);
    }
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    servers.push(server);
    const base = `http://localhost:${server.port}`;
    /** Headers of the dashboard page itself: own Origin, same-origin fetch, the tab session. */
    const page = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', 'X-Wilson-Agent-Session': SESSION };
    return { db, base, page };
  }

  async function call(base: string, method: string, path: string, headers: Record<string, string>, body?: string) {
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    return { status: res.status, text };
  }

  // ── The 500s this sweep fixed ───────────────────────────────────────────────

  test('GET /api/judgements with a cursor past 2^53 is a 400, not a SQLite datatype-mismatch 500', async () => {
    const { base, page } = await start();
    for (const cursor of ['99999999999999999999999999', '9007199254740993']) {
      const r = await call(base, 'GET', `/api/judgements?cursor=${cursor}`, page);
      expect(`${cursor} ${r.status}`).toBe(`${cursor} 400`);
      expect(JSON.parse(r.text)).toEqual({ error: { code: 'invalid_args', message: 'cursor is out of range' } });
      expect(r.text).not.toMatch(LEAK);
    }
    // Unchanged: a cursor that is no number, negative, or within range still lists (an empty page here).
    for (const cursor of ['abc', '-1', '0', '9007199254740991']) {
      const r = await call(base, 'GET', `/api/judgements?cursor=${cursor}`, page);
      expect(`${cursor} ${r.status}`).toBe(`${cursor} 200`);
    }
  });

  test('PUT /api/mcp/policies/:tool with a malformed %-escape is a 400, not a URIError 500', async () => {
    const { base, page } = await start();
    for (const tool of ['%ZZ', '%E0%A4%A', 'abc%']) {
      const r = await call(base, 'PUT', `/api/mcp/policies/${tool}`, page, JSON.stringify({ policy: 'off' }));
      expect(`${tool} ${r.status}`).toBe(`${tool} 400`);
      expect(JSON.parse(r.text).error.code).toBe('invalid_args');
      expect(r.text).not.toMatch(LEAK);
    }
    // A well-formed name that is no tool is still a 404, and a real one still saves.
    expect((await call(base, 'PUT', '/api/mcp/policies/no_such_tool', page, JSON.stringify({ policy: 'off' }))).status).toBe(404);
    expect((await call(base, 'PUT', '/api/mcp/policies/search_transactions', page, JSON.stringify({ policy: 'off' }))).status).toBe(200);
  });

  // ── Regression lock: bad client input stays 4xx across the four families ─────

  const BODY_ROUTES: [string, string][] = [
    ['POST', '/api/judgements/bulk'],
    ['POST', '/api/mcp/grants'],
    ['POST', '/api/mcp/grants/revoke-session'],
    ['POST', '/api/mcp/call'],
    ['POST', '/api/mcp/client-tokens'],
    ['PUT', '/api/mcp/client-tokens/nope/tools'],
    ['PUT', '/api/mcp/settings'],
    ['PUT', '/api/mcp/policies/search_transactions'],
    ['PUT', '/api/prelabel/settings'],
  ];
  const BAD_BODIES = [
    '{bad', 'null', '[]', '5', '"x"',
    '{"tools":5}', '{"tools":[{}]}', `{"tools":["${'a'.repeat(5000)}"]}`,
    '{"ids":"x","action":"accept"}', '{"ids":[1e300],"action":"accept"}', '{"ids":[1],"action":"nope"}',
    '{"enabled":"yes"}', '{"marginCut":"x"}', '{"policy":5}', '{"grantTtlMinutes":-1}', '{"judgeDailyLimit":1e308}',
    '{"tool":5}', '{"tool":"x","args":[]}', '{"sessionGeneration":5}', '{"unknown":1}',
  ];

  test('malformed, mistyped and unknown-field bodies are 4xx with no leak on every body route', async () => {
    const { base, page } = await start();
    for (const [method, path] of BODY_ROUTES) {
      for (const body of BAD_BODIES) {
        const r = await call(base, method, path, page, body);
        const label = `${method} ${path} ${body.slice(0, 40)}`;
        expect(r.status >= 400 && r.status < 500, `${label} -> ${r.status}`).toBe(true);
        expect(r.text, label).not.toMatch(LEAK);
      }
    }
  });

  test('bad ids and query values are 400/404, never 500', async () => {
    const { base, page } = await start();
    const cases: [string, string, number, string?][] = [
      ['GET', '/api/judgements?status=bogus', 400],
      ['POST', '/api/judgements/99999999999999999999999999/accept', 404],
      ['POST', '/api/judgements/0/revoke', 404],
      ['DELETE', '/api/mcp/grants/%ZZ', 404],
      ['GET', '/api/mcp/operations/%ZZ', 404],
      ['POST', '/api/mcp/operations/nope/approve', 404],
      ['POST', '/api/mcp/operations/nope/reject', 404],
      ['POST', '/api/mcp/operations/nope/cancel', 404],
      ['DELETE', '/api/mcp/client-tokens/%ZZ', 404],
      ['POST', '/api/mcp/client-tokens/nope/rotate', 404],
      ['GET', '/api/mcp/audit?cursor=99999999999999999999999', 400],
      ['GET', '/api/mcp/audit?limit=abc', 400],
      ['GET', '/api/mcp/audit?since=' + 'z'.repeat(50), 400],
      ['GET', '/api/prelabel/gold?limit=99999999999999999999999', 200],
      ['POST', '/api/sync/accounts', 405, '{bad'],
    ];
    for (const [method, path, want, body] of cases) {
      const r = await call(base, method, path, page, body);
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} ${want}`);
      expect(r.text).not.toMatch(LEAK);
    }
    // A bad tab session header is a 400 on every route that reads it.
    for (const path of ['/api/mcp/tools', '/api/mcp/grants', '/api/mcp/state', '/api/mcp/operations']) {
      const r = await call(base, 'GET', path, { ...page, 'X-Wilson-Agent-Session': 'not-a-uuid' });
      expect(`${path} ${r.status}`).toBe(`${path} 400`);
    }
  });

  // ── Gates still come first ──────────────────────────────────────────────────

  test('a foreign Host is 421 and a foreign Origin is 403 before the body or a path escape is read', async () => {
    const { base, page } = await start();
    const port = new URL(base).port;
    const writes: [string, string][] = [...BODY_ROUTES, ['PUT', '/api/mcp/policies/%ZZ']];
    for (const [method, path] of writes) {
      const host = await call(base, method, path, { ...page, Host: `evil.example:${port}` }, '{bad');
      expect(`${method} ${path} ${host.status}`).toBe(`${method} ${path} 421`);
      const origin = await call(base, method, path, { ...page, Origin: 'https://evil.example' }, '{bad');
      expect(`${method} ${path} ${origin.status}`).toBe(`${method} ${path} 403`);
    }
  });

  test('a request without browser proof is 403 before its bad body is parsed', async () => {
    const { base } = await start();
    const bare = { 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': SESSION };
    const proofFirst: [string, string][] = [
      ['POST', '/api/judgements/bulk'],
      ['POST', '/api/mcp/grants'],
      ['POST', '/api/mcp/grants/revoke-session'],
      ['POST', '/api/mcp/client-tokens'],
      ['PUT', '/api/mcp/client-tokens/nope/tools'],
      ['PUT', '/api/mcp/settings'],
      ['PUT', '/api/mcp/policies/%ZZ'],
      ['PUT', '/api/prelabel/settings'],
    ];
    for (const [method, path] of proofFirst) {
      const r = await call(base, method, path, bare, '{bad');
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 403`);
    }
  });

  test('with auth on, no login is 401 before a bad body, a bad cursor or a bad path escape is looked at', async () => {
    const { base, page } = await start({ auth: true });
    const cases: [string, string, string?][] = [
      ...BODY_ROUTES.map(([m, p]): [string, string, string] => [m, p, '{bad']),
      ['PUT', '/api/mcp/policies/%ZZ', '{"policy":"off"}'],
      ['GET', '/api/judgements?cursor=99999999999999999999999999'],
      ['GET', '/api/sync/accounts'],
      ['GET', '/api/prelabel/gold'],
    ];
    for (const [method, path, body] of cases) {
      const r = await call(base, method, path, page, body);
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 401`);
    }
  });
});
