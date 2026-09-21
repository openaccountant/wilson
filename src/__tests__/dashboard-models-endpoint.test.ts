import { describe, expect, test, afterEach } from 'bun:test';
import { createTestDb } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, isAuthEnabled } from '../dashboard/auth.js';
import { getConfiguredModel, saveConfig } from '../utils/config.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * HTTP wiring for the Settings "Models" panel:
 * - GET /api/models returns one row per AI task (chat, categorization,
 *   entity-classification, embeddings-not-in-use), with the machine-level
 *   WebGPU capability from the cached server-side probe, plus the model
 *   catalog an admin pins from.
 * - POST /api/models persists a per-task model pin (admin-only when auth is
 *   on, like every other settings write) — live, no restart.
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

interface CatalogEntry {
  id: unknown;
  displayName: unknown;
  provider: unknown;
  providerName: unknown;
  isLocal: unknown;
  cached: unknown;
  downloadSize: unknown;
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
    // The POST tests write per-task model settings — reset them.
    saveConfig({});
  });

  async function start(): Promise<{ base: string; token: string; db: Database }> {
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
    return { base, token, db };
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

  test('response carries the pin catalog with full per-entry shape', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { catalog } = (await res.json()) as { catalog: CatalogEntry[] };
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.displayName).toBe('string');
      expect(typeof entry.provider).toBe('string');
      expect(typeof entry.providerName).toBe('string');
      expect(typeof entry.isLocal).toBe('boolean');
      expect(typeof entry.cached).toBe('boolean');
      expect(entry.downloadSize === null || typeof entry.downloadSize === 'string').toBe(true);
    }
  });

  test('requires auth like the other API routes', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/models`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/models (per-task model overrides)', () => {
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
    saveConfig({});
  });

  async function start(): Promise<{ base: string; adminToken: string; db: Database }> {
    const db = createTestDb();
    dbs.push(db);
    setInitialProfile('test', db);
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    const base = `http://localhost:${result.server.port}`;

    await createUser(db, 'admin', 'pw123456', 'admin');
    enableAuth(db);
    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw123456' }),
    });
    const { token } = (await adminLogin.json()) as { token: string };
    return { base, adminToken: token, db };
  }

  async function getTasks(base: string, token: string): Promise<TaskRow[]> {
    const res = await fetch(`${base}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskRow[] };
    return body.tasks;
  }

  test('admin pin lands live: the next GET shows the pinned row without a restart, reset restores it', async () => {
    const { base, adminToken } = await start();

    const pin = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'categorization', model: 'ollama:qwen3:0.6b' }),
    });
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ success: true, task: 'categorization', model: 'ollama:qwen3:0.6b' });

    let tasks = await getTasks(base, adminToken);
    const categorization = tasks.find((t) => t.task === 'categorization')!;
    expect(categorization.model).toBe('ollama:qwen3:0.6b');
    expect(categorization.modelName).toContain('Qwen3 0.6B');
    expect(categorization.provider).toBe('ollama');
    expect(categorization.assignment).toBe('override');

    // Reset: the row returns to following the chat model.
    const reset = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'categorization', model: null }),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ success: true, task: 'categorization', model: null });

    tasks = await getTasks(base, adminToken);
    const restored = tasks.find((t) => t.task === 'categorization')!;
    expect(restored.model).toBe(getConfiguredModel().model);
    expect(restored.assignment).toBe('default');
  });

  test('viewer cannot pin a model (403, like every other settings write)', async () => {
    const { base, adminToken, db } = await start();
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    const viewerLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'viewerpass' }),
    });
    const { token: viewerToken } = (await viewerLogin.json()) as { token: string };

    const res = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'categorization', model: 'ollama:qwen3:0.6b' }),
    });
    expect(res.status).toBe(403);

    // The admin can still write, proving the gate is role-based, not route-wide.
    const adminPost = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'entity-classification', model: 'gpt-4.1' }),
    });
    expect(adminPost.status).toBe(200);
  });

  test('invalid model ids and unknown tasks are rejected with 400', async () => {
    const { base, adminToken } = await start();

    const badModel = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'categorization', model: 'garbage-id' }),
    });
    expect(badModel.status).toBe(400);
    expect((await badModel.json()).error).toBeTruthy();

    const badTask = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'embeddings', model: 'gpt-5.2' }),
    });
    expect(badTask.status).toBe(400);

    const chatReset = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'chat', model: null }),
    });
    expect(chatReset.status).toBe(400);
  });
});