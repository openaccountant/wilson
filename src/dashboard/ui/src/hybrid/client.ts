/**
 * Hybrid chat client — browser-only orchestration for local-first WebGPU chat.
 *
 * Bundled ONLY into the prebuilt hybrid chunk (dist-hybrid/hybrid-chat.js via
 * vite.hybrid.config.ts); never into the singlefile React HTML, which loads
 * this chunk at runtime from /assets/hybrid-chat.js.
 *
 * Hard contract for the UIs: every failure path — no WebGPU, config/bundle
 * fetch failure, model load/download failure, generation error, tool-call or
 * NEED_MORE_DATA output — resolves {ok:false} (→ silent server path). Nothing
 * here ever throws into a UI catch block, so no hybrid-eligible failure can
 * surface as an error bubble.
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

export type { HybridResult } from './core.js';

/**
 * Structural fetch type — decouples the browser client from whichever global
 * fetch typing wins (DOM lib vs bun-types leaking into the UI tsconfig).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HybridOpts {
  baseUrl: string;
  fetchImpl: FetchLike;
}

/** GET /api/config/local-chat response. */
export interface LocalChatConfigResponse {
  enabled: boolean;
  id: string;
  repo: string;
  displayName: string;
  downloadSize: string;
  bundle: BundleParams;
}

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
  let verdict: HybridCapability = 'unknown';
  let provenRepo: string | null = null;
  try {
    const raw = sessionStorage.getItem(CAPABILITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { verdict?: HybridCapability; repo?: string | null };
      if (parsed.verdict === 'ready' || parsed.verdict === 'unavailable' || parsed.verdict === 'failed') {
        verdict = parsed.verdict;
        provenRepo = parsed.repo ?? null;
      }
    }
  } catch {
    // storage unavailable — start from 'unknown'
  }

  function persist(): void {
    try {
      sessionStorage.setItem(CAPABILITY_STORAGE_KEY, JSON.stringify({ verdict, repo: provenRepo }));
    } catch {
      // storage unavailable — session-only behavior degrades gracefully
    }
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
    // (e.g. adapter without shader-f16 fails fp16 session creation).
    verdict = 'ready';
    persist();
    return 'ready';
  }

  // ── Model load + real-generation proof (layer 3) ────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipelinePromise: Promise<AnyPipeline> | null = null;

  async function loadModel(onProgress?: ProgressCb): Promise<AnyPipeline | null> {
    const cfg = await fetchConfig();
    if (!cfg) return null;

    if (!pipelinePromise || provenRepo !== cfg.repo) {
      pipelinePromise = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Same-origin static ort binaries (scripts/copy-ort-web-assets.ts);
        // the library default points at a public CDN, which we must not need.
        // Main-thread inference (proxy=false) matches the server-side adapter.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onnx = (env as any).backends?.onnx;
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

        const pipe: AnyPipeline = await pipeline('text-generation', cfg.repo, {
          device: 'webgpu',
          dtype: 'fp16',
          progress_callback: progress,
        });

        // Layer 3 — a real generation doubles as warmup and is the only proof
        // that counts. An adapter that passes requestAdapter() but cannot run
        // the model fails here → capability 'failed' for the session.
        onProgress?.('Warming up local model…');
        await pipe([{ role: 'user', content: 'Reply with the single word OK.' }], {
          max_new_tokens: 16,
          do_sample: false,
        });
        return pipe;
      })();
    }

    try {
      const pipe = await pipelinePromise;
      provenRepo = cfg.repo;
      verdict = 'ready';
      persist();
      return pipe;
    } catch {
      pipelinePromise = null;
      verdict = 'failed';
      persist();
      return null;
    }
  }

  // ── Local attempt ───────────────────────────────────────────────────────
  async function tryLocal(
    query: string,
    onProgress?: ProgressCb,
    sessionId?: string | null,
  ): Promise<HybridResult> {
    try {
      if (!shouldAttemptLocal(verdict)) return { ok: false };
      if (verdict === 'unknown') await probe();
      if (!shouldAttemptLocal(verdict)) return { ok: false };

      const cfg = await fetchConfig();
      if (!cfg) return { ok: false };

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
      if (!pipe) return { ok: false };

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
    } catch {
      // Any unexpected failure silently hands off to the server path.
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
      if (!shouldAttemptLocal(verdict)) return failed('unavailable');
      if (verdict === 'unknown') await probe();
      if (!shouldAttemptLocal(verdict)) return failed('unavailable');

      const cfg = await fetchConfig();
      if (!cfg) return failed('unavailable');

      // Track whether this call initiated the model load, so the UI can say
      // "model already loaded (12 ms)" honestly.
      const wasLoaded = pipelinePromise !== null;

      opts.onProgress?.('Loading local model…');
      const loadStart = performance.now();
      const pipe = await loadModel(opts.onProgress);
      if (!pipe) return failed('failed');
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
    } catch {
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
}

export interface CategorizeSampleOpts {
  systemPrompt: string;
  userPrompt: string;
  onProgress?: (label: string) => void;
}