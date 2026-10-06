/**
 * open-jev pre-labeler: the worker / Web Lock / idle / profile wiring, with no
 * React and no browser global (specs/open-jev-labeler.md §4.4, §5, §10).
 *
 * `usePrelabel.ts` is a thin `useSyncExternalStore` binding over this. It exists
 * so the wiring can be tested with a fake worker, fake lock manager, fake fetch
 * and fake timers (the repo has no DOM and no React renderer under bun test).
 *
 * Lock rule: the Web Lock is taken only when the model is about to load (the
 * user consents, or a returning opted-in visit) and given back whenever the
 * model is no longer, or cannot be, in memory: idle, fatal error, worker crash,
 * profile change, unmount.
 */
import type { PrelabelConfig, ReviewQueueItem } from '../types.js';
import { parseFromWorker, type FromWorker, type PrelabelItem, type PrelabelResult, type ToWorker } from './protocol.js';
import {
  acceptResults,
  createLockGate,
  createPrelabelSession,
  describeTurnOnError,
  initialPanelState,
  persistVerdict,
  readPersistedVerdict,
  reducePanel,
  workerPins,
  type KeyValueStorage,
  type LockGate,
  type LockManagerLike,
  type PanelEvent,
  type PanelState,
  type PrelabelSession,
  type RunBinding,
} from './session.js';

/** Terminate the worker (and free the GPU) after this long without a run. */
export const IDLE_MS = 5 * 60 * 1000;
/** Rows scored per run (one /api/reviews page). */
export const RUN_LIMIT = 200;

export const optInKey = (revision: string) => `wilson-prelabel-optin:v1:${revision}`;

/** What a measurement run (S6) hands back: validated rows plus the worker's latency summary. */
export interface MeasureOutcome {
  rows: PrelabelResult[];
  p50Ms: number;
  p95Ms: number;
  cancelled: boolean;
}

/** The slice of `Worker` the controller uses. */
export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface ControllerDeps {
  /** `api()` from api.ts: JSON in, JSON out, throws on a non-2xx. */
  api<T>(path: string, init?: RequestInit): Promise<T>;
  baseUrl(): string;
  /** `new Worker(url, { type: 'module' })`; may throw (SecurityError, unsupported). */
  createWorker(url: string): WorkerLike;
  locks: LockManagerLike | undefined;
  /** `sessionStorage` / `localStorage`, or null when blocked. */
  storage(kind: 'session' | 'local'): KeyValueStorage | null;
  now(): number;
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  reload(): void;
  visibility: { isVisible(): boolean; subscribe(fn: () => void): () => void };
  idleMs?: number;
  /** Test seam: build the lock gate (defaults to `createLockGate`). Lets a test observe `release()` synchronously. */
  lockGate?(locks: LockManagerLike | undefined): LockGate;
}

export interface PrelabelSnapshot {
  state: PanelState;
  config: PrelabelConfig | null;
  /** Scores by transaction id (this tab, this profile, this label set). */
  results: Map<number, PrelabelResult>;
  /** Pending rows with no score yet. */
  unscoredCount: number;
  marginCut: number;
  /** Median decision time of the last finished run, ms. */
  p50Ms: number | null;
  turnOnError: string | null;
  turnOnBusy: boolean;
}

export interface PrelabelController {
  /** Mount: fetch config, then spawn the capability-probe worker. Takes no lock. */
  start(): void;
  /** Unmount: kill the worker and release the lock. */
  stop(): void;
  getSnapshot(): PrelabelSnapshot;
  subscribe(fn: () => void): () => void;
  /** The review rows on screen (called whenever they change). */
  setReviews(rows: readonly ReviewQueueItem[]): void;
  /** Click handler of the consent panel: take the lock, download once, then load. */
  consent(): void;
  cancel(): void;
  /** Score the pending rows that have no score (re-spawns the worker if it idled out). */
  scoreUnscored(): void;
  retry(): void;
  /** Admin: flip `prelabelEnabled` on, then reload. Never rejects: a failure sets `turnOnError`. */
  turnOn(): Promise<void>;
  /** Score arbitrary items without touching the pending-row scores. Null when not ready or busy. */
  measure(items: PrelabelItem[]): Promise<MeasureOutcome | null>;
}

export function createPrelabelController(deps: ControllerDeps): PrelabelController {
  const idleMs = deps.idleMs ?? IDLE_MS;

  let state: PanelState = initialPanelState;
  let config: PrelabelConfig | null = null;
  let results = new Map<number, PrelabelResult>();
  let p50Ms: number | null = null;
  let bound = false;
  let turnOnError: string | null = null;
  let turnOnBusy = false;
  let reviews: readonly ReviewQueueItem[] = [];

  let session: PrelabelSession | null = null;
  let worker: WorkerLike | null = null;
  let gate: LockGate | null = null;
  let consenting = false;
  let activeRun: string | null = null;
  /** Rows already handed to a run: never auto-retried (a manual rescore clears it). */
  const attempted = new Set<number>();
  let starting = false;
  let measureRun: { binding: RunBinding; rows: PrelabelResult[]; resolve(o: MeasureOutcome): void } | null = null;
  let idle: unknown = null;
  let stopped = false;
  /** Bumped by start(); a stale async mount (React StrictMode remount) bails out. */
  let generation = 0;
  let unsubVisible: (() => void) | null = null;

  const listeners = new Set<() => void>();
  let snapshot: PrelabelSnapshot | null = null;

  const unscoredCount = () => reviews.reduce((n, r) => n + (results.has(r.transaction_id) ? 0 : 1), 0);

  function buildSnapshot(): PrelabelSnapshot {
    return {
      state,
      config,
      results,
      unscoredCount: unscoredCount(),
      marginCut: config?.marginCut ?? 0.3,
      p50Ms,
      turnOnError,
      turnOnBusy,
    };
  }

  function emit() {
    snapshot = null;
    for (const fn of [...listeners]) fn();
  }

  function dispatch(ev: PanelEvent) {
    const next = reducePanel(state, ev);
    if (next === state) return;
    state = next;
    emit();
    maybeAutoRun();
  }

  const storage = (kind: 'session' | 'local'): KeyValueStorage | null => {
    try {
      return deps.storage(kind);
    } catch {
      return null;
    }
  };

  function isOptedIn(revision: string): boolean {
    try {
      return storage('local')?.getItem(optInKey(revision)) === '1';
    } catch {
      return false;
    }
  }

  function setOptIn(revision: string) {
    try {
      storage('local')?.setItem(optInKey(revision), '1');
    } catch {
      /* blocked storage: consent is asked again next visit */
    }
  }

  const post = (msg: ToWorker) => worker?.postMessage(msg);

  function clearIdle() {
    if (idle !== null) deps.timers.clear(idle);
    idle = null;
  }

  function armIdle() {
    clearIdle();
    idle = deps.timers.set(() => {
      idle = null;
      // Free the ~350 MB GPU session; scoreUnscored() re-spawns on demand.
      worker?.postMessage({ v: 1, type: 'dispose' } satisfies ToWorker);
      worker?.terminate();
      worker = null;
      // Nothing is running now: let another tab load the model.
      gate?.release();
    }, idleMs);
  }

  function killWorker() {
    clearIdle();
    const w = worker;
    worker = null;
    if (w) {
      try {
        w.postMessage({ v: 1, type: 'dispose' } satisfies ToWorker);
      } catch {
        /* already gone */
      }
      w.terminate();
    }
  }

  /**
   * The model is gone or unusable (crash, fatal error, profile change): stop the
   * worker, end any run so a later one can start (a pending measure() resolves as
   * cancelled rather than hanging), and give the Web Lock back so another tab can
   * load the model.
   */
  function abandonModel() {
    killWorker();
    activeRun = null;
    session?.cancel();
    const m = measureRun;
    if (m) {
      measureRun = null;
      m.resolve({ rows: m.rows, p50Ms: 0, p95Ms: 0, cancelled: true });
    }
    gate?.release();
  }

  /**
   * Take the lock, then run `onGranted` and tell the worker to load. Another tab
   * holding it means that tab is genuinely loading or running the model.
   */
  async function loadWithLock(onGranted?: () => void): Promise<boolean> {
    const g = gate;
    const gen = generation;
    const got = g ? await g.ensure() : 'unsupported';
    // A stop() -> start() inside the await leaves `stopped` false again, so also
    // compare the generation: this call belongs to a mount that no longer exists
    // and must not post "load" to its successor's worker without a lock.
    if (stopped || gen !== generation) {
      g?.release();
      return false;
    }
    if (got === 'locked') {
      dispatch({ t: 'locked' });
      killWorker();
      return false;
    }
    onGranted?.();
    post({ v: 1, type: 'load' });
    return true;
  }

  function handleWorkerMessage(msg: FromWorker) {
    const cfg = config;
    if (!session || !cfg) return;

    const m = measureRun;
    if (m && (msg.type === 'results' || msg.type === 'done') && msg.runId === m.binding.runId) {
      if (msg.type === 'results') {
        m.rows.push(...acceptResults(m.binding, msg).accepted);
        dispatch({ t: 'run_progress', done: m.rows.length });
      } else {
        measureRun = null;
        activeRun = null;
        dispatch({ t: 'run_ended' });
        armIdle();
        m.resolve({ rows: m.rows, p50Ms: msg.p50Ms, p95Ms: msg.p95Ms, cancelled: msg.cancelled });
      }
      return;
    }

    if (msg.type === 'capability') {
      if (msg.verdict !== 'ready' && msg.reason) {
        persistVerdict(storage('session'), cfg.pins, { verdict: msg.verdict, reason: msg.reason });
      }
      const optedIn = isOptedIn(cfg.pins.revision);
      if (msg.verdict === 'ready' && optedIn && state.kind === 'probing') {
        // Returning, already-consented visit: the lock comes right before the load.
        void loadWithLock(() => dispatch({ t: 'worker', msg, optedIn }));
        return;
      }
      dispatch({ t: 'worker', msg, optedIn });
      return;
    }
    if (msg.type === 'results') {
      session.accept(msg);
      results = session.results();
      dispatch({ t: 'run_progress', done: results.size });
      emit();
      return;
    }
    if (msg.type === 'done') {
      if (!session.acceptDone(msg)) return; // stale run
      activeRun = null;
      p50Ms = msg.p50Ms || null;
      dispatch({ t: 'run_ended' });
      armIdle();
      emit();
      return;
    }
    if (msg.type === 'error' && msg.fatal && msg.code !== 'locked') {
      persistVerdict(storage('session'), cfg.pins, { verdict: 'failed', reason: msg.code });
    }
    if (msg.type === 'error' && msg.fatal) abandonModel();
    if (msg.type === 'loaded') armIdle();
    dispatch({ t: 'worker', msg, optedIn: isOptedIn(cfg.pins.revision) });
  }

  function spawnWorker(): boolean {
    const cfg = config;
    if (!cfg) return false;
    killWorker();
    let w: WorkerLike;
    try {
      w = deps.createWorker(`${deps.baseUrl()}/assets/prelabel-worker.js`);
    } catch (err) {
      const reason = err instanceof Error && err.name === 'SecurityError' ? 'dev_cross_origin' : 'worker_unavailable';
      dispatch({ t: 'spawn_failed', reason });
      return false;
    }
    w.onmessage = (ev) => {
      const msg = parseFromWorker(ev.data);
      if (msg) handleWorkerMessage(msg);
    };
    w.onerror = () => {
      // A 404 for the worker script is the normal "hybrid build not present" state.
      // This path bypasses handleWorkerMessage, so it must give the lock back itself.
      abandonModel();
      if (state.kind === 'probing') dispatch({ t: 'spawn_failed', reason: 'worker_unavailable' });
      else dispatch({ t: 'worker', msg: { v: 1, type: 'error', fatal: true, code: 'load', detail: 'worker crashed' }, optedIn: true });
    };
    worker = w;
    w.postMessage({
      v: 1,
      type: 'init',
      pins: workerPins(cfg.pins),
      labels: cfg.labels,
      labelSetVersion: cfg.labelSetVersion,
      assetBase: `${deps.baseUrl()}/assets/`,
    } satisfies ToWorker);
    w.postMessage({ v: 1, type: 'probe' } satisfies ToWorker);
    return true;
  }

  async function startRun(rows: readonly ReviewQueueItem[]) {
    if (!session || starting || activeRun) return;
    starting = true;
    const gen = generation;
    const s = session;
    try {
      // Another tab or the CLI can switch the server's active profile (§5).
      const binding = await s.verifyBinding();
      // The check awaited: a stop() -> start() may have replaced this mount. Its
      // answer belongs to the old session and must not touch the new one.
      if (stopped || gen !== generation) return;
      if (binding === 'changed') {
        dispatch({ t: 'profile_changed' });
        abandonModel();
        return;
      }
      if (state.kind !== 'ready' || !worker) return;
      const plan = s.planRun(rows, { limit: RUN_LIMIT });
      results = s.results(); // cache hits
      emit();
      for (const r of rows) attempted.add(r.transaction_id);
      if (!plan) return;
      activeRun = plan.runId;
      clearIdle();
      dispatch({ t: 'run_started', total: plan.items.length });
      post({ v: 1, type: 'run', runId: plan.runId, items: plan.items });
    } finally {
      // start() already reset the flag for the new mount; a stale call must not clear its successor's.
      if (gen === generation) starting = false;
    }
  }

  /** Auto-run once the model is ready, on rows nobody has handed to a run yet. */
  function maybeAutoRun() {
    if (stopped || state.kind !== 'ready' || !worker) return;
    const fresh = reviews.filter((r) => !attempted.has(r.transaction_id));
    if (fresh.length > 0) void startRun(fresh);
  }

  function applyCacheNow() {
    if (!bound || !session || session.profileChanged()) return;
    session.applyCache(reviews);
    results = session.results();
    emit();
  }

  function start() {
    stopped = false;
    const gen = ++generation;
    bound = false;
    activeRun = null;
    starting = false;
    attempted.clear();
    const s = createPrelabelSession({
      storage: () => storage('session'),
      fetchConfig: () => deps.api<PrelabelConfig>('/api/prelabel/config'),
      now: deps.now,
    });
    session = s;
    gate = (deps.lockGate ?? createLockGate)(deps.locks);

    (async () => {
      let cfg: PrelabelConfig;
      try {
        cfg = await deps.api<PrelabelConfig>('/api/prelabel/config');
      } catch {
        if (!stopped && gen === generation) dispatch({ t: 'config', enabled: false });
        return;
      }
      if (stopped || gen !== generation) return;
      config = cfg;
      emit();
      dispatch({ t: 'config', enabled: cfg.enabled });
      if (!cfg.enabled) return;
      s.bind(cfg);
      bound = true;
      applyCacheNow();

      const persisted = readPersistedVerdict(storage('session'), cfg.pins);
      if (persisted) {
        dispatch({ t: 'spawn_failed', reason: persisted.reason });
        return;
      }
      // No lock yet: the capability probe loads nothing. The lock is taken when
      // the user consents (consent()) or a returning opted-in visit starts the load.
      spawnWorker();
    })();

    unsubVisible = deps.visibility.subscribe(() => {
      if (!deps.visibility.isVisible() || !session) return;
      void session.verifyBinding().then((r) => {
        // A stop() -> start() leaves `stopped` false again: compare the generation.
        if (r === 'changed' && !stopped && gen === generation) {
          dispatch({ t: 'profile_changed' });
          abandonModel();
        }
      });
    });
  }

  function stop() {
    stopped = true;
    unsubVisible?.();
    unsubVisible = null;
    killWorker();
    // Settle a pending measure() like abandonModel()/cancel() do, so its caller is not left hanging.
    activeRun = null;
    const m = measureRun;
    if (m) {
      measureRun = null;
      m.resolve({ rows: m.rows, p50Ms: 0, p95Ms: 0, cancelled: true });
    }
    gate?.release();
    gate = null;
  }

  function consent() {
    const cfg = config;
    if (!cfg || state.kind !== 'consent' || consenting) return;
    consenting = true;
    void loadWithLock(() => {
      setOptIn(cfg.pins.revision);
      dispatch({ t: 'consent' });
    }).finally(() => {
      consenting = false;
    });
  }

  function cancel() {
    const runId = activeRun;
    if (!runId) return;
    post({ v: 1, type: 'cancel', runId });
    session?.cancel();
    const m = measureRun;
    if (m) {
      measureRun = null;
      m.resolve({ rows: m.rows, p50Ms: 0, p95Ms: 0, cancelled: true });
    }
    activeRun = null;
    dispatch({ t: 'run_ended' });
    armIdle();
  }

  function scoreUnscored() {
    if (!session || state.kind !== 'ready') return;
    const rows = reviews.filter((r) => !session!.results().has(r.transaction_id));
    for (const r of rows) attempted.delete(r.transaction_id);
    if (!worker) {
      // Idled out: re-spawn; the auto-run scores once the model is back.
      dispatch({ t: 'config', enabled: true });
      spawnWorker();
      return;
    }
    void startRun(rows);
  }

  function retry() {
    if (state.kind !== 'failed') return;
    dispatch({ t: 'retry' });
    spawnWorker();
  }

  async function turnOn(): Promise<void> {
    turnOnError = null;
    turnOnBusy = true;
    emit();
    try {
      await deps.api('/api/prelabel/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
      deps.reload();
    } catch (err) {
      // e.g. 403 origin_required when the page is not served from the dashboard's own origin.
      turnOnError = describeTurnOnError(err);
      turnOnBusy = false;
      emit();
    }
  }

  async function measure(items: PrelabelItem[]): Promise<MeasureOutcome | null> {
    const cfg = config;
    if (!cfg || !session || items.length === 0 || state.kind !== 'ready' || !worker) return null;
    if (activeRun || starting) return null;
    const gen = generation;
    const binding = await session.verifyBinding();
    // The check awaited: stop() -> start(), the idle timer, a crash or another run
    // may have changed the world. A stale mount's answer must not touch its
    // successor, and a run must never start on a dead worker (the panel would stay
    // 'running' with nothing to end it).
    if (stopped || gen !== generation) return null;
    if (binding === 'changed') {
      dispatch({ t: 'profile_changed' });
      abandonModel();
      return null;
    }
    if (state.kind !== 'ready' || !worker || activeRun || starting) return null;
    const runId = `measure-${deps.now()}`;
    const capped = items.slice(0, cfg.maxRowsPerRun);
    return new Promise<MeasureOutcome>((resolve) => {
      measureRun = {
        binding: { runId, txnIds: new Set(capped.map((i) => i.txnId)), labels: new Set(cfg.labels) },
        rows: [],
        resolve,
      };
      activeRun = runId;
      clearIdle();
      dispatch({ t: 'run_started', total: capped.length });
      post({ v: 1, type: 'run', runId, items: capped });
    });
  }

  return {
    start,
    stop,
    getSnapshot() {
      return (snapshot ??= buildSnapshot());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    setReviews(rows) {
      if (rows === reviews) return;
      reviews = rows;
      applyCacheNow(); // emits when bound
      if (!bound) emit();
      maybeAutoRun();
    },
    consent,
    cancel,
    scoreUnscored,
    retry,
    turnOn,
    measure,
  };
}
