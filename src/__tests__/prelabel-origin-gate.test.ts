/**
 * S3 (critic C1): the interim request gate on every /api/prelabel route
 * (specs/open-jev-labeler.md §9.0). HTTP-level, auth off.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { setActiveProfilePaths, resetActiveProfile } from '../profile/index.js';
import { networkInterfaces } from 'node:os';
import { checkHost, corsHeaders, isAllowedOrigin, isLoopbackPeer, requireBrowserProof, resolveBrowserOrigin } from '../prelabel/origin-gate-interim.js';
import { handlePrelabelRoute, type PrelabelRouteContext } from '../prelabel/routes.js';

describe('prelabel origin gate (HTTP)', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let own: string;
  const settingsFile = () => join(dir, 'settings.json');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prelabel-gate-'));
    setActiveProfilePaths({
      name: 'test', root: dir, database: join(dir, 'data.db'), settings: settingsFile(),
      scratchpad: join(dir, 'scratchpad'), cache: join(dir, 'cache'),
    });
    const db = createTestDb();
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${server.port}`;
    own = base;
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* */ }
    closeAll();
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  const sameOriginJson = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: own, 'Sec-Fetch-Site': 'same-origin', ...extra },
    body: JSON.stringify(body),
  });

  // ── CORS ────────────────────────────────────────────────────────────────

  test('foreign Origin gets no Access-Control-Allow-Origin on config', async () => {
    const res = await fetch(`${base}/api/prelabel/config`, { headers: { Origin: 'http://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('own Origin is reflected, never *', async () => {
    const res = await fetch(`${base}/api/prelabel/config`, { headers: { Origin: own } });
    expect(res.headers.get('access-control-allow-origin')).toBe(own);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('127.0.0.1 own origin is also reflected', async () => {
    const o = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/prelabel/config`, { headers: { Origin: o } });
    expect(res.headers.get('access-control-allow-origin')).toBe(o);
  });

  test('a request with no Origin gets no wildcard', async () => {
    const res = await fetch(`${base}/api/prelabel/config`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('other (non-prelabel) routes never grant a foreign origin either (no wildcard CORS anywhere)', async () => {
    const res = await fetch(`${base}/api/summary`, { headers: { Origin: 'http://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── Read gate (/gold) ───────────────────────────────────────────────────

  test('GET /gold with a foreign Origin is 403 origin_denied', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { Origin: 'http://evil.example' } });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('origin_denied');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('GET /gold with Sec-Fetch-Site cross-site or same-site is 403', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await fetch(`${base}/api/prelabel/gold`, { headers: { 'Sec-Fetch-Site': site } });
      expect(res.status).toBe(403);
    }
  });

  test('GET /gold with Origin: null is 403', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { Origin: 'null' } });
    expect(res.status).toBe(403);
  });

  test('GET /gold with neither Origin nor Sec-Fetch-Site (curl, LAN script) is 403 origin_required', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('origin_required');
  });

  test('GET /gold with Sec-Fetch-Site none is 403 (not browser proof for a fetch)', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { 'Sec-Fetch-Site': 'none' } });
    expect(res.status).toBe(403);
  });

  test('GET /gold with a non-loopback Host and Sec-Fetch-Site same-origin is refused: 421, no body (DNS rebinding, round-3 checkHost)', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { 'Sec-Fetch-Site': 'same-origin', Host: 'rebind.example' } });
    expect(res.status).toBe(421);
    expect(await res.text()).toBe('');
  });

  test('GET /gold with Sec-Fetch-Site same-origin (what a browser sends for a same-origin GET) passes', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(res.status).toBe(200);
  });

  test('GET /gold with the own Origin passes', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: { Origin: own } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(own);
  });

  test('a gold 403 carries no wildcard CORS header', async () => {
    const res = await fetch(`${base}/api/prelabel/gold`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── State-changing gate (PUT /settings) ─────────────────────────────────

  test('PUT settings with text/plain is 415', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', Origin: own, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(415);
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('PUT settings with Sec-Fetch-Site same-site is 403', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ enabled: true }, { 'Sec-Fetch-Site': 'same-site' }));
    expect(res.status).toBe(403);
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('PUT settings with a foreign Origin is 403', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ enabled: true }, { Origin: 'http://evil.example' }));
    expect(res.status).toBe(403);
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('PUT settings with no Origin is 403 (browser proof)', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('origin_required');
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('same-origin JSON PUT is 200 and writes settings.json in the temp profile', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ enabled: true, marginCut: 0.45 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, marginCut: 0.45 });
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf-8'));
    expect(saved.prelabelEnabled).toBe(true);
    expect(saved.prelabelMarginCut).toBe(0.45);
    const cfg = await (await fetch(`${base}/api/prelabel/config`)).json() as { enabled: boolean; marginCut: number };
    expect(cfg.enabled).toBe(true);
    expect(cfg.marginCut).toBe(0.45);
  });

  test('a partial update leaves the other setting alone', async () => {
    await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 0.5 }));
    const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ enabled: true }));
    expect(await res.json()).toEqual({ enabled: true, marginCut: 0.5 });
  });

  test('marginCut: 2 is 400 and writes nothing', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 2 }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('marginCut bounds 0.05 and 0.95 are accepted, 0.04 and 0.96 rejected', async () => {
    expect((await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 0.05 }))).status).toBe(200);
    expect((await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 0.95 }))).status).toBe(200);
    expect((await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 0.04 }))).status).toBe(400);
    expect((await fetch(`${base}/api/prelabel/settings`, sameOriginJson({ marginCut: 0.96 }))).status).toBe(400);
  });

  test('unknown keys (strict body) are 400: file-only settings cannot be set here', async () => {
    for (const body of [{ prelabelDailyLimit: 5 }, { enabled: true, extra: 1 }, { enabled: 'yes' }]) {
      const res = await fetch(`${base}/api/prelabel/settings`, sameOriginJson(body));
      expect(res.status).toBe(400);
    }
    expect(existsSync(settingsFile())).toBe(false);
  });

  test('malformed JSON is 400', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: own, 'Sec-Fetch-Site': 'same-origin' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  test('POST (wrong method) to settings is 405 and never reaches the handler', async () => {
    const res = await fetch(`${base}/api/prelabel/settings`, { ...sameOriginJson({ enabled: true }), method: 'POST' });
    expect(res.status).toBe(405);
    expect(existsSync(settingsFile())).toBe(false);
  });
});

describe('origin-gate-interim (unit): signatures match judge P0b origin-gate.ts', () => {
  const req = (headers: Record<string, string>, url = 'http://localhost:3141/x') => new Request(url, { headers });

  test('isAllowedOrigin(origin, port): own origins only, null and the string "null" are not', () => {
    expect(isAllowedOrigin('http://localhost:3141', 3141)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3141', 3141)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:3141', 3141)).toBe(true);
    expect(isAllowedOrigin('http://localhost:9999', 3141)).toBe(false);
    expect(isAllowedOrigin('http://evil.example', 3141)).toBe(false);
    expect(isAllowedOrigin('null', 3141)).toBe(false);
    expect(isAllowedOrigin(null, 3141)).toBe(false);
  });

  test('isAllowedOrigin honours WILSON_DASHBOARD_DEV and WILSON_DASHBOARD_ALLOWED_ORIGINS via an env argument', () => {
    expect(isAllowedOrigin('http://localhost:5173', 3141, {})).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173', 3141, { WILSON_DASHBOARD_DEV: '1' })).toBe(true);
    expect(isAllowedOrigin('https://oa.lan', 3141, { WILSON_DASHBOARD_ALLOWED_ORIGINS: 'https://oa.lan/' })).toBe(true);
  });

  test('corsHeaders(port, origin) reflects own origins only', () => {
    expect(corsHeaders(3141, null)).toEqual({});
    expect(corsHeaders(3141, 'http://evil.example')).toEqual({});
    expect(corsHeaders(3141, 'http://localhost:3141')).toEqual({ 'Access-Control-Allow-Origin': 'http://localhost:3141', Vary: 'Origin' });
    expect(corsHeaders(3141, 'http://localhost:9999')).toEqual({});
    expect(corsHeaders(3141, 'http://[::1]:3141')['Access-Control-Allow-Origin']).toBe('http://[::1]:3141');
  });

  test('corsHeaders never grants CORS to the vite dev alias, even with WILSON_DASHBOARD_DEV=1', () => {
    expect(corsHeaders(3141, 'http://localhost:5173', { WILSON_DASHBOARD_DEV: '1' })).toEqual({});
  });

  test('requireBrowserProof(req, port?) needs an allowlisted Origin AND same-origin', async () => {
    expect(requireBrowserProof(req({ Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-origin' }), 3141)).toBeNull();
    expect(requireBrowserProof(req({}), 3141)?.status).toBe(403);
    expect(requireBrowserProof(req({ Origin: 'http://localhost:3141' }), 3141)?.status).toBe(403);
    expect(requireBrowserProof(req({ 'Sec-Fetch-Site': 'same-origin' }), 3141)?.status).toBe(403);
    expect(requireBrowserProof(req({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin' }), 3141)?.status).toBe(403);
    const denied = requireBrowserProof(req({}), 3141);
    expect((await denied!.json() as { error: { code: string } }).error.code).toBe('origin_required');
  });

  test('requireBrowserProof defaults the port to the request URL port', () => {
    const ok = req({ Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-origin' });
    expect(requireBrowserProof(ok)).toBeNull();
    const wrongPort = req({ Origin: 'http://localhost:3141', 'Sec-Fetch-Site': 'same-origin' }, 'http://localhost:4000/x');
    expect(requireBrowserProof(wrongPort)?.status).toBe(403);
  });

  test('resolveBrowserOrigin: allowlisted Origin, else same-origin fetch with an allowed Host, else null', () => {
    expect(resolveBrowserOrigin(req({ Origin: 'http://localhost:3141' }), 3141)).toBe('http://localhost:3141');
    expect(resolveBrowserOrigin(req({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin', Host: 'localhost:3141' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin', Host: 'localhost:3141' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-origin', Host: 'localhost:3141' }), 3141)).toBe('http://localhost:3141');
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-origin', Host: 'rebind.example' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'same-origin', Host: 'localhost:5173' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'none', Host: 'localhost:3141' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ 'Sec-Fetch-Site': 'cross-site', Host: 'localhost:3141' }), 3141)).toBeNull();
    expect(resolveBrowserOrigin(req({ Host: 'localhost:3141' }), 3141)).toBeNull();
  });
});

describe('origin-gate-interim (unit): loopback peer and Host checks, same signatures as judge P0b', () => {
  const hostReq = (host: string) => new Request('http://localhost:3141/', { headers: { Host: host } });

  test('isLoopbackPeer(address): ::1, 127/8 and ::ffff:127/8 only; undefined and LAN addresses are not', () => {
    for (const a of ['::1', '127.0.0.1', '127.1.2.3', '::ffff:127.0.0.1', ' ::1 ']) expect(isLoopbackPeer(a)).toBe(true);
    for (const a of [undefined, '', '192.168.1.50', '10.0.0.2', '::ffff:192.168.1.50', '0.0.0.0', 'fe80::1', '127.example.com', '128.0.0.1']) {
      expect(isLoopbackPeer(a)).toBe(false);
    }
  });

  test('checkHost(req, port, env?): loopback names with this port pass, anything else is 421 with no body', async () => {
    expect(checkHost(hostReq('localhost:3141'), 3141, {})).toBeNull();
    expect(checkHost(hostReq('127.0.0.1:3141'), 3141, {})).toBeNull();
    expect(checkHost(hostReq('[::1]:3141'), 3141, {})).toBeNull();
    const evil = checkHost(hostReq('evil.example:3141'), 3141, {})!;
    expect(evil.status).toBe(421);
    expect(await evil.text()).toBe('');
    expect(checkHost(hostReq('dash.lan:3141'), 3141, {})!.status).toBe(421);
    expect(checkHost(hostReq('dash.lan:3141'), 3141, { WILSON_DASHBOARD_ALLOWED_HOSTS: 'dash.lan' })).toBeNull();
    expect(checkHost(hostReq('localhost:5173'), 3141, {})!.status).toBe(421);
    expect(checkHost(hostReq('127.0.0.1:5173'), 3141, {})!.status).toBe(421);
  });
});

describe('prelabel routes refuse a non-loopback peer that spoofs browser headers (handlePrelabelRoute)', () => {
  const PORT = 3141;
  const own = `http://localhost:${PORT}`;
  const ctx = (peerAddress: string | undefined): PrelabelRouteContext => ({
    db: createTestDb(),
    headers: {},
    authEnabled: false,
    currentUser: null,
    canWrite: () => true,
    port: PORT,
    profile: 'test',
    peerAddress,
  });
  /** Every header a browser on the dashboard page would send, forged by a LAN script. */
  const spoofed = (extra: Record<string, string> = {}): Record<string, string> => ({
    Host: `localhost:${PORT}`,
    Origin: own,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  });
  const call = (c: PrelabelRouteContext, path: string, init: RequestInit) =>
    handlePrelabelRoute(new Request(`${own}${path}`, init), new URL(`${own}${path}`), c);

  const LAN_PEERS = ['192.168.1.50', '10.0.0.7', '::ffff:192.168.1.50', 'fe80::1', undefined];

  test('GET config, GET gold and PUT settings are 403 loopback_required from a LAN peer with perfect headers', async () => {
    for (const peer of LAN_PEERS) {
      const c = ctx(peer);
      const reqs: [string, RequestInit][] = [
        ['/api/prelabel/config', { headers: spoofed() }],
        ['/api/prelabel/gold', { headers: spoofed() }],
        ['/api/prelabel/settings', { method: 'PUT', headers: spoofed({ 'Content-Type': 'application/json' }), body: JSON.stringify({ enabled: true }) }],
      ];
      for (const [path, init] of reqs) {
        const res = (await call(c, path, init))!;
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('loopback_required');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
      }
    }
  });

  test('the same requests from a loopback peer pass the gate', async () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const c = ctx(peer);
      expect((await call(c, '/api/prelabel/config', { headers: spoofed() }))!.status).toBe(200);
      expect((await call(c, '/api/prelabel/gold', { headers: spoofed() }))!.status).toBe(200);
    }
  });

  test('a Host that is not ours is 421 on every prelabel route, even from a loopback peer (DNS rebinding)', async () => {
    const c = ctx('127.0.0.1');
    for (const [path, method] of [['/api/prelabel/config', 'GET'], ['/api/prelabel/gold', 'GET'], ['/api/prelabel/settings', 'PUT']]) {
      const res = (await call(c, path, { method, headers: spoofed({ Host: 'rebind.example' }) }))!;
      expect(res.status).toBe(421);
      expect(await res.text()).toBe('');
    }
  });

  test('a LAN-mode Host (WILSON_DASHBOARD_ALLOWED_HOSTS) does not buy a LAN peer access', async () => {
    const prev = process.env.WILSON_DASHBOARD_ALLOWED_HOSTS;
    process.env.WILSON_DASHBOARD_ALLOWED_HOSTS = 'dash.lan';
    try {
      const res = (await call(ctx('192.168.1.50'), '/api/prelabel/gold', { headers: spoofed({ Host: 'dash.lan:3141' }) }))!;
      expect(res.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.WILSON_DASHBOARD_ALLOWED_HOSTS;
      else process.env.WILSON_DASHBOARD_ALLOWED_HOSTS = prev;
    }
  });

  test('paths the module does not own still return null for any peer', async () => {
    expect(await call(ctx('192.168.1.50'), '/api/summary', { headers: spoofed() })).toBeNull();
  });
});

const lanIp = (() => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
})();

describe.skipIf(lanIp === null)('prelabel over a real socket from a non-loopback peer', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prelabel-lan-'));
    setActiveProfilePaths({
      name: 'test', root: dir, database: join(dir, 'data.db'), settings: join(dir, 'settings.json'),
      scratchpad: join(dir, 'scratchpad'), cache: join(dir, 'cache'),
    });
    const db = createTestDb();
    setInitialProfile('test', db);
    server = (await startDashboardServer(db, 0)).server;
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* */ }
    closeAll();
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  test('connecting via the machine LAN address, forging Host/Origin/Sec-Fetch-Site, is refused; loopback still works', async () => {
    const port = server.port;
    const forged = { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' };
    // The dashboard binds to loopback by default, so a LAN peer usually cannot even connect; that is a refusal too.
    // When it can connect (a LAN bind), each prelabel route still answers 403 loopback_required.
    const viaLan = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
      try {
        return await fetch(`http://${lanIp}:${port}${path}`, init);
      } catch {
        return null;
      }
    };
    for (const path of ['/api/prelabel/config', '/api/prelabel/gold']) {
      const res = await viaLan(path, { headers: forged });
      if (res === null) continue;
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('loopback_required');
    }
    const put = await viaLan('/api/prelabel/settings', {
      method: 'PUT',
      headers: { ...forged, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    if (put !== null) expect(put.status).toBe(403);
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);

    const ok = await fetch(`http://localhost:${port}/api/prelabel/gold`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    expect(ok.status).toBe(200);
  });
});
