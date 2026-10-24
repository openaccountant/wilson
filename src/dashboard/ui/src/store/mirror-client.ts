// ── Browser-only: mirror client singleton (main thread) ──────────────────────
//
// Owns the mirror worker and exposes three primitives to the app:
//   initMirror()  — idempotent worker spawn + open of the last-known profile
//   syncMirror()  — one full pull from the server, applied to the mirror
//   tryMirror()   — serve a GET from the mirror when the server is unreachable
// plus a subscribable MirrorState for the UI. Any init failure (no OPFS,
// private mode, a second tab holding the pool lock) degrades to
// `available: false` — the app silently stays network-only, never crashes.
//
// The mirror starts locked and serves nothing until the login gate
// (components/AuthGate.tsx) lets the app in (unlockMirror). When the session
// ends, lockMirror() wipes it before the login view shows (mirror-session.ts).

import MirrorWorkerCtor from './mirror-worker.ts?worker';
import { SYNC_PULL_LIMIT, collectSyncPayload, subagentEnabledFrom, type SyncApplier } from './sync-engine.js';
import { isMirrorExcluded } from './mirror-reads.js';
import { bearerHeader, readAuthToken, reportUnauthorized } from '../lib/authSession.js';
import {
  MIRROR_PROFILE_KEY,
  POOL_RELEASE_RETRY_MS,
  clearLedgerStorage,
  listMirrorPoolProfiles,
  profilesToWipe,
  readStoredMirrorProfile,
  recordProfileAuth,
  removeMirrorPools,
  type ListableStorage,
  type PoolRoot,
} from './mirror-session.js';
import type {
  MirrorState,
  MirrorStatus,
  MirrorTransactionRow,
  MirrorEntityRow,
  MirrorBudgetRow,
  MirrorCategoryRow,
  MirrorAccountRow,
  MirrorBalanceSnapshotRow,
  MirrorLoanRow,
  SyncPayload,
} from './types.js';

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
/** No login lets the app in yet, or the session ended: nothing opens, syncs or serves. */
let locked = true;
/** Bumped by every lock, so a sync pull that started under the old session never writes after the wipe. */
let sessionEpoch = 0;
/** Bumped by every lock, suspend and unlock call: an unlock that waited out a wipe applies only if none came after it. */
let gateSeq = 0;

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function sessionStore(): ListableStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStoredProfile(): string {
  return readStoredMirrorProfile(localStore());
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

/**
 * Idempotently start the mirror. Resolves with the (possibly unavailable) state. A wipe in flight finishes first,
 * so a pool being deleted is never reopened.
 */
export function initMirror(): Promise<MirrorState> {
  if (wiping) return wiping.then(() => initMirror());
  if (locked) return Promise.resolve(state);
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
  // Relative in dev, through vite's proxy, so the request is same-origin (see src/api.ts getBaseUrl).
  const baseUrl = import.meta.env.DEV ? '' : window.location.origin;
  const token = readAuthToken();
  const res = await fetch(`${baseUrl}${path}`, { headers: bearerHeader(token) });
  if (!res.ok) {
    // Same as api(): a refused login sends the tab to the login view (and the sync stops here).
    if (res.status === 401) reportUnauthorized(path, token);
    throw new Error(`API ${res.status}: ${res.statusText}`);
  }
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
  async fetchAllBudgets(): Promise<MirrorBudgetRow[]> {
    return fetchJson<MirrorBudgetRow[]>('/api/budgets/limits');
  },
  async fetchAllCategories(): Promise<MirrorCategoryRow[]> {
    return fetchJson<MirrorCategoryRow[]>('/api/categories');
  },
  // Mirror v4, only ever called when the server's subagent is enabled. These are
  // the same-origin-gated, column-projected routes (sync-routes.ts), not
  // /api/accounts (SELECT *, which carries notes, plaid ids and account numbers).
  async fetchAllAccounts(): Promise<MirrorAccountRow[]> {
    return fetchJson<MirrorAccountRow[]>('/api/sync/accounts');
  },
  async fetchAllBalanceSnapshots(): Promise<MirrorBalanceSnapshotRow[]> {
    return fetchJson<MirrorBalanceSnapshotRow[]>('/api/sync/balance-snapshots');
  },
  async fetchAllLoans(): Promise<MirrorLoanRow[]> {
    return fetchJson<MirrorLoanRow[]>('/api/sync/loans');
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

/** Whether the server has auth on for its active profile (public route; read with the token like every pull). */
async function authEnabledNow(): Promise<boolean> {
  return (await fetchJson<{ authEnabled?: unknown }>('/api/auth/status')).authEnabled === true;
}

/**
 * Whether the server's browser subagent is on. A failed request rejects (the sync
 * then fails like any unreachable-server pull and the mirror keeps its last good
 * set) rather than reading as "off", which would purge the stored balances.
 */
async function subagentEnabled(): Promise<boolean> {
  return subagentEnabledFrom(await fetchJson<unknown>('/api/config/local-chat'));
}

let inFlightSync: Promise<void> | null = null;

async function doSync(): Promise<void> {
  if (locked) return;
  const epoch = sessionEpoch;
  if (!state.available) {
    await initMirror();
    if (!state.available) return;
  }
  // Checked right before each message to the worker (no await in between): a lock posts its wipe first, so
  // nothing this pull sends can reopen or refill the pool after it.
  const current = () => !locked && epoch === sessionEpoch;
  try {
    // Fetch everything BEFORE touching the pool: if any pull fails, the old
    // mirror stays intact and keeps serving its last good set.
    // Balances are pulled only while the browser subagent is enabled, and a failing
    // v4 fetch is isolated inside collectSyncPayload (the rest still syncs).
    const authBefore = await authEnabledNow();
    const netWorth = await subagentEnabled();
    const payload = await collectSyncPayload(syncFetcher, { netWorth });
    const profile = payload.profile;
    // Asked again after the pull: the status route names no profile, so a server that switched its active profile
    // mid-pull could otherwise flag the new profile with the old one's answer. Either "on" counts.
    const authEnabled = authBefore || (await authEnabledNow());
    if (!current()) return;
    // The flag that locks this profile offline goes down before its rows do.
    recordProfileAuth(localStore(), profile, authEnabled);

    // Per-profile keying: when the server's active profile differs from the
    // pool we have open, rekey to the new profile's pool right before applying
    // (the old profile's mirror stays intact on disk). applySync's meta gate
    // remains the safety net for any mismatch that reaches the store anyway.
    if (state.profile !== profile) {
      if (!current()) return;
      const opened = (await rpc('setProfile', { profile })) as MirrorStatus;
      setMirrorState({ profile: opened.profile, seeded: opened.seeded, lastSyncedAt: opened.lastSyncedAt });
    }

    if (!current()) return;
    await rpcSyncTarget()(payload);

    setMirrorState({ online: true, seeded: true, lastSyncedAt: new Date().toISOString() });
    persistProfile(profile);
  } catch {
    // Network-level or worker-level failure: keep serving the last good set.
    setMirrorState({ online: false });
  }
}

/** The server's active profile (the same authed direct fetch a sync pull uses). */
export function fetchActiveMirrorProfile(): Promise<string> {
  return syncFetcher.fetchActiveProfile();
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
  if (isMirrorExcluded(path)) return null; // live agent-access state is never served stale
  if (locked) return null;
  const current = await ensureReady();
  if (locked || !current.available || !current.seeded) return null;
  try {
    return (await rpc('serve', { path })) ?? null;
  } catch {
    return null;
  }
}

// ── Scoped tool port (model worker -> mirror) ────────────────────────────────

/**
 * Open a fresh, scoped tool port for one subagent run. One end of a new
 * MessageChannel is transferred to the mirror worker (which serves ONLY
 * `status` and `toolRead` on it, bound to `expectedProfile`); the other end is
 * returned for the caller to hand to the model worker. The caller closes it
 * when the run ends.
 *
 * Returns null when the mirror is unavailable or has never been seeded, or when
 * the open profile is not the one the caller expects (a stale run must not read
 * another profile's data).
 */
export function openToolPort(expectedProfile?: string): MessagePort | null {
  if (locked || !worker || !state.available || !state.seeded || !state.profile) return null;
  if (expectedProfile !== undefined && expectedProfile !== state.profile) return null;
  const channel = new MessageChannel();
  // Fire and forget: the worker's ack has no pending entry and is ignored.
  worker.postMessage({ id: ++rpcId, type: 'attachPort', profile: state.profile }, [channel.port1]);
  return channel.port2;
}

// ── Session lock ─────────────────────────────────────────────────────────────

/**
 * The gate let the app in (a login, or a profile without auth): the mirror may open, sync and serve. A wipe still in
 * flight (Settings' logout, an earlier check) finishes first and the mirror stays locked until then, so nothing
 * reopens or refills a pool being deleted. A lock or suspend that comes meanwhile wins. Resolves once settled.
 */
export async function unlockMirror(): Promise<void> {
  const seq = ++gateSeq;
  while (wiping) {
    await wiping;
    if (seq !== gateSeq) return;
  }
  if (seq === gateSeq) locked = false;
}

/**
 * The gate shows a screen other than the app or a login one (the server answered with an error): nothing reads the
 * mirror there, so it stops syncing and serving without being wiped. The session has not ended; unlockMirror()
 * reopens it when the app comes back.
 */
export function suspendMirror(): void {
  gateSeq++;
  if (locked) return;
  locked = true;
  sessionEpoch++;
}

let wiping: Promise<void> | null = null;

/** The OPFS root, or null where there is none (no OPFS, private mode). */
async function opfsRoot(): Promise<PoolRoot | null> {
  try {
    return (await navigator.storage.getDirectory()) as unknown as PoolRoot;
  } catch {
    return null;
  }
}

async function doWipe(): Promise<void> {
  // A worker still opening its pool is let finish, so it holds the handles it must release.
  if (initPromise) await initPromise.catch(() => undefined);
  const local = localStore();
  const root = await opfsRoot();
  // Every pool on disk too, not only the profiles this browser recorded (0.8/0.9 recorded none).
  const profiles = profilesToWipe(local, state.profile, await listMirrorPoolProfiles(root));
  const w = worker;
  let failed = profiles;
  if (w) {
    try {
      failed = ((await rpc('wipe', { profiles }, SYNC_RPC_TIMEOUT_MS)) as { failed: string[] }).failed;
    } catch {
      // A worker that cannot answer is terminated below, which releases its handles.
    }
    w.terminate();
    for (const [, entry] of pending) entry.reject(new Error('mirror locked'));
    pending.clear();
    worker = null;
  }
  initPromise = null;
  lastFailedInitAt = 0;
  setMirrorState({ available: false, profile: null, seeded: false, lastSyncedAt: null, online: false });
  // No worker in this tab (another tab's owns the pool, or none ever opened), or it could not finish. A worker
  // terminated just above lets go of its access handles a moment later, so its pools get a short backoff. No OPFS
  // here (no root): there is no pool to remove.
  if (failed.length > 0 && root) {
    const result = await removeMirrorPools(root, failed, { retryDelaysMs: w ? POOL_RELEASE_RETRY_MS : [] });
    if (result.failed.length > 0) console.warn('[mirror] pool still held (another tab wipes its own when it sees the logout):', result.failed.length);
  }
  clearLedgerStorage(local, sessionStore());
}

/**
 * The login session ended (logout, a 401, another tab's logout) or the gate shows the login view: stop serving and
 * delete this browser's copy of the ledger. Resolves once the wipe is done; never rejects. The mirror stays locked
 * until unlockMirror().
 */
export function lockMirror(): Promise<void> {
  locked = true;
  sessionEpoch++;
  gateSeq++;
  if (!wiping) {
    wiping = doWipe()
      .catch((err) => console.warn('[mirror] wipe failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        wiping = null;
      });
  }
  return wiping;
}
