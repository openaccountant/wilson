/**
 * Round 3 / fix 1: hook-wiring tests for the pre-labeler.
 *
 * There is no DOM or React test renderer in this repo, so usePrelabel.ts is a
 * thin useSyncExternalStore binding over `createPrelabelController`
 * (controller.ts), which holds all of the worker / Web Lock / idle / profile
 * wiring and takes every browser global as a dependency. These tests drive it
 * with a fake worker, fake lock manager, fake fetch and fake timers.
 */
import { describe, test, expect } from 'bun:test';
import {
  createPrelabelController,
  type ControllerDeps,
  type WorkerLike,
} from '../dashboard/ui/src/prelabel/controller.js';
import { createLockGate, type LockManagerLike, type KeyValueStorage } from '../dashboard/ui/src/prelabel/session.js';
import type { FromWorker, ToWorker } from '../dashboard/ui/src/prelabel/protocol.js';
import type { PrelabelConfig, ReviewQueueItem } from '../dashboard/ui/src/types.js';

const REVISION = '7c79f25b5ac496089f448a969c801872ad59d31c';

function config(over: Partial<PrelabelConfig> = {}): PrelabelConfig {
  return {
    enabled: true,
    profile: 'demo-a',
    pins: {
      repo: 'onnx-community/open-jev-deberta-v3-large-ONNX',
      dtype: 'q4f16',
      device: 'webgpu',
      temperature: 1.05,
      templateVersion: 'prelabel-tmpl-v1',
      modelId: 'onnx-community/open-jev-deberta-v3-large-ONNX:q4f16',
      revision: REVISION,
      configSha: '2ec35432332ee6b5880509eefe44e6279fd9d3543f6ba96098119ffe0b0c2d5e',
      approxDownloadBytes: 350631305,
    },
    labels: ['Dining', 'Groceries', 'Shopping', 'Other'],
    labelSetVersion: 'cat-4-aaaaaaaaaaaa',
    marginCut: 0.3,
    maxRowsPerRun: 2000,
    approxDownloadBytes: 350631305,
    ...over,
  };
}

function review(id: number): ReviewQueueItem {
  return {
    review_id: id,
    transaction_id: id,
    suggested_category: 'Other',
    confidence: 0.5,
    suggested_at: '2026-01-01',
    date: '2026-01-0' + (id % 9 + 1),
    description: `SYNTH MERCHANT ${id}`,
    merchant_name: null,
    amount: -10 - id,
    current_category: null,
  };
}

function memStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface FakeWorker extends WorkerLike {
  posted: ToWorker[];
  /** Whether the Web Lock was held at the instant each message was posted. */
  heldAtPost: boolean[];
  terminated: boolean;
  emit(msg: FromWorker): void;
  crash(): void;
}

function harness(opts: { optedIn?: boolean; reloadThrows?: boolean; apiImpl?: (path: string, init?: RequestInit) => Promise<unknown> } = {}) {
  const workers: FakeWorker[] = [];
  // `gateHeld` is the synchronous truth about the controller's gate: true only between
  // an `ensure()` that was granted and the next `release()`. `held` (the lock manager's
  // count) drops a few microtasks AFTER release(), so on its own it cannot tell a
  // post made after release() from one made while the lock is genuinely held.
  const lock = { held: 0, requests: 0, otherHolds: false, gateHeld: false };
  const locks: LockManagerLike = {
    request(_name, _o, cb) {
      lock.requests++;
      if (lock.otherHolds) return Promise.resolve(cb(null));
      lock.held++;
      return Promise.resolve(cb({})).finally(() => {
        lock.held--;
      });
    },
  };
  const local = memStorage();
  const session = memStorage();
  if (opts.optedIn) local.setItem(`wilson-prelabel-optin:v1:${REVISION}`, '1');

  let serverConfig = config();
  let configFetches = 0;
  const timers: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = [];
  let reloads = 0;
  let visibleListener: (() => void) | null = null;
  const apiCalls: string[] = [];

  const deps: ControllerDeps = {
    api: (async (path: string, init?: RequestInit) => {
      apiCalls.push(`${init?.method ?? 'GET'} ${path}`);
      if (opts.apiImpl) return opts.apiImpl(path, init);
      if (path === '/api/prelabel/config') {
        configFetches++;
        return serverConfig;
      }
      throw new Error(`unexpected ${path}`);
    }) as ControllerDeps['api'],
    baseUrl: () => 'http://localhost:3141',
    createWorker: () => {
      const w: FakeWorker = {
        posted: [],
        heldAtPost: [],
        terminated: false,
        onmessage: null,
        onerror: null,
        postMessage(m: ToWorker) {
          this.posted.push(m);
          this.heldAtPost.push(lock.held > 0 && lock.gateHeld);
        },
        terminate() {
          this.terminated = true;
        },
        emit(msg: FromWorker) {
          this.onmessage?.({ data: msg });
        },
        crash() {
          this.onerror?.();
        },
      };
      workers.push(w);
      return w;
    },
    locks,
    lockGate: (lm) => {
      const real = createLockGate(lm);
      let releases = 0;
      return {
        async ensure() {
          const before = releases;
          const state = await real.ensure();
          // a release() issued while the request was in flight invalidates this grant
          if (state !== 'locked' && before === releases) lock.gateHeld = true;
          return state;
        },
        release() {
          releases++;
          lock.gateHeld = false;
          real.release();
        },
      };
    },
    storage: (kind) => (kind === 'local' ? local : session),
    now: () => 1_700_000_000_000,
    timers: {
      set(fn, ms) {
        const t = { fn, ms, cleared: false, fired: false };
        timers.push(t);
        return t;
      },
      clear(h) {
        (h as { cleared: boolean }).cleared = true;
      },
    },
    reload: () => {
      reloads++;
      if (opts.reloadThrows) throw new Error('reload blocked');
    },
    visibility: {
      isVisible: () => true,
      subscribe(fn) {
        visibleListener = fn;
        return () => {
          visibleListener = null;
        };
      },
    },
  };

  const controller = createPrelabelController(deps);
  const idleTimer = () => timers.filter((t) => !t.cleared && !t.fired).at(-1);
  return {
    controller,
    workers,
    lock,
    local,
    session,
    timers,
    apiCalls,
    get worker() {
      return workers[workers.length - 1]!;
    },
    get reloads() {
      return reloads;
    },
    get configFetches() {
      return configFetches;
    },
    setServerConfig(c: PrelabelConfig) {
      serverConfig = c;
    },
    fireIdle() {
      const t = idleTimer()!;
      t.fired = true;
      t.fn();
    },
    idleTimer,
    becomeVisible() {
      visibleListener?.();
    },
    state: () => controller.getSnapshot().state.kind,
  };
}

const capabilityReady: FromWorker = { v: 1, type: 'capability', verdict: 'ready', reason: null, adapter: null };
const loaded: FromWorker = {
  v: 1,
  type: 'loaded',
  loadMs: 1,
  fromCache: true,
  firstDecisionMs: 1,
  runtime: { transformers: '4.3.0', ort: '1', openJev: '0.1.2', device: 'webgpu', dtype: 'q4f16' },
  configSha: 'x',
};

/** Mount, consent, load: ends in `ready` with the lock held. */
async function toReady(h: ReturnType<typeof harness>, reviews: ReviewQueueItem[] = []) {
  h.controller.setReviews(reviews);
  h.controller.start();
  await flush();
  h.worker.emit(capabilityReady);
  if (h.state() === 'consent') {
    h.controller.consent();
    await flush();
  } else {
    await flush();
  }
  h.worker.emit(loaded);
  await flush();
}

describe('prelabel controller: Web Lock timing', () => {
  test('mount takes no lock: the probe runs, the consent panel shows, nothing is held', async () => {
    const h = harness();
    h.controller.start();
    await flush();
    expect(h.workers).toHaveLength(1);
    expect(h.worker.posted.map((m) => m.type)).toEqual(['init', 'probe']);
    h.worker.emit(capabilityReady);
    await flush();
    expect(h.state()).toBe('consent');
    expect(h.lock.requests).toBe(0);
    expect(h.lock.held).toBe(0);
    expect(h.worker.posted.some((m) => m.type === 'load')).toBe(false);
  });

  test('consent path: the lock is held at the instant "load" is posted', async () => {
    const h = harness();
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    h.controller.consent();
    await flush();
    const i = h.worker.posted.findIndex((m) => m.type === 'load');
    expect(i).toBeGreaterThan(-1);
    expect(h.worker.heldAtPost[i]).toBe(true);
    expect(h.lock.held).toBe(1);
    expect(h.state()).toBe('loading');
    expect(h.local.data.get(`wilson-prelabel-optin:v1:${REVISION}`)).toBe('1');
  });

  test('returning opted-in path: the lock is taken before "load", without a click', async () => {
    const h = harness({ optedIn: true });
    h.controller.start();
    await flush();
    expect(h.lock.requests).toBe(0); // the probe alone takes nothing
    h.worker.emit(capabilityReady);
    await flush();
    const i = h.worker.posted.findIndex((m) => m.type === 'load');
    expect(i).toBeGreaterThan(-1);
    expect(h.worker.heldAtPost[i]).toBe(true);
    expect(h.lock.held).toBe(1);
  });

  test('another tab holds the lock: state locked, no load, worker killed', async () => {
    const h = harness();
    h.lock.otherHolds = true;
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    h.controller.consent();
    await flush();
    expect(h.state()).toBe('locked');
    expect(h.worker.posted.some((m) => m.type === 'load')).toBe(false);
    expect(h.worker.terminated).toBe(true);
    expect(h.lock.held).toBe(0);
  });
});

describe('prelabel controller: the lock is released', () => {
  test('after the idle timeout (worker disposed and terminated)', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    expect(h.state()).toBe('ready');
    expect(h.lock.held).toBe(1);
    expect(h.idleTimer()).toBeDefined();
    h.fireIdle();
    await flush();
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
    expect(h.worker.posted.some((m) => m.type === 'dispose')).toBe(true);
  });

  test('after a fatal worker error, and the dead worker is not left holding the GPU', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    h.worker.emit({ v: 1, type: 'error', fatal: true, code: 'load', detail: 'boom' });
    await flush();
    expect(h.state()).toBe('failed');
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
  });

  test('after a worker crash that bypasses handleWorkerMessage (w.onerror)', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    expect(h.lock.held).toBe(1);
    h.worker.crash();
    await flush();
    expect(h.state()).toBe('failed');
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
  });

  test('a crash during load (before "loaded") releases too, and Retry can re-take it', async () => {
    const h = harness({ optedIn: true });
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    await flush();
    expect(h.lock.held).toBe(1);
    h.worker.crash();
    await flush();
    expect(h.state()).toBe('failed');
    expect(h.lock.held).toBe(0);

    h.controller.retry();
    await flush();
    expect(h.workers).toHaveLength(2);
    h.worker.emit(capabilityReady);
    await flush();
    expect(h.lock.held).toBe(1);
    expect(h.worker.heldAtPost[h.worker.posted.findIndex((m) => m.type === 'load')]).toBe(true);
  });

  test('a crash while probing (no lock held yet) is "unavailable" and takes no lock', async () => {
    const h = harness();
    h.controller.start();
    await flush();
    h.worker.crash();
    await flush();
    expect(h.state()).toBe('unavailable');
    expect(h.lock.requests).toBe(0);
  });

  test('a crash mid-run clears the run so a later run can start; a pending measure() resolves cancelled', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    const p = h.controller.measure([{ txnId: 1, description: 'SYNTH A', amount: -5, date: '2026-01-01' }]);
    await flush();
    expect(h.state()).toBe('running');
    h.worker.crash();
    const out = await p;
    expect(out).not.toBeNull();
    expect(out!.cancelled).toBe(true);
    await flush(); // the Web Lock releases on a promise turn
    expect(h.lock.held).toBe(0);
  });

  test('on profile_changed found by the auto-run (startRun)', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    expect(h.lock.held).toBe(1);
    h.setServerConfig(config({ profile: 'demo-b' }));
    h.controller.setReviews([review(1), review(2)]); // triggers the auto-run, which verifies the binding first
    await flush();
    await flush();
    expect(h.state()).toBe('profile_changed');
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
    expect(h.idleTimer()).toBeUndefined();
  });

  test('on profile_changed found by measure()', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    h.setServerConfig(config({ profile: 'demo-b' }));
    const out = await h.controller.measure([{ txnId: 1, description: 'SYNTH A', amount: -5, date: '2026-01-01' }]);
    expect(out).toBeNull();
    await flush();
    expect(h.state()).toBe('profile_changed');
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
  });

  test('on profile_changed found when the tab becomes visible', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    h.setServerConfig(config({ profile: 'demo-b' }));
    h.becomeVisible();
    await flush();
    await flush();
    expect(h.state()).toBe('profile_changed');
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
  });

  test('a visible tab with an unchanged profile keeps the lock', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    h.becomeVisible();
    await flush();
    await flush();
    expect(h.state()).toBe('ready');
    expect(h.lock.held).toBe(1);
  });

  test('on unmount (stop)', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    h.controller.stop();
    await flush();
    expect(h.lock.held).toBe(0);
    expect(h.worker.terminated).toBe(true);
  });
});

describe('prelabel controller: idle re-arm', () => {
  test('a finished run re-arms the idle timer; a started run clears it', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    const armedAtLoad = h.idleTimer();
    expect(armedAtLoad).toBeDefined();

    h.controller.setReviews([review(1)]);
    await flush();
    await flush();
    expect(h.state()).toBe('running');
    expect(h.idleTimer()).toBeUndefined(); // running: never idle out mid-run

    const run = h.worker.posted.find((m) => m.type === 'run') as Extract<ToWorker, { type: 'run' }>;
    h.worker.emit({ v: 1, type: 'done', runId: run.runId, n: 1, skipped: 0, cancelled: false, p50Ms: 1, p95Ms: 1, wallMs: 1 });
    await flush();
    expect(h.state()).toBe('ready');
    expect(h.idleTimer()).toBeDefined();
    expect(h.lock.held).toBe(1);
  });

  test('after idle, scoreUnscored re-spawns the worker and re-takes the lock before load', async () => {
    const h = harness({ optedIn: true });
    await toReady(h, [review(1)]);
    await flush();
    const run = h.worker.posted.find((m) => m.type === 'run') as Extract<ToWorker, { type: 'run' }>;
    h.worker.emit({ v: 1, type: 'done', runId: run.runId, n: 0, skipped: 1, cancelled: false, p50Ms: 1, p95Ms: 1, wallMs: 1 });
    await flush();
    h.fireIdle();
    await flush();
    expect(h.lock.held).toBe(0);
    h.controller.scoreUnscored();
    await flush();
    expect(h.workers).toHaveLength(2);
    h.worker.emit(capabilityReady);
    await flush();
    expect(h.lock.held).toBe(1);
    expect(h.worker.heldAtPost[h.worker.posted.findIndex((m) => m.type === 'load')]).toBe(true);
  });
});

describe('prelabel controller: turnOn', () => {
  test('resolves (never rejects) and sets turnOnError when the PUT fails; busy clears', async () => {
    const h = harness({
      apiImpl: async (path) => {
        if (path === '/api/prelabel/settings') throw new Error('API 403: {"error":{"code":"origin_required"}}');
        return config({ enabled: false });
      },
    });
    const p = h.controller.turnOn();
    expect(h.controller.getSnapshot().turnOnBusy).toBe(true);
    await expect(p).resolves.toBeUndefined();
    const snap = h.controller.getSnapshot();
    expect(snap.turnOnBusy).toBe(false);
    expect(snap.turnOnError).toBeTruthy();
    expect(h.reloads).toBe(0);
  });

  test('a network failure resolves too, with a plain-language error', async () => {
    const h = harness({
      apiImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(h.controller.turnOn()).resolves.toBeUndefined();
    expect(h.controller.getSnapshot().turnOnError).toMatch(/Could not reach/);
  });

  test('success reloads the page and leaves no error; a retry clears the old error first', async () => {
    let fail = true;
    const h = harness({
      apiImpl: async () => {
        if (fail) throw new Error('API 500: nope');
        return { enabled: true };
      },
    });
    await h.controller.turnOn();
    expect(h.controller.getSnapshot().turnOnError).toBeTruthy();
    fail = false;
    await h.controller.turnOn();
    expect(h.controller.getSnapshot().turnOnError).toBeNull();
    expect(h.reloads).toBe(1);
  });

  test('a throwing reload() still does not reject', async () => {
    const h = harness({ reloadThrows: true, apiImpl: async () => ({ enabled: true }) });
    await expect(h.controller.turnOn()).resolves.toBeUndefined();
    expect(h.reloads).toBe(1);
  });
});

describe('prelabel controller: snapshot', () => {
  test('subscribe notifies on change and getSnapshot is referentially stable between changes', async () => {
    const h = harness();
    let calls = 0;
    const unsub = h.controller.subscribe(() => calls++);
    const a = h.controller.getSnapshot();
    expect(h.controller.getSnapshot()).toBe(a);
    h.controller.start();
    await flush();
    expect(calls).toBeGreaterThan(0);
    expect(h.controller.getSnapshot()).not.toBe(a);
    unsub();
  });

  test('start/stop/start (React StrictMode) spawns exactly one worker', async () => {
    const h = harness();
    h.controller.start();
    h.controller.stop();
    h.controller.start();
    await flush();
    expect(h.workers).toHaveLength(1);
    expect(h.worker.terminated).toBe(false);
  });

  test('a disabled config leaves the panel off and spawns nothing', async () => {
    const h = harness({ apiImpl: async () => config({ enabled: false }) });
    h.controller.start();
    await flush();
    expect(h.state()).toBe('off');
    expect(h.workers).toHaveLength(0);
    expect(h.lock.requests).toBe(0);
  });
});

describe('prelabel controller: round-3 races', () => {
  const item = { txnId: 1, description: 'SYNTH A', amount: -5, date: '2026-01-01' };

  /** A harness whose config fetch can be held open once the model is ready. */
  function gatedHarness() {
    let hold: Promise<void> | null = null;
    const h = harness({
      optedIn: true,
      apiImpl: async (path) => {
        if (path === '/api/prelabel/config') {
          if (hold) await hold;
          return config();
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    return {
      h,
      holdConfig() {
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        return () => {
          hold = null;
          release();
        };
      },
    };
  }

  test('measure(): an idle-timer kill during verifyBinding does not leave the panel stuck running', async () => {
    const { h, holdConfig } = gatedHarness();
    await toReady(h);
    const release = holdConfig();
    const p = h.controller.measure([item]);
    await flush();
    h.fireIdle(); // worker disposed + terminated while measure() awaits the binding check
    expect(h.worker.terminated).toBe(true);
    release();
    await flush();
    await flush();
    // Must not be stuck: the panel is not 'running' and nothing was posted to a dead worker.
    expect(h.state()).not.toBe('running');
    const out = await Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 50))]);
    expect(out).toBeNull();
    expect(h.worker.posted.some((m) => m.type === 'run')).toBe(false);
    expect(h.idleTimer()).toBeUndefined();
  });
  test('stop() settles a pending measure() as cancelled and clears the run', async () => {
    const h = harness({ optedIn: true });
    await toReady(h);
    const p = h.controller.measure([item]);
    await flush();
    expect(h.state()).toBe('running');
    h.controller.stop();
    const out = await Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 50))]);
    expect(out).not.toBe('hung');
    expect((out as { cancelled: boolean }).cancelled).toBe(true);
    // a remount can measure again (activeRun was cleared)
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    await flush();
    h.worker.emit(loaded);
    await flush();
    const p2 = h.controller.measure([item]);
    await flush();
    expect(h.worker.posted.some((m) => m.type === 'run')).toBe(true);
    void p2;
  });
  test('consent -> stop -> start in one tick never posts "load" to the new worker without a lock', async () => {
    const h = harness();
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    await flush();
    expect(h.state()).toBe('consent');
    h.controller.consent();
    h.controller.stop();
    h.controller.start();
    await flush();
    await flush();
    for (const w of h.workers) {
      w.posted.forEach((m, i) => {
        if (m.type === 'load') expect(w.heldAtPost[i]).toBe(true);
      });
    }
    // the stale consent must not have taken effect or leaked a lock
    expect(h.workers.flatMap((w) => w.posted).some((m) => m.type === 'load')).toBe(false);
    expect(h.lock.held).toBe(0);
    expect(h.local.data.get(`wilson-prelabel-optin:v1:${REVISION}`)).toBeUndefined();
  });
});

describe('prelabel controller: round-4 stale-mount races', () => {
  const item = { txnId: 1, description: 'SYNTH A', amount: -5, date: '2026-01-01' };

  /**
   * A harness whose NEXT config fetch is held open and answered by the test. Every
   * other fetch answers immediately, so a remounted controller behaves normally
   * while the old mount's binding check is still in flight.
   */
  function heldBindingHarness() {
    let holdNext = false;
    let answer!: (cfg: PrelabelConfig) => void;
    const h = harness({
      optedIn: true,
      apiImpl: async (path) => {
        if (path !== '/api/prelabel/config') throw new Error(`unexpected ${path}`);
        if (holdNext) {
          holdNext = false;
          return new Promise<PrelabelConfig>((r) => (answer = r));
        }
        return config();
      },
    });
    return {
      h,
      /** The next binding check hangs until `answerHeld` is called. */
      holdNextBindingCheck() {
        holdNext = true;
      },
      answerHeld(cfg: PrelabelConfig) {
        answer(cfg);
      },
    };
  }

  /** Remount and drive the new mount to `ready` (opted in: capability -> loaded). */
  async function remountToReady(h: ReturnType<typeof harness>) {
    h.controller.stop();
    h.controller.start();
    await flush();
    h.worker.emit(capabilityReady);
    await flush();
    h.worker.emit(loaded);
    await flush();
  }

  const otherProfile = () => config({ profile: 'demo-b' });
  const runPosts = (h: ReturnType<typeof harness>) => h.worker.posted.filter((m) => m.type === 'run');

  test('startRun(): a stale "changed" binding check does not tear down the remounted controller', async () => {
    const { h, holdNextBindingCheck, answerHeld } = heldBindingHarness();
    await toReady(h);
    holdNextBindingCheck();
    h.controller.setReviews([review(1)]); // auto-run -> startRun() -> verifyBinding() hangs
    await flush();
    await remountToReady(h);
    const fresh = h.worker;
    answerHeld(otherProfile()); // the OLD mount learns the profile changed
    await flush();
    await flush();
    expect(h.state()).not.toBe('profile_changed');
    expect(fresh.terminated).toBe(false);
    expect(h.lock.held).toBe(1);
  });

  test('startRun(): a stale call neither blocks the remount\'s auto-run nor posts a second run', async () => {
    const { h, holdNextBindingCheck, answerHeld } = heldBindingHarness();
    await toReady(h);
    holdNextBindingCheck();
    h.controller.setReviews([review(1)]);
    await flush();
    await remountToReady(h);
    // the remounted controller scores the pending row even though the old startRun() never returned
    expect(runPosts(h)).toHaveLength(1);
    answerHeld(config()); // the old binding check now says "ok"
    await flush();
    await flush();
    expect(runPosts(h)).toHaveLength(1);
  });

  test('measure(): a stale "changed" binding check does not tear down the remounted controller', async () => {
    const { h, holdNextBindingCheck, answerHeld } = heldBindingHarness();
    await toReady(h);
    holdNextBindingCheck();
    const p = h.controller.measure([item]); // hangs in verifyBinding()
    await flush();
    await remountToReady(h);
    const fresh = h.worker;
    answerHeld(otherProfile());
    const out = await Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 50))]);
    expect(out).toBeNull();
    expect(h.state()).toBe('ready');
    expect(fresh.terminated).toBe(false);
    expect(h.lock.held).toBe(1);
  });

  test('visibility handler: a stale "changed" binding check does not tear down the remounted controller', async () => {
    const { h, holdNextBindingCheck, answerHeld } = heldBindingHarness();
    await toReady(h);
    holdNextBindingCheck();
    h.becomeVisible(); // OLD mount's handler -> verifyBinding() hangs
    await flush();
    await remountToReady(h);
    const fresh = h.worker;
    answerHeld(otherProfile());
    await flush();
    await flush();
    expect(h.state()).toBe('ready');
    expect(fresh.terminated).toBe(false);
    expect(h.lock.held).toBe(1);
  });

  test('a "changed" binding check on the CURRENT mount still abandons the model', async () => {
    const { h, holdNextBindingCheck, answerHeld } = heldBindingHarness();
    await toReady(h);
    holdNextBindingCheck();
    h.becomeVisible();
    await flush();
    answerHeld(otherProfile());
    await flush();
    await flush();
    expect(h.state()).toBe('profile_changed');
    expect(h.worker.terminated).toBe(true);
    expect(h.lock.held).toBe(0);
  });
});
