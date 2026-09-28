import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, isAuthEnabled } from '../dashboard/auth.js';
import { getConfiguredModel } from '../utils/config.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * HTTP wiring for the Settings "Models" panel:
 * - GET /api/models returns one row per AI task (chat, categorization,
 *   entity-classification, embeddings-not-in-use), with the machine-level
 *   WebGPU capability from the cached server-side probe.
 * - Auth posture is identical to every other /api/* route.
 */

interface TaskRow {
  task: string;
  label: string;
  inUse: boolean;
  model: string | null;
  modelName: string | null;
  provider: string | null;
  providerName: string | null;
  execution: 'local' | 'server' | null;
  webgpu: unknown;
  assignment: string;
  note: string | null;
}

describe('GET /api/models', () => {
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

  async function start(): Promise<{ base: string; token: string }> {
    const db = createTestDb();
    dbs.push(db);
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    const base = `http://localhost:${result.server.port}`;

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

  test('returns one row per task, matching the configured model, with a boolean webgpu flag', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as { tasks: TaskRow[] };

    expect(tasks).toHaveLength(4);
    expect(tasks.map((t) => t.task)).toEqual(['chat', 'categorization', 'entity-classification', 'embeddings']);

    // Machine capability: assert the type, not the value (machine-dependent).
    for (const row of tasks) {
      expect(typeof row.webgpu).toBe('boolean');
    }

    // In-use rows follow the configured chat model (no settings writes here).
    const { model } = getConfiguredModel();
    for (const row of tasks.filter((t) => t.inUse)) {
      expect(row.model).toBe(model);
      expect(row.modelName).toBeTruthy();
      expect(row.execution === 'local' || row.execution === 'server').toBe(true);
      expect(row.assignment).toBe('default');
    }

    // Embeddings is the not-in-use row in this build.
    const embeddings = tasks[tasks.length - 1];
    expect(embeddings.task).toBe('embeddings');
    expect(embeddings.inUse).toBe(false);
    expect(embeddings.model).toBeNull();
    expect(embeddings.note).toContain('No embeddings task');
  });

  test('requires auth like the other API routes', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(401);
  });
});