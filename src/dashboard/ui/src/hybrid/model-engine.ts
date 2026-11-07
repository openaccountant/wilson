/**
 * Model engine — everything that touches transformers.js: the L2 adapter
 * probe, dtype resolution, pipeline creation + warmup, and generation.
 *
 * Runs inside the model Web Worker (model.worker.ts), which injects a static
 * `loadTransformers`. It is also what the hybrid client falls back to
 * in-thread when a test supplies its own `loadTransformers` hook, so this
 * module must never import transformers.js itself: that keeps it loadable
 * under bun and keeps the main-thread part of hybrid-chat.js free of a second
 * transformers copy (spec D1 rule 1).
 */

import {
  buildLocalSystemPrompt,
  buildLocalUserMessage,
  classifyLocalOutput,
  type LocalVerdict,
} from './core.js';
import type { LoadPhase } from './capability.js';
import { createLoadProgressReporter, IN_TAB_WARMUP_LABEL } from './load-progress.js';
import { isOnnxDtype, resolveTransformersDtype, type DtypeFetch } from '../../../../model/transformers-dtype.js';
import {
  createModelCache,
  hubManifestFetcher,
  requestPersistentStorage,
  type CacheEvent,
  type CacheLike,
  type CacheStats,
  type CosLike,
  type ModelCache,
  type PersistResult,
} from './model-cache.js';
import type {
  BenchResult,
  CategorizeResult,
  LoadCacheReport,
  LoadResult,
  ProbeResult,
  WorkerCategorizeOpts,
  WorkerError,
  WorkerModelConfig,
} from './worker-protocol.js';

/** The slice of @huggingface/transformers the engine uses. */
export interface TransformersModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline: (...args: any[]) => Promise<AnyPipeline>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any;
  /** Lets a run stop a generation mid-flight (transformers.js exports it; optional so fakes can omit it). */
  InterruptableStoppingCriteria?: new () => { interrupt(): void };
  /** Token streaming for the benchmark's first-token timing (optional so fakes can omit it). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TextStreamer?: new (tokenizer: any, opts: Record<string, unknown>) => unknown;
  /** Cache inspection (transformers.js 4.x; optional so fakes can omit it). */
  ModelRegistry?: {
    is_pipeline_cached?: (task: string, modelId: string, options?: Record<string, unknown>) => Promise<boolean>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPipeline = any;

export type ProgressCb = (label: string) => void;

export interface ModelEngineOpts {
  /** The transformers.js module. Injected: the worker passes a static import, tests pass a fake. */
  loadTransformers: () => Promise<TransformersModule>;
  /** Hub metadata requests go straight to huggingface.co, never through an authed fetch. */
  hubFetch?: DtypeFetch;
  /**
   * The weight cache's dependencies (specs/model-manager.md M4). Defaults read
   * the browser globals; tests inject fakes. `openCache: null` disables the
   * custom cache (transformers.js then uses its own Cache API store).
   */
  openCache?: (() => Promise<CacheLike>) | null;
  /** `navigator.crossOriginStorage`, consulted only when the model config enables COS. */
  cos?: () => CosLike | null | undefined;
  /** `navigator.storage`, for persist(). */
  storage?: () => { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } | undefined;
  /** Manifest fetch for COS keys and pinned-revision migration (default: the Hub tree API). */
  manifestFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Monotonic clock (ms); tests inject one. */
  now?: () => number;
}

/** The transformers.js Cache API store name (unchanged, so caches from earlier builds still hit). */
export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

function defaultOpenCache(): (() => Promise<CacheLike>) | null {
  const c = (globalThis as { caches?: { open(name: string): Promise<CacheLike> } }).caches;
  return c ? () => c.open(TRANSFORMERS_CACHE_NAME) : null;
}

function defaultCos(): CosLike | null {
  const nav = globalThis.navigator as { crossOriginStorage?: CosLike } | undefined;
  return nav?.crossOriginStorage ?? null;
}

function defaultStorage() {
  return (globalThis.navigator as { storage?: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } } | undefined)
    ?.storage;
}

/** Adapter identity for benchmark records. Never throws. */
async function adapterInfo(): Promise<BenchResult['adapter']> {
  try {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    const adapter = (await gpu?.requestAdapter?.()) as
      | { info?: { vendor?: string; architecture?: string }; features?: { has(n: string): boolean } }
      | null
      | undefined;
    return {
      vendor: adapter?.info?.vendor || null,
      architecture: adapter?.info?.architecture || null,
      shaderF16: adapter?.features ? adapter.features.has('shader-f16') : null,
    };
  } catch {
    return { vendor: null, architecture: null, shaderF16: null };
  }
}

/**
 * The benchmark prompt: synthetic ledger rows, never user data. Fixed, so
 * numbers are comparable across models, revisions and machines.
 */
export const BENCH_MESSAGES = [
  {
    role: 'system',
    content: 'You are a bookkeeping assistant. Answer with one short sentence.',
  },
  {
    role: 'user',
    content: [
      'Transactions (date, merchant, amount):',
      '2026-10-01, Corner Grocery, -82.14',
      '2026-10-02, City Transit, -2.75',
      '2026-10-03, Payroll Deposit, 2450.00',
      '2026-10-05, Coffee Spot, -4.60',
      '2026-10-07, Electric Utility, -96.31',
      '2026-10-09, Corner Grocery, -55.02',
      '2026-10-12, Streaming Service, -15.99',
      '2026-10-15, Rent Payment, -1400.00',
      '2026-10-18, Hardware Store, -38.47',
      '2026-10-21, Coffee Spot, -5.10',
      '2026-10-24, Pharmacy, -22.89',
      '2026-10-28, Corner Grocery, -61.70',
      'Describe the spending pattern in this month, then list each grocery transaction with its amount.',
    ].join('\n'),
  },
] as const;

export const BENCH_MAX_NEW_TOKENS = 128;

function countTokens(ids: unknown): number {
  if (Array.isArray(ids)) return Array.isArray(ids[0]) ? (ids[0] as unknown[]).length : ids.length;
  const dims = (ids as { dims?: number[] } | null)?.dims;
  return Array.isArray(dims) ? dims[dims.length - 1] : 0;
}

/** An engine failure that already carries the WorkerError the client classifies. */
export class EngineError extends Error {
  constructor(
    readonly info: WorkerError,
    readonly original?: unknown,
  ) {
    super(info.message);
    this.name = 'EngineError';
  }
}

/** Coerce anything thrown into a WorkerError (never throws). */
export function toWorkerError(err: unknown, fallbackPhase: WorkerError['phase'] = 'generate'): WorkerError {
  if (err instanceof EngineError) return err.info;
  const e = err as { message?: unknown } | null;
  const message = err instanceof Error ? err.message : typeof e?.message === 'string' ? e.message : String(err);
  return { phase: fallbackPhase, message };
}

/**
 * Whether the adapter exposes `shader-f16`, which fp16 and q4f16 weights need.
 * transformers.js 4.3.x (still true in 4.3.2) only pre-checks this for 'fp16', so a q4f16 load on
 * such a GPU would otherwise fail late, at session creation. Undefined when it
 * cannot be determined (treated as supported).
 */
async function detectShaderF16(): Promise<boolean | undefined> {
  try {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    const adapter = (await gpu?.requestAdapter?.()) as { features?: { has(name: string): boolean } } | null | undefined;
    if (!adapter?.features) return undefined;
    return adapter.features.has('shader-f16');
  } catch {
    return undefined;
  }
}

const defaultHubFetch: DtypeFetch = (url, init) => globalThis.fetch(url, init);

/** Upper bound on the pre-load cache check; past it the load reports as a download. */
const CACHE_CHECK_TIMEOUT_MS = 3000;

/**
 * Are all of the pipeline's files in the Cache API? Undefined when it cannot
 * be told (no ModelRegistry, an error, or too slow): the caller then labels
 * the load as a download, the only wording that is true on a first use.
 */
async function isPipelineCached(
  tf: TransformersModule,
  repo: string,
  dtype: string,
  revision?: string,
): Promise<boolean | undefined> {
  const registry = tf.ModelRegistry;
  if (typeof registry?.is_pipeline_cached !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      registry
        .is_pipeline_cached('text-generation', repo, { dtype, device: 'webgpu', ...(revision ? { revision } : {}) })
        .then((v) => v === true),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CACHE_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Extract the assistant turn from a transformers.js pipeline result — the
 * same logic the server-side TransformersAdapter applies.
 */
export function extractAssistantText(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generated = (result as any)?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    return typeof last === 'object' && last !== null && 'content' in last
      ? String((last as { content: unknown }).content)
      : String(last ?? '');
  }
  if (typeof generated === 'string') return generated;
  return '';
}

/** One generation for the subagent loop (router, next-action, compose). */
export interface GenerateOpts {
  system: string;
  user: string;
  maxNewTokens: number;
  /** Aborting interrupts the generation; it then resolves with whatever was produced. */
  signal?: AbortSignal;
}

export function createModelEngine(engineOpts: ModelEngineOpts) {
  const hubFetch = engineOpts.hubFetch ?? defaultHubFetch;
  const now = engineOpts.now ?? (() => performance.now());
  const openCache = engineOpts.openCache === undefined ? defaultOpenCache() : engineOpts.openCache;
  let model: WorkerModelConfig | null = null;
  let origin = '';

  /** The installed weight cache and the COS setting it was built for. */
  let modelCache: ModelCache | null = null;
  let modelCacheCos: boolean | null = null;
  let persistResult: PersistResult | null = null;
  /** Counts for the load in progress (reset right before pipeline()). */
  let report: LoadCacheReport | null = null;

  function onCacheEvent(e: CacheEvent): void {
    if (!report) return;
    if (e.kind === 'hit' && (e.source === 'cos' || e.source === 'cache' || e.source === 'migrated')) report.hits[e.source]++;
    else if (e.kind === 'miss') report.misses++;
    else if (e.kind === 'store' && e.source === 'cos-write') report.storedBytes.cos += e.bytes ?? 0;
    else if (e.kind === 'store' && e.source === 'cache-write') report.storedBytes.cache += e.bytes ?? 0;
  }

  /** Install (or rebuild, when the COS flag changed) the custom cache on transformers.js's env. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function installCache(env: any, wantCos: boolean): ModelCache | null {
    if (!openCache) return null;
    if (modelCache && modelCacheCos === wantCos) return modelCache;
    const cos = wantCos ? (engineOpts.cos ?? defaultCos)() : null;
    modelCache = createModelCache({
      openCache,
      cos,
      fetchManifest: hubManifestFetcher(engineOpts.manifestFetch ?? ((u, i) => globalThis.fetch(u, i)), env.remoteHost),
      hubHost: typeof env.remoteHost === 'string' ? env.remoteHost : undefined,
      onEvent: onCacheEvent,
    });
    modelCacheCos = wantCos;
    env.useCustomCache = true;
    env.customCache = modelCache;
    return modelCache;
  }

  let pipelinePromise: Promise<{
    pipe: AnyPipeline;
    dtype: string | null;
    cache?: LoadCacheReport;
    cached: boolean | null;
  }> | null = null;
  /** Repo the in-flight/loaded pipelinePromise is for. */
  let pipelineRepo: string | null = null;
  /** The transformers module the loaded pipeline came from (for InterruptableStoppingCriteria). */
  let tfModule: TransformersModule | null = null;

  /** Apply (or change) the model choice. A different repo drops the loaded pipeline. */
  function setModel(next: WorkerModelConfig, nextOrigin: string): void {
    model = next;
    origin = nextOrigin.replace(/\/+$/, '');
    if (pipelineRepo !== null && pipelineRepo !== next.repo) {
      pipelinePromise = null;
      pipelineRepo = null;
    }
  }

  /** Layer 2: a real adapter from this very scope (the worker is what will run the model). */
  async function probe(): Promise<ProbeResult> {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') return 'unavailable';
    try {
      return (await gpu.requestAdapter()) ? 'ready' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  function startLoad(cfg: WorkerModelConfig, onProgress?: ProgressCb) {
    pipelineRepo = cfg.repo;
    pipelinePromise = (async () => {
      let phase: LoadPhase = 'resolve';
      let cachedBefore: boolean | undefined;
      let dtypeUsed: string | null = isOnnxDtype(cfg.catalogDtype) ? cfg.catalogDtype : null;
      try {
        const loaded = await engineOpts.loadTransformers();
        tfModule = loaded;
        const { pipeline, env } = loaded;
        // Same-origin static ort binaries (scripts/copy-ort-web-assets.ts);
        // the library default points at a public CDN, which we must not need.
        // We are already off the main thread, so no ORT proxy worker.
        const onnx = env.backends?.onnx;
        if (onnx?.wasm) {
          onnx.wasm.wasmPaths = `${origin}/assets/ort/`;
          onnx.wasm.proxy = false;
        }
        env.allowLocalModels = false;
        const cache = installCache(env, cfg.crossOriginStorage === true);
        // Ask once per worker for persistent storage: multi-GB weights are the
        // first thing a browser evicts under pressure. Reported, never required.
        persistResult ??= await requestPersistentStorage((engineOpts.storage ?? defaultStorage)());
        const revision = cfg.revision ?? undefined;

        // Shared resolver (same module as the server adapter): the catalog
        // pin from /api/config/local-chat wins without network; only a GPU
        // without shader-f16 (or an uncatalogued repo) consults the Hub file
        // list. Never a hardcoded dtype — repos publish different subsets.
        const { dtype } = await resolveTransformersDtype(cfg.repo, 'webgpu', {
          catalogDtype: isOnnxDtype(cfg.catalogDtype) ? cfg.catalogDtype : undefined,
          shaderF16: await detectShaderF16(),
          fetchImpl: hubFetch,
          hubUrl: env.remoteHost,
          revision,
        });
        dtypeUsed = dtype;

        // "Downloading" (with the catalog size) unless every file is already
        // cached: transformers.js reports a cache read and a download alike.
        const progress = createLoadProgressReporter({
          cached: (cachedBefore = await isPipelineCached(loaded, cfg.repo, dtype, revision)),
          downloadSize: cfg.downloadSize,
          emit: (label) => onProgress?.(label),
        });

        phase = 'load';
        report = {
          hits: { cos: 0, cache: 0, migrated: 0 },
          misses: 0,
          storedBytes: { cos: 0, cache: 0 },
          cosActive: cache?.cosActive ?? false,
          persisted: persistResult.unsupported ? null : persistResult.persisted,
        };
        const pipe: AnyPipeline = await pipeline('text-generation', cfg.repo, {
          device: 'webgpu',
          dtype,
          ...(revision ? { revision } : {}),
          progress_callback: progress,
        });

        // Layer 3 — a real generation doubles as warmup and is the only proof
        // that counts. An adapter that passes requestAdapter() but cannot run
        // the model fails here -> capability 'failed' for this config.
        phase = 'warmup';
        onProgress?.(IN_TAB_WARMUP_LABEL);
        await pipe([{ role: 'user', content: 'Reply with the single word OK.' }], {
          max_new_tokens: 16,
          do_sample: false,
        });
        const cacheReport = report ?? undefined;
        report = null;
        return { pipe, dtype: dtypeUsed, cache: cacheReport, cached: cachedBefore ?? null };
      } catch (err) {
        report = null;
        const e = err as { name?: unknown; code?: unknown } | null;
        const info: WorkerError = {
          phase,
          message: err instanceof Error ? err.message : String(err),
          dtype: dtypeUsed,
        };
        if (e && e.name === 'TransformersDtypeError' && typeof e.code === 'string') info.code = e.code;
        throw new EngineError(info, err);
      }
    })();
    return pipelinePromise;
  }

  /** Create the pipeline (or reuse it). A failed load is forgotten so the next call retries. */
  async function load(onProgress?: ProgressCb): Promise<LoadResult> {
    if (!model) throw new EngineError({ phase: 'protocol', message: 'model engine used before init' });
    const cfg = model;
    const t0 = performance.now();
    const fresh = !pipelinePromise || pipelineRepo !== cfg.repo;
    const inflight = fresh ? startLoad(cfg, onProgress) : pipelinePromise!;
    try {
      const { dtype, cache } = await inflight;
      return { loadMs: performance.now() - t0, loadFresh: fresh, dtype, ...(fresh && cache ? { cache } : {}) };
    } catch (err) {
      if (pipelinePromise === inflight) {
        pipelinePromise = null;
        pipelineRepo = null;
      }
      throw err;
    }
  }

  async function pipe(): Promise<AnyPipeline> {
    if (!pipelinePromise) await load();
    return (await pipelinePromise!).pipe;
  }

  /** One bundle-mode generation. A generation failure is an EngineError('generate'). */
  async function bundleAnswer(query: string, bundleText: string, today: string): Promise<LocalVerdict> {
    try {
      const p = await pipe();
      const messages = [
        { role: 'system', content: buildLocalSystemPrompt(today) },
        { role: 'user', content: buildLocalUserMessage(bundleText, query) },
      ];
      const result = await p(messages, { max_new_tokens: 256, do_sample: false });
      return classifyLocalOutput(extractAssistantText(result));
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(toWorkerError(err, 'generate'), err);
    }
  }

  /** Speed Showdown: one single-row categorization generation. */
  async function categorize(opts: WorkerCategorizeOpts): Promise<CategorizeResult> {
    try {
      const p = await pipe();
      const genStart = performance.now();
      const result = await p(
        [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        // 128 tokens keeps the 0.6B model's JSON answer tight — a rambling
        // generation would falsify the timing story this demo is about.
        { max_new_tokens: 128, do_sample: false },
      );
      return { raw: extractAssistantText(result), decisionMs: performance.now() - genStart };
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(toWorkerError(err, 'generate'), err);
    }
  }

  /**
   * One greedy generation with a token cap and an optional interrupt. A failure
   * is an EngineError('generate'): the GPU session may be poisoned, so callers
   * (the subagent runner) report a device fault and the worker is respawned.
   */
  async function generate(opts: GenerateOpts): Promise<string> {
    try {
      const p = await pipe();
      const callOpts: Record<string, unknown> = { max_new_tokens: opts.maxNewTokens, do_sample: false };
      let cleanup = () => {};
      const Criteria = tfModule?.InterruptableStoppingCriteria;
      if (opts.signal && Criteria) {
        const criteria = new Criteria();
        callOpts.stopping_criteria = criteria;
        const stop = () => criteria.interrupt();
        if (opts.signal.aborted) stop();
        else opts.signal.addEventListener('abort', stop, { once: true });
        cleanup = () => opts.signal?.removeEventListener('abort', stop);
      }
      try {
        const result = await p(
          [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          callOpts,
        );
        return extractAssistantText(result);
      } finally {
        cleanup();
      }
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(toWorkerError(err, 'generate'), err);
    }
  }

  /** Hub files in the weight cache (M4). Empty when the custom cache is not installed yet. */
  async function cacheStats(): Promise<CacheStats & { persisted: boolean | null }> {
    const persisted = persistResult && !persistResult.unsupported ? persistResult.persisted : null;
    if (!modelCache) {
      if (!openCache) return { groups: [], totalBytes: 0, cosActive: false, persisted };
      const tf = await engineOpts.loadTransformers();
      installCache(tf.env, model?.crossOriginStorage === true);
    }
    return { ...(await modelCache!.stats()), persisted };
  }

  /** Remove a repo's cached files. A loaded pipeline for it is dropped so the next use reloads cleanly. */
  async function cacheClear(repo: string, revision?: string): Promise<{ removed: number }> {
    if (!modelCache) {
      if (!openCache) return { removed: 0 };
      const tf = await engineOpts.loadTransformers();
      installCache(tf.env, model?.crossOriginStorage === true);
    }
    const removed = await modelCache!.clear({ repo, revision });
    if (pipelineRepo === repo) {
      pipelinePromise = null;
      pipelineRepo = null;
    }
    return { removed };
  }

  /**
   * M6: one fixed-prompt, greedy generation. First-token latency comes from the
   * streamer's first token callback; decode rate excludes that first token.
   */
  async function bench(): Promise<BenchResult> {
    if (!model) throw new EngineError({ phase: 'protocol', message: 'model engine used before init' });
    const cfg = model;
    const loaded = await load();
    const { cached } = await pipelinePromise!;
    try {
      const p = await pipe();
      const tf = tfModule ?? (await engineOpts.loadTransformers());
      let promptTokens = 0;
      try {
        promptTokens = countTokens(
          p.tokenizer?.apply_chat_template?.(BENCH_MESSAGES, { add_generation_prompt: true, tokenize: true, return_tensor: false }),
        );
      } catch {
        promptTokens = 0;
      }
      let first: number | null = null;
      let last = 0;
      let newTokens = 0;
      const onToken = (tokens: unknown) => {
        const t = now();
        if (first === null) first = t;
        last = t;
        newTokens += Array.isArray(tokens) ? tokens.length || 1 : 1;
      };
      const callOpts: Record<string, unknown> = { max_new_tokens: BENCH_MAX_NEW_TOKENS, do_sample: false };
      if (tf.TextStreamer && p.tokenizer) {
        callOpts.streamer = new tf.TextStreamer(p.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          token_callback_function: onToken,
        });
      }
      const t0 = now();
      const result = await p(BENCH_MESSAGES, callOpts);
      const tEnd = now();
      if (first === null) {
        // No streamer (older build or fake): count the generated tokens after the fact.
        const text = extractAssistantText(result);
        newTokens = countTokens(p.tokenizer?.encode?.(text) ?? []) || text.split(/\s+/).filter(Boolean).length;
        first = tEnd;
        last = tEnd;
      }
      const decodeMs = last - first;
      return {
        repo: cfg.repo,
        revision: cfg.revision ?? null,
        dtype: loaded.dtype,
        loadMs: loaded.loadMs,
        cached,
        firstTokenMs: first - t0,
        decodeTokPerSec: newTokens > 1 && decodeMs > 0 ? (newTokens - 1) / (decodeMs / 1000) : 0,
        promptTokens,
        newTokens,
        adapter: await adapterInfo(),
        transformersVersion: typeof tf.env?.version === 'string' ? tf.env.version : null,
        at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(toWorkerError(err, 'generate'), err);
    }
  }

  return { setModel, probe, load, bundleAnswer, categorize, generate, cacheStats, cacheClear, bench };
}

export type ModelEngine = ReturnType<typeof createModelEngine>;
