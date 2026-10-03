/**
 * Hybrid chat client — browser-only orchestration for local-first WebGPU chat.
 *
 * Bundled ONLY into the prebuilt hybrid chunk (dist-hybrid/hybrid-chat.js via
 * vite.hybrid.config.ts); never into the singlefile React HTML, which loads
 * this chunk at runtime from /assets/hybrid-chat.js.
 *
 * Hard contract for the UIs: every failure path — no WebGPU, config/bundle
 * fetch failure, model load/download failure, generation error, tool-call or
 * NEED_MORE_DATA output — resolves {ok:false} (→ server path). Nothing here
 * ever throws into a UI catch block, so no hybrid-eligible failure can surface
 * as an error bubble. When the local MODEL itself failed, {ok:false} carries a
 * `detail` the UI shows as a small note, and the cause is console.warn'ed.
 */

import {
  buildBundle,
  buildLocalSystemPrompt,
  buildLocalUserMessage,
  classifyLocalOutput,
  isoDaysAgo,
  projectTransactions,
  shouldAttemptLocal,
  type BundleParams,
  type BundleTxnInput,
  type BundleWeekly,
  type HybridCapability,
  type HybridResult,
} from './core.js';
import { parseCategorizationDecision, type ParsedDecision } from '../demo/core.js';
import { isOnnxDtype, resolveTransformersDtype, type DtypeFetch } from '../../../../model/transformers-dtype.js';
import {
  capabilityKey,
  classifyLoadFailure,
  describeLoadFailure,
  parsePersistedCapability,
  restoreCapability,
  type LoadPhase,
  type PersistedCapability,
} from './capability.js';

export type { HybridResult } from './core.js';

/**
 * Structural fetch type — decouples the browser client from whichever global
 * fetch typing wins (DOM lib vs bun-types leaking into the UI tsconfig).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The slice of @huggingface/transformers the client uses. */
export interface TransformersModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline: (...args: any[]) => Promise<AnyPipeline>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any;
}

export interface HybridOpts {
  baseUrl: string;
  fetchImpl: FetchLike;
  /** Test hook: replaces the dynamic import of @huggingface/transformers. */
  loadTransformers?: () => Promise<TransformersModule>;
  /** Test hook: replaces the global fetch for Hub metadata requests. */
  hubFetch?: DtypeFetch;
}

/** A loadModel failure tagged with where it happened, for classification. */
class LoadFailure {
  constructor(
    readonly cause: unknown,
    readonly phase: LoadPhase,
    readonly dtype: string | null,
  ) {}
}

/** GET /api/config/local-chat response. */
export interface LocalChatConfigResponse {
  enabled: boolean;
  id: string;
  repo: string;
  displayName: string;
  downloadSize: string;
  /** Catalog-pinned ONNX dtype (e.g. 'q4f16'); null → resolve from the Hub file list. */
  dtype?: string | null;
  bundle: BundleParams;
}

/**
 * Whether the browser's WebGPU adapter exposes `shader-f16`, which fp16 and
 * q4f16 weights need. transformers.js 4.3.0 only pre-checks this for 'fp16',
 * so a q4f16 load on such a GPU would otherwise fail late, at session
 * creation. Undefined when it cannot be determined (treated as supported).
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

/**
 * Hub metadata requests go straight to huggingface.co with the global fetch,
 * never through the dashboard's fetchImpl (which may attach auth headers).
 */
const defaultHubFetch: DtypeFetch = (url, init) => globalThis.fetch(url, init);

/** Session-storage key for the per-session capability verdict (Track D). */
export const CAPABILITY_STORAGE_KEY = 'wilson-hybrid-capability';

type ProgressCb = (label: string) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPipeline = any;

interface ProgressEvent {
  status?: string;
  progress?: number;
  file?: string;
}

/**
 * Extract the assistant turn from a transformers.js pipeline result — the
 * same logic the server-side TransformersAdapter applies, shared by tryLocal
 * and categorizeSample.
 */
function extractAssistantText(result: unknown): string {
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

export function createHybridChat(opts: HybridOpts) {
  const fetchImpl = opts.fetchImpl;
  const base = opts.baseUrl.replace(/\/+$/, '');

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
  let configPromise: Promise<LocalChatConfigResponse | null> | null = null;
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

  // ── Capability probe (layers 1 and 2; layer 3 is loadModel) ────────────
  async function probe(): Promise<'ready' | 'unavailable' | 'failed'> {
    if (verdict !== 'unknown') return verdict;

    const nav = globalThis.navigator as Navigator | undefined;
    // Structural typing: WebGPU types may not be in every tsconfig's lib set.
    const gpu = (nav as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      verdict = 'unavailable';
      persist();
      return 'unavailable';
    }
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        verdict = 'unavailable';
        persist();
        return 'unavailable';
      }
    } catch {
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

  // ── Model load + real-generation proof (layer 3) ────────────────────────
  let pipelinePromise: Promise<AnyPipeline> | null = null;
  /** Repo the in-flight/loaded pipelinePromise is for. */
  let pipelineRepo: string | null = null;
  /** Reason the last load failed (any failure, not only dtype errors). */
  let lastLoadError: string | null = null;
  const loadTransformers =
    opts.loadTransformers ?? (() => import('@huggingface/transformers') as unknown as Promise<TransformersModule>);
  const hubFetch = opts.hubFetch ?? defaultHubFetch;

  async function loadModel(onProgress?: ProgressCb): Promise<AnyPipeline | null> {
    const cfg = await fetchConfig();
    if (!cfg) return null;
    syncWithConfig(cfg);

    if (!pipelinePromise || pipelineRepo !== cfg.repo) {
      pipelineRepo = cfg.repo;
      pipelinePromise = (async () => {
        let phase: LoadPhase = 'resolve';
        let dtypeUsed: string | null = isOnnxDtype(cfg.dtype) ? cfg.dtype : null;
        try {
          const { pipeline, env } = await loadTransformers();
          // Same-origin static ort binaries (scripts/copy-ort-web-assets.ts);
          // the library default points at a public CDN, which we must not need.
          // Main-thread inference (proxy=false) matches the server-side adapter.
          const onnx = env.backends?.onnx;
          if (onnx?.wasm) {
            onnx.wasm.wasmPaths = `${base}/assets/ort/`;
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
            catalogDtype: isOnnxDtype(cfg.dtype) ? cfg.dtype : undefined,
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
          // the model fails here → capability 'failed' for this config.
          phase = 'warmup';
          onProgress?.('Warming up local model…');
          await pipe([{ role: 'user', content: 'Reply with the single word OK.' }], {
            max_new_tokens: 16,
            do_sample: false,
          });
          return pipe;
        } catch (err) {
          throw new LoadFailure(err, phase, dtypeUsed);
        }
      })();
    }

    try {
      const pipe = await pipelinePromise;
      provenRepo = cfg.repo;
      lastLoadError = null;
      failureDetail = null;
      verdict = 'ready';
      persist();
      return pipe;
    } catch (thrown) {
      pipelinePromise = null;
      pipelineRepo = null;
      const failure = thrown instanceof LoadFailure ? thrown : new LoadFailure(thrown, 'load', null);
      // Always say why — a silently disabled local model is undebuggable.
      lastLoadError = describeLoadFailure(failure.cause, cfg.repo, failure.dtype);
      console.warn(`[hybrid-chat] local model load failed (${failure.phase}): ${lastLoadError}`, failure.cause);
      // Only a genuine capability failure sticks for the session (keyed by
      // config). Network errors, 404s and damaged caches retry next time.
      if (classifyLoadFailure(failure.cause, failure.phase) === 'capability') {
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
  async function tryLocal(
    query: string,
    onProgress?: ProgressCb,
    sessionId?: string | null,
  ): Promise<HybridResult> {
    try {
      if (verdict === 'unavailable') return { ok: false };

      const cfg = await fetchConfig();
      if (!cfg) return { ok: false };
      syncWithConfig(cfg);

      if (verdict === 'unknown') await probe();
      if (!shouldAttemptLocal(verdict)) return unavailableResult(verdict === 'failed' ? failureDetail : null);

      // ── Pre-fetched context bundle (localhost only, existing endpoints) ──
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

      // ── Model + generation ──────────────────────────────────────────────
      onProgress?.('Loading local model…');
      const pipe = await loadModel(onProgress);
      if (!pipe) return unavailableResult(lastLoadError);

      onProgress?.('Thinking locally…');
      const messages = [
        { role: 'system', content: buildLocalSystemPrompt(isoDaysAgo(0)) },
        { role: 'user', content: buildLocalUserMessage(bundle.text, query) },
      ];
      const result = await pipe(messages, { max_new_tokens: 256, do_sample: false });

      // Extract the assistant turn the same way the server-side adapter does.
      const rawOutput = extractAssistantText(result);

      const classified = classifyLocalOutput(rawOutput);
      if (classified.kind === 'handoff') {
        return { ok: false, reason: classified.reason };
      }

      // ── Record the locally-answered exchange (best-effort) ─────────────
      // Losing a history row must never become a user-facing error, so this
      // failure path still returns the answer.
      let recordedSessionId: string | null = null;
      try {
        const body: Record<string, unknown> = { query, answer: classified.text };
        const sid = sessionId ?? null;
        if (sid) body.sessionId = sid;
        const res = await fetchImpl(`${base}/api/chat/local`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as { sessionId?: string | null };
          recordedSessionId = data?.sessionId ?? null;
        }
      } catch {
        // best-effort only
      }

      return { ok: true, answer: classified.text, sessionId: recordedSessionId, source: 'local' };
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

      const cfg = await fetchConfig();
      if (!cfg) return failed('unavailable');
      syncWithConfig(cfg);

      if (verdict === 'unknown') await probe();
      if (verdict === 'failed') return failureDetail ? { ...failed('failed'), detail: failureDetail } : failed('failed');
      if (!shouldAttemptLocal(verdict)) return failed('unavailable');

      // Track whether this call initiated the model load, so the UI can say
      // "model already loaded (12 ms)" honestly.
      const wasLoaded = pipelinePromise !== null;

      opts.onProgress?.('Loading local model…');
      const loadStart = performance.now();
      const pipe = await loadModel(opts.onProgress);
      if (!pipe) return lastLoadError ? { ...failed('failed'), detail: lastLoadError } : failed('failed');
      const loadMs = performance.now() - loadStart;

      opts.onProgress?.('Thinking locally…');
      const genStart = performance.now();
      const result = await pipe(
        [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        // 128 tokens keeps the 0.6B model's JSON answer tight — a rambling
        // generation would falsify the timing story this demo is about.
        { max_new_tokens: 128, do_sample: false },
      );
      const decisionMs = performance.now() - genStart;

      const raw = extractAssistantText(result);
      const parsed = parseCategorizationDecision(raw);
      return {
        ok: true,
        model: cfg.repo,
        raw,
        decision: parsed.ok ? parsed.decision : null,
        decisionMs,
        loadMs,
        loadFresh: !wasLoaded,
      };
    } catch (err) {
      console.warn('[hybrid-chat] browser categorization failed:', err);
      return failed('error');
    }
  }

  return {
    probe,
    loadModel,
    tryLocal,
    categorizeSample,
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