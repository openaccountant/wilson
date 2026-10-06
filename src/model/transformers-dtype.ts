/**
 * ONNX dtype resolution for Transformers.js text-generation models.
 *
 * Shared by BOTH loaders: the server adapter (src/model/providers/transformers.ts,
 * onnxruntime-node in Bun) and the browser hybrid client
 * (src/dashboard/ui/src/hybrid/client.ts, onnxruntime-web on WebGPU). It is
 * deliberately pure: no Node/Bun imports and no transformers.js import, so Vite
 * can bundle it into the browser chunk. Network access goes through an
 * injectable fetch.
 *
 * Transformers.js 4.x loads `onnx/model<suffix>.onnx` for the requested dtype
 * and fails hard (`Could not locate file`) when that exact file is missing; it
 * never falls back to another dtype. Hub repos ship different dtype subsets
 * (granite-4.0-micro-ONNX-web publishes only q4f16), so no single hardcoded
 * dtype works for every repo. Resolution order:
 *
 *   1. Explicit catalog dtype (src/utils/model.ts) — no network when the
 *      pinned file is already cached (or no cache probe is supplied). When a
 *      cache probe says the pin is NOT cached, one Hub metadata request checks
 *      reachability: online, the pin still wins (it is about to download);
 *      offline, step 5's local-cache walk runs instead, so an offline user
 *      whose cache holds a different dtype still loads.
 *   2. Hub metadata, fetched once per repo and cached in memory: the onnx/
 *      file list (api/models/<repo> siblings) and config.json's
 *      `transformers.js_config`.
 *   3. The repo-declared default (`transformers.js_config.dtype`, with the
 *      `device_config[device]` overlay) when that file exists and suits the
 *      device.
 *   4. The first available dtype in the device's fallback chain.
 *   5. Hub unreachable (offline / air-gapped / rate-limited / 5xx): an
 *      optional caller-supplied probe of locally cached dtypes, then `'auto'`
 *      (which makes Transformers.js honour the cached config's dtype).
 *
 * A Hub answer of 401/403/404 is NOT "unreachable": the repo does not exist or
 * is gated/private, so resolution fails fast with a TransformersDtypeError
 * (`repo-not-found`) instead of degrading to `'auto'` (which on WebGPU would
 * download the largest, fp32, weights).
 */

/** Concrete ONNX dtypes Transformers.js 4.x maps to a file suffix. */
export type OnnxDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16';

/** Where a text-generation pipeline runs. */
export type TransformersDevice = 'webgpu' | 'cpu';

/** A resolved dtype, or `'auto'` when nothing better could be determined offline. */
export type ResolvedDtype = OnnxDtype | 'auto';

/** File suffix → dtype, mirroring DEFAULT_DTYPE_SUFFIX_MAPPING in transformers.js 4.3.0. */
const SUFFIX_TO_DTYPE: Record<string, OnnxDtype> = {
  '': 'fp32',
  _fp16: 'fp16',
  _quantized: 'q8',
  _int8: 'int8',
  _uint8: 'uint8',
  _q4: 'q4',
  _bnb4: 'bnb4',
  _q4f16: 'q4f16',
};

const ALL_DTYPES = new Set<string>(Object.values(SUFFIX_TO_DTYPE));

/** dtypes whose kernels need fp16 arithmetic (WebGPU `shader-f16` in the browser). */
const F16_DTYPES = new Set<OnnxDtype>(['fp16', 'q4f16']);

/**
 * Preference order per device. q4f16 first on WebGPU (smallest, fastest on a
 * GPU with fp16); q4 first on CPU. q8/int8/uint8/bnb4 never run on WebGPU.
 */
export const DTYPE_FALLBACK_CHAIN = {
  webgpu: ['q4f16', 'fp16', 'q4', 'fp32'],
  /** Browser WebGPU on an adapter without the `shader-f16` feature. */
  webgpuNoF16: ['q4', 'fp32'],
  cpu: ['q4', 'q4f16', 'int8', 'q8', 'uint8', 'fp32'],
} as const satisfies Record<string, readonly OnnxDtype[]>;

export function isOnnxDtype(value: unknown): value is OnnxDtype {
  return typeof value === 'string' && ALL_DTYPES.has(value);
}

/** The relative file Transformers.js loads for the main `model` session at `dtype`. */
export function onnxFileForDtype(dtype: OnnxDtype): string {
  const suffix = Object.keys(SUFFIX_TO_DTYPE).find((s) => SUFFIX_TO_DTYPE[s] === dtype) ?? '';
  return `onnx/model${suffix}.onnx`;
}

const MODEL_FILE_RE = /^onnx\/model(_fp16|_quantized|_int8|_uint8|_q4f16|_q4|_bnb4)?\.onnx$/;

/**
 * Collect the dtypes a repo publishes from its file list (`onnx/model.onnx` →
 * fp32, `onnx/model_quantized.onnx` → q8, …). External-data chunks
 * (`.onnx_data*`) and non-standard names (e.g. `model_q8.onnx`, which
 * Transformers.js cannot request) are ignored.
 */
export function dtypesFromFileList(files: readonly string[]): Set<OnnxDtype> {
  const out = new Set<OnnxDtype>();
  for (const f of files) {
    const m = MODEL_FILE_RE.exec(f);
    if (m) out.add(SUFFIX_TO_DTYPE[m[1] ?? '']);
  }
  return out;
}

export type DtypeErrorCode = 'no-onnx-weights' | 'no-usable-dtype' | 'requires-shader-f16' | 'repo-not-found';

/** A repo that cannot be loaded at all on the requested device — a clear, early error. */
export class TransformersDtypeError extends Error {
  constructor(
    message: string,
    readonly code: DtypeErrorCode,
    readonly repo: string,
  ) {
    super(message);
    this.name = 'TransformersDtypeError';
  }
}

function chainFor(device: TransformersDevice, shaderF16?: boolean): readonly OnnxDtype[] {
  if (device === 'cpu') return DTYPE_FALLBACK_CHAIN.cpu;
  return shaderF16 === false ? DTYPE_FALLBACK_CHAIN.webgpuNoF16 : DTYPE_FALLBACK_CHAIN.webgpu;
}

/** Pull a dtype out of a config value that may be a string or a per-session object. */
function sessionDtype(value: unknown): unknown {
  if (value && typeof value === 'object') return (value as Record<string, unknown>).model;
  return value;
}

/**
 * The repo-declared default dtype for `device`: `transformers.js_config.dtype`
 * with `device_config[device].dtype` overlaid, exactly as transformers.js
 * applies it. Undefined when the config declares none.
 */
export function configDtypeFor(tjsConfig: unknown, device: TransformersDevice): OnnxDtype | undefined {
  if (!tjsConfig || typeof tjsConfig !== 'object') return undefined;
  const cfg = tjsConfig as { dtype?: unknown; device_config?: Record<string, { dtype?: unknown } | undefined> };
  const overlay = sessionDtype(cfg.device_config?.[device]?.dtype);
  const base = sessionDtype(cfg.dtype);
  const picked = overlay ?? base;
  return isOnnxDtype(picked) ? picked : undefined;
}

export interface PickDtypeInput {
  repo: string;
  device: TransformersDevice;
  /** dtypes the repo publishes (see dtypesFromFileList). */
  available: ReadonlySet<OnnxDtype> | readonly OnnxDtype[];
  /** Repo-declared default (see configDtypeFor). */
  configDtype?: OnnxDtype;
  /** Browser only: whether the WebGPU adapter has `shader-f16`. Undefined = assume yes. */
  shaderF16?: boolean;
}

/**
 * Pure dtype choice over a known file set (steps 3-4). Throws a
 * TransformersDtypeError with an actionable message when nothing fits.
 */
export function pickDtype(input: PickDtypeInput): OnnxDtype {
  const { repo, device, configDtype, shaderF16 } = input;
  const available = new Set(input.available);
  const chain = chainFor(device, shaderF16);

  if (available.size === 0) {
    throw new TransformersDtypeError(
      `no ONNX weights for ${repo}: no onnx/model*.onnx files found. Transformers.js needs an onnx/ folder ` +
        `(onnxruntime-genai and root-level exports are not supported).`,
      'no-onnx-weights',
      repo,
    );
  }

  if (configDtype && available.has(configDtype) && chain.includes(configDtype)) return configDtype;

  for (const dtype of chain) if (available.has(dtype)) return dtype;

  const has = [...available].sort().join(', ');
  if (device === 'webgpu' && shaderF16 === false && [...available].some((d) => F16_DTYPES.has(d))) {
    throw new TransformersDtypeError(
      `${repo} requires a GPU with WebGPU shader-f16 support: it only publishes ${has} weights, ` +
        `and this browser's GPU adapter does not expose shader-f16.`,
      'requires-shader-f16',
      repo,
    );
  }
  throw new TransformersDtypeError(
    `no ONNX weights for ${repo} in any of: ${chain.join(', ')} (${device}); the repo publishes: ${has}.`,
    'no-usable-dtype',
    repo,
  );
}

// ── Hub metadata (cached per repo) ─────────────────────────────────────────

/** Structural fetch type, so this module never depends on a DOM or Bun lib. */
export type DtypeFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Options shared by every Hub request this module makes. */
export interface HubRequestOptions {
  fetchImpl?: DtypeFetch;
  hubUrl?: string;
  /**
   * Hugging Face access token, sent as `Authorization: Bearer` (the server
   * passes HF_TOKEN; the browser never sends one). Needed for gated/private
   * repos.
   */
  hubToken?: string;
}

/** HTTP statuses that mean "this repo does not exist or you may not read it" — not an outage. */
const REPO_NOT_FOUND_STATUSES = new Set([401, 403, 404]);

function hubBase(hubUrl: string | undefined): string {
  return (hubUrl ?? DEFAULT_HUB).replace(/\/+$/, '');
}

function encodeRepo(repo: string): string {
  return repo.split('/').map(encodeURIComponent).join('/');
}

function hubInit(hubToken: string | undefined): { headers?: Record<string, string> } | undefined {
  return hubToken ? { headers: { Authorization: `Bearer ${hubToken}` } } : undefined;
}

function repoNotFound(repo: string, status: number): TransformersDtypeError {
  return new TransformersDtypeError(
    `repo not found or gated: ${repo} (Hub answered HTTP ${status}). Check the model id; for a gated or ` +
      `private repo, accept its terms on huggingface.co and set HF_TOKEN.`,
    'repo-not-found',
    repo,
  );
}

export interface RepoOnnxMetadata {
  available: Set<OnnxDtype>;
  /** `transformers.js_config` from config.json, when the repo has one. */
  tjsConfig?: unknown;
}

const metadataCache = new Map<string, Promise<RepoOnnxMetadata>>();

/** Test hook: forget cached Hub metadata. */
export function clearDtypeMetadataCache(): void {
  metadataCache.clear();
}

const DEFAULT_HUB = 'https://huggingface.co';

async function fetchRepoMetadata(
  repo: string,
  fetchImpl: DtypeFetch,
  hubUrl: string | undefined,
  hubToken: string | undefined,
): Promise<RepoOnnxMetadata> {
  const hub = hubBase(hubUrl);
  const encoded = encodeRepo(repo);
  const init = hubInit(hubToken);

  // Both requests in parallel: the api/models response carries the file list,
  // but (verified 2026-10) not `transformers.js_config`, so config.json is
  // fetched alongside it. A config.json failure is non-fatal.
  const [apiRes, cfgRes] = await Promise.all([
    fetchImpl(`${hub}/api/models/${encoded}`, init),
    fetchImpl(`${hub}/${encoded}/resolve/main/config.json`, init).catch(() => null),
  ]);
  // 401/403/404: the repo is missing, private or gated — a definitive answer,
  // not an outage. Anything else (429, 5xx) is treated like a network failure.
  if (REPO_NOT_FOUND_STATUSES.has(apiRes.status)) throw repoNotFound(repo, apiRes.status);
  if (!apiRes.ok) throw new Error(`Hub metadata request for ${repo} failed: HTTP ${apiRes.status}`);

  const api = (await apiRes.json()) as {
    siblings?: { rfilename?: unknown }[];
    config?: Record<string, unknown>;
  };
  const files = (api.siblings ?? []).map((s) => s?.rfilename).filter((f): f is string => typeof f === 'string');

  let tjsConfig: unknown = api.config?.['transformers.js_config'];
  if (tjsConfig === undefined && cfgRes?.ok) {
    try {
      tjsConfig = ((await cfgRes.json()) as Record<string, unknown>)?.['transformers.js_config'];
    } catch {
      // unparseable config.json — resolve from the file list alone
    }
  }
  return { available: dtypesFromFileList(files), tjsConfig };
}

/**
 * Fetch (once per repo, cached in memory) the dtypes a repo publishes and its
 * transformers.js_config. A failed fetch is not cached, so the next call
 * retries. Rejects with TransformersDtypeError (`repo-not-found`) on
 * 401/403/404, and with a plain Error on network failures, 429 and 5xx.
 */
export function getRepoOnnxMetadata(repo: string, opts: HubRequestOptions = {}): Promise<RepoOnnxMetadata> {
  const cached = metadataCache.get(repo);
  if (cached) return cached;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as DtypeFetch);
  const p = fetchRepoMetadata(repo, fetchImpl, opts.hubUrl, opts.hubToken);
  metadataCache.set(repo, p);
  p.catch(() => metadataCache.delete(repo));
  return p;
}

// ── Full resolution ────────────────────────────────────────────────────────

export type DtypeSource = 'catalog' | 'config' | 'fallback' | 'local-cache' | 'auto';

export interface DtypeResolution {
  dtype: ResolvedDtype;
  source: DtypeSource;
}

export interface ResolveDtypeOptions extends HubRequestOptions {
  /**
   * Explicit dtype from the model catalog. Wins without any network call when
   * it is cached locally or no `localDtypes` probe is supplied.
   */
  catalogDtype?: OnnxDtype | null;
  /** Browser only: adapter.features.has('shader-f16'). Undefined = assume yes. */
  shaderF16?: boolean;
  /**
   * List the dtypes already in the local model cache (the server lists
   * ~/.openaccountant/models/<repo>/onnx). Used offline, and to tell whether a
   * catalog pin still needs a download.
   */
  localDtypes?: (repo: string) => Promise<readonly string[]>;
}

/**
 * Resolve the dtype to pass to `pipeline('text-generation', repo, {device, dtype})`.
 *
 * Throws TransformersDtypeError only when the repo is known (from the Hub) to
 * have no usable weights for this device; network failures degrade to the
 * local cache probe and then to `'auto'`, never to an exception.
 */
export async function resolveTransformersDtype(
  repo: string,
  device: TransformersDevice,
  opts: ResolveDtypeOptions = {},
): Promise<DtypeResolution> {
  const { catalogDtype, shaderF16 } = opts;
  const chain = chainFor(device, shaderF16);
  const needsF16Downgrade = (d: OnnxDtype) => device === 'webgpu' && shaderF16 === false && F16_DTYPES.has(d);

  /** Locally cached dtypes; a failing probe counts as "nothing cached". */
  const probeLocal = async (): Promise<OnnxDtype[]> => {
    if (!opts.localDtypes) return [];
    try {
      return (await opts.localDtypes(repo)).filter(isOnnxDtype);
    } catch {
      return [];
    }
  };
  const localHit = (local: readonly OnnxDtype[]) => chain.find((d) => local.includes(d));

  // 1. Catalog dtype — trusted (a unit test pins it against the recorded Hub
  //    file lists). Only an f16 dtype on a browser GPU without shader-f16
  //    needs the file list, to find a non-f16 alternative.
  if (catalogDtype && !needsF16Downgrade(catalogDtype)) {
    if (!opts.localDtypes) return { dtype: catalogDtype, source: 'catalog' };
    const local = await probeLocal();
    if (local.includes(catalogDtype)) return { dtype: catalogDtype, source: 'catalog' };

    // The pin is not cached, so loading it means a download. One metadata
    // request tells whether that can work: online → the pin (unchanged
    // behaviour); repo missing/gated → a clear error now; offline → whatever
    // the cache already holds, walking the device chain.
    try {
      await getRepoOnnxMetadata(repo, opts);
      return { dtype: catalogDtype, source: 'catalog' };
    } catch (err) {
      if (err instanceof TransformersDtypeError) throw err;
      const hit = localHit(local);
      if (hit) return { dtype: hit, source: 'local-cache' };
      // Nothing usable cached either: try the pin and let the load report it.
      return { dtype: catalogDtype, source: 'catalog' };
    }
  }

  // 2. Hub metadata.
  let meta: RepoOnnxMetadata;
  try {
    meta = await getRepoOnnxMetadata(repo, opts);
  } catch (err) {
    // A definitive "no such repo / no access" is not an outage: fail fast.
    if (err instanceof TransformersDtypeError) throw err;
    // 5. Hub unreachable — walk the same chain over what is cached locally.
    const hit = localHit(await probeLocal());
    if (hit) return { dtype: hit, source: 'local-cache' };
    if (catalogDtype) {
      // Offline and the catalog dtype is f16 on a no-f16 GPU: let it fail at
      // session creation rather than guess.
      return { dtype: catalogDtype, source: 'catalog' };
    }
    return { dtype: 'auto', source: 'auto' };
  }

  // 3-4. Repo-declared default, then the fallback chain.
  const configDtype = configDtypeFor(meta.tjsConfig, device);
  const dtype = pickDtype({ repo, device, available: meta.available, configDtype, shaderF16 });
  const source: DtypeSource = configDtype && dtype === configDtype ? 'config' : 'fallback';
  return { dtype, source };
}

// ── Damaged cache diagnosis ────────────────────────────────────────────────

/**
 * ONNX Runtime messages that mean a model file on disk is unreadable — almost
 * always a truncated download (a 770 MB copy of a 2.09 GB
 * `model_q4f16.onnx_data` fails with "Deserialize tensor … out of bounds").
 */
const CORRUPT_MODEL_RE =
  /can ?not be read in full|external initializer|deseriali[sz]e tensor|protobuf parsing failed|invalid protobuf|failed to parse (the )?(onnx )?model/i;

/** Whether a model-load error looks like a damaged (truncated/corrupt) cached file. */
export function isCorruptModelFileError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return CORRUPT_MODEL_RE.test(msg);
}

/** A cached model that cannot be loaded; the message names exactly what to delete. */
export class TransformersCacheError extends Error {
  constructor(
    message: string,
    readonly repo: string,
    readonly cachePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransformersCacheError';
  }
}

/** One cached file whose size disagrees with the Hub. */
export interface CacheSizeMismatch {
  /** Repo-relative path, e.g. 'onnx/model_q4f16.onnx_data'. */
  path: string;
  localSize: number;
  remoteSize: number;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${n} B`;
}

/**
 * The error for a load that failed on a damaged cache. Never deletes anything
 * itself: it names the repo and the cache path, tells the user to delete it,
 * and lists the files whose size disagrees with the Hub when that is known.
 */
export function corruptCacheError(
  repo: string,
  cachePath: string,
  cause: unknown,
  mismatches: readonly CacheSizeMismatch[] = [],
): TransformersCacheError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const firstLine = (detail.split('\n')[0] ?? '').slice(0, 300);
  const sizes = mismatches.length
    ? ` Size mismatch vs the Hub: ${mismatches
        .map((m) => `${m.path} is ${formatBytes(m.localSize)}, expected ${formatBytes(m.remoteSize)}`)
        .join('; ')}.`
    : '';
  return new TransformersCacheError(
    `The cached model files for ${repo} look incomplete or corrupt (likely an interrupted download).${sizes} ` +
      `Delete ${cachePath} and retry to download it again. ONNX Runtime said: ${firstLine}`,
    repo,
    cachePath,
    { cause },
  );
}

/**
 * Sizes of the files under onnx/ on the Hub (api/models/<repo>/tree/main/onnx),
 * keyed by repo-relative path. Rejects on any failure; callers treat it as
 * best effort.
 */
export async function fetchOnnxTreeSizes(repo: string, opts: HubRequestOptions = {}): Promise<Map<string, number>> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as DtypeFetch);
  const url = `${hubBase(opts.hubUrl)}/api/models/${encodeRepo(repo)}/tree/main/onnx`;
  const res = await fetchImpl(url, hubInit(opts.hubToken));
  if (!res.ok) throw new Error(`Hub tree request for ${repo} failed: HTTP ${res.status}`);
  const entries = await res.json();
  const out = new Map<string, number>();
  for (const e of Array.isArray(entries) ? entries : []) {
    const entry = e as { type?: unknown; path?: unknown; size?: unknown; lfs?: { size?: unknown } };
    const size = typeof entry.lfs?.size === 'number' ? entry.lfs.size : entry.size;
    if (entry.type === 'file' && typeof entry.path === 'string' && typeof size === 'number') out.set(entry.path, size);
  }
  return out;
}

/** Cached files (repo-relative path → bytes on disk) whose size differs from the Hub's. */
export function findCacheSizeMismatches(
  local: ReadonlyMap<string, number>,
  remote: ReadonlyMap<string, number>,
): CacheSizeMismatch[] {
  const out: CacheSizeMismatch[] = [];
  for (const [path, localSize] of local) {
    const remoteSize = remote.get(path);
    if (remoteSize !== undefined && remoteSize !== localSize) out.push({ path, localSize, remoteSize });
  }
  return out;
}
