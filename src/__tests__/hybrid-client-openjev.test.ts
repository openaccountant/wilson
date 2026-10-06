import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHybridChat, type LocalChatConfigResponse, type SubagentTurnOpts } from '../dashboard/ui/src/hybrid/client.js';
import type { ModelBackend } from '../dashboard/ui/src/hybrid/model-backend.js';
import { OPEN_JEV_CHAT_TIMEOUT_MS, type ToolChoice } from '../dashboard/ui/src/hybrid/openjev-route.js';
import {
  type MirrorPrep,
  type SubagentRunArgs,
  type SubagentRunResult,
} from '../dashboard/ui/src/hybrid/worker-protocol.js';

/**
 * Round 4, slice R4-6 (specs/browser-subagent-round4-openjev-router.md §4.3, §11): the hybrid
 * client asks the app's `chooseTool` for the 0 / 2+ keyword-hit questions, applies the pure
 * route decision, and either hands off BEFORE `subagentRun` (port closed) or passes a
 * `routeHint`. Flag off, one hit, or no frozen cut: byte-identical to round 3.
 */

const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3 0.6B' };
const PINS = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16' as const,
  device: 'webgpu' as const,
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1' as const,
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
};
const CUT = 0.35;
const ZERO = 'What was my income last month?';
const MULTI = 'P&L by category for this month';
const SINGLE = 'Give me a P&L for June';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

type Sub = { enabled: boolean; maxSteps: number; compose?: 'template' | 'model'; openJevRouter?: boolean; openJevPins?: typeof PINS | null };
function cfg(subagent: Sub): LocalChatConfigResponse {
  return {
    enabled: true, id: `transformers:${MODEL.repo}`, repo: MODEL.repo, displayName: MODEL.displayName, downloadSize: '~570MB',
    dtype: 'q4f16', bundle: { days: 30, limit: 200, maxChars: 6000 }, subagent,
  };
}
const ON: Sub = { enabled: true, maxSteps: 3, openJevRouter: true, openJevPins: PINS };

function dashboardFetch(config: LocalChatConfigResponse) {
  return async (input: string): Promise<Response> => {
    if (input.endsWith('/api/config/local-chat')) return Response.json(config);
    if (input.includes('/api/transactions')) return Response.json([]);
    if (input.endsWith('/api/weekly-summary')) return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's9' });
    return new Response('not found', { status: 404 });
  };
}

const answerResult: SubagentRunResult = {
  outcome: { kind: 'answer', text: 'Net profit was $3,000.00.', steps: [{ tool: 'profit_loss', args: { period: 'month' }, ok: true, ms: 12, summary: 'x' }] },
  deviceFault: false,
};

function fakeBackend(): ModelBackend & { log: string[]; runArgs: SubagentRunArgs[] } {
  const log: string[] = [];
  const runArgs: SubagentRunArgs[] = [];
  return {
    log, runArgs,
    setModel: () => {},
    probe: async () => 'ready',
    load: async () => (log.push('load'), { loadMs: 1, loadFresh: true, dtype: 'q4f16' }),
    bundleAnswer: async () => (log.push('bundleAnswer'), { kind: 'answer', text: 'bundle answer' }),
    categorize: async () => ({ raw: '', decisionMs: 0 }),
    subagentRun: async (args) => (log.push('subagentRun'), runArgs.push(args), answerResult),
    dispose: () => {},
  };
}

class FakePort {
  closed = 0;
  onmessage = null;
  postMessage() {}
  close() { this.closed++; }
}

const choice = (tool: string, margin: number): ToolChoice => ({ tool, p1: 0.5 + margin, p2: 0.5, margin });

describe('hybrid client: open-jev route tiebreak', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }, configurable: true, writable: true });
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedStorage) Object.defineProperty(globalThis, 'sessionStorage', savedStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  function setup(sub: Sub, over: { routeCut?: number | null; chooseTool?: SubagentTurnOpts['chooseTool'] } = {}) {
    const backend = fakeBackend();
    const port = new FakePort();
    const chat = createHybridChat({
      baseUrl: '', fetchImpl: dashboardFetch(cfg(sub)), backend,
      ...(over.routeCut !== undefined ? { routeCut: over.routeCut } : { routeCut: CUT }),
    });
    const calls: Array<{ question: string; pins: unknown }> = [];
    const progress: string[] = [];
    const chooseTool: SubagentTurnOpts['chooseTool'] | undefined = over.chooseTool === undefined ? undefined : async (req) => {
      calls.push({ question: req.question, pins: req.pins });
      return over.chooseTool!(req);
    };
    const run = (q: string) =>
      chat.tryLocal(q, (l) => progress.push(l), null, {
        subagent: {
          priorLocalTurns: [],
          prepareMirror: async (): Promise<MirrorPrep> => ({ kind: 'ready', port, expectedProfile: 'default', lastSyncedAt: '2026-10-03T11:59:00.000Z' }),
          ...(chooseTool ? { chooseTool } : {}),
        },
      });
    return { backend, port, calls, progress, run };
  }

  test('flag off (absent or false): chooseTool is never called, even on a zero-hit question; no hint (round 3)', async () => {
    for (const sub of [{ enabled: true, maxSteps: 3 }, { enabled: true, maxSteps: 3, openJevRouter: false, openJevPins: null }] as Sub[]) {
      const s = setup(sub, { chooseTool: async () => choice('profit_loss', 0.9) });
      await s.run(ZERO);
      expect(s.calls).toHaveLength(0);
      expect(s.backend.runArgs).toHaveLength(1);
      expect(s.backend.runArgs[0].routeHint).toBeUndefined();
    }
  });

  test('flag on but no pins: treated as off', async () => {
    const s = setup({ enabled: true, maxSteps: 3, openJevRouter: true, openJevPins: null }, { chooseTool: async () => choice('profit_loss', 0.9) });
    await s.run(ZERO);
    expect(s.calls).toHaveLength(0);
    expect(s.backend.runArgs[0].routeHint).toBeUndefined();
  });

  test('flag on but the cut is not frozen (null): chooseTool is not called and the turn is round 3', async () => {
    const s = setup(ON, { routeCut: null, chooseTool: async () => choice('profit_loss', 0.9) });
    await s.run(ZERO);
    expect(s.calls).toHaveLength(0);
    expect(s.backend.runArgs[0].routeHint).toBeUndefined();
  });

  test('flag on, no chooseTool supplied (caller predates it): round 3', async () => {
    const s = setup(ON);
    await s.run(ZERO);
    expect(s.backend.runArgs[0].routeHint).toBeUndefined();
  });

  test('exactly one keyword hit: no chooseTool call and no hint', async () => {
    const s = setup(ON, { chooseTool: async () => choice('net_worth', 0.9) });
    const r = await s.run(SINGLE);
    expect(s.calls).toHaveLength(0);
    expect(s.backend.runArgs[0].routeHint).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  test('zero hits and chooseTool returns null: router-none handoff BEFORE subagentRun, port closed', async () => {
    const s = setup(ON, { chooseTool: async () => null });
    const r = await s.run(ZERO);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toEqual({ question: ZERO, pins: PINS });
    expect(s.backend.log).not.toContain('subagentRun');
    expect(s.port.closed).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('router-none');
    expect(r.handoff).toBeDefined();
    expect(r.handoff?.steps).toEqual([]);
  });

  test('a Qwen load is never started for the handoff (template mode)', async () => {
    const s = setup(ON, { chooseTool: async () => null });
    await s.run(ZERO);
    expect(s.backend.log).toEqual([]);
  });

  test('a valid zero-hit choice passes routeHint {tool, margin, cut, hits: []}', async () => {
    const s = setup(ON, { chooseTool: async () => choice('profit_loss', 0.5) });
    const r = await s.run(ZERO);
    expect(s.backend.runArgs).toHaveLength(1);
    expect(s.backend.runArgs[0].routeHint).toEqual({ tool: 'profit_loss', margin: 0.5, cut: CUT, hits: [] });
    expect(r.ok).toBe(true);
    expect(s.port.closed).toBeGreaterThanOrEqual(1);
  });

  test('a valid multi-hit choice (top1 among the hits) passes the hits too', async () => {
    const s = setup(ON, { chooseTool: async () => choice('profit_loss', 0.5) });
    await s.run(MULTI);
    const hint = s.backend.runArgs[0].routeHint;
    expect(hint?.tool).toBe('profit_loss');
    expect(hint?.hits.length).toBeGreaterThanOrEqual(2);
    expect(hint?.hits).toContain('profit_loss');
  });

  test('multi-hit with top1 outside the hits: router-none before subagentRun', async () => {
    const s = setup(ON, { chooseTool: async () => choice('net_worth', 0.9) });
    const r = await s.run(MULTI);
    expect(s.backend.log).not.toContain('subagentRun');
    expect(!r.ok && r.reason).toBe('router-none');
  });

  test('a margin below the cut, a NaN margin and an unknown tool all hand off as router-none', async () => {
    for (const c of [choice('profit_loss', CUT - 0.01), choice('profit_loss', Number.NaN), choice('delete_everything', 0.9)]) {
      const s = setup(ON, { chooseTool: async () => c });
      const r = await s.run(ZERO);
      expect(s.backend.log).not.toContain('subagentRun');
      expect(!r.ok && r.reason).toBe('router-none');
    }
  });

  test('chooseTool throwing is router-none, never reason:error', async () => {
    const s = setup(ON, { chooseTool: async () => { throw new Error('boom'); } });
    const r = await s.run(ZERO);
    expect(s.backend.log).not.toContain('subagentRun');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('router-none');
  });

  test('a chooseTool that never settles is cut off shortly after the chat timeout', async () => {
    const s = setup(ON, { chooseTool: () => new Promise<ToolChoice | null>(() => {}) });
    const t0 = Date.now();
    const r = await s.run(ZERO);
    expect(Date.now() - t0).toBeLessThan(OPEN_JEV_CHAT_TIMEOUT_MS + 1000);
    expect(!r.ok && r.reason).toBe('router-none');
  });

  test('progress label while picking, then the usual labels', async () => {
    const s = setup(ON, { chooseTool: async () => choice('profit_loss', 0.5) });
    await s.run(ZERO);
    expect(s.progress[0]).toBe('Picking the right lookup on this device…');
  });

  test('the client passes an abort signal to chooseTool', async () => {
    let seen: unknown;
    const s = setup(ON, { chooseTool: async (req) => { seen = req.signal; return choice('profit_loss', 0.5); } });
    await s.run(ZERO);
    expect(seen).toBeDefined();
  });
});
