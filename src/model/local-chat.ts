/**
 * Local-first hybrid chat model config.
 *
 * The dashboard can answer chat locally in the browser (WebGPU via
 * transformers.js) when the question can be answered from a pre-fetched view
 * of the user's own transactions, and falls back silently to the server agent
 * otherwise.
 *
 * The model choice rides the existing `fastModel` routing field on the
 * `transformers` provider (src/providers.ts) — the single place it is named.
 * Everything here is derived from the provider registry and the model catalog;
 * the model id is never duplicated.
 */

import { getProviderById } from '../providers.js';
import { PRELABEL_MODEL, type PrelabelModelPins } from '../prelabel/config.js';
import { getModelsForProvider } from '../utils/model.js';
import { getSetting } from '../utils/config.js';
import { isOnnxDtype, type OnnxDtype } from './transformers-dtype.js';

export const LOCAL_CHAT_PROVIDER_ID = 'transformers';

/**
 * Bounds for the pre-fetched context bundle:
 * - the window is calendar months, not a day count: the browser fetches from
 *   the 1st of last month through today (bundleWindow in
 *   src/dashboard/ui/src/hybrid/core.ts), so "this month" and "last month"
 *   are well-posed and their totals can be computed in JS.
 * - limit caps that GET /api/transactions fetch. The computed totals are summed
 *   over every fetched row, so it is sized for two calendar months of a busy
 *   household; a full page marks the totals unreliable (dollar-total answers
 *   then hand off to the server).
 * - maxChars is the size guard for a small in-tab model's context window: the
 *   rendered bundle is never allowed to exceed this many characters (rows are
 *   dropped first; the totals never are).
 */
export const LOCAL_CHAT_BUNDLE_DEFAULTS = {
  limit: 500,
  maxChars: 6000,
} as const;

/**
 * Browser subagent (specs/browser-subagent.md). OFF until slice 8's go/no-go;
 * flipping the default is a one-line change here, in its own commit. The env
 * override exists for local verification only (the live-Chrome script in the
 * spec); only the literal '1' enables it.
 */
export const LOCAL_SUBAGENT_DEFAULTS = { enabled: false, maxSteps: 3, compose: 'template', openJevRouter: false } as const;

/**
 * How the subagent writes a local answer (specs/DECISIONS.md "Round 3"): 'template' = deterministic per-tool
 * templates (the product default); 'model' = the on-device model composes it (kept for comparison).
 */
export type LocalSubagentCompose = 'template' | 'model';

/** The pins the browser's open-jev worker accepts: the pre-labeler's pins minus the consent-copy-only byte count. */
export type OpenJevWirePins = Omit<PrelabelModelPins, 'approxDownloadBytes'>;

export interface LocalChatSubagentConfig {
  enabled: boolean;
  /** Tool executions per run (the client clamps it to 1..4). */
  maxSteps: number;
  compose: LocalSubagentCompose;
  /**
   * Round 4 (specs/browser-subagent-round4-openjev-router.md §4.4): the on-device open-jev tiebreak for
   * questions the keyword router cannot decide. OFF by default; needs `enabled` AND the user's earlier
   * "Download once" consent in the Review tab. The env override is for local testing only.
   */
  openJevRouter: boolean;
  /** The one pinned open-jev model, sent only when `openJevRouter` is on (null otherwise). */
  openJevPins: OpenJevWirePins | null;
}

function localSubagentConfig(): LocalChatSubagentConfig {
  const forced = process.env.WILSON_LOCAL_SUBAGENT === '1';
  // Comparison arm only: the literal 'model' selects the model writer, anything else is the template.
  const compose: LocalSubagentCompose = process.env.WILSON_LOCAL_SUBAGENT_COMPOSE === 'model' ? 'model' : LOCAL_SUBAGENT_DEFAULTS.compose;
  // Literal '1' only, as for WILSON_LOCAL_SUBAGENT.
  const openJevRouter = process.env.WILSON_LOCAL_SUBAGENT_OPENJEV === '1' || LOCAL_SUBAGENT_DEFAULTS.openJevRouter;
  let openJevPins: OpenJevWirePins | null = null;
  if (openJevRouter) {
    const { approxDownloadBytes: _bytes, ...pins } = PRELABEL_MODEL;
    void _bytes;
    openJevPins = pins;
  }
  return { enabled: forced || LOCAL_SUBAGENT_DEFAULTS.enabled, maxSteps: LOCAL_SUBAGENT_DEFAULTS.maxSteps, compose, openJevRouter, openJevPins };
}

export interface LocalChatModelConfig {
  /** False when the provider registry has no fastModel (browser skips local). */
  enabled: boolean;
  /** The fastModel id verbatim, e.g. 'transformers:onnx-community/gemma-4-E2B-it-ONNX'. */
  id: string;
  /** Hub repo with the provider prefix stripped, e.g. 'onnx-community/gemma-4-E2B-it-ONNX'. */
  repo: string;
  /** Display name from the model catalog. */
  displayName: string;
  /** Approximate first-run download size from the model catalog. */
  downloadSize: string;
  /**
   * ONNX dtype pinned by the catalog entry (e.g. 'q4f16'), so the browser loads
   * exactly onnx/model_<dtype>.onnx without probing the Hub. Null when the
   * fastModel is not catalogued — the browser then resolves it from the Hub
   * file list with the shared resolver (src/model/transformers-dtype.ts).
   */
  dtype: OnnxDtype | null;
  /**
   * 40-hex Hub commit every file loads from (specs/model-manager.md M2). Null only
   * for an uncatalogued fastModel with no pin: the browser then loads `main`.
   */
  revision: string | null;
  /** Where the choice came from: the admin's Browser model setting, or the provider fastModel. */
  source: 'setting' | 'fastModel' | 'none';
  /** Browser weight cache options (M4). */
  cache: LocalChatCacheConfig;
  bundle: { limit: number; maxChars: number };
  subagent: LocalChatSubagentConfig;
}

export interface LocalChatCacheConfig {
  /** Use Cross-Origin Storage for model weights when the browser has it. Default off. */
  crossOriginStorage: boolean;
}

/** settings.json key for the COS flag (specs/model-manager-DECISIONS.md M-D3). */
export const MODEL_CACHE_COS_KEY = 'modelCache.crossOriginStorage';

/** settings.json key for the admin's browser chat model (M5). */
export const BROWSER_CHAT_MODEL_KEY = 'browserChatModel';

/** What POST /api/models/browser saves (always validated against the Hub first). */
export interface BrowserChatModelSetting {
  repo: string;
  revision: string;
  dtype: OnnxDtype;
  displayName?: string;
  downloadSize?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A settings read that can't fail: with no active profile (tests, early boot)
 * there are no settings, so the defaults apply. This config is defensive by design.
 */
function readSetting<T>(key: string, fallback: T): T {
  try {
    return getSetting<T>(key, fallback);
  } catch {
    return fallback;
  }
}

/** The saved Browser model setting, or null when absent or malformed (malformed is ignored, never trusted). */
export function getBrowserChatModelSetting(): BrowserChatModelSetting | null {
  const raw = readSetting<unknown>(BROWSER_CHAT_MODEL_KEY, null);
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) return null;
  if (typeof r.revision !== 'string' || !SHA_RE.test(r.revision)) return null;
  if (!isOnnxDtype(r.dtype)) return null;
  return {
    repo: r.repo,
    revision: r.revision,
    dtype: r.dtype,
    ...(typeof r.displayName === 'string' ? { displayName: r.displayName } : {}),
    ...(typeof r.downloadSize === 'string' ? { downloadSize: r.downloadSize } : {}),
  };
}

export function localChatCacheConfig(): LocalChatCacheConfig {
  return {
    crossOriginStorage: process.env.WILSON_MODEL_COS === '1' || readSetting<unknown>(MODEL_CACHE_COS_KEY, false) === true,
  };
}

/**
 * Derive the local-chat model config from the provider registry + model
 * catalog. Defensive by design: if `fastModel` is ever absent (or no longer
 * matches a catalog entry), `enabled` goes false so the browser silently uses
 * the server path instead of guessing a model.
 */
export function getLocalChatModelConfig(): LocalChatModelConfig {
  const provider = getProviderById(LOCAL_CHAT_PROVIDER_ID);
  const prefix = provider?.modelPrefix ?? 'transformers:';

  // The admin's Browser model (validated when saved) wins over the provider default.
  const chosen = getBrowserChatModelSetting();
  if (chosen) {
    const catalogEntry = getModelsForProvider(LOCAL_CHAT_PROVIDER_ID).find((m) => m.id === `${prefix}${chosen.repo}`);
    return {
      enabled: true,
      id: `${prefix}${chosen.repo}`,
      repo: chosen.repo,
      displayName: chosen.displayName ?? catalogEntry?.displayName ?? chosen.repo,
      downloadSize: chosen.downloadSize ?? catalogEntry?.downloadSize ?? 'unknown',
      dtype: chosen.dtype,
      revision: chosen.revision,
      source: 'setting',
      cache: localChatCacheConfig(),
      bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
      subagent: localSubagentConfig(),
    };
  }

  const fastModel = provider?.fastModel;

  if (!fastModel) {
    return {
      enabled: false,
      id: '',
      repo: '',
      displayName: '',
      downloadSize: '',
      dtype: null,
      revision: null,
      source: 'none',
      cache: localChatCacheConfig(),
      bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
      subagent: localSubagentConfig(),
    };
  }

  const repo = fastModel.startsWith(prefix) ? fastModel.slice(prefix.length) : fastModel;
  const catalogEntry = getModelsForProvider(LOCAL_CHAT_PROVIDER_ID).find((m) => m.id === fastModel);

  return {
    enabled: true,
    id: fastModel,
    repo,
    displayName: catalogEntry?.displayName ?? repo,
    downloadSize: catalogEntry?.downloadSize ?? 'unknown',
    // The browser always runs WebGPU, so a pin only applies to a webgpu entry.
    dtype: catalogEntry?.device === 'webgpu' ? (catalogEntry.dtype ?? null) : null,
    revision: catalogEntry?.revision ?? null,
    source: 'fastModel',
    cache: localChatCacheConfig(),
    bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
    subagent: localSubagentConfig(),
  };
}