import { useCallback, useEffect, useRef, useState } from 'react';
import { authedFetch, getBaseUrl } from '@/api';
import type { HybridResult } from '@/hybrid/core';
import type { WilsonHybridChatGlobal } from '@/hybrid/standalone';

/**
 * React binding for the prebuilt hybrid chat chunk (/assets/hybrid-chat.js).
 *
 * The chunk (and transformers.js inside it) is loaded at runtime via a
 * dynamic import of a variable URL — the inline @vite-ignore comment keeps it
 * OUT of the singlefile React bundle. A missing chunk (hybrid build not
 * present) resolves to null → "unavailable", never a throw: the caller falls
 * back to the server path silently.
 */

type ChunkStatus = 'unknown' | 'available' | 'unavailable';

let chunkPromise: Promise<WilsonHybridChatGlobal | null> | null = null;

function loadHybridChunk(baseUrl: string): Promise<WilsonHybridChatGlobal | null> {
  chunkPromise ??= (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ `${baseUrl}/assets/hybrid-chat.js`)) as {
        WilsonHybridChat?: WilsonHybridChatGlobal;
      };
      return mod?.WilsonHybridChat ?? window.WilsonHybridChat ?? null;
    } catch {
      // 404 (hybrid not built) or a load error → capability-unavailable.
      return null;
    }
  })();
  return chunkPromise;
}

export interface UseHybridChatResult {
  /** Local-first attempt; resolves {ok:false} on any hybrid failure. */
  tryLocal(
    query: string,
    onProgress?: (label: string) => void,
    sessionId?: string | null,
  ): Promise<HybridResult>;
  /** Whether the hybrid chunk itself is loadable (not GPU capability). */
  status: ChunkStatus;
}

export function useHybridChat(): UseHybridChatResult {
  const [status, setStatus] = useState<ChunkStatus>('unknown');
  // The chunk is configured exactly once per loaded instance — init() replaces
  // the internal client, which would drop an already-loaded model.
  const initedRef = useRef<WilsonHybridChatGlobal | null>(null);

  const ensure = useCallback(async (): Promise<WilsonHybridChatGlobal | null> => {
    const base = getBaseUrl();
    const hybrid = await loadHybridChunk(base);
    if (hybrid && initedRef.current !== hybrid) {
      hybrid.init({ baseUrl: base, fetchImpl: authedFetch });
      initedRef.current = hybrid;
    }
    return hybrid;
  }, []);

  useEffect(() => {
    let alive = true;
    void ensure().then((hybrid) => {
      if (alive) setStatus(hybrid ? 'available' : 'unavailable');
    });
    return () => {
      alive = false;
    };
  }, [ensure]);

  const tryLocal = useCallback(
    async (
      query: string,
      onProgress?: (label: string) => void,
      sessionId?: string | null,
    ): Promise<HybridResult> => {
      const hybrid = await ensure();
      if (!hybrid) return { ok: false };
      return hybrid.tryLocal(query, onProgress, sessionId);
    },
    [ensure],
  );

  return { tryLocal, status };
}