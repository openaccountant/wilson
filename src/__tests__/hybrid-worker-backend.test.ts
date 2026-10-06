import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createWorkerBackend,
  DEFAULT_RPC_TIMEOUT_MS,
  type WorkerLike,
} from '../dashboard/ui/src/hybrid/model-backend.js';
import { createHybridChat, CAPABILITY_STORAGE_KEY, type LocalChatConfigResponse } from '../dashboard/ui/src/hybrid/client.js';
import { DEFAULT_SUBAGENT_LIMITS, isMainToWorker, type MainToWorker, type WorkerToMain } from '../dashboard/ui/src/hybrid/worker-protocol.js';

/**
 * The main-thread proxy to the model worker, driven by a fake Worker: how it
 * initialises, correlates replies, and survives a crash. No browser needed.
 */

const MODEL = { repo: 'onnx-community/Qwen3-0.6B-ONNX', displayName: 'Qwen3 0.6B', catalogDtype: 'q4f16' };
const ORIGIN = 'http://127.0.0.1:3000';

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: MainToWorker[] = [];
  terminated = false;
  /** Called for every message; default behaviour replies to probe/load. */
  handler: (msg: MainToWorker, w: FakeWorker) => void = (msg, w) => {
    if (msg.t === 'probe') w.reply({ t: 'result', id: msg.id, ok: true, result: 'ready' });
    if (msg.t === 'load') w.reply({ t: 'result', id: msg.id, ok: true, result: { loadMs: 5, loadFresh: true, dtype: 'q4f16' } });
  };
  transfers: Array<unknown[] | undefined> = [];
  postMessage(message: unknown, transfer?: unknown[]): void {
    expect(isMainToWorker(message)).toBe(true);
    this.posted.push(message as MainToWorker);
    this.transfers.push(transfer);
    queueMicrotask(() => this.handler(message as MainToWorker, this));
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: WorkerToMain): void {
    this.onmessage?.({ data: msg });
  }
  crash(): void {
    this.onerror?.({ message: 'boom' });
  }
}

function setup(timeoutMs?: Parameters<typeof createWorkerBackend>[0]['timeoutMs']) {
  const workers: FakeWorker[] = [];
  const backend = createWorkerBackend({
    origin: ORIGIN,
    timeoutMs,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { backend, workers };
}

describe('createWorkerBackend', () => {
  test('spawns lazily, sends init first (with the page origin), then correlates replies by id', async () => {
    const { backend, workers } = setup();
    expect(workers).toHaveLength(0);
    backend.setModel(MODEL);
    expect(workers).toHaveLength(0); // still lazy

    expect(await backend.probe()).toBe('ready');
    const loaded = await backend.load();
    expect(loaded).toEqual({ loadMs: 5, loadFresh: true, dtype: 'q4f16' });

    expect(workers).toHaveLength(1);
    const kinds = workers[0].posted.map((m) => m.t);
    expect(kinds).toEqual(['init', 'probe', 'load']);
    expect(workers[0].posted[0]).toMatchObject({ t: 'init', v: 1, origin: ORIGIN, model: MODEL });
  });

  test('progress labels reach the callback of the call that caused them', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    await backend.probe(); // spawns the worker
    const w = workers[0];
    w.handler = () => {};
    const labels: string[] = [];
    const first = backend.load((l) => labels.push(l));
    await Promise.resolve();
    const loadMsg = w.posted.find((m) => m.t === 'load')!;
    w.reply({ t: 'progress', id: (loadMsg as { id: number }).id, label: 'Downloading local model… 10%' });
    w.reply({ t: 'progress', id: 9999, label: 'someone else' });
    w.reply({ t: 'result', id: (loadMsg as { id: number }).id, ok: true, result: { loadMs: 1, loadFresh: false, dtype: null } });
    await first;
    expect(labels).toEqual(['Downloading local model… 10%']);
  });

  test('a worker error reply rejects with the WorkerError', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    await backend.probe();
    workers[0].handler = () => {};
    const p = backend.load();
    await Promise.resolve();
    const id = (workers[0].posted.find((m) => m.t === 'load') as { id: number }).id;
    workers[0].reply({ t: 'result', id, ok: false, error: { phase: 'warmup', message: 'GPU device lost', dtype: 'q4f16' } });
    await expect(p).rejects.toMatchObject({ phase: 'warmup', message: 'GPU device lost', dtype: 'q4f16' });
  });

  test('onerror rejects every pending call, terminates the worker and the next call respawns it with a fresh init', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    await backend.probe();
    workers[0].handler = () => {}; // hang the next two calls
    const a = backend.load();
    const b = backend.bundleAnswer('q', 'bundle', '2026-10-02');
    const settled = [a, b].map((p) => p.then(() => 'ok', (e) => (e as { phase: string }).phase));
    await Promise.resolve();

    workers[0].crash();
    expect(await Promise.all(settled)).toEqual(['protocol', 'protocol']);
    expect(workers[0].terminated).toBe(true);

    expect(await backend.probe()).toBe('ready');
    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map((m) => m.t)).toEqual(['init', 'probe']);
  });

  test('an RPC timeout is treated like a crash', async () => {
    const { backend, workers } = setup({ load: 20 });
    backend.setModel(MODEL);
    await backend.probe();
    workers[0].handler = () => {};
    await expect(backend.load()).rejects.toMatchObject({ phase: 'protocol', message: expect.stringContaining('timed out') });
    expect(workers[0].terminated).toBe(true);
  });

  test('a stalled load times out, a slow one that keeps reporting progress does not', async () => {
    const { backend, workers } = setup({ load: 60 });
    backend.setModel(MODEL);
    await backend.probe();
    workers[0].handler = () => {};
    const p = backend.load();
    await Promise.resolve();
    const id = (workers[0].posted.find((m) => m.t === 'load') as { id: number }).id;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 30));
      workers[0].reply({ t: 'progress', id, label: `Downloading local model… ${i}%` });
    }
    workers[0].reply({ t: 'result', id, ok: true, result: { loadMs: 1, loadFresh: true, dtype: 'q4f16' } });
    await expect(p).resolves.toMatchObject({ loadFresh: true });
  });

  test('a Worker constructor that throws (CSP, policy) makes probe unavailable and other calls reject', async () => {
    const backend = createWorkerBackend({
      origin: ORIGIN,
      createWorker: () => {
        throw new Error('Refused to create a worker from blob:');
      },
    });
    backend.setModel(MODEL);
    expect(await backend.probe()).toBe('unavailable');
    await expect(backend.load()).rejects.toMatchObject({ phase: 'protocol' });
  });

  test('changing the model re-sends init to a live worker; an identical config does not', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    await backend.probe();
    backend.setModel({ ...MODEL });
    backend.setModel({ ...MODEL, repo: 'onnx-community/other', catalogDtype: null });
    expect(workers[0].posted.map((m) => m.t)).toEqual(['init', 'probe', 'init']);
    expect(workers[0].posted[2]).toMatchObject({ model: { repo: 'onnx-community/other' } });
  });

  test('bundleAnswer carries strictly increasing runIds', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    workers[0] ?? (await backend.probe());
    const w = workers[0];
    w.handler = (msg, self) => {
      if (msg.t === 'bundleAnswer') self.reply({ t: 'result', id: msg.id, ok: true, result: { kind: 'answer', text: 'hi' } });
      if (msg.t === 'probe') self.reply({ t: 'result', id: msg.id, ok: true, result: 'ready' });
    };
    await backend.bundleAnswer('q1', 'b', 'd');
    await backend.bundleAnswer('q2', 'b', 'd');
    const runs = w.posted.filter((m) => m.t === 'bundleAnswer').map((m) => (m as { runId: number }).runId);
    expect(runs[1]).toBeGreaterThan(runs[0]);
  });

  test('dispose terminates the worker and fails what is in flight', async () => {
    const { backend, workers } = setup();
    backend.setModel(MODEL);
    await backend.probe();
    workers[0].handler = () => {};
    const p = backend.load();
    await Promise.resolve();
    backend.dispose();
    await expect(p).rejects.toMatchObject({ phase: 'protocol' });
    expect(workers[0].terminated).toBe(true);
  });
});

describe('createWorkerBackend: subagentRun (spec section 4.1)', () => {
  const PORT = { postMessage() {}, onmessage: null, close() {} };
  const baseArgs = () => ({
    query: 'Give me a P&L for June',
    nowIso: '2026-07-15T12:00:00.000Z',
    expectedProfile: 'default',
    priorLocalTurns: [{ q: 'a', a: 'b' }],
    limits: DEFAULT_SUBAGENT_LIMITS,
    port: PORT,
  });

  async function ready(opts?: Parameters<typeof setup>[0]) {
    const s = setup(opts);
    s.backend.setModel(MODEL);
    await s.backend.probe();
    return s;
  }

  test('posts subagentRun with the port in the TRANSFER list and resolves the run result', async () => {
    const { backend, workers } = await ready();
    const w = workers[0];
    w.handler = (msg, self) => {
      if (msg.t === 'subagentRun') {
        self.reply({ t: 'result', id: msg.id, ok: true, result: { outcome: { kind: 'bundle-fallback' }, deviceFault: false } });
      }
    };
    const r = await backend.subagentRun(baseArgs());
    expect(r).toEqual({ outcome: { kind: 'bundle-fallback' }, deviceFault: false });
    const i = w.posted.findIndex((m) => m.t === 'subagentRun');
    const msg = w.posted[i] as Extract<MainToWorker, { t: 'subagentRun' }>;
    expect(msg.query).toBe('Give me a P&L for June');
    expect(msg.expectedProfile).toBe('default');
    expect(msg.runId).toBeGreaterThan(0);
    expect(w.transfers[i]).toEqual([PORT]);
  });

  test('step events reach onStep for that run only', async () => {
    const { backend, workers } = await ready();
    const w = workers[0];
    w.handler = () => {};
    const seen: unknown[] = [];
    const p = backend.subagentRun(baseArgs(), (e) => seen.push(e));
    await Promise.resolve();
    const msg = w.posted.find((m) => m.t === 'subagentRun') as Extract<MainToWorker, { t: 'subagentRun' }>;
    w.reply({ t: 'step', id: msg.id, runId: msg.runId, event: { kind: 'gate', verdict: 'route' } });
    w.reply({ t: 'step', id: 9999, runId: 1, event: { kind: 'compose' } });
    w.reply({ t: 'result', id: msg.id, ok: true, result: { outcome: { kind: 'cancelled' }, deviceFault: false } });
    await p;
    expect(seen).toEqual([{ kind: 'gate', verdict: 'route' }]);
  });

  test('aborting the signal posts cancel for that runId', async () => {
    const { backend, workers } = await ready();
    const w = workers[0];
    w.handler = () => {};
    const ac = new AbortController();
    const p = backend.subagentRun(baseArgs(), undefined, ac.signal);
    await Promise.resolve();
    const msg = w.posted.find((m) => m.t === 'subagentRun') as Extract<MainToWorker, { t: 'subagentRun' }>;
    ac.abort();
    expect(w.posted.some((m) => m.t === 'cancel' && m.runId === msg.runId)).toBe(true);
    w.reply({ t: 'result', id: msg.id, ok: true, result: { outcome: { kind: 'cancelled' }, deviceFault: false } });
    expect((await p).outcome).toEqual({ kind: 'cancelled' });
  });

  test('a device fault terminates the worker after the result; the next call respawns it with a fresh init', async () => {
    const { backend, workers } = await ready();
    const w = workers[0];
    w.handler = (msg, self) => {
      if (msg.t === 'subagentRun') {
        self.reply({
          t: 'result',
          id: msg.id,
          ok: true,
          result: { outcome: { kind: 'handoff', reason: 'error', handoff: { v: 1, reason: 'error', mirror: { syncedAt: null }, steps: [] } }, deviceFault: true },
        });
      }
    };
    const r = await backend.subagentRun(baseArgs());
    expect(r.outcome.kind).toBe('handoff');
    expect(r.deviceFault).toBe(true);
    expect(w.terminated).toBe(true);
    expect(await backend.probe()).toBe('ready');
    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map((m) => m.t)).toEqual(['init', 'probe']);
  });

  test('a run that never answers times out like a crash (protocol error, worker terminated)', async () => {
    const { backend, workers } = await ready({ subagentRun: 20 });
    workers[0].handler = () => {};
    await expect(backend.subagentRun(baseArgs())).rejects.toMatchObject({ phase: 'protocol', message: expect.stringContaining('timed out') });
    expect(workers[0].terminated).toBe(true);
  });

  test('the default budget leaves room for the 30 s run deadline', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS.subagentRun).toBeGreaterThan(DEFAULT_SUBAGENT_LIMITS.runDeadlineMs);
  });

  test('a worker that cannot be constructed rejects with a protocol WorkerError (never a throw)', async () => {
    const backend = createWorkerBackend({
      origin: ORIGIN,
      createWorker: () => {
        throw new Error('CSP blocked');
      },
    });
    backend.setModel(MODEL);
    await expect(backend.subagentRun(baseArgs())).rejects.toMatchObject({ phase: 'protocol' });
  });
});

// ── through the hybrid client, with a fake worker ────────────────────────

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const CFG: LocalChatConfigResponse = {
  enabled: true,
  id: `transformers:${MODEL.repo}`,
  repo: MODEL.repo,
  displayName: MODEL.displayName,
  downloadSize: '~570MB',
  dtype: 'q4f16',
  bundle: { days: 30, limit: 200, maxChars: 6000 },
};

function dashboardFetch() {
  const calls: string[] = [];
  const fn = async (input: string): Promise<Response> => {
    calls.push(input);
    if (input.endsWith('/api/config/local-chat')) return Response.json(CFG);
    if (input.includes('/api/transactions')) return Response.json([]);
    if (input.endsWith('/api/weekly-summary')) {
      return Response.json({ thisWeek: { total: 0 }, lastWeek: { total: 0 }, change: { amount: 0, percent: 0 } });
    }
    if (input.endsWith('/api/chat/local')) return Response.json({ sessionId: 's1' });
    return new Response('not found', { status: 404 });
  };
  return { fn, calls };
}

describe('createHybridChat over the worker backend', () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    if (savedStorage) Object.defineProperty(globalThis, 'sessionStorage', savedStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });

  function workerThatAnswers(text: string) {
    const workers: FakeWorker[] = [];
    const createWorker = () => {
      const w = new FakeWorker();
      w.handler = (msg, self) => {
        if (msg.t === 'probe') self.reply({ t: 'result', id: msg.id, ok: true, result: 'ready' });
        if (msg.t === 'load') {
          self.reply({ t: 'progress', id: msg.id, label: 'Downloading local model… 50%' });
          self.reply({ t: 'result', id: msg.id, ok: true, result: { loadMs: 3, loadFresh: true, dtype: 'q4f16' } });
        }
        if (msg.t === 'bundleAnswer') self.reply({ t: 'result', id: msg.id, ok: true, result: { kind: 'answer', text } });
      };
      workers.push(w);
      return w;
    };
    return { workers, createWorker };
  }

  test('a local answer flows main -> worker -> main, and the bundle is built on the main thread', async () => {
    const api = dashboardFetch();
    const { workers, createWorker } = workerThatAnswers('You spent $0 this week.');
    const chat = createHybridChat({ baseUrl: '', origin: ORIGIN, fetchImpl: api.fn, createWorker });
    const progress: string[] = [];

    const r = await chat.tryLocal('how much did I spend?', (l) => progress.push(l));
    expect(r).toEqual({ ok: true, answer: 'You spent $0 this week.', sessionId: 's1', source: 'local' });
    expect(progress).toContain('Downloading local model… 50%');
    expect(api.calls.some((c) => c.includes('/api/transactions'))).toBe(true);
    expect(JSON.parse(storage.getItem(CAPABILITY_STORAGE_KEY)!)).toMatchObject({ verdict: 'ready' });

    const answer = workers[0].posted.find((m) => m.t === 'bundleAnswer') as Extract<MainToWorker, { t: 'bundleAnswer' }>;
    expect(answer.query).toBe('how much did I spend?');
    expect(typeof answer.bundleText).toBe('string');
    // The worker never receives anything authed: no token, no fetch handle.
    expect(JSON.stringify(workers[0].posted)).not.toMatch(/authorization|bearer|token/i);
  });

  test('a worker crash mid-generation resolves {ok:false} (server path), is not persisted as failed, and the next call respawns', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = dashboardFetch();
      const { workers, createWorker } = workerThatAnswers('ok');
      // First call: crash instead of answering.
      const orig = createWorker;
      let first = true;
      const chat2 = createHybridChat({
        baseUrl: '',
        origin: ORIGIN,
        fetchImpl: api.fn,
        createWorker: () => {
          const w = orig();
          const answering = w.handler;
          w.handler = (msg, self) => {
            if (msg.t === 'bundleAnswer' && first) {
              first = false;
              self.crash();
              return;
            }
            answering(msg, self);
          };
          return w;
        },
      });

      const r1 = await chat2.tryLocal('q');
      expect(r1.ok).toBe(false);
      expect(JSON.parse(storage.getItem(CAPABILITY_STORAGE_KEY)!).verdict).not.toBe('failed');

      const r2 = await chat2.tryLocal('q');
      expect(r2.ok).toBe(true);
      expect(workers.length).toBeGreaterThanOrEqual(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('a Worker constructor that throws leaves the client on the server path without an error', async () => {
    const api = dashboardFetch();
    const chat = createHybridChat({
      baseUrl: '',
      origin: ORIGIN,
      fetchImpl: api.fn,
      createWorker: () => {
        throw new Error('blocked');
      },
    });
    expect(await chat.tryLocal('q')).toEqual({ ok: false });
    expect(JSON.parse(storage.getItem(CAPABILITY_STORAGE_KEY)!).verdict).toBe('unavailable');
  });

  test('no worker constructor and no test hook: nothing to run on, {ok:false}', async () => {
    const api = dashboardFetch();
    const chat = createHybridChat({ baseUrl: '', origin: ORIGIN, fetchImpl: api.fn });
    expect(await chat.tryLocal('q')).toEqual({ ok: false });
  });

  test('a worker that refuses to run (opaque origin) answers unavailable and the verdict sticks', async () => {
    const api = dashboardFetch();
    const chat = createHybridChat({
      baseUrl: '',
      origin: ORIGIN,
      fetchImpl: api.fn,
      createWorker: () => {
        const w = new FakeWorker();
        w.handler = (msg, self) => {
          if (msg.t === 'probe') self.reply({ t: 'result', id: msg.id, ok: true, result: 'unavailable' });
        };
        return w;
      },
    });
    expect(await chat.tryLocal('q')).toEqual({ ok: false });
    expect(JSON.parse(storage.getItem(CAPABILITY_STORAGE_KEY)!).verdict).toBe('unavailable');
  });
});
