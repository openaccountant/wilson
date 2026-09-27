import { describe, expect, test, afterEach, mock, beforeEach } from 'bun:test';

// ── Module mocks (must run BEFORE the server module chain is imported) ──────

// Force "no OpenRouter key" for this whole process so the cloud arm
// deterministically runs simulated mode regardless of the operator's env,
// .env file, or CI network. Other providers behave normally.
mock.module('../utils/env.js', () => ({
  getApiKeyNameForProvider: (providerId: string) =>
    providerId === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined,
  getProviderDisplayName: (providerId: string) => providerId,
  checkApiKeyExistsForProvider: (providerId: string) => providerId !== 'openrouter',
  checkApiKeyExists: (apiKeyName: string) => apiKeyName !== 'OPENROUTER_API_KEY',
  saveApiKeyToEnv: () => false,
  saveApiKeyForProvider: () => false,
}));

// Keep the server-side local arm off real hardware/GPU in this suite: the
// warm path fails with a clear, deterministic message (the arm must degrade
// to {ok:false, error} at HTTP 200 — that is exactly what we assert).
mock.module('../model/providers/transformers.js', () => ({
  WEBGPU_MODEL_PATTERNS: ['-ONNX-web', 'LFM2-1.2B-Tool-ONNX', 'Qwen3-0.6B-ONNX'],
  TransformersAdapter: class {
    async call(): Promise<never> {
      throw new Error('mocked transformers adapter (showdown endpoints test)');
    }
  },
  checkWebGpuAvailable: async () => false,
  warmTransformersPipeline: async () => {
    throw new Error('WebGPU is not available on this machine (showdown test mock)');
  },
}));

import { createTestDb, ensureTestProfile } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { traceStore } from '../utils/trace-store.js';
import { interactionStore } from '../utils/interaction-store.js';
import { CATEGORIZER_SYSTEM_PROMPT } from '../tools/categorize/categorize.js';
import type { Database } from '../db/compat-sqlite.js';

ensureTestProfile();

describe('demo showdown endpoints', () => {
  let db: Database;
  let base = '';
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

  beforeEach(async () => {
    db = createTestDb();
    setInitialProfile('showdown-test', db);
    // Wire the stores to the test DB so misattribution is asserted at the
    // persistence layer, exactly like a real dashboard session.
    traceStore.setDatabase(db);
    interactionStore.setDatabase(db);
    traceStore.clear();
    const result = await startDashboardServer(db, 0);
    servers.push(result.server);
    base = `http://localhost:${result.server.port}`;
  });

  afterEach(() => {
    for (const s of servers) {
      try {
        stopDashboardServer(s);
      } catch {
        /* */
      }
    }
    servers.length = 0;
    closeAll();
  });

  function traceCount(provider: string): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM llm_traces WHERE provider = @provider').get({
      provider,
    }) as { n: number };
    return row.n;
  }

  function interactionCount(): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM llm_interactions').get() as { n: number };
    return row.n;
  }

  test('GET /api/demo/showdown/samples serves the 8 fixtures with prompts and model config', async () => {
    const res = await fetch(`${base}/api/demo/showdown/samples`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      samples: Array<{ slug: string; userPrompt: string; description: string; amount: number }>;
      systemPrompt: string;
      config: { cloudModel: string; localModel: string; localRepo: string };
    };

    expect(data.samples).toHaveLength(8);
    for (const sample of data.samples) {
      expect(sample.userPrompt.length).toBeGreaterThan(100);
      expect(sample.userPrompt).toContain(sample.description);
    }
    const harborview = data.samples.find((s) => s.slug === 'harborview-dental');
    expect(harborview?.amount).toBe(-318);

    expect(data.systemPrompt).toBe(CATEGORIZER_SYSTEM_PROMPT);
    expect(data.config.cloudModel).toBe('openrouter:openai/gpt-4o-mini');
    expect(data.config.localRepo).toBe('onnx-community/Qwen3-0.6B-ONNX');
  });

  test('POST cloud with the Harborview slug runs simulated, cleanly attributed', async () => {
    const res = await fetch(`${base}/api/demo/showdown/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'harborview-dental' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      mode: string;
      label: string;
      model: string;
      decisionMs: number;
      traceId: string;
      payload: { system: string; user: string };
      decision: { id: number; category: string; confidence: number };
      decisionSource: string;
    };

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('simulated');
    expect(data.label).toBe('simulated round-trip — no network');
    expect(data.model.startsWith('simulated:')).toBe(true);
    expect(data.decisionSource).toBe('canned');
    expect(data.decision).toEqual({ id: 2, category: 'Health', confidence: 0.99 });
    expect(typeof data.decisionMs).toBe('number');
    expect(data.payload.system).toBe(CATEGORIZER_SYSTEM_PROMPT);
    expect(data.payload.user).toContain('HARBORVIEW DENTAL GROUP');
    expect(data.payload.user).toContain('-318');
    // exactly one transaction row — synthetic samples only, never an import
    // (the response-format template also mentions "id", so count descriptions)
    expect((data.payload.user.match(/"description":/g) ?? []).length).toBe(1);

    // Trace-store misattribution guard at the HTTP layer: the simulated row
    // exists with its marker, and no openrouter row / interaction row exists.
    const rows = db
      .prepare("SELECT trace_id, provider, model, duration_ms FROM llm_traces WHERE provider = 'simulated'")
      .all() as Array<{ trace_id: string; provider: string; model: string; duration_ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe(data.traceId);
    expect(rows[0].duration_ms).toBe(data.decisionMs);
    expect(rows[0].model.startsWith('simulated:')).toBe(true);
    expect(traceCount('openrouter')).toBe(0);
    expect(interactionCount()).toBe(0);
  });

  test('unknown slug → 400 and zero traces recorded', async () => {
    const before = traceCount('simulated');
    const res = await fetch(`${base}/api/demo/showdown/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'attendee-imported-row-999' }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('Unknown sample slug');
    expect(traceCount('simulated')).toBe(before);
    expect(traceCount('openrouter')).toBe(0);
  });

  test('malformed body → 400', async () => {
    const res = await fetch(`${base}/api/demo/showdown/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('slug is required');

    const localRes = await fetch(`${base}/api/demo/showdown/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(localRes.status).toBe(400);
  });

  test('POST local degrades inline ({ok:false, error}) in a no-GPU environment, not a 500', async () => {
    const res = await fetch(`${base}/api/demo/showdown/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'harborview-dental' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error?: string; label: string };
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(data.error!.length).toBeGreaterThan(0);
    expect(data.label).toBe('on this machine');
    // A failed local arm records nothing.
    expect(traceCount('transformers')).toBe(0);
  });

  test('POST browser-trace records the browser arm; invalid bodies 400', async () => {
    const res = await fetch(`${base}/api/demo/showdown/browser-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'onnx-community/Qwen3-0.6B-ONNX', decisionMs: 42.4, ok: true, slug: 'netflix' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { traceId: string; durationMs: number };
    expect(data.durationMs).toBe(42);

    const rows = db
      .prepare("SELECT trace_id, provider, duration_ms FROM llm_traces WHERE provider = 'transformers-browser'")
      .all() as Array<{ trace_id: string; provider: string; duration_ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].trace_id).toBe(data.traceId);
    expect(rows[0].duration_ms).toBe(42);
    expect(interactionCount()).toBe(0);

    const badModel = await fetch(`${base}/api/demo/showdown/browser-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionMs: 10, ok: true }),
    });
    expect(badModel.status).toBe(400);

    const negative = await fetch(`${base}/api/demo/showdown/browser-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', decisionMs: -5, ok: true }),
    });
    expect(negative.status).toBe(400);
  });
});