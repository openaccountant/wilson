/**
 * Where the local model runs, as seen by the hybrid client.
 *
 * `ModelBackend` is the client's only view of the model. Production uses
 * createWorkerBackend: a main-thread RPC proxy to the model Web Worker
 * (model.worker.ts). createInThreadBackend runs the same engine in the
 * calling thread; it exists for tests that inject a fake transformers module.
 *
 * Pure of DOM and of transformers.js: the Worker constructor is injected
 * (WorkerLike), so the proxy's crash/timeout/respawn behaviour is unit tested
 * under bun with a fake worker (src/__tests__/hybrid-worker-backend.test.ts).
 *
 * Every method rejects with a WorkerError (never a bare Error), so the client
 * classifies failures the same way for both backends.
 */

import { toWorkerError, type ModelEngine, type ProgressCb } from './model-engine.js';
import { runSubagentOnPort } from './subagent-runner.js';
import type { PortLike } from '../store/mirror-port-protocol.js';
import {
  HYBRID_PROTOCOL_VERSION,
  createPendingTable,
  isWorkerToMain,
  type BundleAnswerResult,
  type CategorizeResult,
  type LoadResult,
  type MainToWorker,
  type ProbeResult,
  type StepEvent,
  type SubagentRunArgs,
  type SubagentRunResult,
  type WorkerCategorizeOpts,
  type WorkerError,
  type WorkerModelConfig,
} from './worker-protocol.js';

export interface ModelBackend {
  /** Idempotent. Tells the backend which model to run; a changed repo drops the loaded one. */
  setModel(cfg: WorkerModelConfig): void;
  probe(): Promise<ProbeResult>;
  /** Load (or reuse) the model. `loadFresh` says whether this call initiated the load. */
  load(onProgress?: ProgressCb): Promise<LoadResult>;
  bundleAnswer(query: string, bundleText: string, today: string): Promise<BundleAnswerResult>;
  categorize(opts: WorkerCategorizeOpts): Promise<CategorizeResult>;
  /**
   * One subagent turn over the scoped mirror port in `args.port` (transferred to
   * the worker). Resolves the run result; rejects with a WorkerError only when
   * the worker itself failed (crash, timeout). Aborting `signal` cancels the run.
   */
  subagentRun(args: SubagentRunArgs, onStep?: (event: StepEvent) => void, signal?: AbortSignal): Promise<SubagentRunResult>;
  /** Stop everything: terminate the worker and fail whatever is in flight. */
  dispose(): void;
}

/** The slice of a Web Worker the proxy uses. */
export interface WorkerLike {
  /** `transfer` carries the MessagePort of a subagent run (transferred, not cloned). */
  postMessage(message: unknown, transfer?: unknown[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Coerce a rejection into a WorkerError, whichever backend raised it. */
export function asWorkerError(thrown: unknown): WorkerError {
  const t = thrown as Partial<WorkerError> | null;
  if (t && typeof t === 'object' && typeof t.phase === 'string' && typeof t.message === 'string') {
    return t as WorkerError;
  }
  return toWorkerError(thrown);
}

// ── In-thread backend (tests) ────────────────────────────────────────────

export function createInThreadBackend(engine: ModelEngine, origin: string): ModelBackend {
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw toWorkerError(err);
    }
  };
  return {
    setModel: (cfg) => engine.setModel(cfg, origin),
    probe: () => engine.probe(),
    load: (onProgress) => guard(() => engine.load(onProgress)),
    bundleAnswer: (query, bundleText, today) => guard(() => engine.bundleAnswer(query, bundleText, today)),
    categorize: (opts) => guard(() => engine.categorize(opts)),
    subagentRun: (args, onStep, signal) =>
      guard(() =>
        runSubagentOnPort({
          port: args.port as unknown as PortLike,
          generate: (req) =>
            engine.generate({ system: req.system, user: req.user, maxNewTokens: req.maxNewTokens, signal: req.signal ?? signal }),
          input: {
            query: args.query,
            nowIso: args.nowIso,
            expectedProfile: args.expectedProfile,
            priorLocalTurns: args.priorLocalTurns,
            limits: args.limits,
          },
          signal,
          emit: onStep,
        }),
      ),
    dispose: () => {},
  };
}

// ── Worker backend (production) ──────────────────────────────────────────

export type RpcKind = 'probe' | 'load' | 'bundleAnswer' | 'categorize' | 'subagentRun';

/**
 * Per-call time budgets. For `load` the clock restarts on every progress
 * message, so only a stalled download (not a slow one) times out.
 */
export const DEFAULT_RPC_TIMEOUT_MS: Record<RpcKind, number> = {
  probe: 30_000,
  load: 120_000,
  bundleAnswer: 120_000,
  categorize: 120_000,
  // The run's own deadline is 30 s (measured from model-ready); this is the
  // backstop for a worker that stops answering, with headroom over it.
  subagentRun: 45_000,
};

export interface WorkerBackendOpts {
  createWorker: () => WorkerLike;
  /** window.location.origin: absolute, because a blob worker has no usable relative base. */
  origin: string;
  timeoutMs?: Partial<Record<RpcKind, number>>;
}

export function createWorkerBackend(opts: WorkerBackendOpts): ModelBackend {
  const timeouts = { ...DEFAULT_RPC_TIMEOUT_MS, ...opts.timeoutMs };
  const table = createPendingTable<unknown>();
  const progressCbs = new Map<number, ProgressCb>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const budgets = new Map<number, number>();
  const stepCbs = new Map<number, (event: StepEvent) => void>();

  let worker: WorkerLike | null = null;
  let model: WorkerModelConfig | null = null;
  let runCounter = 0;

  function clearCall(id: number): void {
    const t = timers.get(id);
    if (t !== undefined) clearTimeout(t);
    timers.delete(id);
    budgets.delete(id);
    progressCbs.delete(id);
    stepCbs.delete(id);
  }

  function armTimer(id: number): void {
    const prev = timers.get(id);
    if (prev !== undefined) clearTimeout(prev);
    const ms = budgets.get(id);
    if (ms === undefined) return;
    timers.set(
      id,
      setTimeout(() => crash('model worker timed out'), ms),
    );
  }

  /** Reject everything in flight and drop the worker; the next call lazily respawns it. */
  function crash(message: string): void {
    const dead = worker;
    worker = null;
    for (const id of [...timers.keys()]) clearCall(id);
    progressCbs.clear();
    stepCbs.clear();
    table.rejectAll({ phase: 'protocol', message });
    try {
      dead?.terminate();
    } catch {
      // already gone
    }
  }

  function sendInit(w: WorkerLike): void {
    if (!model) return;
    const init: MainToWorker = { t: 'init', v: HYBRID_PROTOCOL_VERSION, origin: opts.origin, model };
    w.postMessage(init);
  }

  /** Throws if the Worker constructor does (CSP, enterprise policy). */
  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const w = opts.createWorker();
    w.onmessage = (event) => {
      const msg = event.data;
      if (!isWorkerToMain(msg)) return;
      if (msg.t === 'step') {
        stepCbs.get(msg.id)?.(msg.event);
        return;
      }
      if (msg.t === 'progress') {
        if (msg.id !== undefined) {
          progressCbs.get(msg.id)?.(msg.label);
          if (budgets.has(msg.id)) armTimer(msg.id);
        }
        return;
      }
      const outcome = msg.ok ? ({ ok: true, value: msg.result } as const) : ({ ok: false, error: msg.error } as const);
      const known = table.settle(msg.id, outcome);
      if (known) clearCall(msg.id);
    };
    w.onerror = () => crash('model worker crashed');
    worker = w;
    sendInit(w);
    return w;
  }

  function call<T>(
    kind: RpcKind,
    build: (id: number) => MainToWorker,
    onProgress?: ProgressCb,
    extra?: { transfer?: unknown[]; onStep?: (event: StepEvent) => void },
  ): Promise<T> {
    let w: WorkerLike;
    try {
      if (!model) throw new Error('no model configured');
      w = ensureWorker();
    } catch (err) {
      return Promise.reject({
        phase: 'protocol',
        message: `model worker unavailable: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies WorkerError);
    }
    const { id, promise } = table.add();
    if (onProgress) progressCbs.set(id, onProgress);
    if (extra?.onStep) stepCbs.set(id, extra.onStep);
    budgets.set(id, timeouts[kind]);
    armTimer(id);
    try {
      if (extra?.transfer) w.postMessage(build(id), extra.transfer);
      else w.postMessage(build(id));
    } catch (err) {
      crash(`model worker postMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return promise as Promise<T>;
  }

  return {
    setModel(cfg) {
      const changed = !model || model.repo !== cfg.repo || model.catalogDtype !== cfg.catalogDtype;
      model = cfg;
      if (changed && worker) sendInit(worker);
    },

    async probe() {
      // A worker that cannot even be constructed means no local model here.
      if (!model) return 'unavailable';
      try {
        ensureWorker();
      } catch {
        return 'unavailable';
      }
      return call<ProbeResult>('probe', (id) => ({ t: 'probe', id }));
    },

    load: (onProgress) => call<LoadResult>('load', (id) => ({ t: 'load', id }), onProgress),

    bundleAnswer(query, bundleText, today) {
      const runId = ++runCounter;
      return call<BundleAnswerResult>('bundleAnswer', (id) => ({ t: 'bundleAnswer', id, runId, query, bundleText, today }));
    },

    categorize: (cats) => call<CategorizeResult>('categorize', (id) => ({ t: 'categorize', id, opts: cats })),

    async subagentRun(args, onStep, signal) {
      const runId = ++runCounter;
      const { port, ...input } = args;
      const onAbort = () => {
        try {
          worker?.postMessage({ t: 'cancel', runId } satisfies MainToWorker);
        } catch {
          // a dead worker has nothing left to cancel
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await call<SubagentRunResult>(
          'subagentRun',
          (id) => ({ t: 'subagentRun', id, runId, port, ...input }),
          undefined,
          { transfer: [port], onStep },
        );
        if (result.deviceFault) {
          // A failed OrtRun can poison the GPU session; the next call respawns a clean worker
          // (the weights come back from the Cache API).
          crash('model worker restarted after a generation failure');
        }
        return result;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    dispose() {
      crash('model worker disposed');
    },
  };
}
