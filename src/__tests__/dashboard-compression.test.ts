import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer, serveDashboardAsset } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * The dashboard inlines its whole React build into one ~3 MB index.html. Served raw that was ~15.7 s
 * LCP on a throttled phone; the page and /assets/* must be compressed when the client allows it.
 */

// @invariant NN-10
describe('dashboard compression', () => {
  let db: Database;
  let base = '';
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;

  beforeEach(async () => {
    db = createTestDb(); // temp profile, never a real ~/.openaccountant profile
    setInitialProfile('compression-test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${result.server.port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    closeAll();
  });

  // fetch() would transparently decode, so read the raw bytes with decompress off.
  const get = (path: string, enc?: string) =>
    fetch(`${base}${path}`, { headers: enc ? { 'Accept-Encoding': enc } : {}, decompress: false } as RequestInit);

  test('HTML is gzip-encoded after bridge injection, with Vary and a matching body', async () => {
    const plain = await (await get('/', 'identity')).text();
    const res = await get('/', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    expect(res.headers.get('vary')).toContain('Origin');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeLessThan(plain.length / 2);
    const html = gunzipSync(bytes).toString('utf8');
    expect(html).toBe(plain);
    expect(html).toContain('/webmcp-bridge.js');
  });

  test('prefers br when offered, and serves identity with Vary when not accepted', async () => {
    const br = await get('/', 'gzip, deflate, br');
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString('utf8')).toContain('/webmcp-bridge.js');

    const none = await get('/');
    expect(none.headers.get('content-encoding')).toBeNull();
    expect(none.headers.get('vary')).toContain('Accept-Encoding');

    const refused = await get('/', 'gzip;q=0, br;q=0');
    expect(refused.headers.get('content-encoding')).toBeNull();
  });
});

describe('serveDashboardAsset compression', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('compresses js/wasm/json when accepted, leaves other types alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    const js = 'export const x = 1;\n'.repeat(500);
    writeFileSync(join(dir, 'hybrid-chat.js'), js);
    mkdirSync(join(dir, 'ort'), { recursive: true });
    writeFileSync(join(dir, 'ort', 'model.wasm'), Buffer.alloc(4096));
    writeFileSync(join(dir, 'font.woff2'), Buffer.alloc(4096));

    const gz = await serveDashboardAsset('/assets/hybrid-chat.js', dir, { Vary: 'Origin' }, 'gzip');
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('vary')).toBe('Origin, Accept-Encoding');
    expect(gz.headers.get('content-type')).toContain('text/javascript');
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString('utf8')).toBe(js);

    const wasm = await serveDashboardAsset('/assets/ort/model.wasm', dir, {}, 'br');
    expect(wasm.headers.get('content-encoding')).toBe('br');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');

    const font = await serveDashboardAsset('/assets/font.woff2', dir, {}, 'gzip');
    expect(font.headers.get('content-encoding')).toBeNull();

    const raw = await serveDashboardAsset('/assets/hybrid-chat.js', dir, {});
    expect(raw.headers.get('content-encoding')).toBeNull();
    expect(await raw.text()).toBe(js);
  });

  test('a changed file is re-compressed, not served stale from the cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    writeFileSync(join(dir, 'a.js'), 'export const v = 1;\n'.repeat(100));
    await serveDashboardAsset('/assets/a.js', dir, {}, 'gzip');
    const next = 'export const v = 22;\n'.repeat(120);
    writeFileSync(join(dir, 'a.js'), next);
    const res = await serveDashboardAsset('/assets/a.js', dir, {}, 'gzip');
    expect(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString('utf8')).toBe(next);
  });
});
