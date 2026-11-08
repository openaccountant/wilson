// ── Browser-only: the mirror worker ──────────────────────────────────────────
//
// Dedicated worker owning the single wa-sqlite connection and all OPFS/wasm
// glue (OPFS SyncAccessHandles are worker-only — see the committed decision
// doc §5.3). Bundled with `?worker` as its own content-hashed module under
// /_app/ (served immutable by the dashboard), and it fetches the hashed
// wa-sqlite wasm from there too, so neither weighs on the page's first paint.
// Message protocol (request → response):
//   { id, type: 'init',       profile }              → { available, profile, seeded, lastSyncedAt }
//   { id, type: 'setProfile', profile }              → same shape (closes/reopens the pool)
//   { id, type: 'applySync',  payload: SyncPayload } → ApplySyncResult + lastSyncedAt
//   { id, type: 'serve',      path }                 → rows | null (null = cannot serve)
//   { id, type: 'wipe',       profiles: string[] }   → { removed, failed }: closes the pool and
//                                                      deletes these profiles' pools (session ended)
//   { id, type: 'attachPort', profile } + transferred MessagePort
//                                                    → null; the port then speaks the SCOPED
//                                                      tool protocol (mirror-port-protocol.ts:
//                                                      status | toolRead only), bound to `profile`
// Responses: { id, ok: true, result } | { id, ok: false, error }.

import wasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import { createWaSqliteHandle, type WaSqliteHandle } from './wa-sqlite-adapter.js';
import { applySync, getMeta, isMirrorSeeded } from './mirror-schema.js';
import { serveApiPath } from './mirror-reads.js';
import { servePort, type PortHost, type PortLike } from './mirror-port-protocol.js';
import { removeMirrorPools, type PoolRoot } from './mirror-session.js';
import type { MirrorStatus, SyncPayload } from './types.js';

let handle: WaSqliteHandle | null = null;

/** The wasm bytes, fetched once per worker (a profile switch reopens the pool, not the download). */
let wasmBytes: Promise<Uint8Array> | null = null;
function loadWasm(): Promise<Uint8Array> {
  wasmBytes ??= fetch(wasmUrl).then(async (res) => {
    if (!res.ok) throw new Error(`wa-sqlite wasm: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  // A failed download must not stick: the next init retry fetches again.
  wasmBytes.catch(() => { wasmBytes = null; });
  return wasmBytes;
}
let profile: string | null = null;
let seeded = false;

async function readLastSyncedAt(): Promise<string | null> {
  try {
    return await getMeta(handle!.binding, 'last_synced_at');
  } catch {
    return null;
  }
}

async function openProfile(name: string): Promise<MirrorStatus> {
  if (handle) await handle.close();
  handle = await createWaSqliteHandle(name, await loadWasm());
  profile = name;
  // A restored mirror (pool reopened after a reload) is already seeded if its
  // meta marker matches the current schema version.
  seeded = await isMirrorSeeded(handle.binding);
  return { profile: name, seeded, lastSyncedAt: await readLastSyncedAt() };
}

async function dispatch(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case 'init':
      return openProfile(msg.profile as string);
    case 'setProfile':
      return openProfile(msg.profile as string);
    case 'applySync': {
      if (!handle) throw new Error('mirror worker not initialized');
      const result = await applySync(handle.binding, msg.payload as SyncPayload);
      seeded = true;
      return { ...result, lastSyncedAt: await readLastSyncedAt() };
    }
    case 'serve': {
      if (!handle || !seeded) return null;
      return serveApiPath(handle.binding, msg.path as string);
    }
    case 'wipe': {
      // The pool's access handles are this worker's, so only it can release them before the directory goes.
      while (attachedPorts.length > 0) attachedPorts.shift()!.close();
      if (handle) {
        try {
          await handle.close();
        } catch {
          // A connection that will not close cleanly still releases its handles below, with the worker.
        }
      }
      handle = null;
      profile = null;
      seeded = false;
      const root = (await navigator.storage.getDirectory()) as unknown as PoolRoot;
      return removeMirrorPools(root, (msg.profiles as string[]) ?? []);
    }
    default:
      throw new Error(`mirror worker: unknown message type ${String(msg.type)}`);
  }
}

// Minimal worker-scope shape: DedicatedWorkerGlobalScope lives in
// lib.webworker.d.ts, which the UI tsconfig does not include.
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<Record<string, unknown>>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

// Scoped tool ports (one per subagent run). A small cap keeps abandoned ports
// from accumulating: the main thread closes its end when a run finishes, but a
// closed peer is not observable here.
const MAX_ATTACHED_PORTS = 4;
const attachedPorts: PortLike[] = [];

// Serialize dispatch: a serve read must never interleave with an in-flight
// applySync transaction (reads on the same connection see uncommitted rows).
let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` on the same chain as the main-channel messages (shared with applySync). */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => undefined);
  return run;
}

const portHost: PortHost = {
  getBinding: () => handle?.binding ?? null,
  getContext: async () => ({ profile, seeded, lastSyncedAt: handle ? await readLastSyncedAt() : null }),
  enqueue,
};

function attachPort(port: MessagePort | undefined, boundProfile: unknown): void {
  if (!port || typeof boundProfile !== 'string') {
    throw new Error('attachPort requires a transferred port and a profile');
  }
  const scoped = port as unknown as PortLike;
  servePort(scoped, boundProfile, portHost);
  attachedPorts.push(scoped);
  while (attachedPorts.length > MAX_ATTACHED_PORTS) attachedPorts.shift()!.close();
}

ctx.onmessage = (event) => {
  const { id, ...rest } = event.data;
  if (rest.type === 'attachPort') {
    try {
      attachPort((event as unknown as { ports?: MessagePort[] }).ports?.[0], rest.profile);
      ctx.postMessage({ id, ok: true, result: null });
    } catch (err) {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  chain = chain
    .then(() => dispatch(rest))
    .then((result) => {
      ctx.postMessage({ id, ok: true, result });
    })
    .catch((err) => {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    });
};