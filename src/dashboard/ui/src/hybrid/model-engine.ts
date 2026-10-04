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
import { isOnnxDtype, resolveTransformersDtype, type DtypeFetch } from '../../../../model/transformers-dtype.js';
import type {
  CategorizeResult,
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPipeline = any;

export type ProgressCb = (label: string) => void;

export interface ModelEngineOpts {
  /** The transformers.js module. Injected: the worker passes a static import, tests pass a fake. */
  loadTransformers: () => Promise<TransformersModule>;
  /** Hub metadata requests go straight to huggingface.co, never through an authed fetch. */
  hubFetch?: DtypeFetch;
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
 * transformers.js 4.3.0 only pre-checks this for 'fp16', so a q4f16 load on
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

interface ProgressEvent {
  status?: string;
  progress?: number;
  file?: string;
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
  let model: WorkerModelConfig | null = null;
  let origin = '';

  let pipelinePromise: Promise<{ pipe: AnyPipeline; dtype: string | null }> | null = null;
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

        const progress = (p: ProgressEvent) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            onProgress?.(`Downloading local model… ${Math.round(p.progress)}%`);
          } else if (p.status === 'initiate') {
            onProgress?.('Downloading local model…');
          }
        };

        // Shared resolver (same module as the server adapter): the catalog
        // pin from /api/config/local-chat wins without network; only a GPU
        // without shader-f16 (or an uncatalogued repo) consults the Hub file
        // list. Never a hardcoded dtype — repos publish different subsets.
        const { dtype } = await resolveTransformersDtype(cfg.repo, 'webgpu', {
          catalogDtype: isOnnxDtype(cfg.catalogDtype) ? cfg.catalogDtype : undefined,
          shaderF16: await detectShaderF16(),
          fetchImpl: hubFetch,
          hubUrl: env.remoteHost,
        });
        dtypeUsed = dtype;

        phase = 'load';
        const pipe: AnyPipeline = await pipeline('text-generation', cfg.repo, {
          device: 'webgpu',
          dtype,
          progress_callback: progress,
        });

        // Layer 3 — a real generation doubles as warmup and is the only proof
        // that counts. An adapter that passes requestAdapter() but cannot run
        // the model fails here -> capability 'failed' for this config.
        phase = 'warmup';
        onProgress?.('Warming up local model…');
        await pipe([{ role: 'user', content: 'Reply with the single word OK.' }], {
          max_new_tokens: 16,
          do_sample: false,
        });
        return { pipe, dtype: dtypeUsed };
      } catch (err) {
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
      const { dtype } = await inflight;
      return { loadMs: performance.now() - t0, loadFresh: fresh, dtype };
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

  return { setModel, probe, load, bundleAnswer, categorize, generate };
}

export type ModelEngine = ReturnType<typeof createModelEngine>;
