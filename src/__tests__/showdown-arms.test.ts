import { describe, expect, test, beforeEach } from 'bun:test';
import {
  runShowdownCloudArm,
  runShowdownLocalServerArm,
  recordSimulatedCloudTrace,
  recordBrowserLocalTrace,
  buildShowdownUserPrompt,
  CLOUD_LIVE_LABEL,
  CLOUD_SIMULATED_LABEL,
  LOCAL_SERVER_LABEL,
} from '../demo/showdown.js';
import { getSampleBySlug } from '../demo/samples.js';
import { callLlm, type CallLlmOptions, type LlmResult } from '../model/llm.js';
import { traceStore, type LlmTrace } from '../utils/trace-store.js';
import { interactionStore } from '../utils/interaction-store.js';
import { createTestDb } from './helpers.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * Injected-deps arm tests — no network, no model, no GPU. A fresh in-memory
 * DB is wired per test so trace-store misattribution can be asserted at the
 * persistence layer.
 */

let db: Database;

beforeEach(() => {
  db = createTestDb();
  traceStore.setDatabase(db);
  interactionStore.setDatabase(db);
  traceStore.clear();
});

/** A callLlm stand-in that records a REAL trace row and returns its ids. */
function recordingCallLlm(overrides: Partial<LlmTrace> = {}) {
  let counter = 0;
  const calls: Array<{ prompt: string; options?: CallLlmOptions }> = [];
  const impl = async (prompt: string, options?: CallLlmOptions): Promise<LlmResult> => {
    calls.push({ prompt, options });
    const trace: LlmTrace = {
      id: `trace-${Date.now()}-${counter++}`,
      timestamp: new Date().toISOString(),
      model: options?.model ?? 'test-model',
      provider: 'test-provider',
      promptLength: prompt.length,
      responseLength: 24,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 1234,
      status: 'ok',
      ...overrides,
    };
    traceStore.record(trace);
    return {
      response: {
        content: '{"transactions":[{"id":2,"category":"Health","confidence":0.95}]}',
        toolCalls: [],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      interactionId: null,
      traceId: trace.id,
      durationMs: trace.durationMs,
    };
  };
  return { impl, calls };
}

describe('runShowdownCloudArm — live mode', () => {
  test('payload is built from the sample fixture only (synthetic-only guard)', async () => {
    const { impl, calls } = recordingCallLlm();
    const res = await runShowdownCloudArm('harborview-dental', {
      hasKey: true,
      probe: async () => true,
      callLlmImpl: impl,
    });

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('live');
    expect(res.label).toBe(CLOUD_LIVE_LABEL);
    expect(res.probeRan).toBe(true);
    expect(calls).toHaveLength(1);

    const expected = buildShowdownUserPrompt(getSampleBySlug('harborview-dental'));
    expect(calls[0].prompt).toBe(expected);
    expect(res.payload.user).toBe(expected);
    expect(calls[0].prompt).toContain('HARBORVIEW DENTAL GROUP');
    expect(calls[0].prompt).toContain('-318');
    // exactly one transaction row — no imported row can ride along (the
    // response-format template also mentions "id", so count descriptions)
    expect((calls[0].prompt.match(/"description":/g) ?? []).length).toBe(1);
    expect(calls[0].options?.model).toBe('openrouter:openai/gpt-4o-mini');
  });

  test('timers come from the recorded per-call trace, not fabricated numbers', async () => {
    const { impl } = recordingCallLlm({ durationMs: 4321 });
    const res = await runShowdownCloudArm('corner-market', {
      hasKey: true,
      probe: async () => true,
      callLlmImpl: impl,
    });

    const [recorded] = traceStore.getRecentTraces(1);
    expect(res.traceId).toBe(recorded.id);
    expect(res.decisionMs).toBe(recorded.durationMs);
    expect(res.decisionMs).toBe(4321);
    // the arm reports the API model (prefix stripped), like the trace row
    expect(res.model).toBe('openai/gpt-4o-mini');
    expect(recorded.provider).toBe('test-provider');
  });

  test('a failed live call resolves {ok:false, error} under the live label', async () => {
    const failing = async (): Promise<LlmResult> => {
      throw new Error('OpenRouter unreachable');
    };
    const res = await runShowdownCloudArm('corner-market', {
      hasKey: true,
      probe: async () => true,
      callLlmImpl: failing,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('OpenRouter unreachable');
    expect(res.label).toBe(CLOUD_LIVE_LABEL);
    expect(res.decisionMs).toBeNull();
    expect(res.traceId).toBeNull();
  });

  test('unknown slugs throw before any LLM call — imported rows cannot enter a payload', async () => {
    const { impl, calls } = recordingCallLlm();
    await expect(
      runShowdownCloudArm('attendee-imported-row-42', { hasKey: true, probe: async () => true, callLlmImpl: impl }),
    ).rejects.toThrow('Unknown sample slug');
    await expect(
      runShowdownLocalServerArm('attendee-imported-row-42', { callLlmImpl: impl }),
    ).rejects.toThrow('Unknown sample slug');
    expect(calls).toHaveLength(0);
  });
});

describe('runShowdownCloudArm — simulated mode', () => {
  test('failed probe degrades to simulated with the canned decision and a marked trace', async () => {
    const { impl, calls } = recordingCallLlm();
    let probeCalls = 0;
    const res = await runShowdownCloudArm('netflix', {
      hasKey: true,
      probe: async () => {
        probeCalls++;
        return false;
      },
      callLlmImpl: impl,
    });

    expect(probeCalls).toBe(1);
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('simulated');
    expect(res.label).toBe(CLOUD_SIMULATED_LABEL);
    expect(res.model.startsWith('simulated:')).toBe(true);
    expect(res.decision).toEqual({ id: 3, category: 'Subscriptions', confidence: 0.99 });
    expect(res.decisionSource).toBe('canned');
    expect(calls).toHaveLength(0); // no LLM call happened

    // Trace store attribution: exactly the marked simulated row.
    const rows = db
      .prepare("SELECT trace_id, model, provider, duration_ms, status FROM llm_traces WHERE provider = 'simulated'")
      .all() as Array<{ trace_id: string; model: string; provider: string; duration_ms: number; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].model.startsWith('simulated:')).toBe(true);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].duration_ms).toBe(res.decisionMs as number);
    expect(res.traceId).toBe(rows[0].trace_id);

    // Misattribution guards: zero openrouter rows, zero interaction rows.
    const openrouter = db
      .prepare("SELECT COUNT(*) AS n FROM llm_traces WHERE provider = 'openrouter'")
      .get() as { n: number };
    expect(openrouter.n).toBe(0);
    const interactions = db.prepare('SELECT COUNT(*) AS n FROM llm_interactions').get() as { n: number };
    expect(interactions.n).toBe(0);
  });

  test('a missing key skips the probe entirely (no pointless network call)', async () => {
    let probeCalls = 0;
    const res = await runShowdownCloudArm('netflix', {
      hasKey: false,
      probe: async () => {
        probeCalls++;
        return true;
      },
    });
    expect(probeCalls).toBe(0);
    expect(res.mode).toBe('simulated');
    expect(res.label).toBe(CLOUD_SIMULATED_LABEL);
    expect(res.probeRan).toBe(false);
  });
});

describe('runShowdownLocalServerArm', () => {
  test('warms separately, then times the recorded decision call', async () => {
    const { impl, calls } = recordingCallLlm({ durationMs: 876 });
    const res = await runShowdownLocalServerArm('harborview-dental', {
      warm: async () => ({ loadMs: 4321, loadedFresh: true }),
      callLlmImpl: impl,
    });

    expect(res.ok).toBe(true);
    expect(res.label).toBe(LOCAL_SERVER_LABEL);
    expect(res.loadMs).toBe(4321);
    expect(res.loadFresh).toBe(true);
    expect(res.model).toBe(getLocalChatModelConfig().repo);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.model).toBe(getLocalChatModelConfig().id);
    expect(calls[0].options?.maxTokens).toBe(128);
    expect(calls[0].prompt).toBe(buildShowdownUserPrompt(getSampleBySlug('harborview-dental')));

    const [recorded] = traceStore.getRecentTraces(1);
    expect(res.traceId).toBe(recorded.id);
    expect(res.decisionMs).toBe(recorded.durationMs);
    expect(res.decisionMs).toBe(876);
  });

  test('warm failure degrades honestly with the error message', async () => {
    const res = await runShowdownLocalServerArm('harborview-dental', {
      warm: async () => {
        throw new Error('WebGPU is not available on this machine.');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('WebGPU is not available');
    expect(res.label).toBe(LOCAL_SERVER_LABEL);
    expect(res.decisionMs).toBeNull();
    expect(res.traceId).toBeNull();
  });
});

describe('recordSimulatedCloudTrace', () => {
  test('records a marked row (provider simulated, model simulated:<apiModel>)', () => {
    const rec = recordSimulatedCloudTrace({
      apiModel: 'openai/gpt-4o-mini',
      userPrompt: 'the prompt',
      cannedResponse: '{"transactions":[]}',
      measuredMs: 12.4,
    });

    expect(rec.durationMs).toBe(12);
    const [row] = traceStore.getRecentTraces(1);
    expect(row.id).toBe(rec.traceId);
    expect(row.provider).toBe('simulated');
    expect(row.model).toBe('simulated:openai/gpt-4o-mini');
    expect(row.status).toBe('ok');
    expect(row.durationMs).toBe(12);

    const persisted = db
      .prepare("SELECT COUNT(*) AS n FROM llm_traces WHERE provider = 'simulated' AND trace_id = @id")
      .get({ id: rec.traceId }) as { n: number };
    expect(persisted.n).toBe(1);
  });
});

describe('recordBrowserLocalTrace', () => {
  test('records the browser arm under provider transformers-browser', () => {
    const rec = recordBrowserLocalTrace({
      model: 'onnx-community/Qwen3-0.6B-ONNX',
      decisionMs: 45.6,
      ok: true,
      slug: 'netflix',
    });

    expect(rec.durationMs).toBe(46);
    const [row] = traceStore.getRecentTraces(1);
    expect(row.id).toBe(rec.traceId);
    expect(row.provider).toBe('transformers-browser');
    expect(row.model).toBe('onnx-community/Qwen3-0.6B-ONNX');
    expect(row.status).toBe('ok');
    expect(row.durationMs).toBe(46);
  });

  test('error path records status error with the message', () => {
    const rec = recordBrowserLocalTrace({ model: 'some-model', decisionMs: 10, ok: false, error: 'boom' });
    const [row] = traceStore.getRecentTraces(1);
    expect(row.id).toBe(rec.traceId);
    expect(row.status).toBe('error');
    expect(row.error).toBe('boom');
  });

  test('rejects missing model and negative / non-numeric decisionMs', () => {
    expect(() => recordBrowserLocalTrace({ model: 'm', decisionMs: -1, ok: true })).toThrow();
    expect(() => recordBrowserLocalTrace({ model: 'm', decisionMs: 'fast', ok: true })).toThrow();
    expect(() => recordBrowserLocalTrace({ model: 'm', decisionMs: Number.NaN, ok: true })).toThrow();
    expect(() => recordBrowserLocalTrace({ model: '', decisionMs: 10, ok: true })).toThrow();
    expect(() => recordBrowserLocalTrace({ decisionMs: 10, ok: true })).toThrow();
  });
});