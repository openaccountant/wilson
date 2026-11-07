/**
 * Model weight cache for the in-browser WebGPU path (specs/model-manager.md M4).
 *
 * Installed into transformers.js as `env.customCache` (a `match`/`put` object),
 * so it sees every file a pipeline loads. Read order:
 *
 *   1. Cross-Origin Storage (COS), when enabled and `navigator.crossOriginStorage`
 *      exists, for Hub LFS files whose sha256 the repo manifest knows. COS is
 *      content-addressed, so every origin that loads the same weights (each
 *      localhost dashboard port, the demo sandbox, HF Spaces) shares one copy.
 *   2. The Cache API store transformers.js has always used (`transformers-cache`),
 *      so caches written by earlier builds keep working.
 *   3. Pinned-revision migration: a miss on `/resolve/<sha>/<file>` falls back to
 *      the same file cached under `/resolve/main/` by pre-pin builds, but only
 *      when that response's ETag proves it is the pinned bytes (the CDN ETag is
 *      the file's xet hash; the manifest records it). No re-download, no guess.
 *
 * COS holds public model weights only, never user data (chat-workspace D12).
 *
 * Pure: no DOM globals. The Cache API, COS and the manifest fetch are injected,
 * so this is unit tested under bun (src/__tests__/hybrid-model-cache.test.ts).
 */

/** The Cache API slice the cache uses (a real `Cache` satisfies it). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete?(key: string): Promise<boolean>;
  keys?(): Promise<ReadonlyArray<{ url: string }>>;
}

export interface CosHashDescriptor {
  algorithm: 'SHA-256';
  value: string;
}

interface CosWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface CosFileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<CosWritable>;
}

type CosGetHandle = (hash: CosHashDescriptor, opts?: { create?: boolean; origins?: '*' | string[] }) => Promise<CosFileHandle>;

/**
 * `navigator.crossOriginStorage`. The explainer's current name is
 * `getFileHandle`; older polyfills (and transformers.js 4.3.2's own adapter)
 * call it `requestFileHandle`. Either is accepted.
 */
export interface CosLike {
  getFileHandle?: CosGetHandle;
  requestFileHandle?: CosGetHandle;
}

/** One file of a repo at a revision, from the Hub tree API. */
export interface ManifestEntry {
  size: number;
  /** LFS oid (sha256, 64 lowercase hex). Absent for small non-LFS files. */
  sha256?: string;
  /** Xet content hash; it is what the Hub CDN sends as the ETag. */
  xetHash?: string;
}

/** path (e.g. 'onnx/model_q4f16.onnx') → entry. */
export type Manifest = ReadonlyMap<string, ManifestEntry>;

export type CacheSource = 'cos' | 'cache' | 'migrated' | 'network';

export interface CacheEvent {
  kind: 'hit' | 'miss' | 'store' | 'store-failed' | 'cos-error';
  source?: CacheSource | 'cos-write' | 'cache-write';
  url: string;
  bytes?: number;
  detail?: string;
}

export interface ModelCacheDeps {
  /** Opens the Cache API store (production: `caches.open('transformers-cache')`). */
  openCache: () => Promise<CacheLike>;
  /** `navigator.crossOriginStorage` when the flag is on; null/undefined otherwise. */
  cos?: CosLike | null;
  /** The Hub manifest for (repo, revision); null when it cannot be fetched. Called at most once per pair. */
  fetchManifest: (repo: string, revision: string) => Promise<Manifest | null>;
  /** Hub host (`env.remoteHost`); only URLs under it are treated as Hub files. */
  hubHost?: string;
  onEvent?: (event: CacheEvent) => void;
}

export interface HubFileRef {
  repo: string;
  revision: string;
  path: string;
}

const DEFAULT_HUB = 'https://huggingface.co';
const SHA_REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** `https://huggingface.co/{owner}/{name}/resolve/{revision}/{path}` → parts; null for anything else. */
export function parseHubFileUrl(url: string, hubHost: string = DEFAULT_HUB): HubFileRef | null {
  const base = hubHost.replace(/\/+$/, '') + '/';
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length).split('?')[0];
  const m = /^([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(rest);
  if (!m) return null;
  let revision: string;
  try {
    revision = decodeURIComponent(m[3]);
  } catch {
    return null;
  }
  return { repo: `${m[1]}/${m[2]}`, revision, path: m[4] };
}

/** ETag with quotes and a weak prefix removed, lowercased. */
function bareEtag(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
}

/**
 * Does a response cached under `main` hold exactly the pinned file? Only an
 * ETag (or X-Linked-ETag) equal to the manifest's xet hash or sha256 counts,
 * and a Content-Length, when present, must match the recorded size.
 */
export function responseMatchesEntry(res: Response, entry: ManifestEntry): boolean {
  const tags = [bareEtag(res.headers.get('etag')), bareEtag(res.headers.get('x-linked-etag'))].filter(
    (t): t is string => t !== null,
  );
  const known = [entry.xetHash, entry.sha256].filter((h): h is string => typeof h === 'string' && h.length > 0);
  if (!tags.some((t) => known.includes(t))) return false;
  const len = res.headers.get('content-length');
  return len === null || Number(len) === entry.size;
}

function cosHandleFn(cos: CosLike | null | undefined): CosGetHandle | null {
  if (!cos) return null;
  if (typeof cos.getFileHandle === 'function') return cos.getFileHandle.bind(cos);
  if (typeof cos.requestFileHandle === 'function') return cos.requestFileHandle.bind(cos);
  return null;
}

export interface CachedFileStat {
  url: string;
  repo: string;
  revision: string;
  path: string;
  bytes: number | null;
}

export interface CacheStats {
  /** Hub files in the Cache API store, grouped by `repo@revision`. */
  groups: Array<{ repo: string; revision: string; files: CachedFileStat[]; bytes: number }>;
  totalBytes: number;
  /** COS is in use for this session (flag on and the API is present). */
  cosActive: boolean;
}

export function createModelCache(deps: ModelCacheDeps) {
  const hubHost = deps.hubHost ?? DEFAULT_HUB;
  const emit = (e: CacheEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // never let telemetry break a load
    }
  };
  const getHandle = cosHandleFn(deps.cos);

  let cachePromise: Promise<CacheLike> | null = null;
  const cache = () => (cachePromise ??= deps.openCache());

  const manifests = new Map<string, Promise<Manifest | null>>();
  function manifest(repo: string, revision: string): Promise<Manifest | null> {
    const key = `${repo}@${revision}`;
    let p = manifests.get(key);
    if (!p) {
      p = deps.fetchManifest(repo, revision).catch(() => null);
      manifests.set(key, p);
    }
    return p;
  }

  async function entryFor(url: string): Promise<{ ref: HubFileRef; entry: ManifestEntry | null } | null> {
    const ref = parseHubFileUrl(url, hubHost);
    if (!ref) return null;
    const m = await manifest(ref.repo, ref.revision);
    return { ref, entry: m?.get(ref.path) ?? null };
  }

  async function cosRead(sha256: string, url: string): Promise<Response | undefined> {
    if (!getHandle) return undefined;
    try {
      const handle = await getHandle({ algorithm: 'SHA-256', value: sha256 });
      const blob = await handle.getFile();
      return new Response(blob, { headers: { 'content-length': String(blob.size) } });
    } catch (err) {
      // NotFoundError is the normal miss; anything else is still only a miss.
      const name = (err as { name?: unknown } | null)?.name;
      if (name !== 'NotFoundError') emit({ kind: 'cos-error', url, detail: String(name ?? err) });
      return undefined;
    }
  }

  async function match(key: string): Promise<Response | undefined> {
    const found = await entryFor(key);
    const sha256 = found?.entry?.sha256;

    if (sha256 && SHA256.test(sha256)) {
      const fromCos = await cosRead(sha256, key);
      if (fromCos) {
        emit({ kind: 'hit', source: 'cos', url: key, bytes: found!.entry!.size });
        return fromCos;
      }
    }

    const c = await cache();
    const hit = await c.match(key);
    if (hit) {
      emit({ kind: 'hit', source: 'cache', url: key });
      return hit;
    }

    // Pre-pin builds cached under /resolve/main/. Reuse only proven-identical bytes.
    if (found?.entry && SHA_REVISION.test(found.ref.revision)) {
      const mainUrl = key.replace(`/resolve/${found.ref.revision}/`, '/resolve/main/');
      const old = mainUrl !== key ? await c.match(mainUrl) : undefined;
      if (old && responseMatchesEntry(old, found.entry)) {
        emit({ kind: 'hit', source: 'migrated', url: key, bytes: found.entry.size });
        return old;
      }
    }

    emit({ kind: 'miss', url: key });
    return undefined;
  }

  async function put(key: string, response: Response): Promise<void> {
    const found = await entryFor(key);
    const sha256 = found?.entry?.sha256;

    if (getHandle && sha256 && SHA256.test(sha256)) {
      const blob = await response.blob();
      try {
        const handle = await getHandle({ algorithm: 'SHA-256', value: sha256 }, { create: true, origins: '*' });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        emit({ kind: 'store', source: 'cos-write', url: key, bytes: blob.size });
        return;
      } catch (err) {
        emit({ kind: 'store-failed', source: 'cos-write', url: key, detail: String((err as Error)?.name ?? err) });
        response = new Response(blob, { headers: response.headers });
      }
    }

    try {
      await (await cache()).put(key, response);
      emit({ kind: 'store', source: 'cache-write', url: key });
    } catch (err) {
      emit({ kind: 'store-failed', source: 'cache-write', url: key, detail: String((err as Error)?.message ?? err) });
      throw err;
    }
  }

  /** Hub files in the Cache API store. COS cannot be enumerated by a page (by design). */
  async function stats(): Promise<CacheStats> {
    const c = await cache();
    const keys = (await c.keys?.()) ?? [];
    const byGroup = new Map<string, { repo: string; revision: string; files: CachedFileStat[]; bytes: number }>();
    let totalBytes = 0;
    for (const { url } of keys) {
      const ref = parseHubFileUrl(url, hubHost);
      if (!ref) continue;
      const res = await c.match(url);
      const len = res?.headers.get('content-length');
      const bytes = len !== null && len !== undefined && Number.isFinite(Number(len)) ? Number(len) : null;
      const k = `${ref.repo}@${ref.revision}`;
      let g = byGroup.get(k);
      if (!g) {
        g = { repo: ref.repo, revision: ref.revision, files: [], bytes: 0 };
        byGroup.set(k, g);
      }
      g.files.push({ url, ...ref, bytes });
      g.bytes += bytes ?? 0;
      totalBytes += bytes ?? 0;
    }
    const groups = [...byGroup.values()].sort((a, b) => b.bytes - a.bytes);
    return { groups, totalBytes, cosActive: getHandle !== null };
  }

  /** Delete one repo's files (every revision, or one) from the Cache API store. Returns files removed. */
  async function clear(opts: { repo: string; revision?: string }): Promise<number> {
    const c = await cache();
    if (!c.keys || !c.delete) return 0;
    let removed = 0;
    for (const { url } of await c.keys()) {
      const ref = parseHubFileUrl(url, hubHost);
      if (!ref || ref.repo !== opts.repo) continue;
      if (opts.revision && ref.revision !== opts.revision) continue;
      if (await c.delete(url)) removed++;
    }
    return removed;
  }

  return { match, put, stats, clear, cosActive: getHandle !== null };
}

export type ModelCache = ReturnType<typeof createModelCache>;

/** Hub tree JSON (`api/models/{repo}/tree/{revision}?recursive=1`) → manifest. */
export function manifestFromTree(tree: unknown): Manifest | null {
  if (!Array.isArray(tree)) return null;
  const out = new Map<string, ManifestEntry>();
  for (const raw of tree) {
    const e = raw as { type?: unknown; path?: unknown; size?: unknown; lfs?: { oid?: unknown; size?: unknown }; xetHash?: unknown };
    if (e?.type !== 'file' || typeof e.path !== 'string') continue;
    const size = typeof e.lfs?.size === 'number' ? e.lfs.size : typeof e.size === 'number' ? e.size : 0;
    const entry: ManifestEntry = { size };
    if (typeof e.lfs?.oid === 'string' && SHA256.test(e.lfs.oid)) entry.sha256 = e.lfs.oid;
    if (typeof e.xetHash === 'string' && e.xetHash.length > 0) entry.xetHash = e.xetHash.toLowerCase();
    out.set(e.path, entry);
  }
  return out;
}

/** Production manifest fetcher: one unauthenticated tree request per (repo, revision). */
export type ManifestFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function hubManifestFetcher(fetchImpl: ManifestFetch, hubHost: string = DEFAULT_HUB) {
  return async (repo: string, revision: string): Promise<Manifest | null> => {
    const base = hubHost.replace(/\/+$/, '');
    const url = `${base}/api/models/${repo.split('/').map(encodeURIComponent).join('/')}/tree/${encodeURIComponent(revision)}?recursive=1`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) return null;
    return manifestFromTree(await res.json());
  };
}

export interface PersistResult {
  /** Storage is (now) persistent: the browser won't evict the weights under pressure. */
  persisted: boolean;
  /** The API is missing (or threw). */
  unsupported: boolean;
}

/** Ask once for persistent storage. Never throws; the result is reported, never required. */
export async function requestPersistentStorage(storage: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } | undefined): Promise<PersistResult> {
  if (!storage || typeof storage.persist !== 'function') return { persisted: false, unsupported: true };
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return { persisted: true, unsupported: false };
    return { persisted: await storage.persist(), unsupported: false };
  } catch {
    return { persisted: false, unsupported: true };
  }
}
