// ── Mirror preparation for a subagent run (main thread, pure) ────────────────
//
// The model worker cannot call syncMirror() (main thread only, mirror-client.ts)
// and must not read another profile's data, so everything about the mirror that
// needs the main thread is decided HERE, before `subagentRun` is posted
// (specs/browser-subagent.md C4/C7/C8):
//
//   1. no usable mirror                    -> 'unavailable'  (bundle mode)
//   2. old (> 120 s) or another profile    -> await syncMirror() for a bounded
//                                             time; still not right -> 'stale'
//   3. fresh and on the server's profile   -> open a fresh scoped tool port,
//                                             bound to that profile -> 'ready'
//
// Every collaborator is injected, so this runs under bun test. useHybridChat
// supplies the real mirror-client functions.

import { isMirrorFresh } from '../hybrid/subagent-core.js';
import type { MirrorPrep } from '../hybrid/worker-protocol.js';

export interface MirrorPrepState {
  available: boolean;
  seeded: boolean;
  profile: string | null;
  lastSyncedAt: string | null;
}

export interface MirrorPrepDeps {
  getState(): MirrorPrepState;
  syncMirror(): Promise<void>;
  /** The server's active profile (GET /api/profiles). */
  fetchActiveProfile(): Promise<string>;
  /** A fresh scoped port bound to `expectedProfile`, or null when the mirror cannot serve one. */
  openToolPort(expectedProfile: string): MessagePort | null;
  now(): number;
  /** How long a run waits for a catch-up sync (default 3 s). */
  syncWaitMs?: number;
}

export const DEFAULT_SYNC_WAIT_MS = 3_000;

export async function prepareMirrorForRun(deps: MirrorPrepDeps): Promise<MirrorPrep> {
  try {
    const first = deps.getState();
    if (!first.available || !first.seeded || !first.profile) return { kind: 'unavailable' };

    let expected: string;
    try {
      expected = await deps.fetchActiveProfile();
    } catch {
      return { kind: 'unavailable' };
    }

    const right = (s: MirrorPrepState) =>
      s.available && s.seeded && s.profile === expected && isMirrorFresh(s.lastSyncedAt, deps.now());

    if (!right(first)) {
      const wait = deps.syncWaitMs ?? DEFAULT_SYNC_WAIT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.syncMirror(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, wait);
          }),
        ]);
      } catch {
        // a failed sync leaves the old state; the re-check below decides
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const after = deps.getState();
      if (!right(after)) return { kind: 'stale', lastSyncedAt: after.lastSyncedAt };
    }

    const state = deps.getState();
    let port: MessagePort | null;
    try {
      port = deps.openToolPort(expected);
    } catch {
      port = null;
    }
    if (!port) return { kind: 'unavailable' };
    return { kind: 'ready', port, expectedProfile: expected, lastSyncedAt: state.lastSyncedAt };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Dev-only helper behind `window.__wilsonDebug.mirrorStatus()`: open a tool
 * port, send one `status` request, close the port. Resolves null when no port
 * could be opened or the mirror does not answer in time.
 */
export function mirrorStatusViaPort(openPort: () => MessagePort | null, timeoutMs = 3_000): Promise<unknown | null> {
  const port = openPort();
  if (!port) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (v: unknown | null) => {
      clearTimeout(timer);
      port.onmessage = null;
      try {
        port.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { id?: number; ok?: boolean; result?: unknown } | null;
      if (data && data.id === 1) done(data.ok ? (data.result ?? null) : null);
    };
    try {
      port.postMessage({ id: 1, t: 'status' });
    } catch {
      done(null);
    }
  });
}
