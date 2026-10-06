import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer, DASHBOARD_IDLE_TIMEOUT_S } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, disableAuth, verifyLogin, lanAuthReady, deactivateUser } from '../dashboard/auth.js';
import {
  allowedOrigins,
  canonicalOrigin,
  checkHost,
  checkStateChange,
  corsHeaders,
  isLoopbackBind,
  requireBrowserProof,
  resolveBrowserOrigin,
} from '../dashboard/origin-gate.js';
import { setGlobalStateFile, getGlobalAgentState, setGlobalAgentState } from '../mcp/global-state.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * P0b network boundary (threat model T01-T05, T29): Host allowlist, Origin
 * allowlist with no wildcard CORS, state-change gate, loopback bind with a
 * per-request LAN rule, and `?token=` limited to export downloads.
 */

const SESSION = '20000000-0000-4000-8000-000000000001';
const ENV_KEYS = ['WILSON_DASHBOARD_DEV', 'WILSON_DASHBOARD_ALLOWED_ORIGINS', 'WILSON_DASHBOARD_ALLOWED_HOSTS', 'WILSON_DASHBOARD_HOST'];

let db: Database;
let stateDir: string;
const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Never touch the real ~/.openaccountant/agent-access.json.
  stateDir = mkdtempSync(join(tmpdir(), 'oa-gate-'));
  setGlobalStateFile(join(stateDir, 'agent-access.json'));
});

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setGlobalStateFile(null);
  rmSync(stateDir, { recursive: true, force: true });
});

async function start(options: { hostname?: string; auth?: boolean } = {}) {
  db = createTestDb();
  seedTestData(db);
  let token: string | undefined;
  if (options.auth) {
    await createUser(db, 'admin1', 'password123', 'admin');
    enableAuth(db);
    token = (await verifyLogin(db, 'admin1', 'password123'))!.token;
  }
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0, options.hostname ? { hostname: options.hostname } : undefined);
  servers.push(result.server);
  const port = result.server.port as number;
  return { db, port, base: `http://localhost:${port}`, token, server: result.server };
}

describe('origin gate: pure functions', () => {
  test('allowedOrigins covers the three loopback names; dev aliases only with WILSON_DASHBOARD_DEV=1; extras from env', () => {
    expect(allowedOrigins(3141, {})).toEqual(['http://localhost:3141', 'http://127.0.0.1:3141', 'http://[::1]:3141']);
    expect(allowedOrigins(3141, { WILSON_DASHBOARD_DEV: '1' })).toEqual(expect.arrayContaining(['http://localhost:5173', 'http://127.0.0.1:5173']));
    expect(allowedOrigins(3141, { WILSON_DASHBOARD_ALLOWED_ORIGINS: 'https://dash.lan, http://10.0.0.5:3141' })).toEqual(
      expect.arrayContaining(['https://dash.lan', 'http://10.0.0.5:3141'])
    );
    expect(allowedOrigins(3141, {})).not.toContain('http://localhost:5173');
  });

  test('canonicalOrigin maps dev aliases to http://localhost:<port> and leaves others alone', () => {
    expect(canonicalOrigin('http://localhost:5173', 3141)).toBe('http://localhost:3141');
    expect(canonicalOrigin('http://127.0.0.1:5173', 3141)).toBe('http://localhost:3141');
    expect(canonicalOrigin('http://127.0.0.1:3141', 3141)).toBe('http://127.0.0.1:3141');
  });

  test('corsHeaders reflects an allowlisted origin and nothing else, never a wildcard', () => {
    expect(corsHeaders(3141, 'http://localhost:3141')).toEqual({ 'Access-Control-Allow-Origin': 'http://localhost:3141', Vary: 'Origin' });
    expect(corsHeaders(3141, 'https://evil.example')).toEqual({});
    expect(corsHeaders(3141, 'null')).toEqual({});
    expect(corsHeaders(3141, null)).toEqual({});
  });

  test('D1: dev aliases stay allowed for state changes but corsHeaders never reflects them (no cross-port ledger reads)', () => {
    const dev = { WILSON_DASHBOARD_DEV: '1' };
    expect(corsHeaders(3141, 'http://localhost:5173', dev)).toEqual({});
    expect(corsHeaders(3141, 'http://127.0.0.1:5173', dev)).toEqual({});
    // The server's own origins and explicit extras still get CORS.
    expect(corsHeaders(3141, 'http://localhost:3141', dev)).toEqual({ 'Access-Control-Allow-Origin': 'http://localhost:3141', Vary: 'Origin' });
    expect(corsHeaders(3141, 'https://dash.lan', { ...dev, WILSON_DASHBOARD_ALLOWED_ORIGINS: 'https://dash.lan' })).toEqual({
      'Access-Control-Allow-Origin': 'https://dash.lan',
      Vary: 'Origin',
    });
    // ...while the dev alias is still inside the state-change / browser-proof allowlist.
    const post = new Request('http://localhost:3141/api/mcp/grants', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' } });
    expect(checkStateChange(post, '/api/mcp/grants', 3141, dev)).toBeNull();
    expect(requireBrowserProof(post, 3141, dev)).toBeNull();
  });

  test('checkHost: loopback names pass, anything else is 421 with no body, WILSON_DASHBOARD_ALLOWED_HOSTS extends it', async () => {
    const req = (host: string) => new Request('http://localhost:3141/', { headers: { Host: host } });
    expect(checkHost(req('localhost:3141'), 3141, {})).toBeNull();
    expect(checkHost(req('127.0.0.1:3141'), 3141, {})).toBeNull();
    expect(checkHost(req('[::1]:3141'), 3141, {})).toBeNull();
    const evil = checkHost(req('evil.example:3141'), 3141, {})!;
    expect(evil.status).toBe(421);
    expect(await evil.text()).toBe('');
    expect(checkHost(req('dash.lan:3141'), 3141, {})!.status).toBe(421);
    expect(checkHost(req('dash.lan:3141'), 3141, { WILSON_DASHBOARD_ALLOWED_HOSTS: 'dash.lan' })).toBeNull();
    // A loopback name on another port addresses some other server (the vite dev server), not this one.
    expect(checkHost(req('localhost:5173'), 3141, {})!.status).toBe(421);
    expect(checkHost(req('127.0.0.1:5173'), 3141, {})!.status).toBe(421);
  });

  test('resolveBrowserOrigin: allowlisted Origin, else same-origin Sec-Fetch-Site + allowed Host, else null', () => {
    const req = (headers: Record<string, string>) => new Request('http://localhost:3141/api/mcp/grants', { headers });
    expect(resolveBrowserOrigin(req({ Origin: 'http://localhost:3141' }), 3141, {})).toBe('http://localhost:3141');
    expect(resolveBrowserOrigin(req({ Origin: 'https://evil.example' }), 3141, {})).toBeNull();
    expect(resolveBrowserOrigin(req({ Origin: 'null' }), 3141, {})).toBeNull();
    expect(resolveBrowserOrigin(req({}), 3141, {})).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-origin', Host: 'localhost:3141' }), 3141, {})).toBe('http://localhost:3141');
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-site', Host: 'localhost:3141' }), 3141, {})).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-origin', Host: 'evil.example:3141' }), 3141, {})).toBeNull();
    // Dev alias is canonicalized for grant binding.
    expect(resolveBrowserOrigin(req({ Origin: 'http://localhost:5173' }), 3141, { WILSON_DASHBOARD_DEV: '1' })).toBe('http://localhost:3141');
    expect(resolveBrowserOrigin(req({ Origin: 'http://localhost:5173' }), 3141, {})).toBeNull();
  });

  test('requireBrowserProof needs an allowlisted Origin AND Sec-Fetch-Site same-origin; the refusal is 403 origin_required', async () => {
    const req = (headers: Record<string, string>) => new Request('http://localhost:3141/api/mcp/operations/x/approve', { method: 'POST', headers });
    expect(requireBrowserProof(req({ Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-origin' }), 3141)).toBeNull();
    for (const headers of [
      {} as Record<string, string>,
      { Origin: 'http://localhost:3141' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' },
    ]) {
      const denied = requireBrowserProof(req(headers), 3141);
      expect(denied?.status).toBe(403);
      expect((await denied!.json()).error.code).toBe('origin_required');
    }
  });

  test('checkStateChange gates state-changing /api methods only', () => {
    const post = (headers: Record<string, string>, path = '/api/chat') => new Request(`http://localhost:3141${path}`, { method: 'POST', headers });
    expect(checkStateChange(post({ Origin: 'https://evil.example' }), '/api/chat', 3141, {})?.status).toBe(403);
    expect(checkStateChange(post({ Origin: 'null' }), '/api/chat', 3141, {})?.status).toBe(403);
    expect(checkStateChange(post({ 'Sec-Fetch-Site': 'same-site' }), '/api/chat', 3141, {})?.status).toBe(403);
    expect(checkStateChange(post({ 'Sec-Fetch-Site': 'cross-site' }), '/api/chat', 3141, {})?.status).toBe(403);
    expect(checkStateChange(post({ Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-origin' }), '/api/chat', 3141, {})).toBeNull();
    expect(checkStateChange(post({ 'Sec-Fetch-Site': 'none' }), '/api/chat', 3141, {})).toBeNull();
    // Non-browser clients send neither header.
    expect(checkStateChange(post({}), '/api/chat', 3141, {})).toBeNull();
    // GETs are not state changes, and /mcp has its own rule.
    expect(checkStateChange(new Request('http://localhost:3141/api/summary', { headers: { Origin: 'https://evil.example' } }), '/api/summary', 3141, {})).toBeNull();
    expect(checkStateChange(post({ Origin: 'https://evil.example' }, '/mcp'), '/mcp', 3141, {})).toBeNull();
  });
});

describe('global agent-access state file', () => {
  test('reads defaults, persists patches, and re-reads when the file changes', () => {
    expect(getGlobalAgentState()).toEqual({});
    setGlobalAgentState({ dashboardHost: '10.0.0.5' });
    expect(getGlobalAgentState().dashboardHost).toBe('10.0.0.5');
    const path = join(stateDir, 'agent-access.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).dashboardHost).toBe('10.0.0.5');
    setGlobalAgentState({ dashboardHost: undefined });
    expect(getGlobalAgentState().dashboardHost).toBeUndefined();
  });
});

describe('Host and Origin gate on the running server (T01, T02)', () => {
  test('Host evil.example → 421 on /, /api/summary and /mcp', async () => {
    const { base } = await start();
    for (const path of ['/', '/api/summary', '/mcp', '/webmcp-bridge.js']) {
      const res = await fetch(base + path, { headers: { Host: 'evil.example:3141' } });
      expect(res.status).toBe(421);
      expect(await res.text()).toBe('');
    }
  });

  test('Host 127.0.0.1:5173 (proxy without changeOrigin) → 421', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/summary', { headers: { Host: '127.0.0.1:5173' } });
    expect(res.status).toBe(421);
  });

  test('a foreign Origin gets no Access-Control-Allow-Origin on /api/transactions', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/transactions', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const noOrigin = await fetch(base + '/api/transactions');
    expect(noOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test("the server's own origin is reflected, never a wildcard", async () => {
    const { base, port } = await start();
    const origin = `http://localhost:${port}`;
    const res = await fetch(base + '/api/transactions', { headers: { Origin: origin } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    const preflight = await fetch(base + '/api/summary', { method: 'OPTIONS', headers: { Origin: origin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  test('a foreign OPTIONS preflight gets 204 with no ACAO', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/summary', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  test('/mcp rejects a present, non-allowlisted Origin', async () => {
    const { base } = await start();
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });
});

describe('state-changing requests (T04)', () => {
  test('text/plain POST /api/mcp/grants from an evil origin → 403 and no grant row', async () => {
    const { base, db: sdb } = await start();
    const res = await fetch(base + '/api/mcp/grants', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site', 'X-Wilson-Agent-Session': SESSION },
      body: JSON.stringify({ tools: ['search_transactions'] }),
    });
    expect(res.status).toBe(403);
    expect((sdb.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n).toBe(0);
  });

  test('POST /api/chat cross-site → 403', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ query: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  test('Sec-Fetch-Site same-site POST (another localhost port) → 403', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/mcp/grants', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': SESSION },
      body: JSON.stringify({ tools: ['search_transactions'] }),
    });
    expect(res.status).toBe(403);
  });

  test('Origin: null POST → 403', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/mcp/grants', {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/json', 'X-Wilson-Agent-Session': SESSION },
      body: JSON.stringify({ tools: ['search_transactions'] }),
    });
    expect(res.status).toBe(403);
  });

  test('a non-browser POST (no Origin, no Sec-Fetch-Site) still reaches ordinary routes', async () => {
    const { base } = await start();
    const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(400); // "query is required": past the gate
  });
});

/** Every GET download under /api/export/. The training ones carry per-export opt-ins, so they must be covered too. */
const EXPORT_ROUTES = ['csv', 'xlsx', 'pnl', 'net-worth', 'tax', 'training/sft', 'training/dpo', 'training/stats'];

describe('?token= is for export downloads only (T29)', () => {
  test('?token= on /api/transactions is 401, the Authorization header works', async () => {
    const { base, token } = await start({ auth: true });
    expect((await fetch(`${base}/api/transactions?token=${token}`)).status).toBe(401);
    expect((await fetch(`${base}/api/transactions`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  test('every /api/export/* GET accepts ?token= with auth enabled', async () => {
    const { base, token } = await start({ auth: true });
    for (const path of EXPORT_ROUTES) {
      const res = await fetch(`${base}/api/export/${path}?token=${token}`);
      // The token authorizes every export; the Schedule C export is also behind the Pro license (402 without one).
      expect(path === 'tax' ? [200, 402] : [200], path).toContain(res.status);
      expect((await fetch(`${base}/api/export/${path}`)).status, `${path} without a token`).toBe(401);
    }
  });

  test('the export route list above is every /api/export/* route server.ts serves (A4: a new one cannot be left untested)', () => {
    const source = readFileSync(fileURLToPath(new URL('../dashboard/server.ts', import.meta.url)), 'utf8');
    const served = [...source.matchAll(/path === '\/api\/export\/([a-z0-9/-]+)'/g)].map((m) => m[1]);
    expect([...new Set(served)].sort()).toEqual([...EXPORT_ROUTES].sort());
    expect(EXPORT_ROUTES).toContain('training/sft');
    expect(EXPORT_ROUTES).toContain('training/dpo');
    expect(EXPORT_ROUTES).toContain('training/stats');
  });

  test('?token= does not authorize a non-GET on an export route', async () => {
    const { base, token } = await start({ auth: true });
    const res = await fetch(`${base}/api/export/csv?token=${token}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('bind address and the LAN rule (T03)', () => {
  test('the server binds loopback by default', async () => {
    const { server } = await start();
    expect(server.hostname).toBe('127.0.0.1');
  });

  test('WILSON_DASHBOARD_HOST and agent-access.json dashboardHost choose the bind, the env var winning', async () => {
    setGlobalAgentState({ dashboardHost: '0.0.0.0' });
    await expect(start()).rejects.toThrow(/auth/i); // from the file: LAN bind + no auth refuses
    closeAll();
    process.env.WILSON_DASHBOARD_HOST = '127.0.0.1';
    const { server } = await start();
    expect(server.hostname).toBe('127.0.0.1');
  });

  test('a non-loopback bind with auth disabled refuses to start', async () => {
    await expect(start({ hostname: '0.0.0.0' })).rejects.toThrow(/auth/i);
  });

  test('a non-loopback bind with auth enabled starts', async () => {
    const { server, token } = await start({ hostname: '0.0.0.0', auth: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/summary`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  test('LAN bind + the active profile loses auth → 503 lan_auth_required on every request', async () => {
    const { server, db: sdb, token } = await start({ hostname: '0.0.0.0', auth: true });
    const url = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${url}/api/summary`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    disableAuth(sdb);
    for (const path of ['/api/summary', '/', '/api/auth/status']) {
      const res = await fetch(url + path);
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.code).toBe('lan_auth_required');
    }
  });

  test('LAN bind + auth flag on but no user can log in (0 users) refuses to start', async () => {
    db = createTestDb();
    seedTestData(db);
    enableAuth(db); // what Settings -> Authentication -> Enable does with zero users
    setInitialProfile('test', db);
    expect(lanAuthReady(db)).toBe(false);
    await expect(startDashboardServer(db, 0, { hostname: '0.0.0.0' })).rejects.toThrow(/admin|user/i);
  });

  test('LAN bind + only a viewer exists (no active admin) refuses to start', async () => {
    db = createTestDb();
    seedTestData(db);
    await createUser(db, 'viewer1', 'password123', 'viewer');
    enableAuth(db);
    setInitialProfile('test', db);
    await expect(startDashboardServer(db, 0, { hostname: '0.0.0.0' })).rejects.toThrow(/admin|user/i);
  });

  test('LAN bind: when the last active admin is deactivated, every request is 503 and /api/auth/setup cannot mint an admin', async () => {
    const { server, db: sdb, token } = await start({ hostname: '0.0.0.0', auth: true });
    const url = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${url}/api/summary`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    deactivateUser(sdb, 1);
    sdb.prepare('DELETE FROM dashboard_users').run(); // zero users: the window /api/auth/setup is public in
    for (const path of ['/api/summary', '/']) {
      const res = await fetch(url + path);
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.code).toBe('lan_auth_required');
    }
    const setup = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'attacker', password: 'password123' }),
    });
    expect(setup.status).toBe(503);
    expect((sdb.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get() as { c: number }).c).toBe(0);
  });

  test('LAN bind + switching to a profile with auth on but zero users → 409', async () => {
    const other = createTestDb();
    enableAuth(other);
    setInitialProfile('other', other);
    const { server, token } = await start({ hostname: '0.0.0.0', auth: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profiles/switch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'other' }),
    });
    expect(res.status).toBe(409);
  });

  test('isLoopbackBind: only localhost, ::1 and a literal 127/8 address are loopback', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackBind(h)).toBe(true);
    for (const h of ['127.example.com', '127.0.0.1.evil.test', '0.0.0.0', '::', '192.168.1.5', '127.0.0.256', '']) {
      expect(isLoopbackBind(h)).toBe(false);
    }
  });

  test('LAN bind + switching to a profile without auth → 409', async () => {
    const other = createTestDb();
    setInitialProfile('other', other); // registered, no auth
    const { server, token } = await start({ hostname: '0.0.0.0', auth: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profiles/switch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'other' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('no dashboard auth');
    const profiles = (await (await fetch(`http://127.0.0.1:${server.port}/api/profiles`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any;
    expect(profiles.active).toBe('test');
  });

  test('on loopback, switching profiles is not gated by auth', async () => {
    const other = createTestDb();
    setInitialProfile('other', other);
    const { base } = await start();
    const res = await fetch(`${base}/api/profiles/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'other' }) });
    expect(res.status).toBe(200);
  });

  test('server idleTimeout is 255 s, the Bun maximum, so the /mcp approval wait survives', () => {
    expect(DASHBOARD_IDLE_TIMEOUT_S).toBe(255);
    const source = readFileSync(new URL('../dashboard/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('idleTimeout: DASHBOARD_IDLE_TIMEOUT_S');
  });
});

describe('vite dev server config', () => {
  test('server.cors is off and allowedHosts is pinned, so another localhost port cannot read /api through the proxy', () => {
    const source = readFileSync(new URL('../dashboard/ui/vite.config.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/server:\s*\{[\s\S]*?\bcors:\s*false/);
    expect(source).toMatch(/allowedHosts:\s*\[/);
  });
});

describe('dev UI through the vite proxy (WILSON_DASHBOARD_DEV=1)', () => {
  function devGrant(base: string, port: number, host = `localhost:${port}`) {
    return fetch(base + '/api/mcp/grants', {
      method: 'POST',
      headers: {
        Host: host,
        Origin: 'http://localhost:5173',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        'X-Wilson-Agent-Session': SESSION,
      },
      body: JSON.stringify({ tools: ['search_transactions'] }),
    });
  }

  test('dev-style request with the dev flag → 200, and the grant is bound to the canonical origin', async () => {
    process.env.WILSON_DASHBOARD_DEV = '1';
    const { base, port, db: sdb } = await start();
    const res = await devGrant(base, port);
    expect(res.status).toBe(200);
    const row = sdb.prepare('SELECT origin FROM mcp_grants').get() as { origin: string };
    expect(row.origin).toBe(`http://localhost:${port}`);

    // The same tab's later GET: no Origin, Sec-Fetch-Site same-origin, Host :3141 after changeOrigin.
    const grants = await fetch(base + '/api/mcp/grants', { headers: { 'Sec-Fetch-Site': 'same-origin', 'X-Wilson-Agent-Session': SESSION } });
    expect(((await grants.json()) as any).grants.map((g: any) => g.tool_name)).toEqual(['search_transactions']);
  });

  test('D1: a GET from the vite origin (same-site) gets no Access-Control-Allow-Origin, so another app on :5173 cannot read the ledger', async () => {
    process.env.WILSON_DASHBOARD_DEV = '1';
    const { base, port } = await start();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const res = await fetch(base + '/api/transactions', { headers: { Host: `localhost:${port}`, Origin: origin, 'Sec-Fetch-Site': 'same-site' } });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const own = await fetch(base + '/api/transactions', { headers: { Origin: `http://localhost:${port}` } });
    expect(own.headers.get('Access-Control-Allow-Origin')).toBe(`http://localhost:${port}`);
  });

  test('the same request without the dev flag → 403', async () => {
    const { base, port, db: sdb } = await start();
    const res = await devGrant(base, port);
    expect(res.status).toBe(403);
    expect((sdb.prepare('SELECT COUNT(*) AS n FROM mcp_grants').get() as { n: number }).n).toBe(0);
  });
});

describe('D2: a malformed Host is a 4xx with no stack page', () => {
  function rawRequest(port: number, host: string): Promise<string> {
    return new Promise((resolve) => {
      let out = '';
      Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          open(sock) { sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`); },
          data(_sock, d) { out += d.toString(); },
          close() { resolve(out); },
          error() { resolve(out); },
        },
      });
    });
  }

  test.each(['[', 'a b', 'x:99999999', 'evil/../x', '%zz', ''])('Host %p -> 4xx, body has no absolute paths', async (host) => {
    const { port } = await start();
    const raw = await rawRequest(port, host);
    const status = Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('Invalid URL');
    expect(body).toBe('');
  });

  test('Bun development mode is off, so an unhandled error never renders a source-and-paths page', async () => {
    const { server } = await start();
    expect((server as any).development).toBe(false);
  });
});

describe('anti-framing (clickjacking)', () => {
  test('every dashboard response forbids framing: HTML, API, static, 404, preflight, /mcp', async () => {
    const { base } = await start();
    const paths = ['/', '/webmcp-bridge.js', '/api/mcp/operations', '/api/auth/status', '/assets/nope.js', '/no-such-route', '/mcp'];
    for (const p of paths) {
      const res = await fetch(`${base}${p}`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
      await res.arrayBuffer();
      expect(res.headers.get('X-Frame-Options'), p).toBe('DENY');
      expect(res.headers.get('Content-Security-Policy'), p).toContain("frame-ancestors 'none'");
    }
    const preflight = await fetch(`${base}/api/mcp/operations`, { method: 'OPTIONS', headers: { Origin: base } });
    expect(preflight.headers.get('X-Frame-Options')).toBe('DENY');
    const hostDenied = await fetch(`${base}/`, { headers: { Host: 'evil.example' } });
    expect(hostDenied.headers.get('X-Frame-Options')).toBe('DENY');
  });

  test('also holds with auth on (401 responses)', async () => {
    const { base } = await start({ auth: true });
    const res = await fetch(`${base}/api/mcp/operations`);
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
