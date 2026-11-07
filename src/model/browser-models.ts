/**
 * Browser model choice (specs/model-manager.md M5): validate any public Hub repo
 * for the in-tab WebGPU path, pin it to a commit, save it, and check pinned
 * models for upstream updates.
 *
 * Validation runs on the server, against the Hub API only (never the user's
 * data). The browser then proves the model with a real load and warmup (the
 * capability verdict) and can benchmark it.
 */

import {
  BROWSER_CHAT_MODEL_KEY,
  MODEL_CACHE_COS_KEY,
  getBrowserChatModelSetting,
  getLocalChatModelConfig,
  localChatCacheConfig,
  type BrowserChatModelSetting,
} from './local-chat.js';
import { DTYPE_FALLBACK_CHAIN, configDtypeFor, isOnnxDtype, onnxFileForDtype, type OnnxDtype } from './transformers-dtype.js';
import { isSupportedCausalLmType, TFJS_MODEL_TYPES } from './tfjs-model-types.js';
import { getModelsForProvider, WEBGPU_SINGLE_FILE_ONNX_MAX_BYTES } from '../utils/model.js';
import { setSetting } from '../utils/config.js';

const HUB = 'https://huggingface.co';
const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** Hub pipeline tags whose chat models can run text-only in the text-generation pipeline. */
const TEXT_CAPABLE_TAGS = new Set(['text-generation', 'image-text-to-text', 'any-to-any', 'text2text-generation']);

export type HubFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface BrowserModelValidation {
  ok: boolean;
  repo: string;
  /** Resolved commit sha (what gets pinned). */
  revision: string | null;
  dtype: OnnxDtype | null;
  /** Download bytes for the chosen dtype's text-generation files. */
  bytes: number | null;
  /** '~1.1GB'-style label for the UI and the in-tab progress line. */
  downloadSize: string | null;
  license: string | null;
  modelType: string | null;
  /** True when the repo is a catalog entry (vetted defaults). */
  catalog: boolean;
  errors: string[];
  warnings: string[];
}

interface HubModelInfo {
  sha?: string;
  private?: boolean;
  gated?: boolean | string;
  disabled?: boolean;
  pipeline_tag?: string;
  cardData?: { license?: string };
}

interface TreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { size?: number };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `~${(bytes / 1e9).toFixed(1)}GB`;
  return `~${Math.max(1, Math.round(bytes / 1e6))}MB`;
}

const SUFFIX: Record<string, OnnxDtype> = { '': 'fp32', _fp16: 'fp16', _quantized: 'q8', _int8: 'int8', _uint8: 'uint8', _q4: 'q4', _bnb4: 'bnb4', _q4f16: 'q4f16' };

/**
 * dtypes a repo can run as text generation, for both single-session exports
 * (`onnx/model<suffix>.onnx`) and multi-session ones (`onnx/decoder_model_merged<suffix>.onnx`).
 */
export function textGenerationDtypes(paths: readonly string[]): Set<OnnxDtype> {
  const out = new Set<OnnxDtype>();
  const re = /^onnx\/(model|decoder_model_merged)(_fp16|_quantized|_int8|_uint8|_q4f16|_q4|_bnb4)?\.onnx$/;
  for (const p of paths) {
    const m = re.exec(p);
    if (m) out.add(SUFFIX[m[2] ?? '']);
  }
  return out;
}

/** The files a text-generation load pulls for `dtype`, external-data shards included. */
export function filesForDtype(paths: readonly string[], dtype: OnnxDtype): string[] {
  const single = onnxFileForDtype(dtype);
  const suffix = single.replace(/^onnx\/model/, '');
  const roots = paths.includes(single) ? [single] : [`onnx/embed_tokens${suffix}`, `onnx/decoder_model_merged${suffix}`];
  return paths.filter((p) => roots.some((r) => p === r || p.startsWith(`${r}_data`)));
}

export async function validateBrowserModel(
  input: { repo?: unknown; revision?: unknown },
  deps: { fetch?: HubFetch; hubUrl?: string } = {},
): Promise<BrowserModelValidation> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as HubFetch);
  const hub = (deps.hubUrl ?? HUB).replace(/\/+$/, '');
  const repo = typeof input.repo === 'string' ? input.repo.trim().replace(/^https:\/\/huggingface\.co\//, '').replace(/\/+$/, '') : '';
  const result: BrowserModelValidation = {
    ok: false,
    repo,
    revision: null,
    dtype: null,
    bytes: null,
    downloadSize: null,
    license: null,
    modelType: null,
    catalog: getModelsForProvider('transformers').some((m) => m.id === `transformers:${repo}`),
    errors: [],
    warnings: [],
  };
  const fail = (msg: string) => {
    result.errors.push(msg);
    return result;
  };

  if (!REPO_RE.test(repo)) return fail('Enter a Hugging Face model id like owner/name.');
  const requested = input.revision === undefined || input.revision === null || input.revision === '' ? 'main' : input.revision;
  if (typeof requested !== 'string' || !(requested === 'main' || SHA_RE.test(requested))) {
    return fail('revision must be "main" or a 40-character commit sha.');
  }
  const enc = repo.split('/').map(encodeURIComponent).join('/');

  let info: HubModelInfo;
  try {
    const res = await fetchImpl(`${hub}/api/models/${enc}/revision/${encodeURIComponent(requested)}`);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return fail(`${repo} was not found on the Hub, or it is private or gated. Only public repos can run in the browser.`);
    }
    if (!res.ok) return fail(`The Hub did not answer for ${repo} (HTTP ${res.status}). Try again in a minute.`);
    info = (await res.json()) as HubModelInfo;
  } catch (err) {
    return fail(`Could not reach the Hugging Face Hub: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (info.private || (info.gated !== undefined && info.gated !== false)) {
    return fail(`${repo} is private or gated. The browser can't send a Hub token, so only public repos are supported.`);
  }
  if (info.disabled) return fail(`${repo} is disabled on the Hub.`);
  if (typeof info.sha !== 'string' || !SHA_RE.test(info.sha)) return fail(`The Hub returned no commit for ${repo}.`);
  result.revision = info.sha;
  result.license = info.cardData?.license ?? null;
  // Multimodal chat exports (Gemma 4 is 'any-to-any') load text-only through the
  // text-generation pipeline; the architecture check below is the real gate.
  if (info.pipeline_tag && !TEXT_CAPABLE_TAGS.has(info.pipeline_tag)) {
    return fail(`${repo} is a ${info.pipeline_tag} model. The browser chat needs a text-generation model.`);
  }
  if (info.pipeline_tag && info.pipeline_tag !== 'text-generation') {
    result.warnings.push(`${repo} is tagged ${info.pipeline_tag}; the browser chat uses it text only.`);
  }
  if (!info.pipeline_tag) result.warnings.push('The repo has no pipeline tag; assuming text generation.');
  if (!result.license) result.warnings.push('The repo declares no license. Check its terms before relying on it.');

  let tree: TreeEntry[];
  let config: Record<string, unknown> | null = null;
  try {
    const [treeRes, cfgRes] = await Promise.all([
      fetchImpl(`${hub}/api/models/${enc}/tree/${info.sha}/onnx?recursive=1`),
      fetchImpl(`${hub}/${enc}/resolve/${info.sha}/config.json`).catch(() => null),
    ]);
    if (treeRes.status === 404) return fail(`${repo} has no onnx/ folder. Transformers.js needs ONNX weights under onnx/.`);
    if (!treeRes.ok) return fail(`Could not list ${repo}'s ONNX files (HTTP ${treeRes.status}).`);
    tree = (await treeRes.json()) as TreeEntry[];
    if (cfgRes?.ok) config = (await cfgRes.json()) as Record<string, unknown>;
  } catch (err) {
    return fail(`Could not read ${repo} from the Hub: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sizes = new Map<string, number>();
  for (const e of Array.isArray(tree) ? tree : []) {
    if (e?.type === 'file' && typeof e.path === 'string') sizes.set(e.path, e.lfs?.size ?? e.size ?? 0);
  }
  const paths = [...sizes.keys()];

  result.modelType = typeof config?.model_type === 'string' ? config.model_type : null;
  if (!config) return fail(`${repo} has no readable config.json.`);
  if (!isSupportedCausalLmType(result.modelType)) {
    return fail(
      `model_type "${result.modelType ?? 'missing'}" isn't a text-generation architecture in transformers.js ${TFJS_MODEL_TYPES.version}.`,
    );
  }

  const available = textGenerationDtypes(paths);
  if (available.size === 0) return fail(`${repo} has no onnx/model*.onnx or onnx/decoder_model_merged*.onnx weights.`);
  const declared = configDtypeFor(config['transformers.js_config'], 'webgpu');
  const chain = DTYPE_FALLBACK_CHAIN.webgpu;
  const dtype: OnnxDtype | undefined =
    declared && available.has(declared) && (chain as readonly OnnxDtype[]).includes(declared) ? declared : chain.find((d) => available.has(d));
  if (!dtype) {
    return fail(`None of ${repo}'s ONNX weights (${[...available].join(', ')}) run on WebGPU (needs ${chain.join(' / ')}).`);
  }
  result.dtype = dtype;
  if (dtype === 'q4f16' || dtype === 'fp16') {
    result.warnings.push(`${dtype} needs a GPU with shader-f16; on other GPUs the browser falls back or reports unsupported.`);
  }

  const files = filesForDtype(paths, dtype);
  const bytes = files.reduce((n, f) => n + (sizes.get(f) ?? 0), 0);
  result.bytes = bytes;
  result.downloadSize = formatBytes(bytes);
  for (const f of files) {
    const sharded = paths.some((p) => p.startsWith(`${f}_data`));
    if (f.endsWith('.onnx') && !sharded && (sizes.get(f) ?? 0) > WEBGPU_SINGLE_FILE_ONNX_MAX_BYTES) {
      return fail(
        `${f} is a single ${formatBytes(sizes.get(f)!)} file. ONNX Runtime Web can't create a WebGPU session from a single file that large (#154); use an export with external data.`,
      );
    }
  }
  if (bytes > 4e9) result.warnings.push(`${result.downloadSize} is a large download for a browser tab.`);

  result.ok = true;
  return result;
}

// ── Settings + updates ──────────────────────────────────────────────────────

export interface BrowserModelsOverview {
  current: ReturnType<typeof getLocalChatModelConfig>;
  saved: BrowserChatModelSetting | null;
  catalog: Array<{ id: string; repo: string; displayName: string; dtype: string | null; revision: string | null; downloadSize: string | null }>;
  cache: { crossOriginStorage: boolean };
}

export function browserModelsOverview(): BrowserModelsOverview {
  return {
    current: getLocalChatModelConfig(),
    saved: getBrowserChatModelSetting(),
    catalog: getModelsForProvider('transformers')
      .filter((m) => m.device === 'webgpu')
      .map((m) => ({
        id: m.id,
        repo: m.id.replace(/^transformers:/, ''),
        displayName: m.displayName,
        dtype: m.dtype ?? null,
        revision: m.revision ?? null,
        downloadSize: m.downloadSize ?? null,
      })),
    cache: localChatCacheConfig(),
  };
}

/** Validate then save. A catalog repo keeps its vetted pin unless a revision is given. */
export async function saveBrowserModel(
  input: { repo?: unknown; revision?: unknown },
  deps: { fetch?: HubFetch; hubUrl?: string } = {},
): Promise<{ ok: true; saved: BrowserChatModelSetting; validation: BrowserModelValidation } | { ok: false; validation: BrowserModelValidation }> {
  const repoIn = typeof input.repo === 'string' ? input.repo.trim() : '';
  const catalogEntry = getModelsForProvider('transformers').find((m) => m.id === `transformers:${repoIn}` && m.device === 'webgpu');
  const revision = input.revision ?? catalogEntry?.revision;
  const validation = await validateBrowserModel({ repo: repoIn, revision }, deps);
  if (!validation.ok || !validation.revision || !validation.dtype) return { ok: false, validation };
  // The catalog's dtype pin is vetted on real GPUs; keep it when the repo still publishes it.
  const dtype: OnnxDtype =
    catalogEntry?.dtype && isOnnxDtype(catalogEntry.dtype) && validation.revision === catalogEntry.revision ? catalogEntry.dtype : validation.dtype;
  const saved: BrowserChatModelSetting = {
    repo: validation.repo,
    revision: validation.revision,
    dtype,
    ...(catalogEntry ? { displayName: catalogEntry.displayName } : {}),
    ...(catalogEntry?.downloadSize && validation.revision === catalogEntry.revision
      ? { downloadSize: catalogEntry.downloadSize }
      : validation.downloadSize
        ? { downloadSize: validation.downloadSize }
        : {}),
  };
  if (!setSetting(BROWSER_CHAT_MODEL_KEY, saved)) {
    validation.ok = false;
    validation.errors.push('Failed to save settings.');
    return { ok: false, validation };
  }
  return { ok: true, saved, validation };
}

export function resetBrowserModel(): boolean {
  return setSetting(BROWSER_CHAT_MODEL_KEY, null);
}

export function setModelCacheCos(enabled: boolean): boolean {
  return setSetting(MODEL_CACHE_COS_KEY, enabled === true);
}

export interface BrowserModelUpdate {
  repo: string;
  pinned: string;
  latest: string | null;
  updateAvailable: boolean;
  error?: string;
}

/** Compare the in-use browser model's pinned revision with Hub `main`. */
export async function checkBrowserModelUpdates(deps: { fetch?: HubFetch; hubUrl?: string } = {}): Promise<BrowserModelUpdate[]> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as HubFetch);
  const hub = (deps.hubUrl ?? HUB).replace(/\/+$/, '');
  const cfg = getLocalChatModelConfig();
  if (!cfg.enabled || !cfg.revision) return [];
  const enc = cfg.repo.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await fetchImpl(`${hub}/api/models/${enc}/revision/main`);
    if (!res.ok) return [{ repo: cfg.repo, pinned: cfg.revision, latest: null, updateAvailable: false, error: `HTTP ${res.status}` }];
    const sha = ((await res.json()) as HubModelInfo).sha ?? null;
    return [{ repo: cfg.repo, pinned: cfg.revision, latest: sha, updateAvailable: !!sha && sha !== cfg.revision }];
  } catch (err) {
    return [{ repo: cfg.repo, pinned: cfg.revision, latest: null, updateAvailable: false, error: err instanceof Error ? err.message : String(err) }];
  }
}
