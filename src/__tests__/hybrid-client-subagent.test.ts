import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHybridChat, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import {
  DEFAULT_SUBAGENT_LIMITS,
  type MirrorPrep,
  type StepEvent,
  type SubagentRunArgs,
  type SubagentRunResult,
} from '../dashboard/ui/src/hybrid/worker-protocol.js';
import { installLocalChatOptIn } from './local-chat-optin-helper.js';

/**
 * The hybrid client's subagent branch (spec sections 3, 5, 11; slice 6), driven
 * with a fake ModelBackend and a fake `prepareMirror`. Flag off must behave
 * exactly like slice 1; flag on gates on the main thread BEFORE any model
 * download, mirror port or bundle fetch.
 */

const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3 0.6B' };

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

function cfg(subagent?: { enabled: boolean; maxSteps: number; compose?: 'template' | 'model' }): LocalChatConfigResponse {
  return {
    enabled: true,
    id: `transformers:${MODEL.repo}`,
    repo: MODEL.repo,
    displayName: MODEL.displayName,
    downloadSize: '~570MB',
    dtype: 'q4f16',
    bundle: { days: 30, limit: 200, maxChars: 6000 },
    ...(subagent ? { subagent } : {}),
  };
}

function dashboardFetch(config: LocalChatConfigResponse) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (input.endsWith('/api/config/local-chat')) return Response.json(config);
    if (input.includes('/api/transactions')) return Response.json([]);
    if (input.endsWith('/api/weekly-summary')) {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's9' });
    return new Response('not found', { status: 404 });
  };
  return { fn, calls };
}

interface FakeBackend extends ModelBackend {
  log: string[];
  runArgs: SubagentRunArgs[];
}

function fakeBackend(run: (args: SubagentRunArgs, onStep?: (e: StepEvent) => void) => Promise<SubagentRunResult>): FakeBackend {
  const log: string[] = [];
  const runArgs: SubagentRunArgs[] = [];
  return {
    log,
    runArgs,
    setModel: () => {},
    probe: async () => {
      log.push('probe');
      return 'ready';
    },
    load: async () => {
      log.push('load');
      return { loadMs: 1, loadFresh: true, dtype: 'q4f16' };
    },
    bundleAnswer: async () => {
      log.push('bundleAnswer');
      return { kind: 'answer', text: 'bundle answer' };
    },
    categorize: async () => ({ raw: '', decisionMs: 0 }),
    subagentRun: async (args, onStep) => {
      log.push('subagentRun');
      runArgs.push(args);
      return run(args, onStep);
    },
    dispose: () => {},
  };
}

class FakePort {
  closed = 0;
  onmessage = null;
  postMessage() {}
  close() {
    this.closed++;
  }
}

const SYNCED = '2026-10-03T11:59:00.000Z';

function ready(port: FakePort): () => Promise<MirrorPrep> {
  return async () => ({ kind: 'ready', port, expectedProfile: 'default', lastSyncedAt: SYNCED });
}

const answerResult: SubagentRunResult = {
  outcome: { kind: 'answer', text: 'Net profit was $3,000.00.', steps: [{ tool: 'profit_loss', args: { period: 'month' }, ok: true, ms: 12, summary: 'x' }] },
  deviceFault: false,
};

describe('hybrid client: subagent branch', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let warn: ReturnType<typeof spyOn>;

  let optIn: ReturnType<typeof installLocalChatOptIn>;
  beforeEach(() => {
    // This browser opted in to on-device chat (consent.ts); the server config says enabled.
    optIn = installLocalChatOptIn(MODEL.repo);
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
      writable: true,
    });
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedStorage) Object.defineProperty(globalThis, 'sessionStorage', savedStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    optIn.restore();
  });

  function chatFor(config: LocalChatConfigResponse, backend: FakeBackend) {
    const api = dashboardFetch(config);
    const chat = createHybridChat({ baseUrl: '', fetchImpl: api.fn, backend });
    return { chat, api };
  }

  test('flag OFF (field absent or enabled:false): prepareMirror is never called and the result is a plain bundle answer', async () => {
    for (const config of [cfg(), cfg({ enabled: false, maxSteps: 3 })]) {
      const backend = fakeBackend(async () => answerResult);
      const { chat } = chatFor(config, backend);
      let prepared = 0;
      const r = await chat.tryLocal('Give me a P&L for June', undefined, null, {
        subagent: { priorLocalTurns: [], prepareMirror: async () => (prepared++, { kind: 'unavailable' }) },
      });
      expect(prepared).toBe(0);
      expect(backend.log).toContain('bundleAnswer');
      expect(backend.log).not.toContain('subagentRun');
      expect(r).toEqual({ ok: true, answer: 'bundle answer', sessionId: 's9', source: 'local' });
    }
  });

  test('flag ON, mutation request: handoff with a proposal, and NOTHING else happens (no probe, load, mirror, bundle fetch)', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat, api } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    let prepared = 0;
    const r = await chat.tryLocal('Recategorize the Netflix charge as Entertainment', undefined, null, {
      subagent: { priorLocalTurns: [], prepareMirror: async () => (prepared++, { kind: 'unavailable' }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('mutation-intent');
    expect(r.handoff?.proposal?.tool).toBe('edit_transaction');
    expect(r.handoff?.proposal?.userWords).toContain('Netflix');
    expect(r.handoff?.steps).toEqual([]);
    expect(backend.log).toEqual([]);
    expect(prepared).toBe(0);
    expect(api.calls.some((c) => c.url.includes('/api/transactions'))).toBe(false);
  });

  test('flag ON, non-data question: handoff carrying only the prior local turns, still no model work', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const priors = [{ q: 'earlier', a: 'answer' }];
    const r = await chat.tryLocal('Explain what a Roth IRA is', undefined, null, {
      subagent: { priorLocalTurns: priors, prepareMirror: async () => ({ kind: 'unavailable' }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('non-data');
    expect(r.handoff?.priorLocalTurns).toEqual(priors);
    expect(r.handoff?.steps).toEqual([]);
    expect(r.handoff?.proposal).toBeUndefined();
    expect(backend.log).toEqual([]);
  });

  test('flag ON but no subagent opts supplied (a caller that predates the feature): bundle mode as before', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const r = await chat.tryLocal('Give me a P&L for June');
    expect(r).toEqual({ ok: true, answer: 'bundle answer', sessionId: 's9', source: 'local' });
  });

  test('mirror stale: handoff(mirror-stale) before any model download, with the mirror timestamp', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, {
      subagent: { priorLocalTurns: [], prepareMirror: async () => ({ kind: 'stale', lastSyncedAt: SYNCED }) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('mirror-stale');
    expect(r.handoff?.reason).toBe('mirror-stale');
    expect(r.handoff?.mirror.syncedAt).toBe(SYNCED);
    expect(backend.log).not.toContain('load');
    expect(backend.log).not.toContain('subagentRun');
  });

  test('mirror unavailable or prepareMirror throwing: fall back to bundle mode, not a handoff', async () => {
    for (const prepare of [async (): Promise<MirrorPrep> => ({ kind: 'unavailable' }), async (): Promise<MirrorPrep> => { throw new Error('boom'); }]) {
      const backend = fakeBackend(async () => answerResult);
      const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
      const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: prepare } });
      expect(r).toEqual({ ok: true, answer: 'bundle answer', sessionId: 's9', source: 'local' });
      expect(backend.log).not.toContain('subagentRun');
    }
  });

  test('ready: runs the subagent with the port, profile, clock, priors and clamped limits; records the answer', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat, api } = chatFor(cfg({ enabled: true, maxSteps: 99 }), backend);
    const port = new FakePort();
    const priors = [{ q: 'q0', a: 'a0' }];
    const r = await chat.tryLocal('Give me a P&L for June', undefined, 'sess-1', {
      subagent: { priorLocalTurns: priors, prepareMirror: ready(port) },
    });
    expect(r).toEqual({
      ok: true,
      answer: 'Net profit was $3,000.00.',
      sessionId: 's9',
      source: 'local',
      mode: 'subagent',
      steps: [{ tool: 'profit_loss', ms: 12 }],
    });
    const args = backend.runArgs[0];
    expect(args.query).toBe('Give me a P&L for June');
    expect(args.expectedProfile).toBe('default');
    expect(args.priorLocalTurns).toEqual(priors);
    expect(args.port).toBe(port);
    expect(Number.isNaN(Date.parse(args.nowIso))).toBe(false);
    expect(args.limits.maxSteps).toBe(4);
    expect(args.limits.runDeadlineMs).toBe(DEFAULT_SUBAGENT_LIMITS.runDeadlineMs);
    // The run did not use the bundle (no /api/transactions) and the exchange was recorded.
    // Round 4 (R4-0): template mode (the default) writes the answer without the model, so it never loads it.
    expect(backend.log).toEqual(['probe', 'subagentRun']);
    expect(api.calls.some((c) => c.url.includes('/api/transactions'))).toBe(false);
    const rec = api.calls.find((c) => c.url.endsWith('/api/chat/local'))!;
    expect(rec.body).toEqual({ query: 'Give me a P&L for June', answer: 'Net profit was $3,000.00.', sessionId: 'sess-1' });
    // The client does not close a port the worker now owns... but it must never leak it either.
    expect(port.closed).toBeGreaterThanOrEqual(1);
  });

  test('a handoff outcome resolves {ok:false, reason, handoff} and sends nothing to /api/chat/local', async () => {
    const handoff = { v: 1 as const, reason: 'empty-result' as const, mirror: { syncedAt: SYNCED }, steps: [{ tool: 'transaction_search' as const, args: { query: 'Zzyzx' }, ok: true, summary: '0 rows' }] };
    const backend = fakeBackend(async () => ({ outcome: { kind: 'handoff', reason: 'empty-result', handoff }, deviceFault: false }));
    const { chat, api } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const port = new FakePort();
    const r = await chat.tryLocal('Show me every Zzyzx Labs charge', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: ready(port) } });
    expect(r).toEqual({ ok: false, reason: 'empty-result', handoff });
    expect(api.calls.some((c) => c.url.endsWith('/api/chat/local'))).toBe(false);
    expect(port.closed).toBeGreaterThanOrEqual(1);
  });

  test('bundle-fallback outcome runs today\'s bundle mode', async () => {
    const backend = fakeBackend(async () => ({ outcome: { kind: 'bundle-fallback' }, deviceFault: false }));
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const port = new FakePort();
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: ready(port) } });
    expect(r).toEqual({ ok: true, answer: 'bundle answer', sessionId: 's9', source: 'local' });
    // Round 4 (R4-0): the template-mode run loads nothing; bundle mode needs the model and loads it then.
    expect(backend.log).toEqual(['probe', 'subagentRun', 'load', 'bundleAnswer']);
  });

  test('cancelled outcome: {ok:false, reason:"cancelled"}, nothing recorded', async () => {
    const backend = fakeBackend(async () => ({ outcome: { kind: 'cancelled' }, deviceFault: false }));
    const { chat, api } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: ready(new FakePort()) } });
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
    expect(api.calls.some((c) => c.url.endsWith('/api/chat/local'))).toBe(false);
  });

  test('a rejected run (worker crash/timeout) never throws: {ok:false, reason:"error"}, port closed, verdict not persisted as failed', async () => {
    const backend = fakeBackend(async () => {
      throw { phase: 'protocol', message: 'model worker crashed' };
    });
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const port = new FakePort();
    const priors = [{ q: 'q0', a: 'a0' }];
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: priors, prepareMirror: ready(port) } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('error');
    expect(port.closed).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(sessionStorage.getItem('wilson-hybrid-capability')!).verdict).toBe('ready');
  });

  test('model load failure (compose: model) closes the port and resolves {ok:false}', async () => {
    const backend = fakeBackend(async () => answerResult);
    backend.load = async () => {
      throw { phase: 'protocol', message: 'worker unavailable' };
    };
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3, compose: 'model' }), backend);
    const port = new FakePort();
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: ready(port) } });
    expect(r.ok).toBe(false);
    expect(port.closed).toBeGreaterThanOrEqual(1);
    expect(backend.log).not.toContain('subagentRun');
  });

  test('R4-0: template mode (explicit or default) runs the subagent with no model load and no generation', async () => {
    for (const config of [cfg({ enabled: true, maxSteps: 3 }), cfg({ enabled: true, maxSteps: 3, compose: 'template' })]) {
      Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
      const backend = fakeBackend(async () => answerResult);
      let generated = 0;
      backend.bundleAnswer = async () => {
        generated++;
        return { kind: 'answer', text: 'x' };
      };
      backend.load = async () => {
        throw new Error('template mode must not load the model');
      };
      const { chat } = chatFor(config, backend);
      const port = new FakePort();
      const labels: string[] = [];
      const r = await chat.tryLocal('Give me a P&L for June', (l) => labels.push(l), null, { subagent: { priorLocalTurns: [], prepareMirror: ready(port) } });
      expect(r.ok).toBe(true);
      expect(backend.log).toEqual(['probe', 'subagentRun']);
      expect(generated).toBe(0);
      expect(labels).not.toContain('Loading local model…');
      expect(port.closed).toBeGreaterThanOrEqual(1);
    }
  });

  test('R4-0: model compose still loads the model before the run', async () => {
    const backend = fakeBackend(async () => answerResult);
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3, compose: 'model' }), backend);
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: ready(new FakePort()) } });
    expect(r.ok).toBe(true);
    expect(backend.log).toEqual(['probe', 'load', 'subagentRun']);
    expect(backend.runArgs[0].limits.compose).toBe('model');
  });

  test('step events become small progress labels (tool names only, never rows)', async () => {
    const backend = fakeBackend(async (_a, onStep) => {
      onStep?.({ kind: 'route', tool: 'profit_loss', via: 'keyword' });
      onStep?.({ kind: 'tool', tool: 'profit_loss', ms: 5, ok: true, args: { period: 'month' } });
      onStep?.({ kind: 'compose' });
      return answerResult;
    });
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    const labels: string[] = [];
    await chat.tryLocal('Give me a P&L for June', (l) => labels.push(l), null, { subagent: { priorLocalTurns: [], prepareMirror: ready(new FakePort()) } });
    expect(labels.some((l) => l.includes('profit_loss'))).toBe(true);
    expect(labels.join('\n')).not.toMatch(/\$3,000/);
  });

  test('an unavailable WebGPU verdict skips everything, flag or not', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    const backend = fakeBackend(async () => answerResult);
    const { chat } = chatFor(cfg({ enabled: true, maxSteps: 3 }), backend);
    await chat.probe();
    const r = await chat.tryLocal('Give me a P&L for June', undefined, null, { subagent: { priorLocalTurns: [], prepareMirror: async () => ({ kind: 'unavailable' }) } });
    expect(r).toEqual({ ok: false });
  });
});
