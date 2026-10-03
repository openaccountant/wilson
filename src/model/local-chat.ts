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
import { getModelsForProvider } from '../utils/model.js';
import type { OnnxDtype } from './transformers-dtype.js';

export const LOCAL_CHAT_PROVIDER_ID = 'transformers';

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

export interface LocalChatModelConfig {
  /** False when the provider registry has no fastModel (browser skips local). */
  enabled: boolean;
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
}

/**
 * Derive the local-chat model config from the provider registry + model
 * catalog. Defensive by design: if `fastModel` is ever absent (or no longer
 * matches a catalog entry), `enabled` goes false so the browser silently uses
 * the server path instead of guessing a model.
 */
export function getLocalChatModelConfig(): LocalChatModelConfig {
  const provider = getProviderById(LOCAL_CHAT_PROVIDER_ID);
  const fastModel = provider?.fastModel;

  if (!fastModel) {
    return {
      enabled: false,
      id: '',
      repo: '',
      displayName: '',
      downloadSize: '',
      dtype: null,
      bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
    };
  }

  const prefix = provider.modelPrefix; // 'transformers:'
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
    bundle: { ...LOCAL_CHAT_BUNDLE_DEFAULTS },
  };
}