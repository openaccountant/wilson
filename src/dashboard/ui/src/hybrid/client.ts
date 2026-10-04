/**
 * Hybrid chat client — browser-only orchestration for local-first WebGPU chat.
 *
 * Bundled ONLY into the prebuilt hybrid chunk (dist-hybrid/hybrid-chat.js via
 * vite.hybrid.config.ts); never into the singlefile React HTML, which loads
 * this chunk at runtime from /assets/hybrid-chat.js.
 *
 * This is the main-thread PROXY. Everything that touches transformers.js (the
 * adapter probe, dtype resolution, pipeline, warmup, generation) runs in the
 * model Web Worker behind a ModelBackend (model-backend.ts). What stays here:
 * the config fetch, the capability verdict and its sessionStorage
 * persistence, the authed bundle fetches and the /api/chat/local record. This
 * module imports no transformers.js and no `?worker` module, so it stays
 * importable under bun test; standalone.ts supplies the real worker
 * constructor.
 *
 * Consent: nothing local runs (no worker, no probe, no bundle fetch, no model
 * download) unless the server reports `enabled` (the admin's
 * `localChatEnabled` setting) AND this browser opted in (consent.ts). Both are
 * re-read on every public call, so turning either off applies to the next
 * message.
 *
 * Hard contract for the UIs: every failure path — no WebGPU, config/bundle
 * fetch failure, model load/download failure, generation error, worker crash,
 * tool-call or NEED_MORE_DATA output — resolves {ok:false} (→ server path).
 * Nothing here ever throws into a UI catch block, so no hybrid-eligible
 * failure can surface as an error bubble. When the local MODEL itself failed,
 * {ok:false} carries a `detail` the UI shows as a small note, and the cause is
 * console.warn'ed.
 */

import {
  buildBundle,
  isoDaysAgo,
  projectTransactions,
  shouldAttemptLocal,
  type BundleParams,
  type BundleTxnInput,
  type BundleWeekly,
  type HandoffReason,
  type HybridCapability,
  type HybridResult,
} from './core.js';
import { parseCategorizationDecision, type ParsedDecision } from '../demo/core.js';
import { isOnnxDtype, type DtypeFetch } from '../../../../model/transformers-dtype.js';
import { createModelEngine, type ProgressCb, type TransformersModule } from './model-engine.js';
import {
  asWorkerError,
  createInThreadBackend,
  createWorkerBackend,
  type ModelBackend,
  type WorkerLike,
} from './model-backend.js';
import {
  clampSubagentLimits,
  workerErrorToCause,
  type RouteHint,
  type LoadResult,
  type MirrorPrep,
  type PriorLocalTurn,
  type StepEvent,
  type SubagentPortHandle,
  type WorkerModelConfig,
} from './worker-protocol.js';
import { buildHandoff, gateQuestion, keywordRoute, type HandoffBuildInput } from './subagent-core.js';
import {
  OPEN_JEV_CHAT_TIMEOUT_MS,
  OPEN_JEV_ROUTE_CUT,
  decideRoute,
  isValidCut,
  type ToolChoice,
} from './openjev-route.js';
import {
  capabilityKey,
  classifyLoadFailure,
  describeLoadFailure,
  parsePersistedCapability,
  restoreCapability,
  type PersistedCapability,
} from './capability.js';
import { hasLocalChatOptIn, type OptInStorage } from './consent.js';

export type { HybridResult } from './core.js';
export type { MirrorPrep, PriorLocalTurn } from './worker-protocol.js';
export type { TransformersModule } from './model-engine.js';
export type { WorkerLike } from './model-backend.js';

/**
 * Structural fetch type — decouples the browser client from whichever global
 * fetch typing wins (DOM lib vs bun-types leaking into the UI tsconfig).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HybridOpts {
  baseUrl: string;
  fetchImpl: FetchLike;
  /**
   * Production: constructs the model Web Worker (standalone.ts passes the
   * `?worker&inline` constructor). Without this, and without a test hook
   * below, there is no local model and every call resolves {ok:false}.
   */
  createWorker?: () => WorkerLike;
  /** The page origin handed to the worker (absolute; a blob worker has no relative base). Defaults to window.location.origin. */
  origin?: string;
  /** Test hook: run the model engine in-thread against this fake transformers module (no worker). */
  loadTransformers?: () => Promise<TransformersModule>;
  /** Test hook: replaces the global fetch for Hub metadata requests (in-thread engine only). */
  hubFetch?: DtypeFetch;
  /** Test hook: a ready-made backend. */
  backend?: ModelBackend;
  /**
   * TEST SEAM ONLY: replaces the frozen OPEN_JEV_ROUTE_CUT for the open-jev tiebreak. Production never
   * sets it; `null` (the frozen value when no viable cut exists) disables the tiebreak.
   */
  routeCut?: number | null;
  /** Where the per-browser opt-in is read (consent.ts). Defaults to localStorage. */
  optInStorage?: OptInStorage | null;
}

/** The pinned open-jev model, as GET /api/config/local-chat ships it (the worker's `init` pins). */
export interface OpenJevConfigPins {
  repo: string;
  dtype: 'q4f16';
  device: 'webgpu';
  temperature: number;
  templateVersion: 'prelabel-tmpl-v1';
  modelId: string;
  revision: string;
  configSha: string;
}

/** GET /api/config/local-chat response. */
export interface LocalChatConfigResponse {
  /** Server side of consent: a fastModel exists AND `localChatEnabled` is on. */
  enabled: boolean;
  /** A fastModel exists (absent from older servers). */
  available?: boolean;
  /** The `localChatEnabled` setting (absent from older servers). */
  consented?: boolean;
  /** Host the model downloads from (absent from older servers). */
  sourceHost?: string;
  id: string;
  repo: string;
  displayName: string;
  downloadSize: string;
  /** Catalog-pinned ONNX dtype (e.g. 'q4f16'); null → resolve from the Hub file list. */
  dtype?: string | null;
  bundle: BundleParams;
  /** Browser subagent flag (absent from older servers = off). */
  subagent?: {
    enabled: boolean;
    maxSteps: number;
    /** Answer writer (absent from older servers = template). */
    compose?: 'template' | 'model';
    /** Round 4: the on-device open-jev tiebreak for 0 / 2+ keyword hits (absent from older servers = off). */
    openJevRouter?: boolean;
    openJevPins?: OpenJevConfigPins | null;
  };
}

/** Per-call options for the browser subagent (the app supplies the mirror half). */
export interface SubagentTurnOpts {
  /** Turns answered on-device earlier in this session (most recent last; capped at 3 on the wire). */
  priorLocalTurns: PriorLocalTurn[];
  /**
   * Main-thread mirror preparation: freshness check, bounded sync wait, profile
   * binding, then a fresh scoped port. Called only after the gate passed and
   * only when the server enabled the subagent.
   */
  prepareMirror(): Promise<MirrorPrep>;
  /**
   * Round 4: the app's open-jev decision over the 5 read tools, asked ONLY for a question with 0 or 2+
   * keyword hits, only when the server flag is on and the cut is frozen. It must never prompt, download,
   * or wait for a model load: not loaded / lock busy / too slow means `null` (a handoff). The client also
   * cuts it off shortly after OPEN_JEV_CHAT_TIMEOUT_MS and treats a throw as `null`.
   */
  chooseTool?(req: { question: string; pins: OpenJevConfigPins; signal?: AbortSignal }): Promise<ToolChoice | null>;
}

export interface TryLocalOpts {
  subagent?: SubagentTurnOpts;
}

/** Session-storage key for the per-session capability verdict (Track D). */
export const CAPABILITY_STORAGE_KEY = 'wilson-hybrid-capability';

function modelConfigOf(cfg: LocalChatConfigResponse): WorkerModelConfig {
  return {
    repo: cfg.repo,
    displayName: cfg.displayName,
    catalogDtype: isOnnxDtype(cfg.dtype) ? cfg.dtype : null,
  };
}

export function createHybridChat(opts: HybridOpts) {
  const fetchImpl = opts.fetchImpl;
  const base = opts.baseUrl.replace(/\/+$/, '');

  // ── Model backend: the worker in production, an in-thread engine in tests ──
  let backendInstance: ModelBackend | null | undefined;
  /** Null when there is nothing to run a model on (no worker constructor, no test hook). */
  function getBackend(): ModelBackend | null {
    if (backendInstance !== undefined) return backendInstance;
    const origin = opts.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? base;
    if (opts.backend) backendInstance = opts.backend;
    else if (opts.loadTransformers) {
      backendInstance = createInThreadBackend(
        createModelEngine({ loadTransformers: opts.loadTransformers, hubFetch: opts.hubFetch }),
        base || origin,
      );
    } else if (opts.createWorker) {
      backendInstance = createWorkerBackend({ createWorker: opts.createWorker, origin });
    } else backendInstance = null;
    return backendInstance;
  }

  // ── Session-cached capability verdict ──────────────────────────────────
  // Layered-probe philosophy (never trust static lists): the verdict is only
  // cached after real probes, and only for the rest of the browser session.
  // 'ready'/'failed' are keyed by the model config (capability.ts), so a
  // changed config — or a resolver fix — retries instead of staying disabled.
  let stored: PersistedCapability | null = null;
  try {
    stored = parsePersistedCapability(sessionStorage.getItem(CAPABILITY_STORAGE_KEY));
  } catch {
    // storage unavailable — start from 'unknown'
  }
  // Before the config is known only the config-independent verdict applies.
  let verdict: HybridCapability = restoreCapability(stored, null);
  /** Config key the in-memory verdict was reconciled against (null = not yet). */
  let syncedKey: string | null = null;
  /** Human-readable reason behind a 'failed' verdict. */
  let failureDetail: string | null = null;
  let provenRepo: string | null = null;

  function persist(): void {
    if (verdict === 'unknown') return;
    const record: PersistedCapability = { verdict, key: syncedKey, repo: provenRepo, detail: failureDetail };
    stored = record;
    try {
      sessionStorage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // storage unavailable — session-only behavior degrades gracefully
    }
  }

  /** Adopt the persisted verdict only if it was recorded for this exact config. */
  function syncWithConfig(cfg: LocalChatConfigResponse): void {
    const key = capabilityKey(cfg);
    if (syncedKey === key) return;
    syncedKey = key;
    if (verdict === 'unavailable') return;
    verdict = restoreCapability(stored, key);
    failureDetail = verdict === 'failed' ? (stored?.detail ?? null) : null;
  }

  // ── Config (model choice rides the server's fastModel field) ───────────
  // Cached for one public call only (refreshConfig at each entry point), so a
  // consent change on the server applies to the next message.
  let configPromise: Promise<LocalChatConfigResponse | null> | null = null;
  function refreshConfig(): void {
    configPromise = null;
  }
  function fetchConfig(): Promise<LocalChatConfigResponse | null> {
    configPromise ??= (async () => {
      try {
        const res = await fetchImpl(`${base}/api/config/local-chat`);
        if (!res.ok) return null;
        const data = (await res.json()) as LocalChatConfigResponse;
        return data?.enabled && data.repo ? data : null;
      } catch {
        return null;
      }
    })();
    return configPromise;
  }

  /**
   * Fetch the config, reconcile the verdict with it and tell the backend which
   * model to run. Null (the server path) unless the server enabled local chat
   * and this browser opted in: the consent gate every model path goes through.
   */
  async function loadConfig(): Promise<LocalChatConfigResponse | null> {
    const cfg = await fetchConfig();
    if (!cfg || !hasLocalChatOptIn(cfg.repo, opts.optInStorage)) return null;
    syncWithConfig(cfg);
    getBackend()?.setModel(modelConfigOf(cfg));
    return cfg;
  }

  // ── Capability probe (layers 1 and 2; layer 3 is loadModel) ────────────
  async function probe(): Promise<'ready' | 'unavailable' | 'failed'> {
    if (verdict !== 'unknown') return verdict;

    // Layer 1, cheap and in this thread: is there a WebGPU API at all? This
    // spares spawning the worker on a browser that can never run the model.
    const nav = globalThis.navigator as Navigator | undefined;
    // Structural typing: WebGPU types may not be in every tsconfig's lib set.
    const gpu = (nav as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      verdict = 'unavailable';
      persist();
      return 'unavailable';
    }
    // Layer 2, in the scope that will actually run the model: a real adapter.
    // Consent first, so an unconsented browser never even spawns the worker.
    const cfg = await loadConfig();
    const backend = cfg ? getBackend() : null;
    if (!backend || !cfg) {
      // Nothing to run on, or the server has local chat off: not a browser
      // property, so nothing is persisted.
      return 'unavailable';
    }
    let layer2: 'ready' | 'unavailable';
    try {
      layer2 = await backend.probe();
    } catch {
      return 'unavailable';
    }
    if (layer2 === 'unavailable') {
      verdict = 'unavailable';
      persist();
      return 'unavailable';
    }
    // Optimistic: layers 1-2 passed. The real-generation layer (loadModel)
    // downgrades to 'failed' if the GPU cannot actually run the model
    // (e.g. a q4f16-only repo on an adapter without shader-f16).
    verdict = 'ready';
    persist();
    return 'ready';
  }

  // ── Model load + real-generation proof (layer 3), in the worker ─────────
  /** Reason the last load failed (any failure, not only dtype errors). */
  let lastLoadError: string | null = null;

  async function loadModel(onProgress?: ProgressCb): Promise<LoadResult | null> {
    const cfg = await loadConfig();
    const backend = getBackend();
    if (!cfg || !backend) return null;

    try {
      const loaded = await backend.load(onProgress);
      provenRepo = cfg.repo;
      lastLoadError = null;
      failureDetail = null;
      verdict = 'ready';
      persist();
      return loaded;
    } catch (thrown) {
      const failure = asWorkerError(thrown);
      const cause = workerErrorToCause(failure);
      const dtype = failure.dtype ?? (isOnnxDtype(cfg.dtype) ? cfg.dtype : null);
      // Always say why — a silently disabled local model is undebuggable.
      lastLoadError = describeLoadFailure(cause, cfg.repo, dtype);
      console.warn(`[hybrid-chat] local model load failed (${failure.phase}): ${lastLoadError}`, cause);
      // Only a genuine capability failure sticks for the session (keyed by
      // config). Network errors, 404s, damaged caches and a crashed or
      // timed-out worker (phase 'protocol': respawned next call) retry.
      const phase = failure.phase;
      const kind =
        phase === 'resolve' || phase === 'load' || phase === 'warmup'
          ? classifyLoadFailure(cause, phase)
          : 'transient';
      if (kind === 'capability') {
        verdict = 'failed';
        failureDetail = lastLoadError;
        persist();
      }
      return null;
    }
  }

  /** {ok:false} carrying the local-model failure reason, when there is one. */
  function unavailableResult(detail: string | null): HybridResult {
    return detail ? { ok: false, detail } : { ok: false };
  }

  // ── Local attempt ───────────────────────────────────────────────────────

  /** Best-effort record of a locally-answered exchange. Losing a history row must never become a user-facing error. */
  async function recordLocal(query: string, answer: string, sessionId?: string | null): Promise<string | null> {
    try {
      const body: Record<string, unknown> = { query, answer };
      const sid = sessionId ?? null;
      if (sid) body.sessionId = sid;
      const res = await fetchImpl(`${base}/api/chat/local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { sessionId?: string | null };
        return data?.sessionId ?? null;
      }
    } catch {
      // best-effort only
    }
    return null;
  }

  /** Bundle mode (slice-1 behaviour): pre-fetched context in the prompt, one generation, no tools. */
  async function runBundleMode(
    cfg: LocalChatConfigResponse,
    query: string,
    onProgress?: ProgressCb,
    sessionId?: string | null,
  ): Promise<HybridResult> {
    // ── Pre-fetched context bundle (localhost only, existing endpoints) ──
    // Fetched here, on the main thread: these are authed requests and the
    // worker never holds the token.
    onProgress?.('Fetching your recent transactions…');
    const start = isoDaysAgo(cfg.bundle.days);
    const end = isoDaysAgo(0);
    const [txnRes, weeklyRes] = await Promise.all([
      fetchImpl(`${base}/api/transactions?start=${start}&end=${end}&limit=${cfg.bundle.limit}`),
      fetchImpl(`${base}/api/weekly-summary`),
    ]);
    if (!txnRes.ok || !weeklyRes.ok) return { ok: false };

    const txnRows = (await txnRes.json()) as BundleTxnInput[];
    const weeklyRaw = (await weeklyRes.json()) as {
      thisWeek: { total: number; byCategory?: { category: string }[] };
      lastWeek: { total: number; byCategory?: { category: string }[] };
      change: { amount: number; percent: number };
    };
    const weekly: BundleWeekly = {
      thisWeek: {
        total: Number(weeklyRaw.thisWeek?.total) || 0,
        topCategory: weeklyRaw.thisWeek?.byCategory?.[0]?.category ?? null,
      },
      lastWeek: {
        total: Number(weeklyRaw.lastWeek?.total) || 0,
        topCategory: weeklyRaw.lastWeek?.byCategory?.[0]?.category ?? null,
      },
      change: {
        amount: Number(weeklyRaw.change?.amount) || 0,
        percent: Number(weeklyRaw.change?.percent) || 0,
      },
    };

    // Project to the narrow field subset + window/limit, then render with
    // the size guard for the 0.6B context window.
    const projected = projectTransactions(txnRows, {
      days: cfg.bundle.days,
      limit: cfg.bundle.limit,
    });
    const bundle = buildBundle(projected, weekly, cfg.bundle);

    // ── Model + generation (in the worker) ──────────────────────────────
    onProgress?.('Loading local model…');
    const loaded = await loadModel(onProgress);
    if (!loaded) return unavailableResult(lastLoadError);

    onProgress?.('Thinking locally…');
    const backend = getBackend();
    if (!backend) return { ok: false };
    const classified = await backend.bundleAnswer(query, bundle.text, isoDaysAgo(0));
    if (classified.kind === 'handoff') {
      return { ok: false, reason: classified.reason };
    }

    const recordedSessionId = await recordLocal(query, classified.text, sessionId);
    return { ok: true, answer: classified.text, sessionId: recordedSessionId, source: 'local' };
  }

  /** A subagent handoff result. Total: a payload that cannot be built degrades to a plain {ok:false}. */
  function handoffResult(reason: HandoffReason, input: Omit<HandoffBuildInput, 'reason' | 'steps' | 'mirrorSyncedAt'> & { mirrorSyncedAt?: string | null }): HybridResult {
    try {
      const handoff = buildHandoff({
        steps: [],
        mirrorSyncedAt: null,
        ...input,
        reason: reason as HandoffBuildInput['reason'],
      });
      return { ok: false, reason, handoff };
    } catch {
      return { ok: false, reason };
    }
  }

  function progressForStep(event: StepEvent): string | null {
    if (event.kind === 'route' && event.tool !== 'none') return `Looking up ${event.tool} on this device…`;
    if (event.kind === 'tool') return `Read ${event.tool} on this device…`;
    if (event.kind === 'compose') return 'Writing the answer locally…';
    return null;
  }

  function closePort(port: SubagentPortHandle): void {
    try {
      port.close();
    } catch {
      // already closed or transferred
    }
  }

  /**
   * Round 4 (specs/browser-subagent-round4-openjev-router.md §4.3). Total: never throws.
   *  - flag off, no pins, no chooseTool, or no frozen cut: round 3, byte for byte;
   *  - exactly one keyword hit: round 3 (open-jev never sees it);
   *  - otherwise ask chooseTool (bounded), apply the pure route decision, and either hand the core a
   *    hint to re-check or hand off as router-none right here (the caller closes the port).
   */
  async function openJevRouteStep(
    cfg: LocalChatConfigResponse,
    query: string,
    sub: SubagentTurnOpts,
    onProgress?: ProgressCb,
  ): Promise<{ kind: 'go'; hint?: RouteHint } | { kind: 'handoff' }> {
    const pins = cfg.subagent?.openJevPins;
    if (cfg.subagent?.openJevRouter !== true || !pins || !sub.chooseTool) return { kind: 'go' };
    const cut = opts.routeCut === undefined ? OPEN_JEV_ROUTE_CUT : opts.routeCut;
    if (!isValidCut(cut)) return { kind: 'go' };
    let hits: string[];
    try {
      hits = keywordRoute(query);
    } catch {
      return { kind: 'go' };
    }
    if (hits.length === 1) return { kind: 'go' };

    onProgress?.('Picking the right lookup on this device…');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let choice: ToolChoice | null = null;
    try {
      choice = await Promise.race([
        sub.chooseTool({ question: query, pins, ...(controller ? { signal: controller.signal } : {}) }),
        new Promise<null>((resolve) => {
          guard = setTimeout(() => resolve(null), OPEN_JEV_CHAT_TIMEOUT_MS + 250);
        }),
      ]);
    } catch {
      choice = null;
    } finally {
      if (guard !== undefined) clearTimeout(guard);
      controller?.abort();
    }
    const decision = decideRoute(hits, choice, cut);
    if ('handoff' in decision || !choice) return { kind: 'handoff' };
    return { kind: 'go', hint: { tool: decision.tool, margin: choice.margin, cut, hits } };
  }

  /** One subagent turn on a prepared mirror port. Always closes the port. */
  async function runSubagentTurn(
    cfg: LocalChatConfigResponse,
    query: string,
    prep: Extract<MirrorPrep, { kind: 'ready' }>,
    sub: SubagentTurnOpts,
    onProgress?: ProgressCb,
    sessionId?: string | null,
  ): Promise<HybridResult> {
    try {
      const limits = clampSubagentLimits(cfg.subagent);
      // Round 4 (R4-6): the open-jev tiebreak for 0 / 2+ keyword hits. Before any model work.
      const routed = await openJevRouteStep(cfg, query, sub, onProgress);
      if (routed.kind === 'handoff') {
        return handoffResult('router-none', { priorLocalTurns: sub.priorLocalTurns, mirrorSyncedAt: prep.lastSyncedAt });
      }
      // Round 4 (R4-0): template mode writes the answer without the model, so the turn
      // never loads it (no download, no GPU session). Only compose: 'model' needs it.
      if (limits.compose === 'model') {
        onProgress?.('Loading local model…');
        const loaded = await loadModel(onProgress);
        if (!loaded) return unavailableResult(lastLoadError);
      }
      const backend = getBackend();
      if (!backend) return unavailableResult(lastLoadError);

      onProgress?.('Thinking locally…');
      let run;
      try {
        run = await backend.subagentRun(
          {
            query,
            nowIso: new Date().toISOString(),
            expectedProfile: prep.expectedProfile,
            priorLocalTurns: sub.priorLocalTurns,
            limits,
            port: prep.port,
            ...(routed.hint ? { routeHint: routed.hint } : {}),
          },
          (event) => {
            const label = progressForStep(event);
            if (label) onProgress?.(label);
          },
        );
      } catch (thrown) {
        // A crashed or timed-out worker (respawned next call). Not a capability failure.
        console.warn('[hybrid-chat] subagent run failed; using the server path:', thrown);
        return handoffResult('error', { priorLocalTurns: sub.priorLocalTurns, mirrorSyncedAt: prep.lastSyncedAt });
      }

      const outcome = run.outcome;
      switch (outcome.kind) {
        case 'answer': {
          const recorded = await recordLocal(query, outcome.text, sessionId);
          return {
            ok: true,
            answer: outcome.text,
            sessionId: recorded,
            source: 'local',
            mode: 'subagent',
            steps: outcome.steps.map((st) => ({ tool: st.tool, ms: st.ms })),
          };
        }
        case 'handoff':
          return { ok: false, reason: outcome.reason, handoff: outcome.handoff };
        case 'cancelled':
          return { ok: false, reason: 'cancelled' };
        case 'bundle-fallback':
          closePort(prep.port);
          return await runBundleMode(cfg, query, onProgress, sessionId);
      }
    } finally {
      closePort(prep.port);
    }
  }

  async function tryLocal(
    query: string,
    onProgress?: ProgressCb,
    sessionId?: string | null,
    opts?: TryLocalOpts,
  ): Promise<HybridResult> {
    try {
      if (verdict === 'unavailable') return { ok: false };

      refreshConfig();
      const cfg = await loadConfig();
      if (!cfg) return { ok: false };

      // ── Subagent gate (pure, main thread) ───────────────────────────────
      // Runs before the probe, the model download, the mirror port and the
      // bundle fetch: a mutation or non-data question never costs a ~570 MB
      // first-run download or a GPU session. Only when the server enabled the
      // subagent AND the caller supplied the mirror half.
      const sub = cfg.subagent?.enabled ? opts?.subagent : undefined;
      if (sub) {
        const gate = gateQuestion(query);
        if (gate.kind !== 'route') {
          const result =
            gate.kind === 'mutation-intent'
              ? handoffResult('mutation-intent', { proposal: gate.proposal, priorLocalTurns: sub.priorLocalTurns })
              : handoffResult('non-data', { priorLocalTurns: sub.priorLocalTurns });
          return verdict === 'failed' && failureDetail && !result.ok ? { ...result, detail: failureDetail } : result;
        }
      }

      if (verdict === 'unknown') await probe();
      if (!shouldAttemptLocal(verdict)) return unavailableResult(verdict === 'failed' ? failureDetail : null);

      if (sub) {
        let prep: MirrorPrep;
        try {
          prep = await sub.prepareMirror();
        } catch {
          prep = { kind: 'unavailable' };
        }
        if (prep.kind === 'stale') {
          return handoffResult('mirror-stale', { priorLocalTurns: sub.priorLocalTurns, mirrorSyncedAt: prep.lastSyncedAt });
        }
        if (prep.kind === 'ready') return await runSubagentTurn(cfg, query, prep, sub, onProgress, sessionId);
        // 'unavailable': no usable mirror, so today's bundle mode.
      }

      return await runBundleMode(cfg, query, onProgress, sessionId);
    } catch (err) {
      // Any unexpected failure hands off to the server path — never silently.
      console.warn('[hybrid-chat] local attempt failed; using the server path:', err);
      return { ok: false, reason: 'error' };
    }
  }

  // ── Speed Showdown: browser categorization arm (issue #92) ──────────────
  // Single-row categorization in the browser, riding the same probe/verdict/
  // loadModel machinery as tryLocal. Never throws; a failure resolves
  // {ok:false, reason} and the DemoTab falls back to the server local path.

  async function categorizeSample(opts: {
    systemPrompt: string;
    userPrompt: string;
    onProgress?: ProgressCb;
  }): Promise<CategorizeSampleResult> {
    const failed = (reason: NonNullable<CategorizeSampleResult['reason']>): CategorizeSampleResult => ({
      ok: false,
      model: '',
      raw: '',
      decision: null,
      decisionMs: 0,
      loadMs: 0,
      loadFresh: false,
      reason,
    });
    try {
      if (verdict === 'unavailable') return failed('unavailable');

      refreshConfig();
      const cfg = await loadConfig();
      if (!cfg) return failed('unavailable');

      if (verdict === 'unknown') await probe();
      if (verdict === 'failed') return failureDetail ? { ...failed('failed'), detail: failureDetail } : failed('failed');
      if (!shouldAttemptLocal(verdict)) return failed('unavailable');

      opts.onProgress?.('Loading local model…');
      const loadStart = performance.now();
      const loaded = await loadModel(opts.onProgress);
      if (!loaded) return lastLoadError ? { ...failed('failed'), detail: lastLoadError } : failed('failed');
      // Measured here (not the worker's own clock) so it includes spawning
      // the worker, the user's actual wait. ≈0 when the model was already warm.
      const loadMs = performance.now() - loadStart;

      opts.onProgress?.('Thinking locally…');
      const backend = getBackend();
      if (!backend) return failed('unavailable');
      const { raw, decisionMs } = await backend.categorize({
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
      });

      const parsed = parseCategorizationDecision(raw);
      return {
        ok: true,
        model: cfg.repo,
        raw,
        decision: parsed.ok ? parsed.decision : null,
        decisionMs,
        loadMs,
        // The worker knows whether this call initiated the load.
        loadFresh: loaded.loadFresh,
      };
    } catch (err) {
      console.warn('[hybrid-chat] browser categorization failed:', err);
      return failed('error');
    }
  }

  /** Terminate the worker and fail anything in flight. A later call respawns it lazily. */
  function dispose(): void {
    backendInstance?.dispose();
    backendInstance = undefined;
  }

  /** Whether local chat may run in this browser now (server on AND opted in). Never throws. */
  async function isLocalActive(): Promise<boolean> {
    refreshConfig();
    try {
      return (await loadConfig()) !== null;
    } catch {
      return false;
    }
  }

  return {
    probe: () => {
      refreshConfig();
      return probe();
    },
    loadModel: (onProgress?: ProgressCb) => {
      refreshConfig();
      return loadModel(onProgress);
    },
    isLocalActive,
    tryLocal,
    categorizeSample,
    dispose,
  };
}

export type HybridChat = ReturnType<typeof createHybridChat>;

export interface CategorizeSampleResult {
  ok: boolean;
  /** Hub repo that actually ran (e.g. 'onnx-community/Qwen3-0.6B-ONNX'). */
  model: string;
  raw: string;
  /** Parsed decision, or null when the output was unparseable (raw shown honestly). */
  decision: ParsedDecision | null;
  /** performance.now() measured around the generation call. */
  decisionMs: number;
  /** Measured around loadModel(); ≈0 when the model was already warm. */
  loadMs: number;
  /** True iff this call initiated the model load. */
  loadFresh: boolean;
  /** When ok=false: why the browser path was not usable. */
  reason?: 'unavailable' | 'failed' | 'error';
  /** When ok=false and known: a human-readable cause (e.g. GPU lacks shader-f16). */
  detail?: string;
}

export interface CategorizeSampleOpts {
  systemPrompt: string;
  userPrompt: string;
  onProgress?: (label: string) => void;
}