// ── Browser-only: the mirror worker ──────────────────────────────────────────
//
// Dedicated worker owning the single wa-sqlite connection and all OPFS/wasm
// glue (OPFS SyncAccessHandles are worker-only — see the committed decision
// doc §5.3). Bundled with `?worker&inline` so it lives inside the single-file
// build. Message protocol (request → response):
//   { id, type: 'init',       profile }              → { available, profile, seeded, lastSyncedAt }
//   { id, type: 'setProfile', profile }              → same shape (closes/reopens the pool)
//   { id, type: 'applySync',  payload: SyncPayload } → ApplySyncResult + lastSyncedAt
//   { id, type: 'serve',      path }                 → rows | null (null = cannot serve)
// Responses: { id, ok: true, result } | { id, ok: false, error }.

import wasmBase64 from 'virtual:wa-sqlite-wasm';
import { createWaSqliteHandle, type WaSqliteHandle } from './wa-sqlite-adapter.js';
import { applySync, getMeta, isMirrorSeeded } from './mirror-schema.js';
import { serveApiPath } from './mirror-reads.js';
import type { MirrorStatus, SyncPayload } from './types.js';

let handle: WaSqliteHandle | null = null;
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
  handle = await createWaSqliteHandle(name, wasmBase64);
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

// Serialize dispatch: a serve read must never interleave with an in-flight
// applySync transaction (reads on the same connection see uncommitted rows).
let chain: Promise<unknown> = Promise.resolve();

ctx.onmessage = (event) => {
  const { id, ...rest } = event.data;
  chain = chain
    .then(() => dispatch(rest))
    .then((result) => {
      ctx.postMessage({ id, ok: true, result });
    })
    .catch((err) => {
      ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    });
};