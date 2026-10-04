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
import { getSetting } from '../utils/config.js';
import { getModelsForProvider } from '../utils/model.js';
import type { OnnxDtype } from './transformers-dtype.js';

export const LOCAL_CHAT_PROVIDER_ID = 'transformers';

/**
 * Where the browser downloads the model from: transformers.js's default
 * `env.remoteHost` (the client never overrides it). Consent copy only.
 */
export const LOCAL_CHAT_SOURCE_HOST = 'huggingface.co';

// ── Consent (per-profile settings.json, same pattern as prelabelEnabled) ─────
//
// Off by default: the first local answer downloads the model to the browser,
// so nothing local happens until an admin turns this on AND the browser's user
// clicks "Download once" (a per-browser opt-in the client keeps in
// localStorage, because the model cache is per browser).

export const LOCAL_CHAT_ENABLED_KEY = 'localChatEnabled';

/** Default off. Anything but a literal `true` in settings.json is off, and so is no profile at all. */
export function localChatEnabled(): boolean {
  try {
    return getSetting<unknown>(LOCAL_CHAT_ENABLED_KEY, false) === true;
  } catch {
    return false;
  }
}

/**
 * Bounds for the pre-fetched context bundle:
 * - days/limit shape the GET /api/transactions window (start/end/limit).
 * - maxChars is the size guard for a 0.6B-class context window: the rendered
 *   bundle is never allowed to exceed this many characters.
 */
export const LOCAL_CHAT_BUNDLE_DEFAULTS = {
  days: 30,
  limit: 200,
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
  /** `available && consented`: the browser attempts local only when true (and the browser opted in). */
  enabled: boolean;
  /** False when the provider registry has no fastModel. */
  available: boolean;
  /** The `localChatEnabled` setting (default false). */
  consented: boolean;
  /** Host the browser downloads the model from (consent copy). */
  sourceHost: string;
  /** The fastModel id verbatim, e.g. 'transformers:onnx-community/Qwen3-0.6B-ONNX'. */
  id: string;
  /** Hub repo with the provider prefix stripped, e.g. 'onnx-community/Qwen3-0.6B-ONNX'. */
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
  bundle: { days: number; limit: number; maxChars: number };
  subagent: LocalChatSubagentConfig;
}

/**
 * Derive the local-chat model config from the provider registry + model
 * catalog. Defensive by design: if `fastModel` is ever absent (or no longer
 * matches a catalog entry), `enabled` goes false so the browser silently uses
 * the server path instead of guessing a model. `enabled` is also false until
 * the `localChatEnabled` setting is on; the model fields are still filled so
 * the consent copy can name the model, its size and its source.
 */
export function getLocalChatModelConfig(): LocalChatModelConfig {
  const provider = getProviderById(LOCAL_CHAT_PROVIDER_ID);
  const fastModel = provider?.fastModel;

  const consented = localChatEnabled();

  if (!fastModel) {
    return {
      enabled: false,
      available: false,
      consented,
      sourceHost: LOCAL_CHAT_SOURCE_HOST,
      id: '',
      repo: '',
      displayName: '',
      downloadSize: '',
      dtype: null,
      bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
      subagent: localSubagentConfig(),
    };
  }

  const prefix = provider.modelPrefix; // 'transformers:'
  const repo = fastModel.startsWith(prefix) ? fastModel.slice(prefix.length) : fastModel;
  const catalogEntry = getModelsForProvider(LOCAL_CHAT_PROVIDER_ID).find((m) => m.id === fastModel);

  return {
    enabled: consented,
    available: true,
    consented,
    sourceHost: LOCAL_CHAT_SOURCE_HOST,
    id: fastModel,
    repo,
    displayName: catalogEntry?.displayName ?? repo,
    downloadSize: catalogEntry?.downloadSize ?? 'unknown',
    // The browser always runs WebGPU, so a pin only applies to a webgpu entry.
    dtype: catalogEntry?.device === 'webgpu' ? (catalogEntry.dtype ?? null) : null,
    bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
    subagent: localSubagentConfig(),
  };
}