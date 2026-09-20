// ── Browser-only: mirror client singleton (main thread) ──────────────────────
//
// Owns the inline mirror worker and exposes three primitives to the app:
//   initMirror()  — idempotent worker spawn + open of the last-known profile
//   syncMirror()  — one full pull from the server, applied to the mirror
//   tryMirror()   — serve a GET from the mirror when the server is unreachable
// plus a subscribable MirrorState for the UI. Any init failure (no OPFS,
// private mode, a second tab holding the pool lock) degrades to
// `available: false` — the app silently stays network-only, never crashes.

import MirrorWorkerCtor from './mirror-worker.ts?worker&inline';
import { SYNC_PULL_LIMIT, type SyncApplier } from './sync-engine.js';
import type { MirrorState, MirrorStatus, MirrorTransactionRow, MirrorEntityRow, SyncPayload } from './types.js';

const MIRROR_PROFILE_KEY = 'wilson_mirror_profile';
const READY_TIMEOUT_MS = 4_000; // offline reload waits out worker/wasm boot
const INIT_RETRY_MS = 30_000;
const RPC_TIMEOUT_MS = 10_000;
const SYNC_RPC_TIMEOUT_MS = 30_000;

// ── State ────────────────────────────────────────────────────────────────────

let state: MirrorState = {
  available: false,
  profile: null,
  seeded: false,
  lastSyncedAt: null,
  online: false,
};

const listeners = new Set<() => void>();

export function getMirrorState(): MirrorState {
  return state;
}

export function subscribeMirrorState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setMirrorState(patch: Partial<MirrorState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

// ── Worker RPC ───────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let rpcId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function spawnWorker(): Worker {
  const w = new MirrorWorkerCtor();
  w.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error ?? 'mirror worker error'));
  };
  w.onerror = () => {
    // A crashed worker fails everything in flight; the mirror is unavailable
    // until a later init retry succeeds.
    for (const [, entry] of pending) entry.reject(new Error('mirror worker crashed'));
    pending.clear();
    setMirrorState({ available: false, online: false });
  };
  return w;
}

function rpc(type: string, extra: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
  if (!worker) return Promise.reject(new Error('mirror worker not started'));
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`mirror worker timeout: ${type}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    worker!.postMessage({ id, type, ...extra });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────

let initPromise: Promise<MirrorState> | null = null;
let lastFailedInitAt = 0;

function readStoredProfile(): string {
  try {
    return localStorage.getItem(MIRROR_PROFILE_KEY) ?? 'default';
  } catch {
    return 'default';
  }
}

function persistProfile(profile: string): void {
  try {
    localStorage.setItem(MIRROR_PROFILE_KEY, profile);
  } catch {
    // Storage may be unavailable (private mode); mirror still works in-session.
  }
}

async function doInit(): Promise<MirrorState> {
  worker = spawnWorker();
  try {
    // Ask the browser for persistent storage so the mirror opts out of LRU
    // eviction (best-effort, fire-and-forget — never blocks init).
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      // Storage API unavailable.
    }
    const stored = readStoredProfile();
    const result = (await rpc('init', { profile: stored })) as MirrorStatus;
    setMirrorState({
      available: true,
      profile: result.profile,
      seeded: result.seeded,
      lastSyncedAt: result.lastSyncedAt,
      // online stays false until the first successful sync.
    });
  } catch (err) {
    // No OPFS, private mode, or a second tab holding the pool lock: degrade to
    // network-only. Never crash, never retry-loop (retry cooldown instead).
    worker.terminate();
    worker = null;
    lastFailedInitAt = Date.now();
    console.warn('[mirror] unavailable, staying network-only:', err instanceof Error ? err.message : err);
  }
  return state;
}

/** Idempotently start the mirror. Resolves with the (possibly unavailable) state. */
export function initMirror(): Promise<MirrorState> {
  if (initPromise) return initPromise;
  if (Date.now() - lastFailedInitAt < INIT_RETRY_MS) return Promise.resolve(state);
  initPromise = doInit().finally(() => {
    if (!state.available) initPromise = null; // allow a cooldown retry
  });
  return initPromise;
}

/** Await init (capped) so an offline reload can wait out worker/wasm boot. */
async function ensureReady(): Promise<MirrorState> {
  await Promise.race([
    initMirror(),
    new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
  ]);
  return state;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

// Authed direct fetches. These deliberately bypass the mirror-aware seam in
// ../api.ts: a sync pull that fell back to mirror data would re-apply the
// mirror to itself and could report "online" while the server is down.
async function fetchJson<T>(path: string): Promise<T> {
  const baseUrl = import.meta.env.DEV ? 'http://localhost:3141' : window.location.origin;
  const headers: Record<string, string> = {};
  const token = localStorage.getItem('wilson_auth_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return (await res.json()) as T;
}

const syncFetcher = {
  async fetchActiveProfile(): Promise<string> {
    const data = await fetchJson<{ profiles: string[]; active: string }>('/api/profiles');
    return data.active;
  },
  async fetchAllTransactions(): Promise<MirrorTransactionRow[]> {
    return fetchJson<MirrorTransactionRow[]>(`/api/transactions?limit=${SYNC_PULL_LIMIT}`);
  },
  async fetchAllEntities(): Promise<MirrorEntityRow[]> {
    return fetchJson<MirrorEntityRow[]>('/api/entities');
  },
};

/** The mirror, reached over worker RPC, as a SyncApplier for the sync engine. */
function rpcSyncTarget(): SyncApplier {
  return async (payload: SyncPayload) => {
    const result = (await rpc('applySync', { payload }, SYNC_RPC_TIMEOUT_MS)) as {
      seeded: boolean;
      upserted: number;
      deleted: number;
      lastSyncedAt: string | null;
    };
    return { seeded: result.seeded, upserted: result.upserted, deleted: result.deleted };
  };
}

let inFlightSync: Promise<void> | null = null;

async function doSync(): Promise<void> {
  if (!state.available) {
    await initMirror();
    if (!state.available) return;
  }
  try {
    // Fetch everything BEFORE touching the pool: if any pull fails, the old
    // mirror stays intact and keeps serving its last good set.
    const profile = await syncFetcher.fetchActiveProfile();
    const [transactions, entities] = await Promise.all([
      syncFetcher.fetchAllTransactions(),
      syncFetcher.fetchAllEntities(),
    ]);

    // Per-profile keying: when the server's active profile differs from the
    // pool we have open, rekey to the new profile's pool right before applying
    // (the old profile's mirror stays intact on disk). applySync's meta gate
    // remains the safety net for any mismatch that reaches the store anyway.
    if (state.profile !== profile) {
      const opened = (await rpc('setProfile', { profile })) as MirrorStatus;
      setMirrorState({ profile: opened.profile, seeded: opened.seeded, lastSyncedAt: opened.lastSyncedAt });
    }

    await rpcSyncTarget()({ profile, transactions, entities });

    setMirrorState({ online: true, seeded: true, lastSyncedAt: new Date().toISOString() });
    persistProfile(profile);
  } catch {
    // Network-level or worker-level failure: keep serving the last good set.
    setMirrorState({ online: false });
  }
}

/** One sync pull (deduplicated while in flight). */
export function syncMirror(): Promise<void> {
  if (inFlightSync) return inFlightSync;
  inFlightSync = doSync().finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Serve a GET from the mirror. Returns the rows for mirrored paths, or null
 * when the mirror is unavailable / never seeded / does not handle the path.
 */
export async function tryMirror(path: string): Promise<unknown | null> {
  const current = await ensureReady();
  if (!current.available || !current.seeded) return null;
  try {
    return (await rpc('serve', { path })) ?? null;
  } catch {
    return null;
  }
}