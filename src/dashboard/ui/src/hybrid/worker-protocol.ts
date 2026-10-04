/**
 * Main thread <-> model worker protocol (browser-subagent spec section 4.1).
 *
 * Pure: no Worker, no DOM, no transformers.js. Imported by the hybrid client
 * (main thread) and by model.worker.ts, and unit tested under bun
 * (src/__tests__/hybrid-worker-protocol.test.ts).
 *
 * The model worker owns the transformers.js import, the ORT/WebGPU session
 * and every generation. The main thread keeps everything authed (config and
 * bundle fetches, the /api/chat/local record) and persists the capability
 * verdict; the worker never holds a token.
 */

import type { LoadPhase } from './capability.js';
import type { HandoffReason, LocalVerdict } from './core.js';
import type { HandoffReadToolName, LocalHandoffV1 } from '../../../../dashboard/local-handoff-format.js';

export const HYBRID_PROTOCOL_VERSION = 1;

/** Model choice, from GET /api/config/local-chat. */
export interface WorkerModelConfig {
  repo: string;
  displayName: string;
  /** Catalog-pinned ONNX dtype (e.g. 'q4f16'); null means resolve from the Hub file list. */
  catalogDtype: string | null;
}

/** Speed Showdown single-row categorization (callbacks cannot cross postMessage). */
export interface WorkerCategorizeOpts {
  systemPrompt: string;
  userPrompt: string;
}

export type MainToWorker =
  /** origin = window.location.origin (absolute: a blob worker has no usable relative base). */
  | { t: 'init'; v: typeof HYBRID_PROTOCOL_VERSION; origin: string; model: WorkerModelConfig }
  | { t: 'probe'; id: number }
  | { t: 'load'; id: number }
  | { t: 'bundleAnswer'; id: number; runId: number; query: string; bundleText: string; today: string }
  | { t: 'categorize'; id: number; opts: WorkerCategorizeOpts }
  /**
   * One subagent turn. `port` is a MessagePort (transferred, never cloned): the
   * scoped mirror tool port for THIS run, bound to `expectedProfile` on the
   * mirror side. It is the worker's only data access.
   */
  | ({ t: 'subagentRun'; id: number; runId: number; port: unknown } & SubagentRunInput)
  | { t: 'cancel'; runId: number };

export type WorkerErrorPhase = LoadPhase | 'generate' | 'protocol' | 'cancelled';

export interface WorkerError {
  phase: WorkerErrorPhase;
  /** TransformersDtypeError code when phase === 'resolve'. */
  code?: string;
  message: string;
  /** The dtype in play when the failure happened, for the human-readable description. */
  dtype?: string | null;
}

export type WorkerToMain =
  /** `id` ties a progress label to the request that caused it (load, categorize). */
  | { t: 'progress'; id?: number; runId?: number; label: string }
  /** A live subagent chip (tool names and counts only; never rows). */
  | { t: 'step'; id: number; runId: number; event: StepEvent }
  | { t: 'result'; id: number; ok: true; result: unknown }
  | { t: 'result'; id: number; ok: false; error: WorkerError };

// Results by request:
//   probe        -> 'ready' | 'unavailable'
//   load         -> LoadResult
//   bundleAnswer -> LocalVerdict
//   categorize   -> CategorizeResult
export type ProbeResult = 'ready' | 'unavailable';
export interface LoadResult {
  loadMs: number;
  /** True iff this call initiated the model load. */
  loadFresh: boolean;
  dtype: string | null;
}
export interface CategorizeResult {
  raw: string;
  decisionMs: number;
}
export type BundleAnswerResult = LocalVerdict;

// ── Subagent run types (specs/browser-subagent.md section 4.1) ─────────

/** A turn answered on-device earlier in this session; rides in the handoff (capped). */
export interface PriorLocalTurn {
  q: string;
  a: string;
}

/**
 * How the local answer is written (specs/DECISIONS.md "Round 3"). 'template' (default): deterministic
 * per-tool templates, no model call. 'model': the on-device model composes it, kept for comparison.
 */
export type ComposeMode = 'template' | 'model';

export interface SubagentLimits {
  /** Tool executions; default 3, hard max 4. */
  maxSteps: number;
  /** Router / next-action generations are capped at this many new tokens (12). */
  routerMaxNewTokens: number;
  /** Compose generation cap (256). */
  composeMaxNewTokens: number;
  /** Per mirror toolRead (3_000). */
  stepTimeoutMs: number;
  /** Whole loop, measured from the start of the run (model already ready) (30_000). */
  runDeadlineMs: number;
  /** Answer writer: 'template' (default) or 'model'. */
  compose: ComposeMode;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxSteps: 3,
  routerMaxNewTokens: 12,
  composeMaxNewTokens: 256,
  stepTimeoutMs: 3_000,
  runDeadlineMs: 30_000,
  compose: 'template',
};

export const SUBAGENT_MAX_STEPS_HARD = 4;

/** Live UI chips. Never contains rows. */
export type StepEvent =
  | { kind: 'gate'; verdict: 'route' | 'mutation-intent' | 'non-data' }
  /**
   * Round 4: `via: 'openjev'` when the open-jev tiebreak picked the tool (or, with tool 'none', when its hint
   * was rejected; `why` says why). `margin` and `cut` ride along for the UI and the eval record, never the wire.
   */
  | { kind: 'route'; tool: HandoffReadToolName | 'none'; via: RouteVia; margin?: number; cut?: number; why?: string }
  | { kind: 'tool'; tool: HandoffReadToolName; ms: number; ok: boolean; rows?: number; args: Record<string, unknown> }
  | { kind: 'compose' };

export type RouteVia = 'keyword' | 'llm' | 'openjev';

/**
 * Round 4 (specs/browser-subagent-round4-openjev-router.md §4.3): the main thread's open-jev pick for a
 * question with 0 or 2+ keyword hits. Advisory only: the core re-checks every field against its own
 * keyword hits and the frozen cut, and hands off as router-none when any check fails.
 */
export interface RouteHint {
  tool: string;
  /** p1 - p2 of the open-jev decision. */
  margin: number;
  /** The cut the main thread applied; must equal the frozen OPEN_JEV_ROUTE_CUT. */
  cut: number;
  /** The keyword hits the main thread saw. */
  hits: string[];
}

/** What a finished tool step leaves behind (no row data: that stays in the worker). */
export interface ToolStepRecord {
  tool: HandoffReadToolName;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  rows?: number;
  summary: string;
}

export type SubagentHandoffReason = Exclude<HandoffReason, 'cancelled'>;

export type SubagentOutcome =
  | { kind: 'answer'; text: string; steps: ToolStepRecord[] }
  | { kind: 'handoff'; reason: SubagentHandoffReason; handoff: LocalHandoffV1 }
  /** The mirror port is unusable or unseeded: run today's bundle mode instead (not a handoff). */
  | { kind: 'bundle-fallback' }
  /** Cancelled by the user or a newer run: nothing is sent anywhere. */
  | { kind: 'cancelled' };

/** The run's inputs, minus the transport fields (id, runId, port). */
export interface SubagentRunInput {
  query: string;
  /** ISO clock for period math, taken on the main thread. */
  nowIso: string;
  /** The server's active profile, fetched by the main thread for this run. */
  expectedProfile: string;
  priorLocalTurns: PriorLocalTurn[];
  limits: SubagentLimits;
  /** Round 4: the open-jev tiebreak's pick, only for 0 / 2+ keyword hits. Absent = round 3. */
  routeHint?: RouteHint;
}

/** Caller-facing arguments for ModelBackend.subagentRun. */
export interface SubagentRunArgs extends SubagentRunInput {
  /** The scoped mirror tool port. Transferred to the worker. */
  port: SubagentPortHandle;
}

/** Structural handle on a MessagePort (the client only ever closes it). */
export interface SubagentPortHandle {
  close(): void;
}

/** subagentRun's result. `deviceFault`: a generation threw, so the GPU session may be poisoned and the worker should be respawned. */
export interface SubagentRunResult {
  outcome: SubagentOutcome;
  deviceFault: boolean;
}

/**
 * What the app's main thread hands the hybrid chunk after preparing the mirror
 * for a run (freshness, bounded sync wait, profile binding: spec C4/C7/C8).
 */
export type MirrorPrep =
  | { kind: 'ready'; port: SubagentPortHandle; expectedProfile: string; lastSyncedAt: string | null }
  /** No usable mirror (unavailable, unseeded, server unreachable): run bundle mode. */
  | { kind: 'unavailable' }
  /** The mirror is old or holds another profile and could not be refreshed in time: hand off. */
  | { kind: 'stale'; lastSyncedAt: string | null };

/** Clamp the config knob into the loop's bounds; every other bound stays at its default. */
export function clampSubagentLimits(cfg: { maxSteps?: number; compose?: string } | undefined): SubagentLimits {
  const n = cfg?.maxSteps;
  const maxSteps =
    typeof n === 'number' && Number.isFinite(n)
      ? Math.min(SUBAGENT_MAX_STEPS_HARD, Math.max(1, Math.floor(n)))
      : DEFAULT_SUBAGENT_LIMITS.maxSteps;
  return { ...DEFAULT_SUBAGENT_LIMITS, maxSteps, compose: cfg?.compose === 'model' ? 'model' : 'template' };
}

// ── Guards ───────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isModelConfig(x: unknown): x is WorkerModelConfig {
  return (
    isRecord(x) &&
    isStr(x.repo) &&
    x.repo.length > 0 &&
    isStr(x.displayName) &&
    (x.catalogDtype === null || isStr(x.catalogDtype))
  );
}

export function isMainToWorker(x: unknown): x is MainToWorker {
  if (!isRecord(x)) return false;
  switch (x.t) {
    case 'init':
      return x.v === HYBRID_PROTOCOL_VERSION && isStr(x.origin) && isModelConfig(x.model);
    case 'probe':
    case 'load':
      return isNum(x.id);
    case 'bundleAnswer':
      return isNum(x.id) && isNum(x.runId) && isStr(x.query) && isStr(x.bundleText) && isStr(x.today);
    case 'categorize':
      return isNum(x.id) && isRecord(x.opts) && isStr(x.opts.systemPrompt) && isStr(x.opts.userPrompt);
    case 'subagentRun':
      return (
        isNum(x.id) &&
        isNum(x.runId) &&
        isStr(x.query) &&
        isStr(x.nowIso) &&
        isStr(x.expectedProfile) &&
        isPriorTurns(x.priorLocalTurns) &&
        isLimits(x.limits) &&
        isRecord(x.port) &&
        (x.routeHint === undefined || isRouteHint(x.routeHint))
      );
    case 'cancel':
      return isNum(x.runId);
    default:
      return false;
  }
}

function isPriorTurns(x: unknown): x is PriorLocalTurn[] {
  return Array.isArray(x) && x.every((t) => isRecord(t) && isStr(t.q) && isStr(t.a));
}

const ROUTE_HINT_KEYS: ReadonlySet<string> = new Set(['tool', 'margin', 'cut', 'hits']);

/** Strict: exactly the four fields, finite numbers, no extra keys. */
export function isRouteHint(x: unknown): x is RouteHint {
  return (
    isRecord(x) &&
    !Array.isArray(x) &&
    Object.keys(x).every((k) => ROUTE_HINT_KEYS.has(k)) &&
    isStr(x.tool) &&
    isNum(x.margin) &&
    isNum(x.cut) &&
    Array.isArray(x.hits) &&
    x.hits.every(isStr)
  );
}

const ROUTE_VIA: ReadonlySet<string> = new Set(['keyword', 'llm', 'openjev']);

function isStepEvent(x: unknown): boolean {
  if (!isRecord(x) || !isStr(x.kind)) return false;
  if (x.kind !== 'route') return true;
  return (
    isStr(x.tool) &&
    isStr(x.via) &&
    ROUTE_VIA.has(x.via) &&
    (x.margin === undefined || isNum(x.margin)) &&
    (x.cut === undefined || isNum(x.cut)) &&
    (x.why === undefined || isStr(x.why))
  );
}

function isLimits(x: unknown): x is SubagentLimits {
  return (
    isRecord(x) &&
    isNum(x.maxSteps) &&
    isNum(x.routerMaxNewTokens) &&
    isNum(x.composeMaxNewTokens) &&
    isNum(x.stepTimeoutMs) &&
    isNum(x.runDeadlineMs) &&
    (x.compose === undefined || x.compose === 'template' || x.compose === 'model')
  );
}

const ERROR_PHASES: ReadonlySet<string> = new Set(['resolve', 'load', 'warmup', 'generate', 'protocol', 'cancelled']);

function isWorkerError(x: unknown): x is WorkerError {
  return isRecord(x) && isStr(x.phase) && ERROR_PHASES.has(x.phase) && isStr(x.message);
}

export function isWorkerToMain(x: unknown): x is WorkerToMain {
  if (!isRecord(x)) return false;
  if (x.t === 'progress') return isStr(x.label);
  if (x.t === 'step') return isNum(x.id) && isNum(x.runId) && isStepEvent(x.event);
  if (x.t === 'result') {
    if (!isNum(x.id)) return false;
    if (x.ok === true) return 'result' in x;
    if (x.ok === false) return isWorkerError(x.error);
  }
  return false;
}

// ── runId supersession (same contract as the net-worth forecast worker) ──

/** A request starts only if it is strictly newer than the active run; late/duplicate posts are dropped. */
export function shouldStart(runId: number, activeRunId: number): boolean {
  return runId > activeRunId;
}

/** An in-flight run aborts at its next check once a newer run (or a cancel) owns the slot. */
export function shouldAbort(myRunId: number, activeRunId: number): boolean {
  return myRunId !== activeRunId;
}

// ── Origin guard ─────────────────────────────────────────────────────────

/**
 * A model worker must run on the page's origin. A `data:` URL worker has an
 * opaque origin ('null'): it cannot use the Cache API (the ~570 MB weights
 * would be re-fetched on every load) and its /assets/ort fetches become
 * cross-origin. On any mismatch the worker answers 'unavailable' and loads
 * nothing.
 */
export function checkWorkerOrigin(
  selfOrigin: string | undefined,
  initOrigin: string,
): { ok: true } | { ok: false; reason: string } {
  if (!selfOrigin || selfOrigin === 'null') {
    return { ok: false, reason: 'worker has an opaque origin (data: URL fallback)' };
  }
  if (!initOrigin || initOrigin === 'null') return { ok: false, reason: 'page origin is opaque or missing' };
  if (selfOrigin !== initOrigin) {
    return { ok: false, reason: `worker origin ${selfOrigin} does not match page origin ${initOrigin}` };
  }
  return { ok: true };
}

// ── Error mapping ────────────────────────────────────────────────────────

/**
 * Rebuild a throwable the shared classifiers understand from a WorkerError.
 * classifyLoadFailure / describeLoadFailure are structural on
 * TransformersDtypeError (by name and code), so a pseudo-instance round-trips
 * the class identity that cannot cross postMessage.
 */
export function workerErrorToCause(err: WorkerError): Error {
  const cause = new Error(err.message);
  if (err.code) {
    cause.name = 'TransformersDtypeError';
    (cause as Error & { code?: string }).code = err.code;
  }
  return cause;
}

// ── Pending-call table ───────────────────────────────────────────────────

export type Settlement<T> = { ok: true; value: T } | { ok: false; error: WorkerError };

export interface PendingTable<T> {
  /** Register a call; the promise settles via settle()/rejectAll(). Rejects with a WorkerError. */
  add(): { id: number; promise: Promise<T> };
  /** Settle one call. Returns false for an unknown or already-settled id. */
  settle(id: number, outcome: Settlement<T>): boolean;
  /** A crash or timeout: fail everything in flight. Ids keep increasing afterwards. */
  rejectAll(error: WorkerError): void;
  readonly size: number;
}

export function createPendingTable<T>(): PendingTable<T> {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: T) => void; reject: (e: WorkerError) => void }>();
  return {
    add() {
      const id = nextId++;
      const promise = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      return { id, promise };
    },
    settle(id, outcome) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      if (outcome.ok) entry.resolve(outcome.value);
      else entry.reject(outcome.error);
      return true;
    },
    rejectAll(error) {
      const entries = [...pending.values()];
      pending.clear();
      for (const e of entries) e.reject(error);
    },
    get size() {
      return pending.size;
    },
  };
}
