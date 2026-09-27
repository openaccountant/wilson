import { describe, expect, test, afterEach, mock, beforeEach } from 'bun:test';

// ── Module mocks (must run BEFORE the server module chain is imported) ──────
// Copied from showdown-endpoints.test.ts: force "no OpenRouter key" so the
// cloud arm deterministically runs simulated mode, and keep the server-side
// local arm off real hardware (it must degrade to {ok:false} at HTTP 200).

mock.module('../utils/env.js', () => ({
  getApiKeyNameForProvider: (providerId: string) =>
    providerId === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined,
  getProviderDisplayName: (providerId: string) => providerId,
  checkApiKeyExistsForProvider: (providerId: string) => providerId !== 'openrouter',
  checkApiKeyExists: (apiKeyName: string) => apiKeyName !== 'OPENROUTER_API_KEY',
  saveApiKeyToEnv: () => false,
  saveApiKeyForProvider: () => false,
}));

mock.module('../model/providers/transformers.js', () => ({
  WEBGPU_MODEL_PATTERNS: ['-ONNX-web', 'LFM2-1.2B-Tool-ONNX', 'Qwen3-0.6B-ONNX'],
  TransformersAdapter: class {
    async call(): Promise<never> {
      throw new Error('mocked transformers adapter (privacy endpoints test)');
    }
  },
  checkWebGpuAvailable: async () => false,
  warmTransformersPipeline: async () => {
    throw new Error('WebGPU is not available on this machine (privacy test mock)');
  },
}));

import { createTestDb, ensureTestProfile } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { traceStore, type LlmTrace } from '../utils/trace-store.js';
import { interactionStore } from '../utils/interaction-store.js';
import { buildShowdownUserPrompt } from '../demo/showdown.js';
import { getSampleBySlug } from '../demo/samples.js';
import type { Database } from '../db/compat-sqlite.js';

ensureTestProfile();

interface PrivacyLedgerResponse {
  runId: string;
  startedAt: string;
  entries: Array<{
    traceId: string;
    timestamp: string;
    provider: string;
    model: string;
    bucket: string;
    durationMs: number;
    status: string;
    error?: string;
  }>;
  counts: { local: number; simulated: number; cloud: number; unknown: number; total: number };
  allLocal: boolean;
  verdict: string;
}

function makeTrace(overrides: Partial<LlmTrace> & { id: string }): LlmTrace {
  return {
    timestamp: new Date().toISOString(),
    model: 'm',
    provider: 'openai',
    promptLength: 10,
    responseLength: 5,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 12,
    status: 'ok',
    ...overrides,
  };
}

describe('demo privacy validator endpoints', () => {
  let db: Database;
  let base = '';
  const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

  beforeEach(async () => {
    db = createTestDb();
    setInitialProfile('privacy-test', db);
    // Wire the stores to the test DB exactly like a real dashboard session.
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

  async function startRun(): Promise<{ id: string; startedAt: string }> {
    const res = await fetch(`${base}/api/demo/privacy/start`, { method: 'POST' });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; startedAt: string };
  }

  async function getLedger(runId: string): Promise<{ status: number; body: string; data: PrivacyLedgerResponse }> {
    const res = await fetch(`${base}/api/demo/privacy/ledger?run=${encodeURIComponent(runId)}`);
    const body = await res.text();
    return { status: res.status, body, data: JSON.parse(body) as PrivacyLedgerResponse };
  }

  test('POST /api/demo/privacy/start issues a run token with a parseable startedAt', async () => {
    const run = await startRun();
    expect(run.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(run.startedAt).getTime())).toBe(false);
  });

  test('GET ledger without a run, or with an unknown run, → 400 with an error message', async () => {
    const noRun = await fetch(`${base}/api/demo/privacy/ledger`);
    expect(noRun.status).toBe(400);
    const noRunBody = (await noRun.json()) as { error: string };
    expect(noRunBody.error).toContain('unknown privacy run');

    const badRun = await fetch(`${base}/api/demo/privacy/ledger?run=not-a-run`);
    expect(badRun.status).toBe(400);
    const badRunBody = (await badRun.json()) as { error: string };
    expect(badRunBody.error).toContain('unknown privacy run');
  });

  test('the demo-run flow: simulated cloud arm + browser-local arm render as honest localhost rows', async () => {
    const run = await startRun();

    // The cloud arm (no key in this process → forced simulated) and the
    // browser-local arm — exactly the two rows a no-key demo run produces.
    const cloudRes = await fetch(`${base}/api/demo/showdown/cloud`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'harborview-dental' }),
    });
    expect(cloudRes.status).toBe(200);
    const cloud = (await cloudRes.json()) as { ok: boolean; mode: string; traceId: string };
    expect(cloud.ok).toBe(true);
    expect(cloud.mode).toBe('simulated');

    const traceRes = await fetch(`${base}/api/demo/showdown/browser-trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'onnx-community/Qwen3-0.6B-ONNX', decisionMs: 42, ok: true, slug: 'harborview-dental' }),
    });
    expect(traceRes.status).toBe(200);

    const { status, body, data } = await getLedger(run.id);
    expect(status).toBe(200);
    expect(data.entries).toHaveLength(2);

    const simulated = data.entries.find((e) => e.bucket === 'simulated');
    const local = data.entries.find((e) => e.bucket === 'local');
    expect(simulated).toBeDefined();
    expect(local).toBeDefined();
    // the simulated timer keeps its markers — provider verbatim 'simulated',
    // model names the simulated api model; it NEVER reads as a cloud call
    expect(simulated!.provider).toBe('simulated');
    expect(simulated!.model.startsWith('simulated:')).toBe(true);
    expect(simulated!.traceId).toBe(cloud.traceId);
    expect(local!.provider).toBe('transformers-browser');

    expect(data.counts.cloud).toBe(0);
    expect(data.counts.simulated).toBe(1);
    expect(data.counts.local).toBe(1);
    expect(data.counts.total).toBe(2);
    expect(data.allLocal).toBe(true);
    expect(data.verdict).toContain('stayed on localhost');
    expect(data.verdict).toContain('0 cloud calls');
    // no cloud-provider marker anywhere in the rendered ledger
    expect(body.includes('openrouter')).toBe(false);
    expect(data.entries.every((e) => e.provider !== 'openrouter')).toBe(true);
  });

  test('the panel can fail honestly: a real cloud call during the run renders red', async () => {
    const run = await startRun();
    traceStore.record(
      makeTrace({
        id: 'cloud-1',
        provider: 'openrouter',
        model: 'openrouter:openai/gpt-4o-mini',
        durationMs: 640,
      }),
    );

    const { data } = await getLedger(run.id);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].bucket).toBe('cloud');
    expect(data.entries[0].provider).toBe('openrouter');
    expect(data.counts.cloud).toBe(1);
    expect(data.allLocal).toBe(false);
    expect(data.verdict).toContain('does not hold');
  });

  test('watermark exclusion: pre-arm rows never appear; post-arm rows do', async () => {
    traceStore.record(makeTrace({ id: 'F' }));
    const run = await startRun();
    const before = await getLedger(run.id);
    expect(before.data.entries.map((e) => e.traceId)).toEqual([]);

    traceStore.record(makeTrace({ id: 'G' }));
    const after = await getLedger(run.id);
    expect(after.data.entries.map((e) => e.traceId)).toEqual(['G']);
  });

  test('an unrecognized provider lands in its own honest bucket — never counted as local', async () => {
    const run = await startRun();
    traceStore.record(makeTrace({ id: 'u1', provider: 'acme-cloud', model: 'acme/mystery' }));

    const { data } = await getLedger(run.id);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].bucket).toBe('unknown');
    expect(data.counts.unknown).toBe(1);
    expect(data.allLocal).toBe(false);
    expect(data.verdict).toContain('not counted as local');
  });

  test('exhibit endpoint: full fixture set, slug-scoped single row, 400 on unknown slug, ?slug= tolerated', async () => {
    const full = await fetch(`${base}/api/demo/privacy/exhibit`);
    expect(full.status).toBe(200);
    const fullData = (await full.json()) as {
      cloudModel: string;
      payload: { system: string; user: string };
      rowCount: number;
      rows: Array<{ slug: string; description: string }>;
      note: string;
    };
    expect(fullData.rowCount).toBe(8);
    expect(fullData.rows).toHaveLength(8);
    for (const row of fullData.rows) expect(fullData.payload.user).toContain(row.description);
    expect(fullData.payload.user).not.toContain('ATTENDEE');

    const scoped = await fetch(`${base}/api/demo/privacy/exhibit?slug=harborview-dental`);
    expect(scoped.status).toBe(200);
    const scopedData = (await scoped.json()) as typeof fullData;
    expect(scopedData.rowCount).toBe(1);
    // byte-identical to what the showdown arms send for that same sample
    expect(scopedData.payload.user).toBe(buildShowdownUserPrompt(getSampleBySlug('harborview-dental')));
    expect(scopedData.payload.user).toContain('HARBORVIEW DENTAL GROUP');

    const unknown = await fetch(`${base}/api/demo/privacy/exhibit?slug=nope`);
    expect(unknown.status).toBe(400);
    const unknownBody = (await unknown.json()) as { error: string };
    expect(unknownBody.error).toContain('Unknown sample slug');

    const empty = await fetch(`${base}/api/demo/privacy/exhibit?slug=`);
    expect(empty.status).toBe(200);
    const emptyData = (await empty.json()) as { rowCount: number };
    expect(emptyData.rowCount).toBe(8);
  });
});