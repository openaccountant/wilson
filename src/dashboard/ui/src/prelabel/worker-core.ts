/**
 * open-jev pre-labeler: the worker engine (specs/open-jev-labeler.md §4, §5, §7).
 *
 * Pure apart from injected dependencies, so bun tests drive it with a fake
 * OpenJev, a fake transformers `env`, a fake `navigator.gpu` and a fake clock.
 * `worker.ts` is the `self.onmessage` shim that wires the real ones. This file
 * imports no DOM, worker or network API and no runtime library: only `core.ts`
 * (pure) and the protocol types.
 *
 * Rules the engine enforces:
 *  - Nothing touches the network before a `load` or `info` message (consent
 *    lives in the UI, §4.4). `OpenJev.info()` is called only for an `info`
 *    message, never as a side effect of `load`.
 *  - `env.remotePathTemplate` is pinned to the 40-hex revision before ANY
 *    library call that can fetch (`info`, `load`); `config.json` at that
 *    revision is hashed and must equal the pin, else `model_mismatch` and the
 *    350 MB of weights are never downloaded.
 *  - Capability ladder (§4.3) ends at `unavailable`. There is no wasm fallback
 *    (DECISIONS OQ6): a wasm or fp32 pin is refused outright.
 *  - Decisions are sequential, batch-1, pass `temperature` explicitly and bare
 *    option labels (never descriptions) for the pre-labeler's batch runs.
 *  - Round 4: a `choose` request (one chat decision, optional option descriptions)
 *    shares ONE decide queue with batch rows. At most one `decide()` is ever in
 *    flight on the ORT session, and a waiting `choose` is served before the next
 *    batch row, so a chat turn waits for at most the row already in flight.
 */
import { buildQuestion, formatState, topTwo } from './core.js';
import { routeChoiceQuestion } from '../hybrid/openjev-route.js';
import type { FromWorker, PrelabelItem, PrelabelPins, PrelabelResult, ToWorker } from './protocol.js';

// ── Limits (spec §4.2, §7) ──────────────────────────────────────────────────

/** Whole-sequence context limit of the open-jev DeBERTa (library default). */
export const MAX_LENGTH_TOKENS = 512;
/** Library default `maxStateTokens` for open-jev. */
export const MAX_STATE_TOKENS = 256;
/** If the option labels alone exceed this many tokens the run is refused. */
export const MAX_OPTION_TOKENS = 200;
/** The first results chunk is posted after this many rows (UI shows life fast). */
export const FIRST_CHUNK_ROWS = 5;
/** Every later chunk holds this many rows. */
export const CHUNK_ROWS = 25;
/** Minimum gap between `progress` messages while downloading. */
const PROGRESS_THROTTLE_MS = 100;
const WARMUP_STATE = 'description: WARMUP | amount: -1.00 | date: 2026-01-01';

// ── Structural types for the injected dependencies ──────────────────────────

export interface OpenJevLike {
  readonly runtime: { model: string; family: string; device: string; dtype: string };
  countTokens(text: string): number;
  decide(
    state: string,
    questions: readonly { type: 'choice'; instructions: string; options: readonly string[]; descriptions?: Readonly<Record<string, string>> }[],
    options: { temperature: number; truncation: 'cut' },
  ): Promise<ReadonlyArray<{ probabilities: Record<string, number> }>>;
  dispose(): Promise<void>;
}

export interface OpenJevStatic {
  info(options: { model: string; device: 'webgpu'; dtype: 'q4f16' }): Promise<{ isCached: boolean; downloadSize: number }>;
  load(options: {
    model: string;
    device: 'webgpu';
    dtype: 'q4f16';
    temperature: number;
    truncation: 'cut';
    onProgress?: (p: { progress: number; loaded: number; total: number }) => void;
  }): Promise<OpenJevLike>;
}

/** The slice of the transformers.js `env` the engine configures. */
export interface TransformersEnvLike {
  version?: string;
  remoteHost?: string;
  remotePathTemplate?: string;
  allowLocalModels?: boolean;
  backends?: { onnx?: { wasm?: { wasmPaths?: unknown }; versions?: { web?: string } } };
}

export interface GpuAdapterLike {
  features?: { has(feature: string): boolean };
  info?: { vendor?: string; architecture?: string; description?: string; device?: string; isFallbackAdapter?: boolean | null };
  isFallbackAdapter?: boolean | null;
}

export interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

export interface PrelabelEngineDeps {
  /** Returns the transformers module's `env` and open-jev on the SAME module instance. */
  loadOpenJev(): Promise<{ OpenJev: OpenJevStatic; env: TransformersEnvLike; ortVersion?: string }>;
  now(): number;
  /** `navigator.gpu`, or undefined when absent (insecure context, no WebGPU in workers). */
  gpu: GpuLike | undefined;
  /** GET the URL and return the lowercase hex sha256 of the body. */
  fetchConfigSha(url: string): Promise<string>;
  post(msg: FromWorker): void;
  /** Let queued messages (cancel) run between rows. Defaults to a 0 ms timeout. */
  yieldTick?(): Promise<void>;
}

export interface PrelabelEngine {
  handle(msg: ToWorker): Promise<void>;
}

type CapabilityMsg = Extract<FromWorker, { type: 'capability' }>;
type LoadedMsg = Extract<FromWorker, { type: 'loaded' }>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Nearest-rank percentile of an ascending-sorted list; 0 for an empty list. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

// ── Engine ──────────────────────────────────────────────────────────────────

export function createPrelabelEngine(deps: PrelabelEngineDeps): PrelabelEngine {
  const { post, now } = deps;
  const yieldTick = deps.yieldTick ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  let pins: PrelabelPins | null = null;
  /** Empty for a chat-only host (Round 4): batch runs are refused, warmup uses the route question. */
  let labels: string[] = [];
  /** Set when init refused the pins; re-reported on every later request. */
  let refused: CapabilityMsg | null = null;

  let modulePromise: Promise<{ OpenJev: OpenJevStatic; env: TransformersEnvLike; ortVersion?: string }> | null = null;
  let jev: OpenJevLike | null = null;
  let loadPromise: Promise<void> | null = null;
  let loadedMsg: LoadedMsg | null = null;
  let failedFatal = false;
  let infoCached: boolean | null = null;

  let activeRunId: string | null = null;
  let cancelledRunId: string | null = null;

  // ── the one decide queue (Round 4) ─────────────────────────────────────────
  // The shim does not await handle(), so a `choose` can arrive while a batch row is
  // inside decide(). Every decide() goes through acquire()/release(); a hand-off keeps
  // `deciding` true so nothing slips between waiters, and chooses go first.
  let deciding = false;
  const chooseWaiters: Array<() => void> = [];
  const rowWaiters: Array<() => void> = [];
  function acquireDecide(priority: boolean): Promise<void> {
    if (!deciding) {
      deciding = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => (priority ? chooseWaiters : rowWaiters).push(resolve));
  }
  function releaseDecide(): void {
    const next = chooseWaiters.shift() ?? rowWaiters.shift();
    if (next) next();
    else deciding = false;
  }

  const error = (code: Extract<FromWorker, { type: 'error' }>['code'], detail: string, fatal = false) =>
    post({ v: 1, type: 'error', fatal, code, detail });

  // ── capability ────────────────────────────────────────────────────────────

  async function probeCapability(): Promise<CapabilityMsg> {
    const msg = (verdict: CapabilityMsg['verdict'], reason: string | null, adapter: CapabilityMsg['adapter']): CapabilityMsg => ({
      v: 1, type: 'capability', verdict, reason, adapter,
    });
    // 0. No navigator.gpu (insecure context, Firefox/macOS, no WebGPU in workers): never throw.
    if (!deps.gpu) return msg('unavailable', 'no_webgpu', null);
    let adapter: GpuAdapterLike | null;
    try {
      adapter = await deps.gpu.requestAdapter();
    } catch {
      return msg('unavailable', 'no_webgpu', null);
    }
    if (!adapter) return msg('unavailable', 'no_webgpu', null);

    const info = adapter.info ?? {};
    const vendor = String(info.vendor ?? '');
    const architecture = String(info.architecture ?? '');
    const description = String(info.description ?? '');
    // The top-level attribute is deprecated and the spike saw null: prefer info's, treat null as "not fallback".
    const isFallback = (info.isFallbackAdapter ?? adapter.isFallbackAdapter) === true;
    const shaderF16 = adapter.features?.has('shader-f16') === true;
    const summary = { vendor, architecture, shaderF16, isFallback };

    // 1. fallback adapter or software renderer: the same rule the spike used.
    if (isFallback || /swiftshader/i.test(`${vendor} ${architecture} ${description}`)) {
      return msg('unavailable', 'no_webgpu', summary);
    }
    // 2. q4f16 needs shader-f16. No wasm fallback (DECISIONS OQ6).
    if (!shaderF16) return msg('unavailable', 'no_shader_f16', summary);
    return msg('ready', null, summary);
  }

  // ── module + env ──────────────────────────────────────────────────────────

  /** Load the module and pin its env. Runs before every call that can fetch. */
  async function configuredModule(p: PrelabelPins, assetBase: string) {
    modulePromise ??= deps.loadOpenJev();
    const mod = await modulePromise;
    const { env } = mod;
    env.allowLocalModels = false;
    // Every remote file (tokenizer, config, weights) comes from ONE immutable commit.
    env.remotePathTemplate = `{model}/resolve/${p.revision}/`;
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) wasm.wasmPaths = `${assetBase}ort/`;
    return mod;
  }

  let assetBase = '/assets/';

  // ── handlers ──────────────────────────────────────────────────────────────

  function onInit(msg: Extract<ToWorker, { type: 'init' }>) {
    // Re-init resets nothing that is loaded; the pins/labels of a loaded session are fixed.
    if (msg.pins.device !== 'webgpu' || msg.pins.dtype !== 'q4f16') {
      refused = { v: 1, type: 'capability', verdict: 'unavailable', reason: 'unsupported_pins', adapter: null };
      post(refused);
      return;
    }
    refused = null;
    pins = msg.pins;
    labels = [...(msg.labels ?? [])];
    assetBase = msg.assetBase.endsWith('/') ? msg.assetBase : `${msg.assetBase}/`;
  }

  /** Common guard: false (after reporting) when the engine cannot serve a request. */
  function requireInit(): boolean {
    if (refused) {
      post(refused);
      return false;
    }
    if (!pins) {
      error('load', 'not_initialized');
      return false;
    }
    return true;
  }

  async function onProbe() {
    post(await probeCapability());
  }

  async function onInfo() {
    if (!requireInit() || !pins) return;
    try {
      const { OpenJev } = await configuredModule(pins, assetBase);
      const info = await OpenJev.info({ model: pins.repo, device: 'webgpu', dtype: 'q4f16' });
      infoCached = info.isCached;
      post({ v: 1, type: 'info', isCached: info.isCached, downloadSize: info.downloadSize });
    } catch (e) {
      error('load', errMsg(e));
    }
  }

  function onLoad(): Promise<void> {
    if (!requireInit() || !pins) return Promise.resolve();
    if (loadedMsg) {
      post(loadedMsg);
      return Promise.resolve();
    }
    if (failedFatal) {
      error('load', 'previous_load_failed', true);
      return Promise.resolve();
    }
    loadPromise ??= doLoad(pins).finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  async function doLoad(p: PrelabelPins) {
    const t0 = now();
    const fail = (reason: string, code: Extract<FromWorker, { type: 'error' }>['code'], detail: string) => {
      failedFatal = true;
      post({ v: 1, type: 'capability', verdict: 'failed', reason, adapter: null });
      error(code, detail, true);
    };

    const cap = await probeCapability();
    if (cap.verdict !== 'ready') {
      post(cap);
      return;
    }

    let mod: Awaited<ReturnType<typeof configuredModule>>;
    let configSha: string;
    try {
      mod = await configuredModule(p, assetBase);
      const host = mod.env.remoteHost ?? 'https://huggingface.co/';
      const base = host.endsWith('/') ? host : `${host}/`;
      configSha = (await deps.fetchConfigSha(`${base}${p.repo}/resolve/${p.revision}/config.json`)).toLowerCase();
    } catch (e) {
      fail('load', 'load', errMsg(e));
      return;
    }
    if (configSha !== p.configSha) {
      fail('model_mismatch', 'model_mismatch', `config.json sha256 ${configSha} does not match the pinned ${p.configSha}`);
      return;
    }

    let progressEvents = 0;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let session: OpenJevLike;
    try {
      session = await mod.OpenJev.load({
        model: p.repo,
        device: 'webgpu',
        dtype: 'q4f16',
        temperature: p.temperature,
        truncation: 'cut',
        onProgress: (pr) => {
          progressEvents++;
          const t = now();
          if (pr.loaded >= pr.total || t - lastProgressAt >= PROGRESS_THROTTLE_MS) {
            lastProgressAt = t;
            post({ v: 1, type: 'progress', phase: 'download', loaded: pr.loaded, total: pr.total });
          }
        },
      });
    } catch (e) {
      fail('load', 'load', errMsg(e));
      return;
    }
    if (session.runtime.device !== 'webgpu' || session.runtime.dtype !== 'q4f16') {
      const detail = `runtime resolved to ${session.runtime.device}/${session.runtime.dtype}, expected webgpu/q4f16`;
      await session.dispose().catch(() => {});
      fail('load', 'load', detail);
      return;
    }
    post({ v: 1, type: 'progress', phase: 'session', loaded: 1, total: 1 });

    // Warmup doubles as the first-decision measurement (the spike saw ~200 ms).
    post({ v: 1, type: 'progress', phase: 'warmup', loaded: 0, total: 1 });
    const w0 = now();
    try {
      // A chat-only host has no labels: warm up on the route question it will actually ask.
      const wq = labels.length > 0 ? buildQuestion(labels) : null;
      const question = wq ? { type: 'choice' as const, instructions: wq.question, options: wq.options } : routeChoiceQuestion();
      await session.decide(WARMUP_STATE, [question], {
        temperature: p.temperature,
        truncation: 'cut',
      });
    } catch (e) {
      await session.dispose().catch(() => {});
      fail('first_decision', 'decide', errMsg(e));
      return;
    }
    const firstDecisionMs = now() - w0;
    post({ v: 1, type: 'progress', phase: 'warmup', loaded: 1, total: 1 });

    jev = session;
    loadedMsg = {
      v: 1,
      type: 'loaded',
      loadMs: now() - t0,
      fromCache: infoCached ?? progressEvents === 0,
      firstDecisionMs,
      runtime: {
        transformers: mod.env.version ?? 'unknown',
        ort: mod.ortVersion ?? mod.env.backends?.onnx?.versions?.web ?? 'unknown',
        openJev: '0.1.2',
        device: session.runtime.device,
        dtype: session.runtime.dtype,
      },
      configSha,
    };
    post(loadedMsg);
  }

  async function onRun(msg: Extract<ToWorker, { type: 'run' }>) {
    if (!requireInit() || !pins) return;
    if (!jev) {
      error('load', 'not_loaded');
      return;
    }
    if (activeRunId !== null) {
      error('decide', `run_in_progress:${activeRunId}`);
      return;
    }
    if (labels.length === 0) {
      error('decide', 'no_labels');
      return;
    }
    const session = jev;
    const { question, options } = buildQuestion(labels);
    const optionTokens = options.reduce((sum, l) => sum + session.countTokens(l), 0);
    if (optionTokens > MAX_OPTION_TOKENS) {
      error('label_set_too_large', `labels use ${optionTokens} tokens (limit ${MAX_OPTION_TOKENS})`);
      return;
    }
    const questionTokens = session.countTokens(question);
    const temperature = pins.temperature;
    const q = [{ type: 'choice' as const, instructions: question, options }];

    activeRunId = msg.runId;
    const start = now();
    const msList: number[] = [];
    let skipped = 0;
    let pending: PrelabelResult[] = [];
    let sent = 0;
    const flush = () => {
      if (pending.length === 0) return;
      post({ v: 1, type: 'results', runId: msg.runId, rows: pending });
      sent += pending.length;
      pending = [];
    };
    const push = (row: PrelabelResult) => {
      pending.push(row);
      if (pending.length >= (sent === 0 ? FIRST_CHUNK_ROWS : CHUNK_ROWS)) flush();
    };

    let cancelled = false;
    try {
      for (const item of msg.items) {
        if (cancelledRunId === msg.runId) {
          cancelled = true;
          break;
        }
        const row = await scoreItem(session, item, q, temperature, optionTokens + questionTokens);
        if (row.ok) msList.push(row.ms);
        else skipped++;
        push(row);
        await yieldTick();
      }
      if (cancelledRunId === msg.runId) cancelled = true;
    } finally {
      flush();
      activeRunId = null;
      if (cancelledRunId === msg.runId) cancelledRunId = null;
    }
    const sorted = [...msList].sort((a, b) => a - b);
    post({
      v: 1,
      type: 'done',
      runId: msg.runId,
      n: msList.length,
      skipped,
      cancelled,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      wallMs: now() - start,
    });
  }

  async function scoreItem(
    session: OpenJevLike,
    item: PrelabelItem,
    questions: Parameters<OpenJevLike['decide']>[1],
    temperature: number,
    fixedTokens: number,
  ): Promise<PrelabelResult> {
    if (item.description.trim() === '') return { txnId: item.txnId, ok: false, reason: 'empty_description' };
    if (!Number.isFinite(item.amount)) return { txnId: item.txnId, ok: false, reason: 'bad_amount' };
    const state = formatState(item);
    try {
      const stateTokens = session.countTokens(state);
      await acquireDecide(false);
      let answer: Awaited<ReturnType<OpenJevLike['decide']>>[number];
      let ms: number;
      try {
        const t0 = now();
        [answer] = await session.decide(state, questions, { temperature, truncation: 'cut' });
        ms = now() - t0;
      } finally {
        releaseDecide();
      }
      const top = topTwo(answer.probabilities);
      if (!top) return { txnId: item.txnId, ok: false, reason: 'decide_error' };
      return {
        txnId: item.txnId,
        ok: true,
        choice: top.top2[0][0],
        p1: top.p1,
        p2: top.p2,
        margin: top.margin,
        top2: top.top2,
        ms,
        stateTokens,
        // The library cuts trailing state tokens at maxStateTokens or when the sequence would exceed maxLength.
        truncated: stateTokens > MAX_STATE_TOKENS || stateTokens + fixedTokens > MAX_LENGTH_TOKENS,
      };
    } catch {
      return { txnId: item.txnId, ok: false, reason: 'decide_error' };
    }
  }

  async function onChoose(msg: Extract<ToWorker, { type: 'choose' }>) {
    const reply = (reason: Extract<Extract<FromWorker, { type: 'chosen' }>, { ok: false }>['reason']) =>
      post({ v: 1, type: 'chosen', reqId: msg.reqId, ok: false, reason });
    const session = jev;
    if (!session || !pins) return reply('not_loaded');
    const texts = msg.options.map((o) => (msg.descriptions?.[o] ? `${o}: ${msg.descriptions[o]}` : o));
    if (texts.reduce((sum, t) => sum + session.countTokens(t), 0) > MAX_OPTION_TOKENS) return reply('options_too_large');
    const question = {
      type: 'choice' as const,
      instructions: msg.question,
      options: msg.options,
      ...(msg.descriptions ? { descriptions: msg.descriptions } : {}),
    };
    await acquireDecide(true);
    try {
      // dispose() may have run while this request waited its turn.
      if (jev !== session) return reply('not_loaded');
      const t0 = now();
      const [answer] = await session.decide(msg.state, [question], { temperature: pins.temperature, truncation: 'cut' });
      const ms = now() - t0;
      const top = topTwo(answer.probabilities);
      if (!top) return reply('decide_error');
      post({
        v: 1, type: 'chosen', reqId: msg.reqId, ok: true,
        choice: top.top2[0][0], p1: top.p1, p2: top.p2, margin: top.margin, top2: top.top2, ms,
      });
    } catch {
      reply('decide_error');
    } finally {
      releaseDecide();
    }
  }

  async function onDispose() {
    if (activeRunId !== null) cancelledRunId = activeRunId;
    const session = jev;
    jev = null;
    loadedMsg = null;
    failedFatal = false;
    if (session) await session.dispose().catch(() => {});
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  async function handle(msg: ToWorker): Promise<void> {
    switch (msg.type) {
      case 'init':
        return onInit(msg);
      case 'probe':
        return onProbe();
      case 'info':
        return onInfo();
      case 'load':
        return onLoad();
      case 'run':
        return onRun(msg);
      case 'choose':
        return onChoose(msg);
      case 'cancel':
        // Synchronous: the run loop checks this between rows.
        if (activeRunId === msg.runId) cancelledRunId = msg.runId;
        return;
      case 'dispose':
        return onDispose();
    }
  }

  return { handle };
}
