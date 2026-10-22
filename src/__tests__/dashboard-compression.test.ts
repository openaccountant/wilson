import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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

// @invariant NN-10
describe('compression stays off the event loop', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Incompressible-ish bytes make brotli q9 take long enough to be measurable.
  const noise = (n: number) => {
    const b = new Uint8Array(n);
    for (let o = 0; o < n; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(n, o + 65536)));
    return b;
  };

  test('compressBytes returns a promise', async () => {
    const { compressBytes } = await import('../dashboard/compression.js');
    const p = compressBytes(new Uint8Array(1024), 'gzip');
    expect(p).toBeInstanceOf(Promise);
    expect((await p).length).toBeGreaterThan(0);
  });

  test('timers keep firing while a large asset compresses', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    writeFileSync(join(dir, 'big.wasm'), noise(32 * 1024 * 1024));

    // One job only: if compression blocked the loop, the single stall would span the whole request.
    // (With several jobs a blocking implementation stalls for only one job's length, ~elapsed/N, and slips through.)
    let maxGap = 0;
    let ticks = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 2);

    const t0 = performance.now();
    const res = await serveDashboardAsset('/assets/big.wasm', dir, {}, 'br');
    const elapsed = performance.now() - t0;
    clearInterval(timer);

    expect(res.headers.get('content-encoding')).toBe('br');
    expect(elapsed).toBeGreaterThan(50); // sanity: the job really was heavy
    expect(maxGap).toBeLessThan(elapsed / 4);
    expect(ticks).toBeGreaterThan(elapsed / 2 / 4); // at least a quarter of the expected ticks fired
  });

  test('concurrent first requests for one asset share a single compression job', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    writeFileSync(join(dir, 'shared.js'), 'export const x = 1;\n'.repeat(5000));

    const mod = await import('../dashboard/compression.js');
    const spy = spyOn(mod, 'compressBytes');
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => serveDashboardAsset('/assets/shared.js', dir, {}, 'gzip')),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const bodies = await Promise.all(responses.map((r) => r.arrayBuffer()));
      expect(responses.every((r) => r.headers.get('content-encoding') === 'gzip')).toBe(true);
      expect(new Set(bodies.map((b) => Buffer.from(b).toString('base64'))).size).toBe(1);

      // A later request is a cache hit, not a second job.
      await serveDashboardAsset('/assets/shared.js', dir, {}, 'gzip');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
