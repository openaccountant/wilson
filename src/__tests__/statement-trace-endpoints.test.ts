import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';
import { createFakeEmbedder } from './fake-embedder.js';
import { parseStatementContent, sha256Hex } from '../tools/import/client-import.js';

/**
 * HTTP-layer tests for the Demo tab's statement agent trace:
 * POST /api/demo/trace/step. The server is booted with an injected fake
 * embedder so the whole run is offline and deterministic.
 */

const FIXTURE_CONTENT = readFileSync(new URL('../../demos/fixtures/august-2026-chase.csv', import.meta.url), 'utf-8');

async function createServer() {
  const db = createTestDb();
  setInitialProfile('test', db);
  const fake = createFakeEmbedder();
  const result = await startDashboardServer(db, 0, { traceEmbed: fake.embed });
  return { db, fake, server: result.server, base: `http://localhost:${result.server.port}` };
}

type ServerHandle = Awaited<ReturnType<typeof createServer>>['server'];

const post = (base: string, body: unknown, token?: string) =>
  fetch(base + '/api/demo/trace/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {}) },
    body: JSON.stringify(body),
  });

const fixtureParsed = () => parseStatementContent(FIXTURE_CONTENT);

describe('POST /api/demo/trace/step', () => {
  const servers: ServerHandle[] = [];
  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    closeAll();
  });

  async function start() {
    const ctx = await createServer();
    servers.push(ctx.server);
    return ctx;
  }

  test('import step commits the fixture; immediate re-POST skips via file-hash dedup', async () => {
    const { db, base } = await start();
    const parsed = fixtureParsed();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);
    const body = {
      step: 'import',
      filename: 'august-2026-chase.csv',
      bank: parsed.bank,
      format: parsed.format,
      fileHash,
      transactions: parsed.transactions,
    };

    const first = await post(base, body);
    expect(first.status).toBe(200);
    const firstData = await first.json();
    expect(firstData.status).toBe('ok');
    expect(firstData.detail.imported).toBe(34);
    expect(firstData.detail.importedIds).toHaveLength(34);
    expect(firstData.detail.bank).toBe('chase');
    expect(firstData.detail.format).toBe('csv');
    expect(Number.isFinite(firstData.durationMs)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM transactions').get()).toEqual({ c: 34 });

    const second = await post(base, body);
    expect(second.status).toBe(200);
    const secondData = await second.json();
    expect(secondData.status).toBe('skipped');
    expect(secondData.detail.previouslyImported).toBeDefined();
    expect(secondData.detail.previouslyImported.transactionCount).toBe(34);
    expect(secondData.detail.message).toContain('already imported');
    // No rows duplicated by the re-drop.
    expect(db.prepare('SELECT COUNT(*) AS c FROM transactions').get()).toEqual({ c: 34 });
  });

  test('embed, predict, and reconcile steps return their shapes over HTTP', async () => {
    const { db, base } = await start();
    const parsed = fixtureParsed();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const importRes = await post(base, {
      step: 'import',
      filename: 'august-2026-chase.csv',
      bank: parsed.bank,
      format: parsed.format,
      fileHash,
      transactions: parsed.transactions,
    });
    const importData = await importRes.json();
    const importedIds: number[] = importData.detail.importedIds;

    const embedRes = await post(base, {
      step: 'embed',
      transactions: parsed.transactions.map((t) => ({ description: t.description })),
    });
    expect(embedRes.status).toBe(200);
    const embedData = await embedRes.json();
    expect(embedData.status).toBe('ok');
    expect(embedData.detail.model).toBe('onnx-community/all-MiniLM-L6-v2-ONNX');
    expect(embedData.detail.matches).toHaveLength(34);
    for (const m of embedData.detail.matches) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }

    const predictRes = await post(base, { step: 'predict', description: 'PAYROLL DEPOSIT - ACME CORP' });
    expect(predictRes.status).toBe(200);
    const predictData = await predictRes.json();
    expect(predictData.detail.category).toBe('Income');
    expect(predictData.detail.displayOnly).toBe(true);
    expect(predictData.detail.confidence).toBe(1);

    const reconcileRes = await post(base, { step: 'reconcile', importedIds });
    expect(reconcileRes.status).toBe(200);
    const reconcileData = await reconcileRes.json();
    expect(reconcileData.detail.duplicates).toHaveLength(2);
    expect(reconcileData.detail.spikes).toEqual([]);
    const descriptions = reconcileData.detail.duplicates.map((d: { transactions: { description: string }[] }) => d.transactions[0].description).sort();
    expect(descriptions).toEqual(['HARBORVIEW HOTEL', 'MEGAMART ONLINE']);

    // The read-only steps wrote nothing beyond the import itself.
    expect(db.prepare('SELECT COUNT(*) AS c FROM transactions').get()).toEqual({ c: 34 });
  });

  test('unknown step and malformed bodies return 400 with precise messages', async () => {
    const { base } = await start();

    const unknown = await post(base, { step: 'teleport' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain('unknown step');

    const noDescription = await post(base, { step: 'predict' });
    expect(noDescription.status).toBe(400);
    expect((await noDescription.json()).error).toContain('description');

    const emptyRows = await post(base, { step: 'embed', transactions: [] });
    expect(emptyRows.status).toBe(400);

    const badRow = await post(base, { step: 'embed', transactions: [{ description: '' }] });
    expect(badRow.status).toBe(400);

    const notNumbers = await post(base, { step: 'reconcile', importedIds: ['one', 'two'] });
    expect(notNumbers.status).toBe(400);
    expect((await notNumbers.json()).error).toContain('importedIds');

    const emptyIds = await post(base, { step: 'reconcile', importedIds: [] });
    expect(emptyIds.status).toBe(400);

    const noFileHash = await post(base, { step: 'import', filename: 'x.csv', transactions: [{ date: '2026-08-01', description: 'A', amount: 1 }] });
    expect(noFileHash.status).toBe(400);
    expect((await noFileHash.json()).error).toContain('fileHash');
  });

  // ── RBAC ─────────────────────────────────────────────────────────────────

  async function setupRbac() {
    const { db, base } = await start();
    await createUser(db, 'admin', 'adminpass', 'admin');
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);

    const adminLogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass' }),
    });
    const adminToken = (await adminLogin.json()).token;

    const viewerLogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewerpass' }),
    });
    const viewerToken = (await viewerLogin.json()).token;

    return { db, base, adminToken, viewerToken };
  }

  test('import step mirrors /api/import RBAC: 401 unauth, 403 viewer, 200 admin; read steps stay open to viewers', async () => {
    const { base, adminToken, viewerToken } = await setupRbac();
    const parsed = fixtureParsed();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);
    const importBody = {
      step: 'import',
      filename: 'august-2026-chase.csv',
      bank: parsed.bank,
      format: parsed.format,
      fileHash,
      transactions: parsed.transactions,
    };

    // Unauthenticated → the authed section's 401 (same middleware as /api/import).
    const unauth = await post(base, importBody);
    expect(unauth.status).toBe(401);

    // Viewer → 403 on the write step (the canWrite mirror).
    const viewer = await post(base, importBody, viewerToken);
    expect(viewer.status).toBe(403);

    // Admin → 200, rows committed.
    const admin = await post(base, importBody, adminToken);
    expect(admin.status).toBe(200);
    expect((await admin.json()).detail.imported).toBe(34);

    // Read/inference steps are not writes: a viewer may run them.
    const viewerPredict = await post(base, { step: 'predict', description: 'FUEL DEPOT' }, viewerToken);
    expect(viewerPredict.status).toBe(200);
    expect((await viewerPredict.json()).detail.category).toBe('Transport');
  });
});