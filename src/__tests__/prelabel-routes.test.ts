/** S3: GET /api/prelabel/config (specs/open-jev-labeler.md §9.1). */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers.js';
import { insertTransactions } from '../db/queries.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { setActiveProfilePaths, resetActiveProfile } from '../profile/index.js';
import { PRELABEL_MODEL } from '../prelabel/config.js';
import { CATEGORIES } from '../tools/categorize/categories.js';

describe('GET /api/prelabel/config', () => {
  let dir: string;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prelabel-routes-'));
    setActiveProfilePaths({
      name: 'test', root: dir, database: join(dir, 'data.db'), settings: join(dir, 'settings.json'),
      scratchpad: join(dir, 'scratchpad'), cache: join(dir, 'cache'),
    });
    const db = createTestDb();
    setInitialProfile('test', db);
    // createTestDb only sets a profile when none is set; ours is already set.
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* */ }
    closeAll();
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns the documented shape, off by default', async () => {
    const res = await fetch(`${base}/api/prelabel/config`);
    expect(res.status).toBe(200);
    const cfg = await res.json() as Record<string, unknown>;
    expect(cfg.enabled).toBe(false);
    expect(cfg.profile).toBe('test');
    expect(cfg.pins).toEqual({ ...PRELABEL_MODEL });
    expect(cfg.labels).toEqual(CATEGORIES);
    expect(cfg.labelSetVersion).toBe('cat-18-0f7b02225108');
    expect(cfg.marginCut).toBe(0.3);
    expect(cfg.maxRowsPerRun).toBe(2000);
    expect(cfg.approxDownloadBytes).toBe(350631305);
  });

  test('does not expose a wasm fp32 override (DECISIONS OQ6)', async () => {
    const cfg = await (await fetch(`${base}/api/prelabel/config`)).json() as Record<string, unknown>;
    expect('allowWasmFp32' in cfg).toBe(false);
  });

  test('reflects settings.json for enabled and marginCut', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ prelabelEnabled: true, prelabelMarginCut: 0.4 }));
    const cfg = await (await fetch(`${base}/api/prelabel/config`)).json() as Record<string, unknown>;
    expect(cfg.enabled).toBe(true);
    expect(cfg.marginCut).toBe(0.4);
  });

  test('ignores out-of-range or non-boolean stored values', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ prelabelEnabled: 'yes', prelabelMarginCut: 7 }));
    const cfg = await (await fetch(`${base}/api/prelabel/config`)).json() as Record<string, unknown>;
    expect(cfg.enabled).toBe(false);
    expect(cfg.marginCut).toBe(0.3);
  });

  test('unknown /api/prelabel path is 404', async () => {
    const res = await fetch(`${base}/api/prelabel/nope`);
    expect(res.status).toBe(404);
  });

  test('wrong method on config is 405', async () => {
    const res = await fetch(`${base}/api/prelabel/config`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

// ── S6: GET /api/prelabel/gold (specs/open-jev-labeler.md §9.1) ─────────────

describe('GET /api/prelabel/gold', () => {
  let dir: string;
  let db: ReturnType<typeof createTestDb>;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  /** What a same-origin browser GET carries; /gold refuses callers without it. */
  const proof = { 'Sec-Fetch-Site': 'same-origin' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prelabel-gold-'));
    setActiveProfilePaths({
      name: 'test', root: dir, database: join(dir, 'data.db'), settings: join(dir, 'settings.json'),
      scratchpad: join(dir, 'scratchpad'), cache: join(dir, 'cache'),
    });
    db = createTestDb();
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    try { stopDashboardServer(server); } catch { /* */ }
    closeAll();
    resetActiveProfile();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(rows: Array<{ date: string; description: string; amount: number; category: string | null; verified: boolean }>) {
    const { ids } = insertTransactions(db, rows.map((r) => ({ date: r.date, description: r.description, amount: r.amount, category: r.category ?? undefined })));
    rows.forEach((r, i) => {
      if (r.verified) db.prepare('UPDATE transactions SET user_verified = 1 WHERE id = @id').run({ id: ids[i] });
    });
    return ids;
  }

  test('returns only user_verified=1 rows that have a category, in the documented shape', async () => {
    const ids = seed([
      { date: '2026-06-01', description: 'WHOLE FOODS', amount: -42.5, category: 'Groceries', verified: true },
      { date: '2026-06-02', description: 'UNVERIFIED', amount: -5, category: 'Dining', verified: false },
      { date: '2026-06-03', description: 'VERIFIED BUT NO CATEGORY', amount: -7, category: null, verified: true },
    ]);
    const res = await fetch(`${base}/api/prelabel/gold`, { headers: proof });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toEqual([{ txnId: ids[0], description: 'WHOLE FOODS', amount: -42.5, date: '2026-06-01', label: 'Groceries' }]);
  });

  test('newest first (date, then id)', async () => {
    const ids = seed([
      { date: '2026-06-01', description: 'A', amount: -1, category: 'Dining', verified: true },
      { date: '2026-06-03', description: 'B', amount: -2, category: 'Dining', verified: true },
      { date: '2026-06-03', description: 'C', amount: -3, category: 'Dining', verified: true },
    ]);
    const body = await (await fetch(`${base}/api/prelabel/gold`, { headers: proof })).json() as { rows: Array<{ txnId: number }> };
    expect(body.rows.map((r) => r.txnId)).toEqual([ids[2], ids[1], ids[0]]);
  });

  test('an empty ledger is an empty list', async () => {
    const body = await (await fetch(`${base}/api/prelabel/gold`, { headers: proof })).json() as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  test('limit is clamped to 1..500; a missing or junk limit means 500', async () => {
    seed(Array.from({ length: 505 }, (_, i) => ({
      date: '2026-05-01', description: `ROW ${i}`, amount: -1 - i, category: 'Other', verified: true,
    })));
    const len = async (q: string) => ((await (await fetch(`${base}/api/prelabel/gold${q}`, { headers: proof })).json()) as { rows: unknown[] }).rows.length;
    expect(await len('')).toBe(500);
    expect(await len('?limit=2')).toBe(2);
    expect(await len('?limit=0')).toBe(1);
    expect(await len('?limit=-9')).toBe(1);
    expect(await len('?limit=99999')).toBe(500);
    expect(await len('?limit=abc')).toBe(500);
  });

  test('is read-only: it does not modify the ledger', async () => {
    seed([{ date: '2026-06-01', description: 'X', amount: -1, category: 'Dining', verified: true }]);
    const before = db.prepare('SELECT COUNT(*) AS n, SUM(user_verified) AS v FROM transactions').get();
    await fetch(`${base}/api/prelabel/gold`, { headers: proof });
    expect(db.prepare('SELECT COUNT(*) AS n, SUM(user_verified) AS v FROM transactions').get()).toEqual(before);
  });

  test('with auth on: no token 401, viewer 403, admin 200', async () => {
    seed([{ date: '2026-06-01', description: 'X', amount: -1, category: 'Dining', verified: true }]);
    await createUser(db, 'admin', 'adminpass', 'admin');
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);
    const login = async (username: string, password: string) =>
      ((await (await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      })).json()) as { token: string }).token;
    const adminToken = await login('admin', 'adminpass');
    const viewerToken = await login('viewer', 'viewerpass');
    expect((await fetch(`${base}/api/prelabel/gold`, { headers: proof })).status).toBe(401);
    expect((await fetch(`${base}/api/prelabel/gold`, { headers: { ...proof, Authorization: `Bearer ${viewerToken}` } })).status).toBe(403);
    const ok = await fetch(`${base}/api/prelabel/gold`, { headers: { ...proof, Authorization: `Bearer ${adminToken}` } });
    expect(ok.status).toBe(200);
  });
});
