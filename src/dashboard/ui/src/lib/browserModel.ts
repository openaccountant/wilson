/**
 * Settings > Models > Browser model card (specs/model-manager.md M4–M6).
 *
 * The pure decisions and labels behind the card, kept out of the component so they can be tested under bun without
 * a DOM. The shapes mirror the server's `/api/models/browser*` answers (src/model/browser-models.ts) and the hybrid
 * chunk's `cacheStats()` / `bench()` results; they are restated here because the UI package does not import server
 * modules.
 */

export type OnnxDtypeLabel = string;

/** GET /api/models/browser `current` (the server's LocalChatModelConfig, the fields the card reads). */
export interface BrowserModelCurrent {
  enabled: boolean;
  id: string;
  repo: string;
  displayName: string;
  downloadSize: string;
  dtype: OnnxDtypeLabel | null;
  revision: string | null;
  source: 'setting' | 'fastModel' | 'none';
}

export interface BrowserModelCatalogEntry {
  id: string;
  repo: string;
  displayName: string;
  dtype: string | null;
  revision: string | null;
  downloadSize: string | null;
}

export interface BrowserModelsOverview {
  current: BrowserModelCurrent;
  saved: { repo: string; revision: string; dtype: string; displayName?: string; downloadSize?: string } | null;
  catalog: BrowserModelCatalogEntry[];
  cache: { crossOriginStorage: boolean };
}

/** POST /api/models/browser/validate. */
export interface BrowserModelValidation {
  ok: boolean;
  repo: string;
  revision: string | null;
  dtype: string | null;
  bytes: number | null;
  downloadSize: string | null;
  license: string | null;
  modelType: string | null;
  catalog: boolean;
  errors: string[];
  warnings: string[];
}

/** GET /api/models/browser/updates → `{ updates: BrowserModelUpdate[] }`. */
export interface BrowserModelUpdate {
  repo: string;
  pinned: string;
  latest: string | null;
  updateAvailable: boolean;
  error?: string;
}

/** The hybrid chunk's `cacheStats()` result. */
export interface CacheStatsLike {
  groups: Array<{ repo: string; revision: string; files: unknown[]; bytes: number }>;
  totalBytes: number;
  cosActive: boolean;
  persisted: boolean | null;
}

/** The hybrid chunk's `bench()` / `lastBench()` result (worker-protocol.ts BenchResult). */
export interface BenchResultLike {
  repo: string;
  revision: string | null;
  dtype: string | null;
  loadMs: number;
  cached: boolean | null;
  firstTokenMs: number;
  decodeTokPerSec: number;
  promptTokens: number;
  newTokens: number;
  adapter: { vendor: string | null; architecture: string | null; shaderF16: boolean | null };
  transformersVersion: string | null;
  at: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/** First 7 characters of a commit sha, or an em dash when there is none. */
export function shortSha(sha: string | null | undefined): string {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : '—';
}

/** Byte counts as the card shows them: `1.2 GB`, `350 MB`, `12 KB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export type BrowserModelSourceLabel = 'catalog' | 'custom' | 'provider default' | 'none';

/** Where the current browser model came from, in the card's words. */
export function modelSourceLabel(overview: Pick<BrowserModelsOverview, 'current' | 'catalog'>): BrowserModelSourceLabel {
  const { current, catalog } = overview;
  if (!current.enabled || current.source === 'none') return 'none';
  if (current.source === 'fastModel') return 'provider default';
  return catalog.some((m) => m.repo === current.repo) ? 'catalog' : 'custom';
}

/**
 * What the person typed or pasted into "Use another Hugging Face model": `owner/name`, or a huggingface.co URL
 * (optionally `/tree/<sha>` or `/blob/<sha>/...`). Returns the repo and, when the URL names a commit, that revision.
 * Null when it doesn't look like a model id. The server validates again; this only decides what to send.
 */
export function parseRepoInput(raw: string): { repo: string; revision?: string } | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?huggingface\.co\//i, '').replace(/^hf\.co\//i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (s.startsWith('models/')) s = s.slice('models/'.length);
  const parts = s.split('/');
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if (!REPO_RE.test(repo)) return null;
  const rev = (parts[2] === 'tree' || parts[2] === 'blob' || parts[2] === 'resolve') && parts[3] ? parts[3] : undefined;
  return rev && SHA_RE.test(rev) ? { repo, revision: rev } : { repo };
}

/** "Use this model" is enabled only for a passed validation of exactly what is in the input now. */
export function canUseValidated(validation: BrowserModelValidation | null, input: string): boolean {
  if (!validation || !validation.ok || !validation.revision || !validation.dtype) return false;
  const parsed = parseRepoInput(input);
  return parsed !== null && parsed.repo === validation.repo;
}

/** The persistence line under the cache list. */
export function persistenceLine(persisted: boolean | null | undefined): string {
  if (persisted === true) return 'Storage is persistent: the browser keeps these files unless you clear them.';
  if (persisted === false) return 'Storage may be evicted: the browser can delete these files when space runs low.';
  return 'Storage persistence is unknown in this browser.';
}

/** Cache groups for display: the current model first, then largest first. */
export function sortCacheGroups<G extends { repo: string; revision: string; bytes: number }>(
  groups: readonly G[],
  current: { repo: string; revision: string | null } | null,
): G[] {
  const isCurrent = (g: G) => !!current && g.repo === current.repo && (current.revision === null || g.revision === current.revision);
  return [...groups].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)) || b.bytes - a.bytes);
}

/** Distinct repos in the cache, in display order (Clear acts per repo, all revisions). */
export function cachedRepos(groups: readonly { repo: string; bytes: number }[]): Array<{ repo: string; bytes: number; revisions: number }> {
  const out = new Map<string, { repo: string; bytes: number; revisions: number }>();
  for (const g of groups) {
    const e = out.get(g.repo) ?? { repo: g.repo, bytes: 0, revisions: 0 };
    e.bytes += g.bytes;
    e.revisions += 1;
    out.set(g.repo, e);
  }
  return [...out.values()];
}

/** One line per update check result. */
export function updateLine(u: BrowserModelUpdate): string {
  if (u.error) return `Could not check ${u.repo} for updates (${u.error}).`;
  if (u.updateAvailable && u.latest) return `Update available: ${shortSha(u.pinned)} → ${shortSha(u.latest)}`;
  return `Up to date at ${shortSha(u.pinned)}.`;
}

/** Whether an update result can be applied (POST with the repo and the latest revision). */
export function canApplyUpdate(u: BrowserModelUpdate): boolean {
  return u.updateAvailable && typeof u.latest === 'string' && SHA_RE.test(u.latest) && !u.error;
}

export interface BenchRow {
  label: string;
  value: string;
}

function ms(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString('en-US')} ms` : '—';
}

/** The benchmark result as label/value rows. */
export function benchRows(b: BenchResultLike): BenchRow[] {
  const adapter = [b.adapter?.vendor, b.adapter?.architecture].filter((s): s is string => !!s).join(' / ');
  const at = new Date(b.at);
  return [
    { label: 'First token', value: ms(b.firstTokenMs) },
    { label: 'Decode', value: Number.isFinite(b.decodeTokPerSec) ? `${b.decodeTokPerSec.toFixed(1)} tok/s` : '—' },
    { label: 'Load', value: `${ms(b.loadMs)} (${b.cached === true ? 'cached' : b.cached === false ? 'cold' : 'cache unknown'})` },
    { label: 'GPU', value: adapter || 'unknown adapter' },
    { label: 'Transformers.js', value: b.transformersVersion ?? 'unknown' },
    { label: 'Run', value: Number.isNaN(at.getTime()) ? b.at : at.toLocaleString() },
  ];
}

/** The hybrid chunk methods the card uses; every one is optional (older chunks lack them). */
export interface HybridModelManagerLike {
  refreshConfig?(): Promise<unknown>;
  cacheStats?(): Promise<CacheStatsLike | null>;
  cacheClear?(repo: string, revision?: string): Promise<{ removed: number } | null>;
  bench?(onProgress?: (label: string) => void): Promise<BenchResultLike | null>;
  lastBench?(repo: string, revision: string | null, dtype: string | null): BenchResultLike | null;
}

export interface HybridCapabilities {
  loaded: boolean;
  cache: boolean;
  clear: boolean;
  bench: boolean;
  lastBench: boolean;
  refresh: boolean;
}

/** Which parts of the card the loaded chunk (if any) can back. */
export function hybridCapabilities(h: HybridModelManagerLike | null | undefined): HybridCapabilities {
  const fn = (k: keyof HybridModelManagerLike) => !!h && typeof h[k] === 'function';
  return {
    loaded: !!h,
    cache: fn('cacheStats'),
    clear: fn('cacheClear'),
    bench: fn('bench'),
    lastBench: fn('lastBench'),
    refresh: fn('refreshConfig'),
  };
}

/** The short note shown in place of a section the chunk can't back. */
export function missingNote(caps: HybridCapabilities, part: 'cache' | 'bench'): string | null {
  if (!caps.loaded) {
    return part === 'cache' ? 'Load the chat once to inspect the cache.' : 'Load the chat once to run a benchmark.';
  }
  if (part === 'cache' && !caps.cache) return 'This build of the in-tab chat cannot report its cache. Reload the page after updating Wilson.';
  if (part === 'bench' && !caps.bench) return 'This build of the in-tab chat cannot run a benchmark. Reload the page after updating Wilson.';
  return null;
}

/** Whether this browser exposes Cross-Origin Storage. */
export function hasCrossOriginStorage(nav: unknown): boolean {
  return !!nav && typeof nav === 'object' && 'crossOriginStorage' in nav && !!(nav as { crossOriginStorage?: unknown }).crossOriginStorage;
}

/** An error thrown by `api()` is `API <status>: <body>`; pull a readable message out of a JSON body. */
export function apiErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /^API (\d+): ([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  if (m[1] === '403') return 'Only an admin can change the browser model.';
  try {
    const body = JSON.parse(m[2]) as { error?: unknown; validation?: { errors?: unknown } };
    const errs = body.validation?.errors;
    if (Array.isArray(errs) && errs.length && typeof errs[0] === 'string') return errs.join(' ');
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return m[2] || `HTTP ${m[1]}`;
}
