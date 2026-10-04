/**
 * open-jev pre-labeler: main-thread session logic, pure and bun-tested
 * (specs/open-jev-labeler.md §5, §7, §10.3, §4.3, §4.4).
 *
 * Everything with a rule in it lives here so `usePrelabel.ts` stays a thin
 * React/Worker binding:
 *  - the sessionStorage score cache, keyed by {profile, label set, model, pin,
 *    template} with a per-row FNV-1a hash of the exact state string;
 *  - `acceptResults`, which drops anything the worker was not asked about;
 *  - profile binding (another tab can switch the server's active profile);
 *  - the Web Lock that lets one tab at a time load the model;
 *  - persisted capability verdicts;
 *  - the panel state machine.
 *
 * No DOM, worker, network or storage global is touched: storage, config
 * fetching, locks and the clock are injected. Storage that throws is treated as
 * absent (the rows are simply re-scored).
 */
import { cacheKey, formatState } from './core.js';
import type { FromWorker, PrelabelItem, PrelabelPins, PrelabelResult } from './protocol.js';
import type { PrelabelConfig } from '../types.js';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

// ── Hash ────────────────────────────────────────────────────────────────────

/** 32-bit FNV-1a over UTF-16 code units; unsigned. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ── Result acceptance (§5, critic) ──────────────────────────────────────────

export interface RunBinding {
  runId: string;
  /** Transactions this run asked the worker to score. */
  txnIds: ReadonlySet<number>;
  /** The label set the run was started with. */
  labels: ReadonlySet<string>;
}

const isProb = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * Validate one ok:true row against a label set; returns it with `margin`
 * normalised to p1 - p2, or null. Does not check run membership.
 */
function validateOk(r: Extract<PrelabelResult, { ok: true }>, labels: ReadonlySet<string>): PrelabelResult | null {
  const [[l1, q1], [l2, q2]] = r.top2;
  if (!labels.has(r.choice) || r.choice !== l1 || !labels.has(l2)) return null;
  if (!isProb(r.p1) || !isProb(r.p2) || !isProb(q1) || !isProb(q2) || r.p2 > r.p1) return null;
  if (!Number.isFinite(r.ms) || !Number.isFinite(r.stateTokens)) return null;
  return { ...r, margin: r.p1 - r.p2 };
}

/**
 * Pure. Which rows of a `results` message may attach to the current run.
 * Drops: a stale runId; a txnId the run never asked about; a choice or top2
 * label outside the run's label set; non-finite or out-of-[0,1] probabilities;
 * p2 > p1. A worker left over from a cancelled run can never score rows it was
 * not asked about. `margin` is recomputed, never trusted.
 */
export function acceptResults(
  run: RunBinding | null,
  msg: Extract<FromWorker, { type: 'results' }>,
): { accepted: PrelabelResult[]; dropped: number } {
  if (!run || msg.runId !== run.runId) return { accepted: [], dropped: msg.rows.length };
  const accepted: PrelabelResult[] = [];
  let dropped = 0;
  for (const row of msg.rows) {
    if (!run.txnIds.has(row.txnId)) {
      dropped++;
      continue;
    }
    if (!row.ok) {
      accepted.push(row);
      continue;
    }
    const v = validateOk(row, run.labels);
    if (v) accepted.push(v);
    else dropped++;
  }
  return { accepted, dropped };
}

// ── Session ─────────────────────────────────────────────────────────────────

/** The fields of a /api/reviews row the session reads. */
export interface ReviewRowLike {
  transaction_id: number;
  description: string;
  amount: number;
  date: string;
}

export interface RunPlan {
  runId: string;
  items: PrelabelItem[];
}

export interface PrelabelSessionDeps {
  /** Lazily evaluated: `sessionStorage` itself can throw on access. */
  storage(): KeyValueStorage | null | undefined;
  /** GET /api/prelabel/config. */
  fetchConfig(): Promise<PrelabelConfig>;
  now(): number;
  newRunId?(): string;
}

export type BindingCheck = 'ok' | 'changed' | 'error';

/** Entries kept in the cache before the oldest are evicted. */
const CACHE_MAX_ROWS = 4000;

interface CacheRow {
  h: number;
  r: PrelabelResult;
}

export interface PrelabelSession {
  /** Start (or restart) a session for the config the server just returned. Clears results and run. */
  bind(config: PrelabelConfig): void;
  /**
   * Pick the rows to score, in display order, skipping rows already scored this
   * session and rows whose cached score still matches their state. Cache hits are
   * applied to `results()` immediately. Supersedes any earlier run. Null when
   * there is nothing to score, or after the profile changed.
   */
  planRun(rows: readonly ReviewRowLike[], opts: { limit: number }): RunPlan | null;
  /**
   * Apply cache hits to `results()` without starting a run, so chips can show
   * before the model has loaded. Returns how many rows are still unscored.
   */
  applyCache(rows: readonly ReviewRowLike[]): number;
  /** Attach a `results` message to the current run (validated, cached). */
  accept(msg: Extract<FromWorker, { type: 'results' }>): { accepted: PrelabelResult[]; dropped: number };
  /** True (and the run ends) when `done` belongs to the current run. */
  acceptDone(msg: Extract<FromWorker, { type: 'done' }>): boolean;
  /** Make every later worker message for the current run stale. */
  cancel(): void;
  hasActiveRun(): boolean;
  /** A copy of the scores held for this session. */
  results(): Map<number, PrelabelResult>;
  droppedCount(): number;
  /** Re-read /api/prelabel/config; on a profile, label-set or pin change cancel and discard (§5). */
  verifyBinding(): Promise<BindingCheck>;
  profileChanged(): boolean;
}

function readCache(storage: KeyValueStorage | null | undefined, key: string, labels: ReadonlySet<string>): Map<number, CacheRow> {
  const out = new Map<number, CacheRow>();
  try {
    const raw = storage?.getItem(key);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return out;
    const rows = (parsed as { rows?: unknown }).rows;
    if (typeof rows !== 'object' || rows === null) return out;
    for (const [k, entry] of Object.entries(rows as Record<string, unknown>)) {
      const id = Number(k);
      const e = entry as { h?: unknown; r?: PrelabelResult } | null;
      if (!Number.isInteger(id) || !e || typeof e.h !== 'number' || !e.r || e.r.ok !== true || e.r.txnId !== id) continue;
      const v = validateOk(e.r, labels);
      if (v) out.set(id, { h: e.h, r: v });
    }
  } catch {
    /* unavailable or corrupt: re-score */
  }
  return out;
}

export function createPrelabelSession(deps: PrelabelSessionDeps): PrelabelSession {
  let seq = 0;
  const newRunId = deps.newRunId ?? (() => `run-${deps.now()}-${++seq}`);

  let cfg: PrelabelConfig | null = null;
  let labelSet: ReadonlySet<string> = new Set();
  let key = '';
  let changed = false;
  let dropped = 0;

  const results = new Map<number, PrelabelResult>();
  /** txn -> hash of the state the held result was scored for (null: not scorable). */
  const hashes = new Map<number, number | null>();
  let cache = new Map<number, CacheRow>();
  let run: (RunBinding & { hashes: Map<number, number | null> }) | null = null;

  function writeCache() {
    try {
      while (cache.size > CACHE_MAX_ROWS) cache.delete(cache.keys().next().value as number);
      const rows: Record<string, CacheRow> = {};
      for (const [id, row] of cache) rows[String(id)] = row;
      deps.storage()?.setItem(key, JSON.stringify({ v: 1, rows }));
    } catch {
      /* quota or blocked storage: the cache is only an optimisation */
    }
  }

  function bind(config: PrelabelConfig) {
    cfg = config;
    labelSet = new Set(config.labels);
    key = cacheKey({
      profile: config.profile,
      labelSetVersion: config.labelSetVersion,
      modelId: config.pins.modelId,
      revision: config.pins.revision,
      templateVersion: config.pins.templateVersion,
    });
    changed = false;
    dropped = 0;
    results.clear();
    hashes.clear();
    run = null;
    let storage: KeyValueStorage | null | undefined;
    try {
      storage = deps.storage();
    } catch {
      storage = null;
    }
    cache = readCache(storage, key, labelSet);
  }

  function toItem(r: ReviewRowLike): { item: PrelabelItem; hash: number | null } {
    const item: PrelabelItem = { txnId: r.transaction_id, description: r.description, amount: r.amount, date: r.date.slice(0, 10) };
    const scorable = item.description.trim() !== '' && Number.isFinite(item.amount);
    return { item, hash: scorable ? fnv1a32(formatState(item)) : null };
  }

  /** True when the row already has a score for its current state (held in memory or cached). */
  function resolveFromMemoryOrCache(item: PrelabelItem, hash: number | null): boolean {
    if (results.has(item.txnId) && hashes.get(item.txnId) === hash) return true;
    const hit = hash !== null ? cache.get(item.txnId) : undefined;
    if (hit && hit.h === hash) {
      results.set(item.txnId, hit.r);
      hashes.set(item.txnId, hash);
      return true;
    }
    return false;
  }

  function applyCache(rows: readonly ReviewRowLike[]): number {
    if (!cfg || changed) return rows.length;
    let unscored = 0;
    for (const r of rows) {
      const { item, hash } = toItem(r);
      if (!resolveFromMemoryOrCache(item, hash)) unscored++;
    }
    return unscored;
  }

  function planRun(rows: readonly ReviewRowLike[], opts: { limit: number }): RunPlan | null {
    if (!cfg || changed) return null;
    const cap = Math.max(0, Math.min(opts.limit, cfg.maxRowsPerRun));
    const items: PrelabelItem[] = [];
    const runHashes = new Map<number, number | null>();
    for (const r of rows) {
      const { item, hash } = toItem(r);
      if (resolveFromMemoryOrCache(item, hash)) continue;
      if (items.length >= cap) continue;
      items.push(item);
      runHashes.set(item.txnId, hash);
    }
    if (items.length === 0) return null;
    const runId = newRunId();
    run = { runId, txnIds: new Set(items.map((i) => i.txnId)), labels: labelSet, hashes: runHashes };
    return { runId, items };
  }

  function accept(msg: Extract<FromWorker, { type: 'results' }>) {
    const out = acceptResults(run, msg);
    dropped += out.dropped;
    if (!run || out.accepted.length === 0) return out;
    let cacheTouched = false;
    for (const r of out.accepted) {
      const h = run.hashes.get(r.txnId) ?? null;
      results.set(r.txnId, r);
      hashes.set(r.txnId, h);
      if (r.ok && h !== null) {
        cache.delete(r.txnId); // re-insert so it counts as newest
        cache.set(r.txnId, { h, r });
        cacheTouched = true;
      }
    }
    if (cacheTouched) writeCache();
    return out;
  }

  function acceptDone(msg: Extract<FromWorker, { type: 'done' }>): boolean {
    if (!run || msg.runId !== run.runId) return false;
    run = null;
    return true;
  }

  async function verifyBinding(): Promise<BindingCheck> {
    if (!cfg) return 'error';
    let fresh: PrelabelConfig;
    try {
      fresh = await deps.fetchConfig();
    } catch {
      return 'error';
    }
    const same =
      fresh.profile === cfg.profile &&
      fresh.labelSetVersion === cfg.labelSetVersion &&
      fresh.pins.revision === cfg.pins.revision;
    if (same) return 'ok';
    changed = true;
    run = null;
    results.clear();
    hashes.clear();
    cache = new Map();
    return 'changed';
  }

  return {
    bind,
    planRun,
    applyCache,
    accept,
    acceptDone,
    cancel: () => {
      run = null;
    },
    hasActiveRun: () => run !== null,
    results: () => new Map(results),
    droppedCount: () => dropped,
    verifyBinding,
    profileChanged: () => changed,
  };
}

/** The pins the worker accepts: the server's pins minus the consent-copy-only byte count. */
export function workerPins(pins: PrelabelConfig['pins']): PrelabelPins {
  const { approxDownloadBytes: _bytes, ...rest } = pins;
  void _bytes;
  return rest;
}

// ── Web Lock (§4.4) ─────────────────────────────────────────────────────────

export interface LockManagerLike {
  request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown> | unknown;
}

export interface LockHandle {
  /** `held`: this tab may load the model. `locked`: another tab has it. `unsupported`: no Web Locks; run without. */
  state: 'held' | 'locked' | 'unsupported';
  release(): void;
}

export const PRELABEL_LOCK_NAME = 'wilson-prelabel';

/** Only one tab at a time loads ~350 MB onto the GPU. */
export function acquirePrelabelLock(locks: LockManagerLike | undefined, name = PRELABEL_LOCK_NAME): Promise<LockHandle> {
  const none = (state: 'locked' | 'unsupported'): LockHandle => ({ state, release() {} });
  if (!locks) return Promise.resolve(none('unsupported'));
  return new Promise<LockHandle>((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    try {
      const p = locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(none('locked'));
          return;
        }
        resolve({ state: 'held', release: () => release() });
        await held;
      });
      Promise.resolve(p).catch(() => resolve(none('unsupported')));
    } catch {
      resolve(none('unsupported'));
    }
  });
}

export interface LockGate {
  /**
   * Take the lock now (idempotent; concurrent calls share one request). Resolves
   * `held`/`unsupported` when this tab may load the model, `locked` when another
   * tab holds it. A `locked` answer is not remembered: the next call asks again.
   */
  ensure(): Promise<LockHandle['state']>;
  /** Give the lock back (idle model, fatal error, unmount). Safe when nothing is held. */
  release(): void;
}

/**
 * The lock is taken at the moment the user consents to load the model (Download
 * once, or a returning opted-in visit about to load), never on mount: a tab that
 * only shows the consent panel must not make a second tab say "running in another
 * tab" (Round 2, fix 4).
 */
export function createLockGate(locks: LockManagerLike | undefined, name = PRELABEL_LOCK_NAME): LockGate {
  let handle: LockHandle | null = null;
  let pending: Promise<LockHandle['state']> | null = null;
  let generation = 0;
  return {
    ensure() {
      if (handle) return Promise.resolve(handle.state);
      if (pending) return pending;
      const gen = generation;
      const p: Promise<LockHandle['state']> = acquirePrelabelLock(locks, name).then((h) => {
        if (pending === p) pending = null;
        if (gen !== generation) {
          // released while the request was in flight: do not keep it
          h.release();
          return h.state;
        }
        if (h.state !== 'locked') handle = h;
        return h.state;
      });
      pending = p;
      return p;
    },
    release() {
      generation++;
      pending = null;
      const h = handle;
      handle = null;
      h?.release();
    },
  };
}

// ── Turning the feature on (PUT /api/prelabel/settings) ─────────────────────

/** Plain-language reason a turn-on PUT failed. `api()` throws `Error("API <status>: <body>")`. */
export function describeTurnOnError(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const name = err instanceof Error ? err.name : '';
  if (name === 'RequiresConnectionError' || err instanceof TypeError || /failed to fetch|fetch failed|networkerror/i.test(text)) {
    return 'Could not reach the Wilson server. Check that it is running, then try again.';
  }
  const status = /^API (\d{3})\b/.exec(text)?.[1];
  if (status === '403') {
    if (/origin_required|origin_denied|origin_forbidden/.test(text)) {
      return 'The change was refused because it did not come from the dashboard page itself. Open the dashboard at its own address (http://localhost:<port>) in this browser and try again.';
    }
    return 'Only an admin can turn the second opinion on.';
  }
  if (status) return `Could not turn on the second opinion (server answered ${status}). Try again, or set prelabelEnabled in settings.json.`;
  return 'Could not turn on the second opinion. Try again.';
}

// ── Persisted capability verdicts (§4.3 step 4) ─────────────────────────────

/** Only real capability failures persist; network/load failures retry. */
const PERSISTABLE_REASONS: ReadonlySet<string> = new Set([
  'no_webgpu',
  'no_shader_f16',
  'unsupported_pins',
  'model_mismatch',
  'first_decision',
]);

export interface PersistedVerdict {
  verdict: 'unavailable' | 'failed';
  reason: string;
}

const verdictKey = (p: { modelId: string; revision: string; templateVersion: string }) =>
  `wilson-prelabel-verdict:v1:${p.modelId}|${p.revision}|${p.templateVersion}`;

export function persistVerdict(
  storage: KeyValueStorage | null | undefined,
  pins: { modelId: string; revision: string; templateVersion: string },
  v: PersistedVerdict,
): void {
  if (!PERSISTABLE_REASONS.has(v.reason)) return;
  try {
    storage?.setItem(verdictKey(pins), JSON.stringify(v));
  } catch {
    /* blocked storage */
  }
}

export function readPersistedVerdict(
  storage: KeyValueStorage | null | undefined,
  pins: { modelId: string; revision: string; templateVersion: string },
): PersistedVerdict | null {
  try {
    const raw = storage?.getItem(verdictKey(pins));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PersistedVerdict>;
    if ((v.verdict === 'unavailable' || v.verdict === 'failed') && typeof v.reason === 'string' && PERSISTABLE_REASONS.has(v.reason)) {
      return { verdict: v.verdict, reason: v.reason };
    }
  } catch {
    /* blocked or corrupt */
  }
  return null;
}

// ── Panel state machine (§10.2) ─────────────────────────────────────────────

export type PanelState =
  | { kind: 'init' }
  | { kind: 'off' }
  | { kind: 'locked' }
  | { kind: 'probing' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'consent' }
  | { kind: 'loading'; phase: 'download' | 'session' | 'warmup'; loaded: number; total: number }
  | { kind: 'ready' }
  | { kind: 'running'; done: number; total: number; p50Ms: number | null }
  | { kind: 'failed'; reason: string; detail: string }
  | { kind: 'profile_changed' };

export type PanelEvent =
  | { t: 'config'; enabled: boolean }
  | { t: 'locked' }
  | { t: 'spawn_failed'; reason: string }
  | { t: 'worker'; msg: FromWorker; optedIn: boolean }
  | { t: 'consent' }
  | { t: 'run_started'; total: number }
  | { t: 'run_progress'; done: number; p50Ms?: number | null }
  | { t: 'run_ended' }
  | { t: 'retry' }
  | { t: 'profile_changed' };

export const initialPanelState: PanelState = { kind: 'init' };

const LOADING_START: PanelState = { kind: 'loading', phase: 'download', loaded: 0, total: 0 };

export function reducePanel(state: PanelState, ev: PanelEvent): PanelState {
  // A profile change is terminal until the tab reloads.
  if (state.kind === 'profile_changed') return state;
  switch (ev.t) {
    case 'config':
      return ev.enabled ? { kind: 'probing' } : { kind: 'off' };
    case 'locked':
      return { kind: 'locked' };
    case 'spawn_failed':
      return { kind: 'unavailable', reason: ev.reason };
    case 'consent':
      return state.kind === 'consent' ? LOADING_START : state;
    case 'retry':
      return state.kind === 'failed' ? { kind: 'probing' } : state;
    case 'profile_changed':
      return { kind: 'profile_changed' };
    case 'run_started':
      return state.kind === 'ready' ? { kind: 'running', done: 0, total: ev.total, p50Ms: null } : state;
    case 'run_ended':
      return state.kind === 'running' ? { kind: 'ready' } : state;
    case 'run_progress':
      return state.kind === 'running' ? { ...state, done: ev.done, p50Ms: ev.p50Ms === undefined ? state.p50Ms : ev.p50Ms } : state;
    case 'worker': {
      const m = ev.msg;
      switch (m.type) {
        case 'capability':
          if (m.verdict === 'ready') return state.kind === 'probing' ? (ev.optedIn ? LOADING_START : { kind: 'consent' }) : state;
          if (m.verdict === 'unavailable') return { kind: 'unavailable', reason: m.reason ?? 'unknown' };
          return { kind: 'failed', reason: m.reason ?? 'unknown', detail: m.reason ?? '' };
        case 'progress':
          return state.kind === 'loading' ? { kind: 'loading', phase: m.phase, loaded: m.loaded, total: m.total } : state;
        case 'loaded':
          return { kind: 'ready' };
        case 'done':
          return state.kind === 'running' ? { kind: 'ready' } : state;
        case 'error':
          if (m.fatal || m.code === 'label_set_too_large') return { kind: 'failed', reason: m.code, detail: m.detail };
          return state;
        default:
          return state;
      }
    }
  }
}
