import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { initMirror, syncMirror, getMirrorState, subscribeMirrorState } from '@/store/mirror-client';
import type { MirrorState } from '@/store/types';

// Full-set pulls are cheap at dashboard scale; the constant is tunable.
const SYNC_INTERVAL_MS = 60_000;

/**
 * Mount the offline mirror for the whole app: init the worker, pull one sync
 * immediately, then refresh on an interval so the mirror converges with the
 * server (imports made through the browser statement importer arrive this way).
 */
export function useMirrorSync(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await initMirror();
      if (!cancelled) void syncMirror();
    })();
    const interval = setInterval(() => {
      void syncMirror();
    }, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
}

/** Live mirror status (available / seeded / online) for UI affordances. */
export function useMirrorStatus(): MirrorState {
  return useSyncExternalStore(subscribeMirrorState, getMirrorState);
}