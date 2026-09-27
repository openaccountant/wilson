/**
 * Speed Showdown — race Wilson's local categorization decision against a
 * cloud round-trip for the SAME decision task (issue #92).
 *
 * Server-only module. Every timing on screen is a real, recorded number:
 * - live arms read the per-call duration `callLlm` just recorded into the
 *   trace store (returned additively on LlmResult),
 * - the simulated cloud arm times real local work (canned assembly + parse)
 *   and records it under provider 'simulated' so the trace store can never
 *   misattribute it as a real cloud call,
 * - the browser-local arm POSTs its measured performance.now() duration to
 *   the browser-trace recording endpoint (provider 'transformers-browser').
 *
 * Synthetic-only guard (structural, not a filter): both arms take only a
 * sample slug; the server resolves the in-repo ground-truth fixture and no
 * API accepts row payloads. An imported row is physically incapable of
 * entering a real-mode prompt because no code path feeds it to the builder.
 */

import { callLlm } from '../model/llm.js';
import { getProviderById } from '../providers.js';
import { checkApiKeyExistsForProvider } from '../utils/env.js';
import { traceStore } from '../utils/trace-store.js';
import { getLocalChatModelConfig } from '../model/local-chat.js';
import { warmTransformersPipeline } from '../model/providers/transformers.js';
import { buildCategorizationPrompt } from '../tools/categorize/prompt.js';
import { CATEGORIZER_SYSTEM_PROMPT } from '../tools/categorize/categorize.js';
import { getSampleBySlug, SAMPLE_TRANSACTIONS, type SampleTransaction } from './samples.js';

/**
 * The exact system prompt the production categorize tool uses — the demo
 * shares one string with it (single source of truth in categorize.ts).
 */
export const SHOWDOWN_SYSTEM_PROMPT = CATEGORIZER_SYSTEM_PROMPT;

// ── Trace-store provider markers ────────────────────────────────────────────

/**
 * The provider strings the two non-network arms write into the trace store.
 * Exported (byte-identical to the literals the arms have always recorded) so
 * the privacy ledger (#95) classifies them from this one source instead of
 * re-spelling the markers.
 */
export const SIMULATED_PROVIDER = 'simulated';
export const BROWSER_LOCAL_PROVIDER = 'transformers-browser';

// ── Labels (exact strings; mirrored in src/dashboard/ui/src/demo/core.ts) ───

export const LOCAL_BROWSER_LABEL = 'in your browser, on your GPU';
export const LOCAL_SERVER_LABEL = 'on this machine';
export const CLOUD_LIVE_LABEL = 'live call to OpenRouter';
export const CLOUD_SIMULATED_LABEL = 'simulated round-trip — no network';

// ── Cloud mode selection ────────────────────────────────────────────────────

export type CloudMode = 'live' | 'simulated';

/**
 * Live only when the key is present AND the network probe passed. Anything
 * else degrades honestly to a simulated round-trip. `networkOk === null`
 * means the probe never ran (no key) — that alone must never produce 'live'.
 */
export function resolveCloudMode(input: { hasKey: boolean; networkOk: boolean | null }): CloudMode {
  return input.hasKey === true && input.networkOk === true ? 'live' : 'simulated';
}

/** Matches the baseURL in src/model/providers/index.ts. */
export const OPENROUTER_PROBE_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_PROBE_TIMEOUT_MS = 2500;

/**
 * Small failover network probe for the cloud arm. Runs only when an API key
 * is present. Never throws: any failure (HTTP error, timeout, DNS) → false.
 */
export async function probeOpenRouterNetwork(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OPENROUTER_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetchImpl(OPENROUTER_PROBE_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Samples endpoint payload ────────────────────────────────────────────────

export interface ShowdownSamplesResponse {
  samples: Array<SampleTransaction & { userPrompt: string }>;
  systemPrompt: string;
  /** cloudModel = openrouter fastModel verbatim; local ids from the registry. */
  config: { cloudModel: string; localModel: string; localRepo: string };
}

/**
 * The user prompt for the identical decision task: the production
 * categorization prompt with the hardcoded category list (no dbCategories) so
 * the exhibit is deterministic and matches the in-repo fixtures.
 */
export function buildShowdownUserPrompt(sample: SampleTransaction): string {
  return buildCategorizationPrompt([
    { id: sample.id, description: sample.description, amount: sample.amount, date: sample.date },
  ]);
}

export function getShowdownSamples(): ShowdownSamplesResponse {
  const cfg = getLocalChatModelConfig();
  const cloudModel = getProviderById('openrouter')?.fastModel ?? '';
  return {
    samples: SAMPLE_TRANSACTIONS_CACHE,
    systemPrompt: SHOWDOWN_SYSTEM_PROMPT,
    config: { cloudModel, localModel: cfg.id, localRepo: cfg.repo },
  };
}

// Pre-rendered once — the prompt is pure and the fixtures are fixed.
const SAMPLE_TRANSACTIONS_CACHE: Array<SampleTransaction & { userPrompt: string }> =
  SAMPLE_TRANSACTIONS.map((sample) => ({ ...sample, userPrompt: buildShowdownUserPrompt(sample) }));

// ── Arms ────────────────────────────────────────────────────────────────────

export interface ShowdownDeps {
  /** Default: the real callLlm. */
  callLlmImpl?: typeof callLlm;
  /** Default: checkApiKeyExistsForProvider('openrouter'). */
  hasKey?: boolean;
  /** Default: probeOpenRouterNetwork() — runs ONLY when hasKey is true. */
  probe?: () => Promise<boolean>;
  /** Default: warmTransformersPipeline (server local arm only). */
  warm?: (model: string) => Promise<{ loadMs: number; loadedFresh: boolean }>;
}

export interface ShowdownArmResult {
  ok: boolean;
  /** Exact mode/source label, always stating what ran. */
  label: string;
  model: string;
  /** Cloud arm only: which mode actually ran. */
  mode?: CloudMode;
  /** ALWAYS the recorded per-call duration when ok — never a fabricated number. */
  decisionMs: number | null;
  traceId: string | null;
  /** Raw model output text (UI parses it for display). */
  raw?: string;
  /** Simulated arm only: the canned decision. */
  decision?: { id: number; category: string; confidence: number } | null;
  decisionSource?: 'canned';
  /** The exact exhibit — what leaves your machine. */
  payload: { system: string; user: string };
  /** Cloud arm only: whether the network probe actually ran. */
  probeRan?: boolean;
  /** Local arm only: measured model-load time, shown separately. */
  loadMs?: number;
  loadFresh?: boolean;
  /** Set when ok=false (arm failed honestly — rendered inline, not a crash). */
  error?: string;
}

/**
 * Cloud arm: a real OpenRouter round-trip for the identical decision task
 * when a key is present and the network is reachable; otherwise a
 * clearly-labeled simulated round-trip timer over the same payload.
 */
export async function runShowdownCloudArm(
  slug: string,
  deps: ShowdownDeps = {},
): Promise<ShowdownArmResult> {
  const sample = getSampleBySlug(slug); // throws on unknown id → endpoint 400s
  const user = buildShowdownUserPrompt(sample);
  const payload = { system: SHOWDOWN_SYSTEM_PROMPT, user };

  const cloudModel = getProviderById('openrouter')?.fastModel ?? '';
  const apiModel = cloudModel.replace(/^openrouter:/, '');

  const hasKey = deps.hasKey ?? checkApiKeyExistsForProvider('openrouter');
  let networkOk: boolean | null = null;
  if (hasKey) {
    networkOk = await (deps.probe ?? probeOpenRouterNetwork)();
  }
  const mode = resolveCloudMode({ hasKey, networkOk });

  if (mode === 'live') {
    try {
      const result = await (deps.callLlmImpl ?? callLlm)(user, {
        model: cloudModel,
        systemPrompt: SHOWDOWN_SYSTEM_PROMPT,
        callType: 'demo-showdown',
      });
      return {
        ok: true,
        mode,
        label: CLOUD_LIVE_LABEL,
        model: apiModel,
        decisionMs: result.durationMs,
        traceId: result.traceId,
        raw: result.response.content,
        payload,
        probeRan: true,
      };
    } catch (err) {
      return {
        ok: false,
        mode,
        label: CLOUD_LIVE_LABEL,
        model: apiModel,
        decisionMs: null,
        traceId: null,
        payload,
        probeRan: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Simulated round-trip: time real local work (canned-response assembly plus
  // the parse the UI would perform). Never presented as network latency.
  const simStart = performance.now();
  const canned = `{"transactions":[{"id":${sample.id},"category":"${sample.expectedCategory}","confidence":0.99}]}`;
  JSON.parse(canned); // real local work
  const measuredMs = performance.now() - simStart;

  const recorded = recordSimulatedCloudTrace({
    apiModel,
    userPrompt: user,
    cannedResponse: canned,
    measuredMs,
  });

  return {
    ok: true,
    mode: 'simulated',
    label: CLOUD_SIMULATED_LABEL,
    model: `simulated:${apiModel}`,
    decisionMs: recorded.durationMs,
    traceId: recorded.traceId,
    raw: canned,
    decision: { id: sample.id, category: sample.expectedCategory, confidence: 0.99 },
    decisionSource: 'canned',
    payload,
    probeRan: hasKey,
  };
}

/**
 * Server-side local arm: the transformers provider (spec-49 hybrid's server
 * path), used when the browser cannot run WebGPU. Model load time is measured
 * separately from the timed decision call.
 */
export async function runShowdownLocalServerArm(
  slug: string,
  deps: ShowdownDeps = {},
): Promise<ShowdownArmResult> {
  const sample = getSampleBySlug(slug); // throws on unknown id → endpoint 400s
  const user = buildShowdownUserPrompt(sample);
  const payload = { system: SHOWDOWN_SYSTEM_PROMPT, user };

  const cfg = getLocalChatModelConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      label: LOCAL_SERVER_LABEL,
      model: '',
      decisionMs: null,
      traceId: null,
      payload,
      error: 'local model not configured',
    };
  }

  let loadMs: number | undefined;
  let loadFresh: boolean | undefined;
  try {
    const loaded = await (deps.warm ?? warmTransformersPipeline)(cfg.repo);
    loadMs = loaded.loadMs;
    loadFresh = loaded.loadedFresh;

    const result = await (deps.callLlmImpl ?? callLlm)(user, {
      model: cfg.id,
      systemPrompt: SHOWDOWN_SYSTEM_PROMPT,
      callType: 'demo-showdown',
      maxTokens: 128,
    });

    return {
      ok: true,
      label: LOCAL_SERVER_LABEL,
      model: cfg.repo,
      decisionMs: result.durationMs,
      traceId: result.traceId,
      raw: result.response.content,
      payload,
      loadMs,
      loadFresh,
    };
  } catch (err) {
    return {
      ok: false,
      label: LOCAL_SERVER_LABEL,
      model: cfg.repo,
      decisionMs: null,
      traceId: null,
      payload,
      loadMs,
      loadFresh,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Trace recording (simulated + browser arms) ──────────────────────────────

/**
 * Record the simulated cloud round-trip. The provider 'simulated' marker and
 * `simulated:<model>` name keep these rows forever attributable — and no
 * interaction row is written, so a simulated run never looks like a real LLM
 * interaction anywhere in the dashboard.
 */
export function recordSimulatedCloudTrace(input: {
  apiModel: string;
  userPrompt: string;
  cannedResponse: string;
  measuredMs: number;
}): { traceId: string; durationMs: number } {
  const durationMs = Math.max(0, Math.round(input.measuredMs));
  const trace = {
    id: `${Date.now()}-showdown-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    model: `simulated:${input.apiModel}`,
    provider: SIMULATED_PROVIDER,
    promptLength: input.userPrompt.length,
    responseLength: input.cannedResponse.length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs,
    status: 'ok' as const,
  };
  traceStore.record(trace);
  // Deliberately NO interactionStore call here.
  return { traceId: trace.id, durationMs };
}

export interface BrowserTraceBody {
  model?: unknown;
  decisionMs?: unknown;
  ok?: unknown;
  error?: unknown;
  slug?: unknown;
}

/**
 * Record the browser-local arm's measured decision time (provider
 * 'transformers-browser') so every on-screen timer is a recorded trace row.
 * Throws on invalid input (the endpoint turns that into a 400). No
 * interaction row — this is a measurement, not a server-side LLM interaction.
 */
export function recordBrowserLocalTrace(body: BrowserTraceBody): { traceId: string; durationMs: number } {
  const model = typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
  if (!model) {
    throw new Error('model is required');
  }
  const n = typeof body?.decisionMs === 'number' ? body.decisionMs : NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('decisionMs must be a finite non-negative number');
  }
  const ok = body?.ok === true;
  const error = typeof body?.error === 'string' ? body.error : undefined;
  const durationMs = Math.round(n);
  const trace = {
    id: `${Date.now()}-showdown-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    model,
    provider: BROWSER_LOCAL_PROVIDER,
    promptLength: 0,
    responseLength: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs,
    status: (ok ? 'ok' : 'error') as 'ok' | 'error',
    ...(error !== undefined ? { error } : {}),
  };
  traceStore.record(trace);
  return { traceId: trace.id, durationMs };
}