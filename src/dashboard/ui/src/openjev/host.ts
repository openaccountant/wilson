/**
 * The open-jev host: ONE worker, ONE Web Lock gate, ONE opt-in key and ONE idle policy per
 * tab, shared by the Review tab's pre-labeler and the chat's read-tool router (Round 4,
 * specs/browser-subagent-round4-openjev-router.md §4.1, §4.4; DECISIONS "Round 4").
 *
 * What the chat side may do here is deliberately small. `choose()`:
 *  - never asks for consent and never starts a download: without the user's earlier
 *    "Download once" opt-in (the pre-labeler's key, for the pinned revision) it returns
 *    null and does nothing at all (no worker, no probe, no lock);
 *  - never waits for a load: a session that is not loaded returns null at once, and if
 *    the user opted in, a load FROM THE CACHE starts in the background so later turns
 *    can use it;
 *  - never waits for or steals the `wilson-prelabel` lock: it is taken (ifAvailable)
 *    only when a load is about to start, and another tab holding it means null;
 *  - never waits longer than OPEN_JEV_CHAT_TIMEOUT_MS for a decision.
 * Every failure resolves null (the caller hands off to the server). Nothing throws.
 *
 * Reference counting: the model is disposed, the worker ended and the lock released only
 * when no client holds the host. The pre-labeler holds it through an explicit lease
 * (released by its own idle/unmount/profile-change paths); chat holds it implicitly while
 * it was used in the last OPENJEV_IDLE_MS.
 *
 * Pure apart from injected dependencies (worker factory, locks, storage, timers), so bun
 * tests drive it with fakes. Imports no DOM, worker, network or model-runtime API. The
 * identifier for the model library is deliberately never spelled out here: this module
 * ships in the singlefile React bundle, which the build guard scans for it.
 */
import { OPEN_JEV_CHAT_TIMEOUT_MS } from '../hybrid/openjev-route.js';
import { parseFromWorker, type FromWorker, type PrelabelPins, type ToWorker } from '../prelabel/protocol.js';
import { createLockGate, type KeyValueStorage, type LockGate, type LockManagerLike } from '../prelabel/session.js';

/** Terminate the worker (and free the GPU) after this long without a user. */
export const OPENJEV_IDLE_MS = 5 * 60 * 1000;

/** The Review tab's "Download once" consent key, per pinned revision. Shared on purpose: one consent. */
export const optInKey = (revision: string) => `wilson-prelabel-optin:v1:${revision}`;

/** The slice of `Worker` the host uses. */
export interface HostWorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface OpenJevHostDeps {
  /** `new Worker(url, { type: 'module' })`; may throw (SecurityError in dev cross-origin, unsupported). */
  createWorker(url: string): HostWorkerLike;
  baseUrl(): string;
  locks: LockManagerLike | undefined;
  /** `localStorage`, or null when blocked. May throw. */
  storage(): KeyValueStorage | null;
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  idleMs?: number;
}

export type HostClient = 'prelabel' | 'chat';

export interface ChooseRequest {
  /** The text being classified (the user's question), at most 512 characters. */
  state: string;
  question: string;
  /** 2 to 8 names. */
  options: string[];
  /** Optional per-option description, rendered by the model as `name: description`. */
  descriptions?: Record<string, string>;
}

export interface ChooseOutcome {
  choice: string;
  p1: number;
  p2: number;
  /** p1 - p2, recomputed here, never trusted from the worker. */
  margin: number;
  top2: [[string, number], [string, number]];
  ms: number;
}

export interface ChooseOptions {
  timeoutMs?: number;
  signal?: { readonly aborted: boolean; addEventListener(type: 'abort', fn: () => void, opts?: { once?: boolean }): void; removeEventListener?(type: 'abort', fn: () => void): void };
}

export interface HostLease {
  /** Post a message to the shared worker. False when the lease is released or no worker is alive. */
  post(msg: ToWorker): boolean;
  /** Idempotent. The last holder to release frees the model and the lock. */
  release(): void;
}

export type HostVerdict = 'unknown' | 'ready' | 'unavailable' | 'failed';

export interface HostSnapshot {
  verdict: HostVerdict;
  workerAlive: boolean;
  loaded: boolean;
  loading: boolean;
  holders: HostClient[];
  /** Why the worker could not be created, if it could not. */
  spawnError: 'dev_cross_origin' | 'worker_unavailable' | null;
}

export interface OpenJevHost {
  /** The server's pins (null = the feature is off or unreachable). A different revision drops any loaded model. */
  configure(pins: PrelabelPins | null): void;
  /** True when the user already clicked "Download once" for the pinned revision. Read from storage every call. */
  optedIn(): boolean;
  /** Persist the Review tab's consent click (the key chat reads). */
  grantConsent(): void;
  /** The pre-labeler's door: spawn (init without labels + capability probe; takes no lock, loads nothing) and listen. */
  acquire(client: HostClient, onMessage?: (msg: FromWorker) => void): HostLease;
  /** The shared Web Lock gate: the pre-labeler calls this at consent time, right before it posts `load`. */
  ensureLock(): Promise<'held' | 'locked' | 'unsupported'>;
  /** The chat's door. Resolves null on every "no", never throws. */
  choose(req: ChooseRequest, opts?: ChooseOptions): Promise<ChooseOutcome | null>;
  snapshot(): HostSnapshot;
  /** Unmount/test teardown: end everything. */
  shutdown(): void;
}

const WORKER_PATH = '/assets/prelabel-worker.js';

interface Pending {
  options: readonly string[];
  settle(value: ChooseOutcome | null): void;
}

export function createOpenJevHost(deps: OpenJevHostDeps): OpenJevHost {
  const idleMs = deps.idleMs ?? OPENJEV_IDLE_MS;

  let pins: PrelabelPins | null = null;
  let worker: HostWorkerLike | null = null;
  let verdict: HostVerdict = 'unknown';
  let spawnError: HostSnapshot['spawnError'] = null;
  let loaded = false;
  let loading = false;
  /** Bumped by every teardown so an in-flight lock request or load knows it is stale. */
  let generation = 0;
  let chatActive = false;
  let idle: unknown = null;
  let seq = 0;

  const gate: LockGate = createLockGate(deps.locks);
  const leases = new Set<{ client: HostClient; onMessage?: (msg: FromWorker) => void; post: HostLease['post'] }>();
  const pending = new Map<string, Pending>();

  const storage = (): KeyValueStorage | null => {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  };

  function optedIn(): boolean {
    if (!pins) return false;
    try {
      return storage()?.getItem(optInKey(pins.revision)) === '1';
    } catch {
      return false;
    }
  }

  const holderCount = () => leases.size + (chatActive ? 1 : 0);
  const wantsLoad = () => chatActive && optedIn();

  function clearIdle() {
    if (idle !== null) deps.timers.clear(idle);
    idle = null;
  }

  function postRaw(msg: ToWorker): boolean {
    if (!worker) return false;
    try {
      worker.postMessage(msg);
      return true;
    } catch {
      return false;
    }
  }

  /** End the worker (disposing the model first if `dispose`), settle waiters, give the lock back. */
  function teardown(dispose: boolean) {
    generation++;
    clearIdle();
    chatActive = false;
    const w = worker;
    worker = null;
    loaded = false;
    loading = false;
    for (const p of [...pending.values()]) p.settle(null);
    if (w) {
      if (dispose) {
        try {
          w.postMessage({ v: 1, type: 'dispose' });
        } catch {
          /* already gone */
        }
      }
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
    }
    gate.release();
  }

  function fanOut(msg: FromWorker) {
    for (const l of [...leases]) {
      try {
        l.onMessage?.(msg);
      } catch {
        /* a client bug must not break the host */
      }
    }
  }

  function validChosen(msg: Extract<FromWorker, { type: 'chosen'; ok: true }>, options: readonly string[]): ChooseOutcome | null {
    const { choice, p1, p2, margin, top2, ms } = msg;
    const prob = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
    if (!options.includes(choice) || top2[0][0] !== choice) return null;
    if (!prob(p1) || !prob(p2) || p2 > p1 || !Number.isFinite(margin) || Math.abs(margin - (p1 - p2)) > 1e-6) return null;
    if (!Number.isFinite(ms)) return null;
    return { choice, p1, p2, margin: p1 - p2, top2, ms };
  }

  async function loadWithLock(): Promise<void> {
    if (loading || loaded || !worker || verdict !== 'ready') return;
    loading = true;
    const gen = generation;
    const got = await gate.ensure();
    if (gen !== generation) return; // torn down meanwhile; the gate already dropped the lock
    if (got === 'locked') {
      // Another tab has the model. Never wait, never steal: this turn and the next ones hand off.
      loading = false;
      return;
    }
    if (!postRaw({ v: 1, type: 'load' })) loading = false;
  }

  function onWorkerMessage(raw: unknown) {
    const msg = parseFromWorker(raw);
    if (!msg) return;
    if (msg.type === 'chosen') {
      const p = pending.get(msg.reqId);
      if (!p) return; // late (timed out) or unknown: ignored
      p.settle(msg.ok ? validChosen(msg, p.options) : null);
      return;
    }
    if (msg.type === 'capability') {
      verdict = msg.verdict;
      fanOut(msg);
      if (msg.verdict === 'ready') {
        if (wantsLoad()) void loadWithLock();
      } else if (!loaded && !loading && ![...leases].some((l) => l.client === 'prelabel')) {
        // Nothing can run here: free the worker (no model to dispose).
        teardown(false);
      }
      return;
    }
    if (msg.type === 'loaded') {
      loaded = true;
      loading = false;
      fanOut(msg);
      return;
    }
    if (msg.type === 'error' && msg.fatal && msg.code !== 'locked') {
      verdict = 'failed';
      fanOut(msg);
      teardown(false);
      return;
    }
    fanOut(msg);
  }

  function onWorkerError() {
    verdict = 'failed';
    fanOut({ v: 1, type: 'error', fatal: true, code: 'load', detail: 'worker crashed' });
    teardown(false);
  }

  /** Create the worker, send the chat-only init, then the capability probe. False when it cannot exist. */
  function spawn(): boolean {
    if (worker) return true;
    if (!pins) return false;
    let w: HostWorkerLike;
    try {
      w = deps.createWorker(`${deps.baseUrl()}${WORKER_PATH}`);
    } catch (err) {
      spawnError = err instanceof Error && err.name === 'SecurityError' ? 'dev_cross_origin' : 'worker_unavailable';
      verdict = 'unavailable';
      return false;
    }
    spawnError = null;
    w.onmessage = (ev) => onWorkerMessage(ev.data);
    w.onerror = () => onWorkerError();
    worker = w;
    const base = deps.baseUrl();
    // No `labels` key: a chat-only host never opened the Review tab. The pre-labeler posts its own init.
    postRaw({ v: 1, type: 'init', pins, labelSetVersion: '', assetBase: `${base}/assets/` });
    postRaw({ v: 1, type: 'probe' });
    return true;
  }

  function touchChat() {
    chatActive = true;
    clearIdle();
    idle = deps.timers.set(() => {
      idle = null;
      chatActive = false;
      if (holderCount() === 0) teardown(true);
    }, idleMs);
  }

  function ask(req: ChooseRequest, opts: ChooseOptions | undefined): Promise<ChooseOutcome | null> {
    const reqId = `c${++seq}`;
    return new Promise<ChooseOutcome | null>((resolve) => {
      let timer: unknown = null;
      const onAbort = () => settle(null);
      function settle(value: ChooseOutcome | null) {
        if (!pending.delete(reqId)) return;
        if (timer !== null) deps.timers.clear(timer);
        opts?.signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      }
      pending.set(reqId, { options: req.options, settle });
      timer = deps.timers.set(() => settle(null), opts?.timeoutMs ?? OPEN_JEV_CHAT_TIMEOUT_MS);
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      const msg: ToWorker = {
        v: 1, type: 'choose', reqId, state: req.state, question: req.question, options: [...req.options],
        ...(req.descriptions ? { descriptions: { ...req.descriptions } } : {}),
      };
      if (!postRaw(msg)) settle(null);
    });
  }

  async function choose(req: ChooseRequest, opts?: ChooseOptions): Promise<ChooseOutcome | null> {
    try {
      if (!pins || !optedIn()) return null;
      if (verdict === 'unavailable' || verdict === 'failed') return null;
      if (opts?.signal?.aborted) return null;
      // Mark chat active BEFORE spawning: the capability reply decides whether to load.
      const wasActive = chatActive;
      chatActive = true;
      if (!worker && !spawn()) {
        chatActive = wasActive;
        return null;
      }
      touchChat();
      // Not loaded: this turn goes to the server; warm the model from the cache for the next ones.
      if (!loaded) {
        if (verdict === 'ready' && !loading) void loadWithLock();
        return null;
      }
      return await ask(req, opts);
    } catch {
      return null;
    }
  }

  function acquire(client: HostClient, onMessage?: (msg: FromWorker) => void): HostLease {
    let released = false;
    const lease = {
      client,
      onMessage,
      post: (msg: ToWorker) => !released && postRaw(msg),
    };
    leases.add(lease);
    spawn();
    return {
      post: lease.post,
      release() {
        if (released) return;
        released = true;
        leases.delete(lease);
        if (holderCount() === 0) teardown(true);
      },
    };
  }

  return {
    configure(next) {
      const changed = (next?.revision ?? null) !== (pins?.revision ?? null);
      pins = next;
      if (changed) {
        verdict = 'unknown';
        spawnError = null;
        if (worker) teardown(true);
        else gate.release();
      }
    },
    optedIn,
    grantConsent() {
      if (!pins) return;
      try {
        storage()?.setItem(optInKey(pins.revision), '1');
      } catch {
        /* blocked storage: consent is asked again next visit */
      }
    },
    acquire,
    ensureLock: () => gate.ensure(),
    choose,
    snapshot: () => ({
      verdict,
      workerAlive: worker !== null,
      loaded,
      loading,
      holders: [...[...leases].map((l) => l.client), ...(chatActive ? (['chat'] as const) : [])],
      spawnError,
    }),
    shutdown() {
      leases.clear();
      chatActive = false;
      teardown(true);
    },
  };
}
