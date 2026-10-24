// @invariant NN-10 NN-05
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createTestDb } from './helpers.js';
import {
  DASHBOARD_APP_DIR,
  DASHBOARD_APP_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  serveDashboardAsset,
  startDashboardServer,
  stopDashboardServer,
} from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { setGlobalStateFile } from '../mcp/global-state.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * The React dashboard ships as index.html plus content-hashed files under /_app/ (vite `assetsDir`), not one
 * inlined 3 MB page: the HTML is revalidated on every load, the hashed files are cached for a year. These are
 * public build artifacts (no auth, like the HTML), still behind the Host gate, and the route must never serve
 * anything outside dist/_app/.
 */

const HASHED_JS = 'index-AbC123_x.js';
const JS_BODY = 'export const answer = 42;\n'.repeat(200);

describe('serveDashboardAsset under /_app/', () => {
  let dir: string;
  let outside: string;
  const opts = { prefix: DASHBOARD_APP_PREFIX, immutableHashed: true };
  const serve = (p: string, enc: string | null = null) => serveDashboardAsset(p, dir, { Vary: 'Origin' }, enc, opts);

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'oa-app-assets-'));
    dir = join(root, '_app');
    mkdirSync(dir);
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, HASHED_JS), JS_BODY);
    writeFileSync(join(dir, 'style-Zz9_-yX1.css'), 'body{color:red}\n'.repeat(100));
    writeFileSync(join(dir, 'wa-sqlite-Bkv7CwRB.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    writeFileSync(join(dir, 'unhashed.js'), 'export {};\n');
    // A sibling of the asset dir, as dist/index.html is: it must stay unreachable.
    outside = join(root, 'secret.txt');
    writeFileSync(outside, 'FAKE secret (dummy)');
  });

  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  test('hashed JS: JavaScript type, immutable for a year, nosniff', async () => {
    const res = await serve(`/_app/${HASHED_JS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(IMMUTABLE_CACHE_CONTROL).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(JS_BODY);
  });

  test('CSS and wasm get their own types (wasm must be application/wasm for streaming compile)', async () => {
    const css = await serve('/_app/style-Zz9_-yX1.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    const wasm = await serve('/_app/wa-sqlite-Bkv7CwRB.wasm');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
  });

  test('keeps the compressed-asset cache: gzip when accepted, with Vary, same bytes', async () => {
    const res = await serve(`/_app/${HASHED_JS}`, 'gzip');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    expect(res.headers.get('vary')).toContain('Origin');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeLessThan(JS_BODY.length / 2);
    expect(gunzipSync(bytes).toString('utf8')).toBe(JS_BODY);
  });

  test('a name without a content hash is never sent immutable', async () => {
    const res = await serve('/_app/unhashed.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('refuses traversal, directories, odd separators and missing files with a bare 404', async () => {
    const attempts = [
      '/_app/../secret.txt',
      '/_app/nested/../../secret.txt',
      '/_app/..%2Fsecret.txt',
      '/_app/%2e%2e/secret.txt',
      '/_app/..\\secret.txt',
      `/_app/${outside}`,
      '/_app//etc/passwd',
      '/_app/nested',
      '/_app/nested/',
      '/_app/',
      '/_app/missing-AbCdEf12.js',
      `/_app/${HASHED_JS}\0.txt`,
      '/assets/x.js', // wrong prefix for this directory
    ];
    for (const p of attempts) {
      const res = await serve(p);
      expect({ p, status: res.status }).toEqual({ p, status: 404 });
      expect(res.headers.get('cache-control')).toBeNull();
      expect(await res.text()).not.toContain('FAKE secret');
    }
  });
});

describe('dashboard server: page and /_app/ route', () => {
  let db: Database;
  let stateDir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;
  let base = '';
  let port = 0;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'oa-app-route-'));
    setGlobalStateFile(join(stateDir, 'agent-access.json')); // never the real ~/.openaccountant
    db = createTestDb();
    setInitialProfile('app-assets-test', db);
    await createUser(db, 'admin1', 'password123', 'admin');
    enableAuth(db); // the assets must load before a login, like the page itself
    const started = await startDashboardServer(db, 0);
    server = started.server;
    port = server.port!;
    base = `http://localhost:${port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    closeAll();
    setGlobalStateFile(null);
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Send a request line verbatim (fetch would normalize `..` away before it left the client). */
  const raw = (target: string, host = `localhost:${port}`) =>
    new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let out = '';
      sock.on('data', (d) => (out += d.toString('latin1')));
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });

  test('index.html is revalidated (no-cache), the API stays behind the login', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('/webmcp-bridge.js');
    expect((await fetch(`${base}/api/accounts`)).status).toBe(401);
  });

  test('the WebMCP bridge script is compressed and revalidated', async () => {
    const res = await fetch(`${base}/webmcp-bridge.js`, { headers: { 'Accept-Encoding': 'gzip' }, decompress: false } as RequestInit);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString('utf8').length).toBeGreaterThan(1000);
  });

  test('/_app/ answers without a login, refuses traversal and only takes GET/HEAD', async () => {
    const missing = await fetch(`${base}/_app/nope-AbCdEf12.js`);
    expect(missing.status).toBe(404); // public route: a 404, never a 401

    for (const target of ['/_app/../server.ts', '/_app/..%2F..%2Fserver.ts', '/_app/%2e%2e/%2e%2e/server.ts', '/_app/../../../package.json']) {
      const res = await raw(target);
      expect(res.split('\r\n')[0]).not.toContain(' 200 ');
      expect(res).not.toContain('startDashboardServer');
      expect(res).not.toContain('"name": "@openaccountant');
    }

    const post = await fetch(`${base}/_app/x-AbCdEf12.js`, { method: 'POST', headers: { Origin: base } });
    expect(post.status).toBe(405);
  });

  test('/_app/ is still behind the Host gate (NN-05)', async () => {
    const res = await raw('/_app/index-AbCdEf12.js', `evil.example:${port}`);
    expect(res.split('\r\n')[0]).toContain(' 421 ');
  });

  const indexPath = new URL('../dashboard/ui/dist/index.html', import.meta.url).pathname;
  const built = existsSync(indexPath) && existsSync(DASHBOARD_APP_DIR);

  test.skipIf(!built)('every file the built page names is served, hashed and immutable, before login', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/_app\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(2); // entry script + stylesheet at least
    for (const ref of refs) {
      const res = await fetch(`${base}${ref}`);
      expect({ ref, status: res.status }).toEqual({ ref, status: 200 });
      expect(res.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(res.headers.get('content-type')).toMatch(ref.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    }
    // The served page is the built one plus the bridge tag, nothing inlined on the way.
    expect(html.length).toBeLessThan(readFileSync(indexPath, 'utf8').length + 200);
  });
});
