/** Round 4, R4-5: the shared open-jev host (fake worker, locks, storage and timers). */
import { describe, test, expect } from 'bun:test';
import {
  OPENJEV_IDLE_MS,
  createOpenJevHost,
  optInKey,
  type HostWorkerLike,
  type OpenJevHost,
  type OpenJevHostDeps,
} from '../dashboard/ui/src/openjev/host.js';
import { OPEN_JEV_CHAT_TIMEOUT_MS, OPEN_JEV_ROUTE_OPTIONS, OPEN_JEV_ROUTE_QUESTION } from '../dashboard/ui/src/hybrid/openjev-route.js';
import type { FromWorker, PrelabelPins, ToWorker } from '../dashboard/ui/src/prelabel/protocol.js';

const pins: PrelabelPins = {
  repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
  dtype: 'q4f16',
  device: 'webgpu',
  temperature: 1.05,
  templateVersion: 'prelabel-tmpl-v1',
  modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
  revision: '7c79f25b5ac496089f448a969c801872ad59d31c',
  configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
};
const NAMES = Object.keys(OPEN_JEV_ROUTE_OPTIONS);
const req = { state: 'What was my income last month?', question: OPEN_JEV_ROUTE_QUESTION, options: NAMES, descriptions: { ...OPEN_JEV_ROUTE_OPTIONS } };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeWorker implements HostWorkerLike {
  posted: ToWorker[] = [];
  terminated = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly opts: { verdict?: 'ready' | 'unavailable' | 'failed'; chooseReply?: 'auto' | 'never' | ((m: Extract<ToWorker, { type: 'choose' }>) => FromWorker | null) }) {}
  postMessage(msg: ToWorker) {
    this.posted.push(msg);
    queueMicrotask(() => this.autoReply(msg));
  }
  terminate() { this.terminated = true; }
  deliver(msg: unknown) { this.onmessage?.({ data: msg }); }
  private autoReply(msg: ToWorker) {
    if (this.terminated) return;
    if (msg.type === 'probe') {
      const verdict = this.opts.verdict ?? 'ready';
      this.deliver({ v: 1, type: 'capability', verdict, reason: verdict === 'ready' ? null : 'no_webgpu', adapter: null });
    } else if (msg.type === 'load') {
      this.deliver({ v: 1, type: 'loaded', loadMs: 1200, fromCache: true, firstDecisionMs: 200, runtime: { transformers: '4', ort: '1', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' }, configSha: pins.configSha });
    } else if (msg.type === 'choose') {
      const mode = this.opts.chooseReply ?? 'auto';
      if (mode === 'never') return;
      if (typeof mode === 'function') {
        const r = mode(msg);
        if (r) this.deliver(r);
        return;
      }
      this.deliver({ v: 1, type: 'chosen', reqId: msg.reqId, ok: true, choice: msg.options[3] ?? msg.options[0], p1: 0.7, p2: 0.2, margin: 0.5, top2: [[msg.options[3] ?? msg.options[0], 0.7], [msg.options[0], 0.2]], ms: 84 });
    }
  }
  types() { return this.posted.map((m) => m.type); }
}

function fakeLocks(otherHolds = false) {
  const state = { held: false, requests: [] as string[], released: 0 };
  return {
    state,
    request(name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void) {
      state.requests.push(name);
      if (otherHolds || state.held) return Promise.resolve(cb(null));
      state.held = true;
      return Promise.resolve(cb({ name })).finally(() => { state.held = false; state.released++; });
    },
  };
}

function fakeTimers() {
  const t: { id: number; fn: () => void; ms: number }[] = [];
  let n = 0;
  return {
    set: (fn: () => void, ms: number) => { const id = ++n; t.push({ id, fn, ms }); return id; },
    clear: (h: unknown) => { const i = t.findIndex((x) => x.id === h); if (i >= 0) t.splice(i, 1); },
    pending: () => t.map((x) => x.ms),
    fire(ms: number) { const i = t.findIndex((x) => x.ms === ms); if (i < 0) throw new Error(`no timer of ${ms} ms`); const [x] = t.splice(i, 1); x.fn(); },
  };
}

function rig(o: { optedIn?: boolean; otherHolds?: boolean; verdict?: 'ready' | 'unavailable' | 'failed'; chooseReply?: ConstructorParameters<typeof FakeWorker>[0]['chooseReply']; storageThrows?: boolean; createThrows?: Error; locks?: undefined | 'none' } = {}) {
  const workers: FakeWorker[] = [];
  const urls: string[] = [];
  const store = new Map<string, string>();
  if (o.optedIn) store.set(optInKey(pins.revision), '1');
  const locks = fakeLocks(o.otherHolds);
  const timers = fakeTimers();
  const deps: OpenJevHostDeps = {
    createWorker: (url) => {
      if (o.createThrows) throw o.createThrows;
      urls.push(url);
      const w = new FakeWorker({ verdict: o.verdict, chooseReply: o.chooseReply });
      workers.push(w);
      return w;
    },
    baseUrl: () => 'http://localhost:3000',
    locks: o.locks === 'none' ? undefined : locks,
    storage: () => {
      if (o.storageThrows) throw new Error('blocked');
      return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
    },
    timers,
  };
  const host: OpenJevHost = createOpenJevHost(deps);
  host.configure(pins);
  return { host, workers, urls, store, locks, timers };
}

describe('chat never downloads, consents or waits', () => {
  test('without opt-in: null, no worker, no lock, no info/load', async () => {
    const r = rig({ optedIn: false });
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(r.workers).toHaveLength(0);
    expect(r.locks.state.requests).toEqual([]);
  });

  test('without pins: null and nothing is spawned', async () => {
    const r = rig({ optedIn: true });
    r.host.configure(null);
    expect(await r.host.choose(req)).toBeNull();
    expect(r.workers).toHaveLength(0);
  });

  test('blocked storage counts as not opted in', async () => {
    const r = rig({ optedIn: true, storageThrows: true });
    expect(await r.host.choose(req)).toBeNull();
    expect(r.workers).toHaveLength(0);
  });

  test('opted in but not loaded: the turn gets null at once and a background load starts from the cache', async () => {
    const r = rig({ optedIn: true });
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    const w = r.workers[0];
    expect(w.types()).toEqual(['init', 'probe', 'load']);
    // chat-only init: no labels key at all
    expect(w.posted[0]).toEqual({ v: 1, type: 'init', pins, labelSetVersion: '', assetBase: 'http://localhost:3000/assets/' });
    expect(r.urls).toEqual(['http://localhost:3000/assets/prelabel-worker.js']);
    expect(w.types()).not.toContain('info');
    expect(r.locks.state.requests).toEqual(['wilson-prelabel']);
    expect(r.locks.state.held).toBe(true);
  });

  test('a later turn on the loaded session gets the decision', async () => {
    const r = rig({ optedIn: true });
    await r.host.choose(req);
    await flush();
    const out = await r.host.choose(req);
    expect(out).toMatchObject({ choice: 'net_worth', p1: 0.7, p2: 0.2 });
    expect(out?.margin).toBeCloseTo(0.5, 10);
    const choose = r.workers[0].posted.find((m) => m.type === 'choose') as Extract<ToWorker, { type: 'choose' }>;
    expect(choose).toMatchObject({ state: req.state, question: req.question, options: NAMES, descriptions: req.descriptions });
    expect(choose.reqId.length).toBeGreaterThan(0);
  });

  test('only one load while a load is in flight', async () => {
    const r = rig({ optedIn: true });
    await Promise.all([r.host.choose(req), r.host.choose(req), r.host.choose(req)]);
    await flush();
    expect(r.workers).toHaveLength(1);
    expect(r.workers[0].types().filter((t) => t === 'load')).toHaveLength(1);
  });

  test('another tab holds the lock: null, never waits, no load is posted', async () => {
    const r = rig({ optedIn: true, otherHolds: true });
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(await r.host.choose(req)).toBeNull();
    expect(r.workers[0].types()).not.toContain('load');
    expect(r.workers).toHaveLength(1);
    expect(r.locks.state.requests.length).toBeGreaterThanOrEqual(1);
  });

  test('no Web Locks support: loads without a lock', async () => {
    const r = rig({ optedIn: true, locks: 'none' });
    await r.host.choose(req);
    await flush();
    expect(r.workers[0].types()).toContain('load');
    expect((await r.host.choose(req))?.choice).toBe('net_worth');
  });

  test('unavailable capability: never loads, never retries the probe, null forever', async () => {
    const r = rig({ optedIn: true, verdict: 'unavailable' });
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(r.workers).toHaveLength(1);
    expect(r.workers[0].types()).toEqual(['init', 'probe']);
    expect(r.locks.state.requests).toEqual([]);
  });

  test('a timeout gives null, and a late reply is ignored', async () => {
    const r = rig({ optedIn: true, chooseReply: 'never' });
    await r.host.choose(req);
    await flush();
    const p = r.host.choose(req);
    await flush();
    expect(r.timers.pending()).toContain(OPEN_JEV_CHAT_TIMEOUT_MS);
    r.timers.fire(OPEN_JEV_CHAT_TIMEOUT_MS);
    expect(await p).toBeNull();
    const posted = r.workers[0].posted.find((m) => m.type === 'choose') as Extract<ToWorker, { type: 'choose' }>;
    r.workers[0].deliver({ v: 1, type: 'chosen', reqId: posted.reqId, ok: true, choice: 'net_worth', p1: 0.7, p2: 0.2, margin: 0.5, top2: [['net_worth', 0.7], ['forecast', 0.2]], ms: 1 });
  });

  test('an aborted signal gives null', async () => {
    const r = rig({ optedIn: true, chooseReply: 'never' });
    await r.host.choose(req);
    await flush();
    const ac = new AbortController();
    const p = r.host.choose(req, { signal: ac.signal });
    await flush();
    ac.abort();
    expect(await p).toBeNull();
    expect(await r.host.choose(req, { signal: ac.signal })).toBeNull();
  });

  test('a worker-side failure (decide_error, not_loaded) gives null', async () => {
    const r = rig({ optedIn: true, chooseReply: (m) => ({ v: 1, type: 'chosen', reqId: m.reqId, ok: false, reason: 'decide_error' }) });
    await r.host.choose(req);
    await flush();
    expect(await r.host.choose(req)).toBeNull();
  });

  test('a reply that fails validation gives null (choice outside the options, non-finite margin, p2 > p1)', async () => {
    const bad: Array<Record<string, unknown>> = [
      { choice: 'not_an_option' },
      { margin: Number.NaN },
      { margin: Number.POSITIVE_INFINITY },
      { p1: 0.2, p2: 0.7, margin: -0.5 },
    ];
    for (const patch of bad) {
      const r = rig({ optedIn: true, chooseReply: (m) => ({ v: 1, type: 'chosen', reqId: m.reqId, ok: true, choice: 'net_worth', p1: 0.7, p2: 0.2, margin: 0.5, top2: [['net_worth', 0.7], ['forecast', 0.2]], ms: 5, ...patch }) as FromWorker });
      await r.host.choose(req);
      await flush();
      expect(await r.host.choose(req)).toBeNull();
    }
  });

  test('createWorker throwing (dev cross-origin SecurityError) never throws into the caller', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'SecurityError' });
    const r = rig({ optedIn: true, createThrows: err });
    expect(await r.host.choose(req)).toBeNull();
    expect(await r.host.choose(req)).toBeNull();
  });

  test('a fatal worker error abandons the model: pending chooses resolve null and the lock is given back', async () => {
    const r = rig({ optedIn: true, chooseReply: 'never' });
    await r.host.choose(req);
    await flush();
    const p = r.host.choose(req);
    await flush();
    r.workers[0].deliver({ v: 1, type: 'error', fatal: true, code: 'load', detail: 'boom' });
    expect(await p).toBeNull();
    await flush();
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
    // and the page does not loop on a failed model
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(r.workers).toHaveLength(1);
  });

  test('a worker crash (onerror) abandons the model and releases the lock', async () => {
    const r = rig({ optedIn: true });
    await r.host.choose(req);
    await flush();
    r.workers[0].onerror?.();
    await flush();
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
    expect(await r.host.choose(req)).toBeNull();
  });
});

describe('two clients, one worker', () => {
  test('the pre-labeler lease and chat share one worker; the lease sees messages and can post', async () => {
    const r = rig({ optedIn: true });
    const seen: FromWorker[] = [];
    const lease = r.host.acquire('prelabel', (m) => seen.push(m));
    await flush();
    await r.host.choose(req);
    await flush();
    expect(r.workers).toHaveLength(1);
    expect(seen.some((m) => m.type === 'capability')).toBe(true);
    expect(seen.some((m) => m.type === 'loaded')).toBe(true);
    // chosen replies are the host's, never fanned out
    await r.host.choose(req);
    expect(seen.some((m) => m.type === 'chosen')).toBe(false);
    expect(lease.post({ v: 1, type: 'cancel', runId: 'x' })).toBe(true);
    expect(r.workers[0].types()).toContain('cancel');
  });

  test('acquiring the pre-labeler alone spawns, inits and probes, but takes no lock and loads nothing', async () => {
    const r = rig({ optedIn: true });
    r.host.acquire('prelabel');
    await flush();
    expect(r.workers[0].types()).toEqual(['init', 'probe']);
    expect(r.locks.state.requests).toEqual([]);
  });

  test('a profile change releases the pre-labeler but the model stays while chat holds it', async () => {
    const r = rig({ optedIn: true });
    const lease = r.host.acquire('prelabel');
    await r.host.choose(req);
    await flush();
    lease.release();
    await flush();
    expect(r.workers[0].terminated).toBe(false);
    expect(r.workers[0].types()).not.toContain('dispose');
    expect(r.locks.state.held).toBe(true);
    expect((await r.host.choose(req))?.choice).toBe('net_worth');
    // releasing twice is harmless
    lease.release();
    expect(r.workers[0].terminated).toBe(false);
  });

  test('with only the pre-labeler holding, releasing it frees the model and the lock', async () => {
    const r = rig({ optedIn: true });
    const lease = r.host.acquire('prelabel');
    await flush();
    // the pre-labeler loads through the host's shared gate after its own consent click
    expect(await r.host.ensureLock()).toBe('held');
    lease.post({ v: 1, type: 'load' });
    await flush();
    lease.release();
    await flush();
    expect(r.workers[0].types()).toContain('dispose');
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
  });
});

describe('idle', () => {
  test('chat idle: after 5 minutes without a turn the model is disposed, the worker ends and the lock is released', async () => {
    const r = rig({ optedIn: true });
    await r.host.choose(req);
    await flush();
    expect(r.timers.pending()).toContain(OPENJEV_IDLE_MS);
    expect(OPENJEV_IDLE_MS).toBe(5 * 60 * 1000);
    r.timers.fire(OPENJEV_IDLE_MS);
    await flush();
    expect(r.workers[0].types()).toContain('dispose');
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
    // the next turn starts over from the cache
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(r.workers).toHaveLength(2);
    expect((await r.host.choose(req))?.choice).toBe('net_worth');
  });

  test('every chat turn re-arms the idle timer', async () => {
    const r = rig({ optedIn: true });
    await r.host.choose(req);
    await flush();
    await r.host.choose(req);
    expect(r.timers.pending().filter((m) => m === OPENJEV_IDLE_MS)).toHaveLength(1);
  });

  test('chat idle while the pre-labeler still holds: the model stays', async () => {
    const r = rig({ optedIn: true });
    const lease = r.host.acquire('prelabel');
    await r.host.choose(req);
    await flush();
    r.timers.fire(OPENJEV_IDLE_MS);
    await flush();
    expect(r.workers[0].terminated).toBe(false);
    expect(r.locks.state.held).toBe(true);
    lease.release();
    await flush();
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
  });

  test('changing the pinned revision drops the old model', async () => {
    const r = rig({ optedIn: true });
    await r.host.choose(req);
    await flush();
    r.host.configure({ ...pins, revision: 'a'.repeat(40) });
    await flush();
    expect(r.workers[0].terminated).toBe(true);
    expect(r.locks.state.held).toBe(false);
    // the new revision has no consent yet
    expect(await r.host.choose(req)).toBeNull();
    await flush();
    expect(r.workers).toHaveLength(1);
  });
});

describe('consent is shared with the Review tab', () => {
  test('the opt-in key is the pre-labeler key for the pinned revision', () => {
    expect(optInKey(pins.revision)).toBe(`wilson-prelabel-optin:v1:${pins.revision}`);
  });
  test('grantConsent writes that key and chat then loads from it', async () => {
    const r = rig({ optedIn: false });
    expect(r.host.optedIn()).toBe(false);
    r.host.grantConsent();
    expect(r.store.get(optInKey(pins.revision))).toBe('1');
    expect(r.host.optedIn()).toBe(true);
    await r.host.choose(req);
    await flush();
    expect(r.workers[0].types()).toContain('load');
  });
});
