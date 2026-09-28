import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer, serveDashboardAsset, DASHBOARD_ASSETS_DIR } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, isAuthEnabled } from '../dashboard/auth.js';
import { getChatSessionById, getChatHistoryBySession } from '../db/queries.js';
import { existsSync } from 'node:fs';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Hybrid (local-first WebGPU) chat server surface:
 * - GET /api/config/local-chat exposes the fastModel-derived model choice and
 *   bundle bounds (changeable in one place — the provider registry).
 * - POST /api/chat/local records locally-answered exchanges into the SAME
 *   chat_sessions/chat_history shapes the server agent writes, so reloading a
 *   session keeps locally-answered turns. OPERATOR VETO CANDIDATE: this is a
 *   new browser-originated history-append path.
 * - /assets/* is served publicly (module scripts + ORT's own wasm fetches
 *   cannot attach auth headers) with path-traversal rejection.
 */

const HYBRID_BUILT = existsSync(join(DASHBOARD_ASSETS_DIR, 'hybrid-chat.js'));

describe('local chat endpoints', () => {
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];
  const dbs: Database[] = [];

  afterEach(() => {
    for (const s of servers) {
      try { stopDashboardServer(s); } catch { /* */ }
    }
    servers.length = 0;
    for (const db of dbs) {
      try { db.close(); } catch { /* */ }
    }
    dbs.length = 0;
    closeAll();
  });

  async function start(): Promise<{ base: string; token: string | null }> {
    const db = createTestDb();
    dbs.push(db);
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    const base = `http://localhost:${result.server.port}`;

    // Enable auth so the public/private boundary is actually exercised.
    const user = await createUser(db, 'admin', 'pw123456', 'admin');
    enableAuth(db);
    expect(isAuthEnabled(db)).toBe(true);
    void user;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw123456' }),
    });
    const { token } = (await login.json()) as { token: string };
    return { base, token };
  }

  const authed = (token: string | null, init?: RequestInit): RequestInit => ({
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // ── GET /api/config/local-chat ───────────────────────────────────────────

  test('config endpoint exposes the fastModel-derived choice and bundle bounds', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/config/local-chat`, authed(token));
    expect(res.status).toBe(200);
    const cfg = await res.json() as {
      enabled: boolean; id: string; repo: string; displayName: string; downloadSize: string;
      bundle: { days: number; limit: number; maxChars: number };
    };
    expect(cfg.enabled).toBe(true);
    expect(cfg.id).toBe('transformers:onnx-community/Qwen3-0.6B-ONNX');
    expect(cfg.repo).toBe('onnx-community/Qwen3-0.6B-ONNX'); // prefix stripped for the browser
    expect(cfg.displayName).toContain('Qwen3 0.6B');
    expect(cfg.bundle).toEqual({ days: 30, limit: 200, maxChars: 6000 });
  });

  test('config endpoint requires auth like the other API routes', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config/local-chat`);
    expect(res.status).toBe(401);
  });

  // ── POST /api/chat/local ─────────────────────────────────────────────────

  test('records a local exchange: creates a session titled from the query + a history row', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/chat/local`, authed(token, {
      method: 'POST',
      body: JSON.stringify({ query: 'how much did I spend on groceries this week?', answer: 'You spent $54.21.' }),
    }));
    expect(res.status).toBe(200);
    const { success, sessionId } = await res.json() as { success: boolean; sessionId: string };
    expect(success).toBe(true);
    expect(sessionId).toBeTruthy();

    const db = dbs[0];
    const session = getChatSessionById(db, sessionId);
    expect(session).toBeDefined();
    expect(session!.title).toBe('how much did I spend on groceries this week?');
    const rows = getChatHistoryBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe('how much did I spend on groceries this week?');
    expect(rows[0].answer).toBe('You spent $54.21.');
    expect(rows[0].summary).toBeNull(); // LLM summaries are a server-agent behavior
  });

  test('reuses a supplied sessionId instead of creating a new session', async () => {
    const { base, token } = await start();
    const db = dbs[0];

    const first = await fetch(`${base}/api/chat/local`, authed(token, {
      method: 'POST',
      body: JSON.stringify({ query: 'q1', answer: 'a1' }),
    }));
    const { sessionId } = await first.json() as { sessionId: string };

    const second = await fetch(`${base}/api/chat/local`, authed(token, {
      method: 'POST',
      body: JSON.stringify({ query: 'q2', answer: 'a2', sessionId }),
    }));
    const secondBody = await second.json() as { success: boolean; sessionId: string };
    expect(secondBody.success).toBe(true);
    expect(secondBody.sessionId).toBe(sessionId);

    expect(getChatHistoryBySession(db, sessionId)).toHaveLength(2);
    // Only one session was created for both exchanges.
    const sessions = await (await fetch(`${base}/api/chat/sessions`, authed(token))).json() as unknown[];
    expect(sessions).toHaveLength(1);
  });

  test('a supplied-but-unknown sessionId falls back to a fresh session', async () => {
    const { base, token } = await start();
    const db = dbs[0];
    const res = await fetch(`${base}/api/chat/local`, authed(token, {
      method: 'POST',
      body: JSON.stringify({ query: 'q', answer: 'a', sessionId: 'not-a-real-session-id' }),
    }));
    const body = await res.json() as { success: boolean; sessionId: string };
    expect(body.success).toBe(true);
    expect(body.sessionId).not.toBe('not-a-real-session-id');
    expect(getChatSessionById(db, body.sessionId)).toBeDefined();
  });

  test('titles are capped at 100 chars', async () => {
    const { base, token } = await start();
    const longQuery = 'x'.repeat(250);
    const res = await fetch(`${base}/api/chat/local`, authed(token, {
      method: 'POST',
      body: JSON.stringify({ query: longQuery, answer: 'a' }),
    }));
    const { sessionId } = await res.json() as { sessionId: string };
    const session = getChatSessionById(dbs[0], sessionId);
    expect(session!.title!.length).toBe(100);
    expect(session!.title).toBe(longQuery.slice(0, 100));
  });

  test('rejects missing or empty query/answer with 400', async () => {
    const { base, token } = await start();
    for (const body of [{}, { query: 'q' }, { answer: 'a' }, { query: '   ', answer: 'a' }, { query: 'q', answer: '' }]) {
      const res = await fetch(`${base}/api/chat/local`, authed(token, {
        method: 'POST',
        body: JSON.stringify(body),
      }));
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('required');
    }
  });

  test('local recording requires auth (same posture as POST /api/chat)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/chat/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'q', answer: 'a' }),
    });
    expect(res.status).toBe(401);
  });

  // ── /assets/* static serving ─────────────────────────────────────────────

  test('assets are public even when auth is enabled (module scripts carry no headers)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/assets/hybrid-chat.js`);
    // 200 when the hybrid build exists in this tree, 404 when not — but never
    // 401, or the module script would be blocked under auth.
    if (HYBRID_BUILT) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
    } else {
      expect(res.status).toBe(404);
    }
  });
});

describe('serveDashboardAsset (direct)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('serves files with the right content types', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    writeFileSync(join(dir, 'hybrid-chat.js'), 'export const x = 1;\n');
    mkdirSync(join(dir, 'ort'), { recursive: true });
    writeFileSync(join(dir, 'ort', 'model.wasm'), Buffer.from([0, 97, 115, 109])); // \0asm
    writeFileSync(join(dir, 'data.json'), '{"a":1}');

    const js = await serveDashboardAsset('/assets/hybrid-chat.js', dir, {});
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe('export const x = 1;\n');

    const wasm = await serveDashboardAsset('/assets/ort/model.wasm', dir, {});
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');

    const json = await serveDashboardAsset('/assets/data.json', dir, {});
    expect(json.status).toBe(200);
    expect(json.headers.get('content-type')).toContain('application/json');
  });

  test('404s missing files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    const res = await serveDashboardAsset('/assets/nope.js', dir, {});
    expect(res.status).toBe(404);
  });

  test('rejects path traversal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-assets-'));
    writeFileSync(join(dir, 'in-dir.js'), '// ok\n');
    const secret = join(tmpdir(), `oa-secret-${Date.now()}.txt`);
    writeFileSync(secret, 'SECRET');
    try {
      const up = await serveDashboardAsset('/assets/../' + secret.split('/').pop(), dir, {});
      expect(up.status).toBe(404);

      const deep = await serveDashboardAsset('/assets/../../../../../etc/passwd', dir, {});
      expect(deep.status).toBe(404);

      // Empty rel path (exactly '/assets/') is not a file either.
      expect((await serveDashboardAsset('/assets/', dir, {})).status).toBe(404);
    } finally {
      rmSync(secret, { force: true });
    }
  });
});